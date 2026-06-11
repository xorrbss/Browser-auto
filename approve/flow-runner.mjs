// approve/flow-runner.mjs — the EFFECTFUL flow.json step runner (general-action-rpa Step C). Drives a captured
// flows/<name>.flow.json step sequence (the recorder's declarative, semantic-locator model — see flows/SCHEMA.md)
// with PLAYWRIGHT (whose clicks are trusted/isTrusted by default), so an action's sequence is RECORDED, never
// model-authored. The irreversible step (the point-of-no-return) is gated: dry-run STOPS before it; live runs the
// caller's onBeforeIrreversible (audit 'clicked' + the clicksIssued cap) first. It takes `page` as a parameter and
// imports NO Playwright, so its dispatch + validation are unit-tested browser-free with a mock page
// (tests/flow-runner-unit.test.sh). FAIL-CLOSED: an unknown step kind, a needs_review step, or an effectful
// locator that is not UNIQUE at replay (count!==1) ⇒ throw (never act on first-of-many; never guess).
//
// NOT YET WIRED into approve/approve-run.mjs — the approve action keeps its captured hardcoded modal flow
// (button→radio→opinion→confirm). Wiring an `ap.steps` action onto this runner happens WITH the per-action
// Gate-B capture of a real non-approval action (operator-accompanied) — see dev/active/general-action-rpa/DESIGN.md.
'use strict';

const FIND_BY = new Set(['testid', 'role', 'label', 'text', 'placeholder', 'alt', 'title']);
const FIND_ACTION = new Set(['click', 'fill', 'type', 'select', 'check', 'uncheck', 'hover']);
const WAIT_UNTIL = new Set(['url', 'text', 'load']);
const SCROLL_DIR = new Set(['up', 'down', 'left', 'right']);
const FRAME_BY = new Set(['id', 'name', 'title', 'urlGlob', 'index']); // iframe-step scope (same-origin recording)
const EFFECTFUL = new Set(['click', 'fill', 'type', 'select', 'check', 'uncheck']); // hover is non-effectful
const OPEN_RECORD_SOURCE = new Set(['first', 'row_index', 'field_value']);
const SAFE_NAME = /^[A-Za-z0-9_-]+$/;
const DEFAULT_STEP_TIMEOUT_MS = 20000;
const MAX_STEP_TIMEOUT_MS = 10 * 60 * 1000;

function validViewportPoint(p) {
	return p && typeof p === 'object' &&
		Number.isFinite(Number(p.x)) && Number(p.x) >= 0 && Number(p.x) <= 100000 &&
		Number.isFinite(Number(p.y)) && Number(p.y) >= 0 && Number(p.y) <= 100000;
}

function validFindTarget(c) {
	return c && typeof c === 'object' && FIND_BY.has(c.by) &&
		typeof c.value === 'string' && c.value !== '' &&
		(c.name == null || typeof c.name === 'string');
}

export function isEffectfulStep(s) {
	return (s && s.kind === 'find' && EFFECTFUL.has(s.action)) || (s && s.kind === 'open_record');
}

function stepTimeout(s) {
	return Number.isInteger(s && s.timeoutMs) ? s.timeoutMs : DEFAULT_STEP_TIMEOUT_MS;
}

// validateSteps(steps): PURE structural validation of a flow.json step array (no browser). Fail-closed on any
// unknown/unresolved/malformed step — never "best-effort". Returns { ok, reason }.
export function validateSteps(steps) {
	if (!Array.isArray(steps) || !steps.length) return { ok: false, reason: 'steps must be a non-empty array' };
	for (let i = 0; i < steps.length; i++) {
		const s = steps[i];
		if (!s || typeof s !== 'object') return { ok: false, reason: `step ${i}: not an object` };
		if (s.needs_review) return { ok: false, reason: `step ${i}: needs_review (unresolved locator) — refuse` };
		if (s.unsupported) return { ok: false, reason: `step ${i}: unsupported "${s.unsupported}" must remain needs_review` };
		if (s.timeoutMs != null && !(Number.isInteger(s.timeoutMs) && s.timeoutMs > 0 && s.timeoutMs <= MAX_STEP_TIMEOUT_MS)) {
			return { ok: false, reason: `step ${i}: timeoutMs must be an integer from 1 to ${MAX_STEP_TIMEOUT_MS}` };
		}
		if (s.kind === 'find') {
			if (!FIND_BY.has(s.by)) return { ok: false, reason: `step ${i}: find.by "${s.by}" invalid` };
			if (typeof s.value !== 'string' || !s.value) return { ok: false, reason: `step ${i}: find.value required` };
			if (!FIND_ACTION.has(s.action)) return { ok: false, reason: `step ${i}: find.action "${s.action}" invalid` };
			// fill/type/select MUST carry the recorded value (the {{input_N}} token or a literal). A value-less
			// effectful field action would default to fill('') / selectOption(undefined) at runStep and SILENTLY
			// CLEAR or mis-set the field — a wrong-data submission in an RPA flow. The recorder always emits a
			// token, so an absent one means it was dropped downstream; refuse it fail-loud rather than replay it.
			if ((s.action === 'fill' || s.action === 'type') && !(typeof s.text === 'string' && s.text !== ''))
				return { ok: false, reason: `step ${i}: ${s.action} requires a non-empty text (the recorded value/token) — refusing to replay an empty ${s.action}` };
			if (s.action === 'select' && !(s.val != null || (typeof s.text === 'string' && s.text !== '')))
				return { ok: false, reason: `step ${i}: select requires val or a non-empty text` };
			if (s.frame !== undefined) { // optional iframe scope — validate it (fail-closed on a bad/unsafe frame locator)
				const f = s.frame;
				if (!f || typeof f !== 'object' || !FRAME_BY.has(f.by) || f.value == null) return { ok: false, reason: `step ${i}: invalid frame locator` };
				if (typeof f.value === 'string' && /["\\]/.test(f.value)) return { ok: false, reason: `step ${i}: frame value has unsafe chars` };
				if (f.by === 'index' && !(Number.isInteger(f.value) && f.value >= 0)) return { ok: false, reason: `step ${i}: frame index must be a non-negative integer` };
			}
		} else if (s.kind === 'wait') {
			if (!WAIT_UNTIL.has(s.until)) return { ok: false, reason: `step ${i}: wait.until "${s.until}" invalid` };
			if (s.until !== 'load' && (typeof s.value !== 'string' || !s.value)) return { ok: false, reason: `step ${i}: wait.value required` };
		} else if (s.kind === 'press') {
			if (typeof s.value !== 'string' || !s.value) return { ok: false, reason: `step ${i}: press.value required` };
		} else if (s.kind === 'scroll') {
			if (!SCROLL_DIR.has(s.dir)) return { ok: false, reason: `step ${i}: scroll.dir "${s.dir}" invalid` };
			const px = Number(s.px);
			if (!(Number.isFinite(px) && px > 0)) return { ok: false, reason: `step ${i}: scroll.px must be a positive number` };
			if (s.at !== undefined && !validViewportPoint(s.at)) return { ok: false, reason: `step ${i}: scroll.at invalid` };
			if (s.container !== undefined && s.anchor !== undefined) return { ok: false, reason: `step ${i}: scroll.container and scroll.anchor are mutually exclusive` };
			if (s.container !== undefined) {
				const c = s.container;
				if (!validFindTarget(c)) return { ok: false, reason: `step ${i}: scroll.container invalid` };
				if (s.frame !== undefined) {
					const f = s.frame;
					if (!f || typeof f !== 'object' || !FRAME_BY.has(f.by) || f.value == null) return { ok: false, reason: `step ${i}: invalid frame locator` };
					if (typeof f.value === 'string' && /["\\]/.test(f.value)) return { ok: false, reason: `step ${i}: frame value has unsafe chars` };
					if (f.by === 'index' && !(Number.isInteger(f.value) && f.value >= 0)) return { ok: false, reason: `step ${i}: frame index must be a non-negative integer` };
				}
			} else if (s.anchor !== undefined) {
				const a = s.anchor;
				if (!validFindTarget(a)) return { ok: false, reason: `step ${i}: scroll.anchor invalid` };
				if (s.frame !== undefined) {
					const f = s.frame;
					if (!f || typeof f !== 'object' || !FRAME_BY.has(f.by) || f.value == null) return { ok: false, reason: `step ${i}: invalid frame locator` };
					if (typeof f.value === 'string' && /["\\]/.test(f.value)) return { ok: false, reason: `step ${i}: frame value has unsafe chars` };
					if (f.by === 'index' && !(Number.isInteger(f.value) && f.value >= 0)) return { ok: false, reason: `step ${i}: frame index must be a non-negative integer` };
				}
			} else if (s.frame !== undefined) {
				return { ok: false, reason: `step ${i}: scroll.frame requires scroll.container or scroll.anchor` };
			}
		} else if (s.kind === 'open_record') {
			const source = s.source || 'first';
			if (!OPEN_RECORD_SOURCE.has(source)) return { ok: false, reason: `step ${i}: open_record.source "${source}" invalid` };
			if (typeof s.recipe !== 'string' || !SAFE_NAME.test(s.recipe)) return { ok: false, reason: `step ${i}: open_record.recipe invalid` };
			if (s.field != null && s.field !== '' && (typeof s.field !== 'string' || !SAFE_NAME.test(s.field))) return { ok: false, reason: `step ${i}: open_record.field invalid` };
			if (source === 'row_index') {
				if (!(Number.isInteger(s.rowIndex) && s.rowIndex >= 0)) return { ok: false, reason: `step ${i}: open_record.rowIndex must be a non-negative integer` };
			} else if (source === 'field_value') {
				if (!(typeof s.value === 'string' && s.value.trim() !== '')) return { ok: false, reason: `step ${i}: open_record.value required for field_value` };
			} else if (s.rowIndex != null && !(Number.isInteger(s.rowIndex) && s.rowIndex >= 0)) {
				return { ok: false, reason: `step ${i}: open_record.rowIndex must be a non-negative integer` };
			}
		} else {
			return { ok: false, reason: `step ${i}: unknown kind "${s.kind}"` };
		}
	}
	return { ok: true, reason: '' };
}

// frameScope(page, frame): the parent-visible iframe → a Playwright FrameLocator scope (same-origin iframe
// recording). Playwright scopes finds INTO the frame; a value with a quote/backslash is refused (selector-safe).
function frameScope(page, f) {
	const v = String(f.value);
	if (f.by !== 'index' && /["\\]/.test(v)) throw new Error('unsafe frame value');
	if (f.by === 'id') return page.frameLocator(`iframe[id="${v}"]`);
	if (f.by === 'name') return page.frameLocator(`iframe[name="${v}"]`);
	if (f.by === 'title') return page.frameLocator(`iframe[title="${v}"]`);
	if (f.by === 'urlGlob') return page.frameLocator(`iframe[src*="${v}"]`);
	if (f.by === 'index') return page.frameLocator('iframe').nth(f.value);
	throw new Error(`unsupported frame locator: ${JSON.stringify(f)}`);
}

// buildLocator(page, step): semantic find-locator → a Playwright locator (getByRole/Text/Label/…). NO @ref/CSS.
// A step with a `frame` is scoped INTO that iframe via frameScope (the uniqueness count is then frame-local).
export function buildLocator(page, s) {
	const scope = s.frame ? frameScope(page, s.frame) : page;
	const exact = s.exact !== false;
	switch (s.by) {
		case 'testid': return scope.getByTestId(s.value);
		case 'role': return scope.getByRole(s.value, s.name ? { name: s.name, exact } : undefined);
		case 'label': return scope.getByLabel(s.value, { exact });
		case 'text': return scope.getByText(s.value, { exact });
		case 'placeholder': return scope.getByPlaceholder(s.value, { exact });
		case 'alt': return scope.getByAltText(s.value, { exact });
		case 'title': return scope.getByTitle(s.value, { exact });
		default: throw new Error(`unknown find.by ${s.by}`);
	}
}

// runStep(page, step, resolveValue): execute ONE step. An effectful find FAILS CLOSED unless the locator is
// UNIQUE (count===1) — never act on first-of-many. resolveValue substitutes {{input_N}} tokens from the sidecar.
async function runStep(page, s, opts) {
	const { resolveValue = (x) => x, openRecord } = opts;
	const timeout = stepTimeout(s);
	if (s.kind === 'wait') {
		if (s.until === 'url') return page.waitForURL(s.value, { timeout });
		if (s.until === 'text') return page.getByText(s.value, { exact: false }).first().waitFor({ timeout });
		return page.waitForLoadState(s.value || 'networkidle', { timeout });
	}
	if (s.kind === 'press') return page.keyboard.press(s.value);
	if (s.kind === 'scroll') {
		const px = Math.abs(parseInt(s.px, 10) || 0);
		const d = { up: [0, -px], down: [0, px], left: [-px, 0], right: [px, 0] }[s.dir] || [0, 0];
		if (s.container) {
			const loc = buildLocator(page, { ...s.container, frame: s.frame });
			const c = await loc.count();
			if (c !== 1) throw new Error(`scroll.container ${s.container.by}:${s.container.value} matched ${c} elements (need exactly 1) fail-closed`);
			const moved = await loc.first().evaluate((el, delta) => {
				const beforeX = Math.round(el.scrollLeft || 0);
				const beforeY = Math.round(el.scrollTop || 0);
				el.scrollLeft = beforeX + delta.dx;
				el.scrollTop = beforeY + delta.dy;
				const afterX = Math.round(el.scrollLeft || 0);
				const afterY = Math.round(el.scrollTop || 0);
				return Math.abs(afterX - beforeX) > 0 || Math.abs(afterY - beforeY) > 0;
			}, { dx: d[0], dy: d[1] });
			if (!moved) throw new Error(`scroll.container ${s.container.by}:${s.container.value} did not move`);
			return;
		}
		if (s.anchor) {
			const loc = buildLocator(page, { ...s.anchor, frame: s.frame });
			const c = await loc.count();
			if (c !== 1) throw new Error(`scroll.anchor ${s.anchor.by}:${s.anchor.value} matched ${c} elements (need exactly 1) fail-closed`);
			const moved = await loc.first().evaluate((anchor, delta) => {
				function scrollable(el) {
					if (!el || el.nodeType !== 1) return false;
					const cs = window.getComputedStyle(el);
					const oy = cs.overflowY || '';
					const ox = cs.overflowX || '';
					return ((/(auto|scroll|overlay)/.test(oy) && el.scrollHeight > el.clientHeight) ||
						(/(auto|scroll|overlay)/.test(ox) && el.scrollWidth > el.clientWidth));
				}
				let el = anchor;
				while (el && el !== document.documentElement && !scrollable(el)) el = el.parentElement;
				if (!el || el === document.documentElement) return false;
				const beforeX = Math.round(el.scrollLeft || 0);
				const beforeY = Math.round(el.scrollTop || 0);
				el.scrollLeft = beforeX + delta.dx;
				el.scrollTop = beforeY + delta.dy;
				const afterX = Math.round(el.scrollLeft || 0);
				const afterY = Math.round(el.scrollTop || 0);
				return Math.abs(afterX - beforeX) > 0 || Math.abs(afterY - beforeY) > 0;
			}, { dx: d[0], dy: d[1] });
			if (!moved) throw new Error(`scroll.anchor ${s.anchor.by}:${s.anchor.value} did not move a scrollable ancestor`);
			return;
		}
		if (s.at) await page.mouse.move(Math.round(Number(s.at.x)), Math.round(Number(s.at.y)));
		return page.mouse.wheel(d[0], d[1]);
	}
	if (s.kind === 'open_record') {
		if (typeof openRecord !== 'function') throw new Error('open_record step requires an openRecord runner callback');
		return openRecord(page, s);
	}
	// find
	const loc = buildLocator(page, s);
	if (EFFECTFUL.has(s.action)) { const c = await loc.count(); if (c !== 1) throw new Error(`find ${s.by}:${s.value} matched ${c} elements (need exactly 1) — fail-closed`); }
	const t = loc.first();
	switch (s.action) {
		case 'click': return t.click({ timeout });
		case 'fill': return t.fill(resolveValue(s.text != null ? s.text : ''), { timeout });
		case 'type': return t.pressSequentially(resolveValue(s.text != null ? s.text : ''), { timeout });
		case 'select': return t.selectOption(resolveValue(s.val != null ? s.val : s.text), { timeout });
		case 'check': return t.check({ timeout });
		case 'uncheck': return t.uncheck({ timeout });
		case 'hover': return t.hover({ timeout });
		default: throw new Error(`unknown find.action ${s.action}`);
	}
}

// irreversibleOptsFor(flow): derive the runSteps gate config from a flow.json's OPTIONAL top-level
// declaration, so the generic replayer (bin/play-flow.mjs) stops hardcoding reversible:true — a blanket
// opt-out that would run an approval commit UN-audited + UN-capped, a side door around the approve gate.
// A flow OPTS IN to the audited point-of-no-return by declaring `irreversibleAt` (an int step index);
// the caller then passes reversible:false + irreversibleAt + an onBeforeIrreversible audit, engaging the
// same fail-closed gate the approve leaf uses. Without the field (or with an explicit reversible:true),
// replay stays reversible — BYTE-IDENTICAL to the prior behavior for every existing flow (none declare it).
export function irreversibleOptsFor(flow) {
	const steps = (flow && Array.isArray(flow.steps)) ? flow.steps : [];
	const hasEffectful = steps.some(isEffectfulStep);
	if (flow && flow.reversible === true) return { reversible: true };
	if (flow && Number.isInteger(flow.irreversibleAt) && hasEffectful) return { reversible: false, irreversibleAt: flow.irreversibleAt };
	return { reversible: true };
}

const SAFE_FLOW_REF = /^flows\/[A-Za-z0-9_-]+\.flow\.json$/;

// normalizeActionSteps(block): schema helper for recipe.actions.<name>.steps. Inline arrays can be
// executed by runActionBlock; {from:"flows/<name>.flow.json"} is a safe committed flow reference that
// a caller may load explicitly. Arbitrary paths are refused so an action recipe cannot escape flows/.
export function normalizeActionSteps(block) {
	const raw = block && block.steps;
	if (Array.isArray(raw)) return { ok: true, source: 'inline', steps: raw };
	const from = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? raw.from : '';
	if (typeof from === 'string' && from.trim()) {
		const ref = from.trim().replace(/\\/g, '/');
		if (!SAFE_FLOW_REF.test(ref)) return { ok: false, reason: 'steps.from must be flows/<name>.flow.json' };
		return { ok: true, source: 'flow-ref', from: ref, steps: null };
	}
	return { ok: false, reason: 'steps must be an inline array or {from:"flows/<name>.flow.json"}' };
}

function actionIrreversibleAt(block) {
	if (Number.isInteger(block && block.irreversibleAt)) return block.irreversibleAt;
	const irr = block && block.irreversible;
	if (Number.isInteger(irr && irr.atIndex)) return irr.atIndex;
	if (Number.isInteger(irr && irr.atStep)) return irr.atStep;
	return -1;
}

export function irreversibleOptsForActionBlock(block) {
	if (block && block.reversible === true) return { reversible: true };
	if (block && (block.class === 'reversible-full' || block.riskClass === 'reversible-full')) return { reversible: true };
	const at = actionIrreversibleAt(block);
	return Number.isInteger(at) && at >= 0 ? { reversible: false, irreversibleAt: at } : { reversible: false, irreversibleAt: -1 };
}

// runActionBlock(page, block, opts): browser-free-testable executor for action blocks that carry inline
// flow steps. This is the safe implementation scaffold for generic actions; callers that use flow refs
// must load the referenced committed flow and pass its steps explicitly rather than letting recipes open
// arbitrary files.
export async function runActionBlock(page, block, opts = {}) {
	const spec = normalizeActionSteps(block);
	if (!spec.ok) throw new Error('invalid action steps: ' + spec.reason);
	if (!Array.isArray(spec.steps)) throw new Error('action steps reference must be loaded by the caller before execution');
	const gate = irreversibleOptsForActionBlock(block);
	return runSteps(page, spec.steps, { ...gate, ...opts });
}

// runSteps(page, steps, opts): drive the validated step sequence. opts:
//   irreversibleAt (int, default -1): the index of the point-of-no-return step. dryRun (default true) STOPS
//   before it (returns {stoppedBeforeIrreversible:true}); live runs onBeforeIrreversible(i, step) FIRST (the
//   caller's audit 'clicked' + clicksIssued cap) then executes it. resolveValue (default identity) for {{input_N}}.
export async function runSteps(page, steps, opts = {}) {
	const v = validateSteps(steps);
	if (!v.ok) throw new Error('invalid steps: ' + v.reason);
	const { irreversibleAt = -1, onBeforeIrreversible, dryRun = true, resolveValue = (x) => x, log = () => {}, reversible = false } = opts;
	// FAIL-CLOSED irreversible-gate config (red-team MISSING_IRREVERSIBLE_VALIDATION / NON_EFFECTFUL_IRREVERSIBLE /
	// OPTIONAL_ONBEFOREIRREVERSIBLE): unless the action is EXPLICITLY `reversible`, an action containing any
	// effectful step MUST pin a valid point-of-no-return — an in-range index pointing at an EFFECTFUL find — and
	// (in live) an onBeforeIrreversible callback. A mis-set / out-of-range / non-effectful marker, or a missing
	// callback, would silently run the commit step UNAUDITED + UNCAPPED, so REFUSE up-front (never run effectfully
	// through an un-gated commit). A genuinely reversible action opts out with reversible:true.
	const hasEffectful = steps.some(isEffectfulStep);
	if (!reversible && hasEffectful) {
		if (!Number.isInteger(irreversibleAt) || irreversibleAt < 0 || irreversibleAt >= steps.length)
			throw new Error(`REFUSED: irreversibleAt ${irreversibleAt} out of range [0,${steps.length}) — an effectful action must pin its point-of-no-return (or pass reversible:true) — fail-closed`);
		const irr = steps[irreversibleAt];
		if (!isEffectfulStep(irr))
			throw new Error(`REFUSED: irreversibleAt ${irreversibleAt} is "${irr.kind}/${irr.action || ''}", not an effectful find — the real commit would run un-gated (fail-closed)`);
		if (!dryRun && typeof onBeforeIrreversible !== 'function')
			throw new Error('REFUSED: a live irreversible run requires an onBeforeIrreversible callback (audit + cap) — fail-closed');
	}
	for (let i = 0; i < steps.length; i++) {
		if (i === irreversibleAt) {
			if (dryRun) { log(`dry-run: stop BEFORE irreversible step ${i}`); return { stoppedBeforeIrreversible: true }; }
			await onBeforeIrreversible(i, steps[i]); // audit 'clicked' + consume the cap BEFORE the commit (guaranteed present by the check above)
		}
		await runStep(page, steps[i], opts);
		// NOTE (red-team STEPS_AFTER_IRREVERSIBLE): any steps after irreversibleAt are POST-COMMIT — the commit was
		// already audited ('clicked') by onBeforeIrreversible, so a post-step failure surfaces as the leaf's
		// completion/reconciliation outcome (committed-but-uncertain), never a silently-lost commit.
	}
	return { stoppedBeforeIrreversible: false };
}
