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
import { createRequire } from 'node:module';
import { PROBE_ROOT } from './spawn.js';

// lib/db.js (CJS) for the synced approval TITLE per doc_id — the leaf binds approval to that title
// (content guard; red-team CRITICAL F1). A doc not in the DB cannot be content-verified ⇒ refused.
const require = createRequire(import.meta.url);
const { openDb, closeDb, getApproval } = require('../lib/db.js');
function titlesFor(docs) {
	const db = openDb();
	try { const m = {}; for (const d of docs) { const row = getApproval(db, d); m[d] = row && row.title != null ? String(row.title) : null; } return m; }
	finally { closeDb(db); }
}

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

const stopPath = () => path.join(PROBE_ROOT, 'data', 'approve-STOP');

// approvePost(p, bodyJson, res, { sendJson, enqueue, nodeLeaf }) -> handled?
export function approvePost(p, bodyJson, res, { sendJson, enqueue, nodeLeaf }) {
	// KILL-SWITCH: write data/approve-STOP — a running approve leaf stops BEFORE its next doc (red-team
	// F-KILLSWITCH-UNWIRED). Each new run clears it at the leaf's startup, so this only halts the live batch.
	if (p === '/api/approve/stop') {
		try { fs.mkdirSync(path.dirname(stopPath()), { recursive: true }); fs.writeFileSync(stopPath(), String(new Date().toISOString())); sendJson(res, 200, { ok: true, stopped: true }); }
		catch (e) { sendJson(res, 500, { error: 'could not write kill-switch: ' + (e && e.message) }); }
		return true;
	}
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
	const dryRun = bodyJson.dryRun !== false; // DEFAULT DRY-RUN — live needs an explicit dryRun:false
	let max = parseInt(bodyJson.max, 10); if (!Number.isFinite(max) || max < 0) max = 0;
	let maxAmount = parseInt(bodyJson.maxAmount, 10); if (!Number.isFinite(maxAmount) || maxAmount < 0) maxAmount = 0;
	// LIVE requires a positive count cap (fail-closed; red-team F5/F2).
	if (!dryRun && max <= 0) { sendJson(res, 400, { error: '실제 승인(dryRun:false)에는 최대 건수(max ≥ 1)가 필요합니다 — blast-radius 제한.' }); return true; }
	// LIVE requires a per-doc VALUE ceiling (maxAmount) OR an explicit owner opt-out — no silent
	// unbounded-value auto-approve (red-team v2 AMT-CEILING-EVADE / F-AMOUNT-UNBOUND).
	if (!dryRun && maxAmount <= 0 && bodyJson.allowNoValueCeiling !== true) {
		sendJson(res, 400, { error: '실제 승인엔 건당 최대 금액(maxAmount ≥ 1)이 필요합니다. 금액 상한 없이 진행하려면 allowNoValueCeiling:true를 명시하세요(무한 금액 자동 승인 — 소유자 책임).' });
		return true;
	}
	// CONTENT BINDING (red-team CRITICAL F1): every doc must have a synced TITLE the leaf re-verifies on
	// the live detail. A doc not in the approvals DB cannot be content-verified ⇒ refuse.
	const titles = titlesFor(docs);
	const unsynced = docs.filter((d) => !titles[d]);
	if (unsynced.length) { sendJson(res, 400, { error: `동기화되지 않은 문서(제목 확인 불가) — 먼저 동기화하세요: ${unsynced.slice(0, 5).join(', ')}${unsynced.length > 5 ? '…' : ''}` }); return true; }
	const targets = docs.map((d) => ({ doc_id: d, title: titles[d], ...(maxAmount ? { maxAmount } : {}) }));
	// targets -> a 0600 single-use file in data/ (gitignored); the leaf consumes + deletes it (Korean/size-safe vs argv).
	const targetsFile = path.join(PROBE_ROOT, 'data', `.approve-targets-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
	try { fs.mkdirSync(path.dirname(targetsFile), { recursive: true }); fs.writeFileSync(targetsFile, JSON.stringify(targets), { mode: 0o600 }); }
	catch (e) { sendJson(res, 500, { error: 'could not stage targets: ' + (e && e.message) }); return true; }

	const args = ['--recipe', `recipes/${app}.json`, '--state', `approve/${app}.pw-state.json`, '--list-url', listUrl, '--targets-file', targetsFile];
	if (!dryRun) args.push('--live', '--max', String(max));
	if (maxAmount) args.push('--max-amount', String(maxAmount));

	const label = `${dryRun ? 'DRY approve' : 'AUTO-APPROVE'} ${app} (${docs.length}건${!dryRun ? `, max ${max}` : ''}${maxAmount ? `, ≤${maxAmount}원` : ''})`;
	const job = enqueue({ kind: 'approve', label, spawnFn: () => nodeLeaf('approve/approve-run.mjs', args) });
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
