// webui/capture.js — helpers for the web-UI approve-capture (Gate-B) feature, Phase 1a (DRY-RUN TEST ONLY).
// See dev/active/general-action-rpa/UI-CAPTURE.md. These are thin, deterministic helpers over the existing
// recipe + recorder; they NEVER approve and NEVER write the committed recipe (that is Phase 2 / enable).
import fs from 'node:fs';
import path from 'node:path';

// buildPreviewRecipe(recipeObj, action, block): return a NON-committed preview recipe whose actions[action] is
// the block to dry-run-test — `block` (an operator-supplied/edited block) when given, else the recipe's existing
// actions[action] (or legacy top-level approve for action==='approve'). `enabled` is STRIPPED so a not-yet-enabled
// (uncaptured) action can still be RESOLVED for a DRY test — the dry-run never commits, and the committed recipe
// is untouched. Returns null when there is no block to test (fail-closed: the route refuses).
export function buildPreviewRecipe(recipeObj, action, block) {
	const base = recipeObj && typeof recipeObj === 'object' ? recipeObj : {};
	const actions = { ...(base.actions || {}) };
	let blk = null;
	if (block && typeof block === 'object') blk = block;
	else if (actions[action] && typeof actions[action] === 'object') blk = actions[action];
	else if (action === 'approve' && base.approve && typeof base.approve === 'object') blk = base.approve;
	if (!blk) return null;
	const { enabled, ...rest } = blk; // strip enabled:false so resolveAction resolves it for the dry test
	actions[action] = rest;
	return { ...base, actions };
}

// assembleActionBlock(flow, facts): PURE — turn a RECORDED approve flow.json (the operator's journey on a
// disposable doc) + operator-confirmed checklist `facts` into a recipe.actions.<form> block (Gate-B Phase 1b).
// The model is NOT involved — the operator authored the recording and confirms the facts. Extracted FROM the
// flow: the 결재 button (the last button-click before the decision radio — the affordance that opens the modal),
// the 승인 decision radio, the 의견 opinion fill (optional). From `facts` (the operator stops BEFORE 확인, so it
// is pinned here): confirmName (확인), openBy, formType, amountLabel, success, titleField. The block is
// **enabled:false** — FAIL-CLOSED until a dry-run + live-verify + an explicit operator enable (Phase 2). Returns
// { ok, block } or { ok:false, error, missing } when a REQUIRED part (button/decision/confirm) is absent.
export function assembleActionBlock(flow, facts = {}) {
	const steps = flow && Array.isArray(flow.steps) ? flow.steps.map((s, i) => ({ ...s, _i: i })) : [];
	const isRole = (s, role, action) => s.kind === 'find' && s.by === 'role' && s.value === role && (!action || s.action === action);
	const decision = steps.find((s) => isRole(s, 'radio')); // 승인 radio (check or click)
	let button = null; // the LAST button-click BEFORE the decision (opens the decision modal)
	for (const s of steps) { if (isRole(s, 'button', 'click') && (!decision || s._i < decision._i)) button = s; }
	const opinion = steps.find((s) => s.kind === 'find' && s.action === 'fill' && s.by === 'placeholder');
	const confirmName = String(facts.confirmName || '').trim();
	const missing = [];
	if (!button) missing.push('button (결재 — a button click before the decision radio)');
	if (!decision) missing.push('decision (승인 — a radio in the recorded flow)');
	if (!confirmName) missing.push('confirm (확인 — set it in the checklist; capture stops before clicking it)');
	if (missing.length) return { ok: false, error: '플로우에서 필수 항목을 찾지 못했습니다: ' + missing.join('; '), missing };
	const block = {
		enabled: false, // FAIL-CLOSED until dry-run + live-verify + operator enable (Phase 2)
		openBy: facts.openBy || 'rowText',
		idLabelExactlyOne: facts.idLabelExactlyOne !== false,
		button: { role: 'button', name: button.name || '', exact: true },
		decision: { role: 'radio', name: decision.name || '' },
		...(opinion ? { opinion: { placeholder: opinion.value, text: facts.opinionText || '자동 승인' } } : {}),
		confirm: { role: 'button', name: confirmName, exact: true },
		...(facts.amountLabel ? { amount: { label: String(facts.amountLabel) } } : {}),
		...(facts.formType ? { formType: facts.formType } : {}),
		success: facts.success || 'leftInbox',
		...(facts.titleField ? { titleField: String(facts.titleField) } : {}),
		_capturedVia: 'webui-capture (Gate-B Phase 1b) — review + dry-run + live-verify before enable',
	};
	return { ok: true, block };
}

// listCaptureFlows(probeRoot, app): the captured approve flows for an app (flows/approve-<app>-*.flow.json),
// newest first. Read-only; used by the capture panel to show what has been recorded (Phase 1b consumes them).
export function listCaptureFlows(probeRoot, app) {
	const dir = path.join(probeRoot, 'flows');
	let names = [];
	try { names = fs.readdirSync(dir); } catch { return []; }
	const pre = `approve-${app}-`;
	return names
		.filter((n) => n.startsWith(pre) && n.endsWith('.flow.json'))
		.map((n) => { let mtime = 0; try { mtime = fs.statSync(path.join(dir, n)).mtimeMs; } catch {} return { name: n.replace(/\.flow\.json$/, ''), mtime }; })
		.sort((a, b) => b.mtime - a.mtime);
}

// sweepOldPreviews(probeRoot, maxAgeMs): delete stale temp preview recipes (data/.capture-preview-*.json) left
// by past dry-runs — the leaf consumes the targets file but not the recipe, so previews are swept on the next
// call. data/ is gitignored; this is housekeeping only.
export function sweepOldPreviews(probeRoot, maxAgeMs = 600000) {
	const dir = path.join(probeRoot, 'data');
	let names = [];
	try { names = fs.readdirSync(dir); } catch { return; }
	const now = Date.now();
	for (const n of names) {
		if (!/^\.capture-preview-.*\.json$/.test(n)) continue;
		const f = path.join(dir, n);
		try { if (now - fs.statSync(f).mtimeMs > maxAgeMs) fs.rmSync(f, { force: true }); } catch {}
	}
}
