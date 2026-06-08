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
