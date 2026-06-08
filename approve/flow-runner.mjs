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

// validateSteps(steps): PURE structural validation of a flow.json step array (no browser). Fail-closed on any
// unknown/unresolved/malformed step — never "best-effort". Returns { ok, reason }.
export function validateSteps(steps) {
	if (!Array.isArray(steps) || !steps.length) return { ok: false, reason: 'steps must be a non-empty array' };
	for (let i = 0; i < steps.length; i++) {
		const s = steps[i];
		if (!s || typeof s !== 'object') return { ok: false, reason: `step ${i}: not an object` };
		if (s.needs_review) return { ok: false, reason: `step ${i}: needs_review (unresolved locator) — refuse` };
		if (s.kind === 'find') {
			if (!FIND_BY.has(s.by)) return { ok: false, reason: `step ${i}: find.by "${s.by}" invalid` };
			if (typeof s.value !== 'string' || !s.value) return { ok: false, reason: `step ${i}: find.value required` };
			if (!FIND_ACTION.has(s.action)) return { ok: false, reason: `step ${i}: find.action "${s.action}" invalid` };
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
	switch (s.by) {
		case 'testid': return scope.getByTestId(s.value);
		case 'role': return scope.getByRole(s.value, s.name ? { name: s.name, exact: !!s.exact } : undefined);
		case 'label': return scope.getByLabel(s.value, s.exact ? { exact: true } : undefined);
		case 'text': return scope.getByText(s.value, s.exact ? { exact: true } : undefined);
		case 'placeholder': return scope.getByPlaceholder(s.value);
		case 'alt': return scope.getByAltText(s.value);
		case 'title': return scope.getByTitle(s.value);
		default: throw new Error(`unknown find.by ${s.by}`);
	}
}

// runStep(page, step, resolveValue): execute ONE step. An effectful find FAILS CLOSED unless the locator is
// UNIQUE (count===1) — never act on first-of-many. resolveValue substitutes {{input_N}} tokens from the sidecar.
async function runStep(page, s, resolveValue) {
	if (s.kind === 'wait') {
		if (s.until === 'url') return page.waitForURL(s.value, { timeout: 20000 });
		if (s.until === 'text') return page.getByText(s.value, { exact: false }).first().waitFor({ timeout: 20000 });
		return page.waitForLoadState('networkidle');
	}
	if (s.kind === 'press') return page.keyboard.press(s.value);
	if (s.kind === 'scroll') {
		const px = Math.abs(parseInt(s.px, 10) || 0);
		const d = { up: [0, -px], down: [0, px], left: [-px, 0], right: [px, 0] }[s.dir] || [0, 0];
		return page.mouse.wheel(d[0], d[1]);
	}
	// find
	const loc = buildLocator(page, s);
	if (EFFECTFUL.has(s.action)) { const c = await loc.count(); if (c !== 1) throw new Error(`find ${s.by}:${s.value} matched ${c} elements (need exactly 1) — fail-closed`); }
	const t = loc.first();
	switch (s.action) {
		case 'click': return t.click();
		case 'fill': return t.fill(resolveValue(s.text != null ? s.text : ''));
		case 'type': return t.pressSequentially(resolveValue(s.text != null ? s.text : ''));
		case 'select': return t.selectOption(resolveValue(s.val != null ? s.val : s.text));
		case 'check': return t.check();
		case 'uncheck': return t.uncheck();
		case 'hover': return t.hover();
		default: throw new Error(`unknown find.action ${s.action}`);
	}
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
	const hasEffectful = steps.some((s) => s.kind === 'find' && EFFECTFUL.has(s.action));
	if (!reversible && hasEffectful) {
		if (!Number.isInteger(irreversibleAt) || irreversibleAt < 0 || irreversibleAt >= steps.length)
			throw new Error(`REFUSED: irreversibleAt ${irreversibleAt} out of range [0,${steps.length}) — an effectful action must pin its point-of-no-return (or pass reversible:true) — fail-closed`);
		const irr = steps[irreversibleAt];
		if (!(irr.kind === 'find' && EFFECTFUL.has(irr.action)))
			throw new Error(`REFUSED: irreversibleAt ${irreversibleAt} is "${irr.kind}/${irr.action || ''}", not an effectful find — the real commit would run un-gated (fail-closed)`);
		if (!dryRun && typeof onBeforeIrreversible !== 'function')
			throw new Error('REFUSED: a live irreversible run requires an onBeforeIrreversible callback (audit + cap) — fail-closed');
	}
	for (let i = 0; i < steps.length; i++) {
		if (i === irreversibleAt) {
			if (dryRun) { log(`dry-run: stop BEFORE irreversible step ${i}`); return { stoppedBeforeIrreversible: true }; }
			await onBeforeIrreversible(i, steps[i]); // audit 'clicked' + consume the cap BEFORE the commit (guaranteed present by the check above)
		}
		await runStep(page, steps[i], resolveValue);
		// NOTE (red-team STEPS_AFTER_IRREVERSIBLE): any steps after irreversibleAt are POST-COMMIT — the commit was
		// already audited ('clicked') by onBeforeIrreversible, so a post-step failure surfaces as the leaf's
		// completion/reconciliation outcome (committed-but-uncertain), never a silently-lost commit.
	}
	return { stoppedBeforeIrreversible: false };
}
