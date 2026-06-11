// approve/guards.mjs — PURE deterministic guard helpers for the auto-approve leaf (NO Playwright import,
// so they are unit-tested browser-free in tests/approve-guards-unit.test.sh). After the owner removed the
// per-item-human gate (memory approve-gate-override), these deterministic guards are the SOLE safety, so
// each is FAIL-CLOSED by construction: on any ambiguity they return the cautious answer (skip/uncertain),
// never the permissive one. approve-run.mjs imports these; it owns only the Playwright-coupled glue.
'use strict';
import { isEffectfulStep, normalizeActionSteps, validateSteps } from './flow-runner.mjs';

// parseKRW(text): largest KRW value in `text`, handling "1,234,567원" / "₩1,234,567" / "5억[3000만]" /
// "300만". Returns -1 if no figure. Takes the MAX in the region so a total alongside line items reads
// the total (over-read ⇒ over-skip ⇒ fail-safe for an amount CEILING).
export function parseKRW(txt) {
	let max = -1; const add = (v) => { if (Number.isFinite(v) && v >= 0 && v > max) max = v; }; let m;
	const reUnit = /([0-9][0-9,.]*)\s*억(?:\s*([0-9][0-9,.]*)\s*만)?/g; while ((m = reUnit.exec(txt))) add(Math.round(parseFloat((m[1] || '0').replace(/,/g, '')) * 1e8 + (m[2] ? parseFloat(m[2].replace(/,/g, '')) * 1e4 : 0)));
	const reMan = /([0-9][0-9,.]*)\s*만\s*원?/g; while ((m = reMan.exec(txt))) add(Math.round(parseFloat(m[1].replace(/,/g, '')) * 1e4));
	const reWon = /(?:₩\s*)?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*원?/g; while ((m = reWon.exec(txt))) add(parseInt(m[1].replace(/,/g, ''), 10));
	return max;
}

// pagerDecision(mode, optionTextsPerSelect): decide the TOTAL page count from the page-number combobox,
// RELIABLY (red-team PAGESELECT-* / carry-forward). The completion check (countDoc) scans every page and
// concludes a doc "left 대기" when it is absent on ALL scanned pages — so if the page count is UNDER-read,
// a doc on an unscanned page reads ABSENT ⇒ false "approved". This must never happen, so a pager is only
// TRUSTED when both:
//   (a) the recipe explicitly declares pagination.mode === 'combobox' — a native <select> lists ALL its
//       <option>s in the DOM, so it is NOT windowed like a link-pager (option-count == page-count), AND
//   (b) exactly ONE <select> has numeric options forming the CONTIGUOUS sequence 1..N (N≥2). That rejects
//       a rows-per-page select ([10,20,50]) and any 1-based window / sparse set / multiple candidates.
//   mode: recipe.pagination?.mode (falsy ⇒ the recipe declares no pagination ⇒ single page).
//   optionTextsPerSelect: Array<Array<string>> — the option texts of each <select> currently on the page.
// Returns:
//   { kind: 'none' }                  — no pagination / no pager rendered ⇒ treat as a single page (total 1)
//   { kind: 'pager', index, total }   — the index-th <select> is a trustworthy 1..N pager of `total` pages
//   { kind: 'uncertain' }             — declared combobox but the pager is untrustworthy ⇒ caller FAIL-CLOSES
export function pagerDecision(mode, optionTextsPerSelect) {
	if (!mode) return { kind: 'none' };                 // recipe declares no pagination ⇒ single page
	if (mode !== 'combobox') return { kind: 'uncertain' }; // only the <select> combobox pager is reliably scannable
	const selects = Array.isArray(optionTextsPerSelect) ? optionTextsPerSelect : [];
	const numericSelects = []; // indices of selects with ≥2 numeric options (candidate pagers)
	const pagers = [];         // indices whose numeric options are exactly 1..N
	selects.forEach((opts, index) => {
		const nums = (Array.isArray(opts) ? opts : []).map((o) => String(o).trim()).filter((o) => /^\d+$/.test(o)).map(Number);
		if (nums.length < 2) return;
		numericSelects.push(index);
		const uniq = [...new Set(nums)].sort((a, b) => a - b);
		if (uniq.every((v, k) => v === k + 1)) pagers.push({ index, total: uniq.length }); // contiguous 1..N
	});
	if (pagers.length === 1) return { kind: 'pager', ...pagers[0] };
	if (numericSelects.length === 0) return { kind: 'none' }; // combobox declared but none rendered ⇒ single page
	return { kind: 'uncertain' };                             // a numeric select exists but isn't a clean 1..N pager, or >1 candidate ⇒ fail-closed
}

// matchesFormType(liveForm, want): does the live form-type heading match any DECLARED expected form?
// `want` is a string or array of expected form names; match = normalized substring (the heading may carry
// extra adornment). Empty liveForm or no match ⇒ false (caller FAIL-CLOSES). norm() folds whitespace.
export function matchesFormType(liveForm, want) {
	const lf = norm(liveForm);
	if (!lf) return false;
	const names = (Array.isArray(want) ? want : [want]).map(norm).filter(Boolean);
	return names.some((w) => lf.includes(w));
}

export const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

const ACTION_NAME_RE = /^[\p{L}\p{N}_-]+$/u;

export const ACTION_CATALOG = Object.freeze({
	approve: Object.freeze({
		id: 'approve',
		family: 'decision-modal',
		executor: 'approve-modal-v1',
		riskClass: 'irreversible',
		resultStatus: 'approved',
		requiresDecision: true,
		requiresTargetReview: true,
		requiresDryRun: true,
		requiresHumanConfirm: true,
		requiresCap: true,
		requiresCompletion: true,
		description: 'Approve one reviewed target through a captured decision modal.',
	}),
	reject: Object.freeze({
		id: 'reject',
		family: 'decision-modal',
		executor: 'approve-modal-v1',
		riskClass: 'irreversible',
		resultStatus: 'rejected',
		requiresDecision: true,
		requiresTargetReview: true,
		requiresDryRun: true,
		requiresHumanConfirm: true,
		requiresCap: true,
		requiresCompletion: true,
		description: 'Reject or return one reviewed target through a captured decision modal.',
	}),
	update: Object.freeze({
		id: 'update',
		family: 'record-flow',
		executor: 'flow-runner',
		riskClass: 'effectful',
		resultStatus: 'updated',
		requiresSteps: true,
		requiresTargetReview: true,
		requiresDryRun: true,
		requiresHumanConfirm: true,
		requiresCap: true,
		requiresCompletion: true,
		description: 'Apply a captured update/status-change flow to a reviewed target.',
	}),
	upload: Object.freeze({
		id: 'upload',
		family: 'file-flow',
		executor: 'flow-runner',
		riskClass: 'effectful',
		resultStatus: 'uploaded',
		requiresSteps: true,
		requiresFile: true,
		requiresTargetReview: true,
		requiresDryRun: true,
		requiresHumanConfirm: true,
		requiresCap: true,
		requiresCompletion: true,
		description: 'Upload a predeclared local artifact through a captured file-flow.',
	}),
	download: Object.freeze({
		id: 'download',
		family: 'artifact-flow',
		executor: 'flow-runner',
		riskClass: 'read-sensitive',
		resultStatus: 'downloaded',
		requiresSteps: true,
		requiresArtifactGate: true,
		requiresTargetReview: true,
		requiresDryRun: true,
		requiresHumanConfirm: true,
		requiresCap: true,
		requiresCompletion: true,
		description: 'Download a target-scoped artifact with a captured completion marker and artifact gate.',
	}),
	export: Object.freeze({
		id: 'export',
		family: 'artifact-flow',
		executor: 'flow-runner',
		riskClass: 'read-sensitive',
		resultStatus: 'exported',
		requiresSteps: true,
		requiresArtifactGate: true,
		requiresTargetReview: true,
		requiresDryRun: true,
		requiresHumanConfirm: true,
		requiresCap: true,
		requiresCompletion: true,
		description: 'Export a reviewed data set through a captured flow and sanitized-export policy gate.',
	}),
});

function actionCatalogId(action, block = {}) {
	const declared = block && (block.actionType || block.type || block.catalogAction);
	if (typeof declared === 'string' && ACTION_CATALOG[declared]) return declared;
	const name = String(action || '').trim();
	if (ACTION_CATALOG[name]) return name;
	if (/^approve(?:[_-]|$)/.test(name)) return 'approve';
	if (/^(reject|return)(?:[_-]|$)/.test(name)) return 'reject';
	return '';
}

export function actionCatalogEntry(action, block = {}) {
	const id = actionCatalogId(action, block);
	return id ? ACTION_CATALOG[id] : null;
}

function hasNamedLocator(x) {
	return !!(x && typeof x === 'object' && typeof x.name === 'string' && x.name.trim());
}

function hasCompletion(block) {
	return !!(block && (block.success || block.completion));
}

function validateIrreversibleIndex(block, steps) {
	if (block && block.reversible === true) return { ok: true };
	if (block && (block.class === 'reversible-full' || block.riskClass === 'reversible-full')) return { ok: true };
	const idx = Number.isInteger(block && block.irreversibleAt) ? block.irreversibleAt
		: Number.isInteger(block && block.irreversible && block.irreversible.atIndex) ? block.irreversible.atIndex
			: Number.isInteger(block && block.irreversible && block.irreversible.atStep) ? block.irreversible.atStep
				: -1;
	if (!Number.isInteger(idx) || idx < 0 || idx >= steps.length) return { ok: false, reason: 'irreversibleAt (or irreversible.atIndex) must point at the point-of-no-return step' };
	if (!isEffectfulStep(steps[idx])) return { ok: false, reason: 'irreversibleAt must point at an effectful step' };
	return { ok: true };
}

export function actionSuccessStatus(action, block = {}) {
	const explicit = block && typeof block.resultStatus === 'string' && block.resultStatus.trim();
	if (explicit) return explicit.trim();
	const entry = actionCatalogEntry(action, block);
	return entry ? entry.resultStatus : 'completed';
}

export function validateActionBlock(action, block, opts = {}) {
	if (!ACTION_NAME_RE.test(String(action || ''))) return { ok: false, reason: 'invalid action name' };
	if (!block || typeof block !== 'object' || Array.isArray(block)) return { ok: false, reason: `action "${action}" must be an object` };
	const catalog = actionCatalogEntry(action, block);
	if (!catalog) return { ok: false, reason: `action "${action}" is not in the RPA action catalog (approve/reject/update/upload/download/export)` };
	if (block.enabled === false) {
		const reason = `action "${action}" is disabled (enabled:false) - capture its UI per system (Gate-B) and enable it first`;
		return opts.allowDisabled ? { ok: true, disabled: true, reason, catalog, catalogId: catalog.id, resultStatus: catalog.resultStatus } : { ok: false, reason };
	}
	if (catalog.family === 'decision-modal') {
		if (!hasNamedLocator(block.button)) return { ok: false, reason: `action "${action}" requires button.name` };
		if (catalog.requiresDecision && !hasNamedLocator(block.decision)) return { ok: false, reason: `action "${action}" requires decision.name` };
		if (!hasNamedLocator(block.confirm)) return { ok: false, reason: `action "${action}" requires confirm.name` };
		if (catalog.requiresCompletion && !hasCompletion(block)) return { ok: false, reason: `action "${action}" requires success or completion marker` };
		return { ok: true, catalog, catalogId: catalog.id, resultStatus: actionSuccessStatus(action, block) };
	}
	const stepSpec = normalizeActionSteps(block);
	if (!stepSpec.ok) return { ok: false, reason: `action "${action}" ${stepSpec.reason}` };
	if (Array.isArray(stepSpec.steps)) {
		const sv = validateSteps(stepSpec.steps);
		if (!sv.ok) return { ok: false, reason: `action "${action}" invalid steps: ${sv.reason}` };
		const iv = validateIrreversibleIndex(block, stepSpec.steps);
		if (!iv.ok) return { ok: false, reason: `action "${action}" ${iv.reason}` };
	}
	if (catalog.requiresCompletion && !hasCompletion(block)) return { ok: false, reason: `action "${action}" requires success or completion marker` };
	if (catalog.requiresFile && !(block.file && (block.file.token || block.file.pathToken || block.file.input))) return { ok: false, reason: `action "${action}" requires file.token/pathToken/input` };
	if (catalog.requiresArtifactGate && !(block.artifactPolicy || block.download || block.export)) return { ok: false, reason: `action "${action}" requires artifactPolicy/download/export gate metadata` };
	return { ok: true, catalog, catalogId: catalog.id, resultStatus: actionSuccessStatus(action, block), stepSource: stepSpec.source, stepRef: stepSpec.from || null };
}

// resolveAction(recipe, action): the FAIL-CLOSED action selector (general-action-rpa Step B). Returns the
// action block for `action` from recipe.actions[action] (canonical), or the legacy top-level recipe.approve
// when action==='approve'. An action that is absent, or explicitly `enabled:false` (declared but not yet
// captured per-system), is REFUSED — the model never picks an arbitrary action; only a captured+enabled one runs.
export function resolveAction(recipe, action) {
	const a = (recipe && recipe.actions && recipe.actions[action]) || (action === 'approve' && recipe ? recipe.approve : null);
	if (!a) return { ok: false, reason: `no action "${action}" — recipe has no actions.${action}${action === 'approve' ? ' (or legacy approve)' : ''} block` };
	const v = validateActionBlock(action, a);
	if (!v.ok) return { ok: false, reason: v.reason };
	return { ok: true, action: a, catalog: v.catalog, catalogId: v.catalogId, resultStatus: v.resultStatus };
}

// amountVerdict(amt, ceiling): the FAIL-CLOSED amount-ceiling decision (pure; the page-coupled extractAmount
// stays in the leaf). `amt`: null = no amount locator in the recipe, -1 = locator/figure not found, else the
// parsed 원 value. Returns { eligible, reason, audit } — eligible only when a figure ≤ ceiling was read.
export function amountVerdict(amt, ceiling) {
	if (amt === null) return { eligible: false, reason: 'recipe has no amount locator (approve.amount.label) — cannot enforce ceiling (fail-closed)', audit: 'no-amount-locator' };
	if (amt < 0) return { eligible: false, reason: 'amount not parseable at the 금액 label (fail-closed)', audit: 'amount-unparseable' };
	if (amt > ceiling) return { eligible: false, reason: `amount ${amt} > ceiling ${ceiling}`, audit: `amount>${ceiling}` };
	return { eligible: true, reason: '', audit: String(amt) };
}

// completionVerdict(stamped, afterTotal): the POSITIVE completion decision (pure). `stamped` = a NEW today
// 승인 stamp appeared on the doc's own line; `afterTotal` = countDoc across all pages (-1 uncertain, 0 absent,
// >0 still present). Approved ONLY when stamped AND absent; every other combination ⇒ fail-closed with a reason.
export function completionVerdict(stamped, afterTotal) {
	if (afterTotal === -1) return { ok: false, reason: 'post-approve: 대기 list uncertain — cannot confirm' };
	if (!stamped && afterTotal > 0) return { ok: false, reason: 'post-approve: no new 승인 stamp AND still in 대기 (not committed)' };
	if (!stamped) return { ok: false, reason: 'post-approve: doc left 대기 but NO new today 승인 stamp on its line — uncertain (fail-closed)' };
	if (afterTotal > 0) return { ok: false, reason: 'post-approve: today 승인 stamp present but doc still in 대기 — contradictory (fail-closed)' };
	return { ok: true, reason: '' };
}
