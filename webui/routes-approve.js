// webui/routes-approve.js — the EFFECTFUL auto-approve scenario route.
//
// SAFETY POSTURE: the owner released the per-item-human gate (memory approve-gate-override), so this runs
// the Playwright trusted-click leaf (approve/approve-run.mjs) that approves REAL docs with no human click.
// The deterministic guardrails live in the leaf (idLabel exactly-one, dry-run, --max cap, kill-switch,
// append-only audit, positive completion verify). This route only validates input, resolves recipe/state/
// list-url, and enqueues the leaf on the serial queue; results come back as the leaf's JSON summary line
// in the job log (the UI parses it). Read-only status via approveGet.

import fs from 'node:fs';
import path from 'node:path';
import { PROBE_ROOT } from './spawn.js';

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const recipeFor = (app) => path.join(PROBE_ROOT, 'recipes', `${app}.json`);
const stateFor = (app) => path.join(PROBE_ROOT, 'approve', `${app}.pw-state.json`);

// Resolve the 대기/list URL: data/approvals.config GW_INBOX_URL (the hiworks 대기 inbox). Quotes stripped.
function listUrlFor(app) {
	try {
		const cfg = fs.readFileSync(path.join(PROBE_ROOT, 'data', 'approvals.config'), 'utf8');
		const m = /^\s*GW_INBOX_URL\s*=\s*"?([^"\n]+)"?/m.exec(cfg);
		if (m) return m[1].trim();
	} catch { /* fall through */ }
	return '';
}

// A doc_id is passed as ONE argv element (shell:false) and joined with commas for --docs, so the only
// hard constraint is: no comma / newline, non-empty, bounded length. (Hiworks ids contain Korean/()/-.)
const validDoc = (d) => typeof d === 'string' && d.length > 0 && d.length <= 100 && !/[,\n\r]/.test(d);

// approvePost(p, bodyJson, res, { sendJson, enqueue, nodeLeaf }) -> handled?
export function approvePost(p, bodyJson, res, { sendJson, enqueue, nodeLeaf }) {
	if (p !== '/api/approve/run') return false;
	const app = String(bodyJson.app || '').trim();
	if (!NAME_RE.test(app)) { sendJson(res, 400, { error: 'invalid app name' }); return true; }
	if (!fs.existsSync(recipeFor(app))) { sendJson(res, 400, { error: `no recipe recipes/${app}.json` }); return true; }
	// The recipe must have an approve block (else the leaf refuses) — fail fast with a clear message.
	try { if (!JSON.parse(fs.readFileSync(recipeFor(app), 'utf8')).approve) { sendJson(res, 400, { error: `recipe ${app} has no "approve" block` }); return true; } }
	catch { sendJson(res, 400, { error: `recipe ${app} unreadable` }); return true; }
	if (!fs.existsSync(stateFor(app))) { sendJson(res, 400, { error: `no Playwright login for '${app}' — run: node approve/auth-pw.mjs … approve/${app}.pw-state.json` }); return true; }
	const listUrl = listUrlFor(app);
	if (!listUrl) { sendJson(res, 400, { error: 'no 대기 list URL (set GW_INBOX_URL in data/approvals.config)' }); return true; }

	const docs = Array.isArray(bodyJson.docs) ? bodyJson.docs : [];
	if (!docs.length) { sendJson(res, 400, { error: 'docs: a non-empty array of doc_ids is required' }); return true; }
	if (!docs.every(validDoc)) { sendJson(res, 400, { error: 'docs: each must be a non-empty string ≤100 chars with no comma/newline' }); return true; }
	const dryRun = bodyJson.dryRun !== false; // DEFAULT DRY-RUN — live approve requires an explicit dryRun:false
	let max = parseInt(bodyJson.max, 10); if (!Number.isFinite(max) || max < 0) max = 0;

	const args = [
		'approve/approve-run.mjs',
		'--recipe', `recipes/${app}.json`,
		'--state', `approve/${app}.pw-state.json`,
		'--list-url', listUrl,
		'--docs', docs.join(','),
	];
	if (dryRun) args.push('--dry-run');
	if (max) args.push('--max', String(max));

	const label = `${dryRun ? 'DRY approve' : 'AUTO-APPROVE'} ${app} (${docs.length} doc${docs.length > 1 ? 's' : ''}${max ? `, max ${max}` : ''})`;
	const job = enqueue({ kind: 'approve', label, spawnFn: () => nodeLeaf('approve/approve-run.mjs', args.slice(1)) });
	sendJson(res, 202, { job, dryRun, docs: docs.length });
	return true;
}

// approveGet(p, url, res, { sendJson }) -> handled? Reports whether a Playwright login exists per app.
export function approveGet(p, url, res, { sendJson }) {
	if (p !== '/api/approve/state') return false;
	const app = (url.searchParams.get('app') || '').trim();
	const ok = NAME_RE.test(app) && fs.existsSync(stateFor(app)) && fs.existsSync(recipeFor(app));
	let hasApprove = false;
	try { hasApprove = ok && !!JSON.parse(fs.readFileSync(recipeFor(app), 'utf8')).approve; } catch {}
	sendJson(res, 200, { app, loggedIn: NAME_RE.test(app) && fs.existsSync(stateFor(app)), hasApproveRecipe: hasApprove, listUrl: !!listUrlFor(app) });
	return true;
}
