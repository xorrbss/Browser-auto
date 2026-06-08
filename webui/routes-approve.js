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

// lib/db.js (CJS): the leaf binds approval to a per-doc TITLE re-verified on the live detail (content guard;
// red-team CRITICAL F1). The title source is REGISTRY-AWARE (P2): the legacy 결재 path reads the `approvals`
// table; a generic registered system reads its `records` table (the recipe-declared title field). A doc with
// no title in EITHER ⇒ refused (can't content-verify). The recipe stays a committed `recipes/<app>.json`
// file (the framework's existing per-system onboarding artifact) — generic vs 결재 differs only in the
// list-URL + title SOURCE, never in the leaf's guards.
const require = createRequire(import.meta.url);
const { openDb, closeDb, getApproval, getSystem, getRecord } = require('../lib/db.js');

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const recipeFor = (app) => path.join(PROBE_ROOT, 'recipes', `${app}.json`);
const stateFor = (app) => path.join(PROBE_ROOT, 'approve', `${app}.pw-state.json`);

// gwConfig(): parse data/approvals.config for the legacy 결재 inbox (GW_APP + GW_INBOX_URL).
function gwConfig() {
	try {
		const cfg = fs.readFileSync(path.join(PROBE_ROOT, 'data', 'approvals.config'), 'utf8');
		const app = (/^\s*GW_APP\s*=\s*"?([^"\n]+)"?/m.exec(cfg) || [])[1];
		const url = (/^\s*GW_INBOX_URL\s*=\s*"?([^"\n]+)"?/m.exec(cfg) || [])[1];
		return { app: app && app.trim(), url: url && url.trim() };
	} catch { return {}; }
}

// listUrlFor(app): the pending-list URL the leaf scans. REGISTRY-AWARE + fail-closed:
//   • the legacy 결재 app (config GW_APP) → GW_INBOX_URL (hiworks 대기 inbox — UNCHANGED / exact);
//   • a generic registered system → its registry target_url (its list page);
//   • neither ⇒ '' (the route refuses).
export function listUrlFor(app) {
	const cfg = gwConfig();
	if (app && app === cfg.app && cfg.url) return cfg.url; // legacy 결재 (hiworks) — exact, regression-preserved
	const db = openDb();
	try { const sys = getSystem(db, app); if (sys && sys.target_url) return String(sys.target_url).trim(); }
	finally { closeDb(db); }
	if (!cfg.app && cfg.url) return cfg.url; // back-compat: a bare GW_INBOX_URL config with no GW_APP set
	return '';
}

// titlesFor(app, docs, titleField): per-doc content-binding title. Tries the `approvals` table (legacy 결재)
// THEN the registered system's `records` table (data[titleField]); null when absent in BOTH ⇒ the route
// refuses that doc (no content binding = no approve).
export function titlesFor(app, docs, titleField = 'title') {
	const db = openDb();
	try {
		const m = {};
		for (const d of docs) {
			const ap = getApproval(db, d);
			if (ap && ap.title != null && String(ap.title).trim()) { m[d] = String(ap.title); continue; }
			const rec = getRecord(db, app, d);
			const t = rec && rec.data ? rec.data[titleField] : null;
			m[d] = t != null && String(t).trim() ? String(t) : null;
		}
		return m;
	} finally { closeDb(db); }
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
	if (!fs.existsSync(recipeFor(app))) { sendJson(res, 400, { error: `no recipe recipes/${app}.json — onboard this system's approve recipe first` }); return true; }
	// The recipe must have an approve block (else the leaf refuses) — fail fast with a clear message.
	let recipeObj;
	try { recipeObj = JSON.parse(fs.readFileSync(recipeFor(app), 'utf8')); }
	catch { sendJson(res, 400, { error: `recipe ${app} unreadable` }); return true; }
	if (!recipeObj.approve) { sendJson(res, 400, { error: `recipe ${app} has no "approve" block — capture this system's approve UI (Gate-B) first` }); return true; }
	const titleField = recipeObj.approve.titleField || 'title'; // generic systems: the records field used for the content-binding title
	if (!fs.existsSync(stateFor(app))) { sendJson(res, 400, { error: `no Playwright login for '${app}' — run: node approve/auth-pw.mjs … approve/${app}.pw-state.json` }); return true; }
	const listUrl = listUrlFor(app);
	if (!listUrl) { sendJson(res, 400, { error: 'no 대기 list URL (set GW_INBOX_URL in data/approvals.config)' }); return true; }

	const docs = Array.isArray(bodyJson.docs) ? bodyJson.docs : [];
	if (!docs.length) { sendJson(res, 400, { error: 'docs: a non-empty array of doc_ids is required' }); return true; }
	if (!docs.every(validDoc)) { sendJson(res, 400, { error: 'docs: each must be a non-empty string ≤100 chars with no comma/newline' }); return true; }
	const dryRun = bodyJson.dryRun !== false; // DEFAULT DRY-RUN — live needs an explicit dryRun:false
	// REVIEWED batch: the operator read each doc's summary on the webui review screen and CHECKED the ones to
	// approve, so the human is the content/amount control (the 총 금액/총 합 계 label is drafter-TYPED → unreliable
	// for an automated ceiling). Drops the value-ceiling requirement; the count cap is the number of checked items.
	const reviewed = bodyJson.reviewed === true;
	let max = parseInt(bodyJson.max, 10); if (!Number.isFinite(max) || max < 0) max = 0;
	let maxAmount = parseInt(bodyJson.maxAmount, 10); if (!Number.isFinite(maxAmount) || maxAmount < 0) maxAmount = 0;
	if (!dryRun && reviewed && max <= 0) max = docs.length; // reviewed: the checked-item count IS the blast-radius cap
	// LIVE requires a positive count cap (fail-closed; red-team F5/F2).
	if (!dryRun && max <= 0) { sendJson(res, 400, { error: '실제 승인(dryRun:false)에는 최대 건수(max ≥ 1)가 필요합니다 — blast-radius 제한.' }); return true; }
	// TYPED (full-auto) LIVE requires a per-doc VALUE ceiling (maxAmount) OR an explicit owner opt-out — no
	// silent unbounded-value auto-approve (red-team v2 AMT-CEILING-EVADE). REVIEWED mode is exempt: the human
	// reviewed each summary, which is a STRONGER control than a (drafter-typed-label) amount heuristic.
	if (!dryRun && !reviewed && maxAmount <= 0 && bodyJson.allowNoValueCeiling !== true) {
		sendJson(res, 400, { error: '실제 승인엔 건당 최대 금액(maxAmount ≥ 1)이 필요합니다. 금액 상한 없이 진행하려면 allowNoValueCeiling:true를 명시하세요(무한 금액 자동 승인 — 소유자 책임).' });
		return true;
	}
	// CONTENT BINDING (red-team CRITICAL F1): every doc must have a synced TITLE the leaf re-verifies on
	// the live detail. A doc not in the approvals DB cannot be content-verified ⇒ refuse.
	const titles = titlesFor(app, docs, titleField);
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
	if (reviewed) args.push('--reviewed'); // human-reviewed batch: leaf relaxes form-homogeneity (mixed forms are the human's choice)

	// An explicit new run clears any kill-switch (halt) — the leaf REFUSES to start while STOP exists, so the
	// route owns the clear; a queued batch never self-clears (red-team KILLSWITCH-QUEUED).
	try { fs.rmSync(stopPath(), { force: true }); } catch {}
	const label = `${dryRun ? 'DRY' : 'LIVE'} ${reviewed ? '검토-결재' : 'AUTO-APPROVE'} ${app} (${docs.length}건${!dryRun ? `, max ${max}` : ''}${maxAmount ? `, ≤${maxAmount}원` : ''})`;
	const job = enqueue({ kind: 'approve', label, spawnFn: () => nodeLeaf('approve/approve-run.mjs', args) });
	sendJson(res, 202, { job, dryRun, docs: docs.length });
	return true;
}

// approveGet(p, url, res, { sendJson }) -> handled? Read-only status + the append-only audit viewer.
export function approveGet(p, url, res, { sendJson }) {
	// Audit viewer: the append-only JSONL trail (data/approve-audit.jsonl) the leaf fsyncs every stage to —
	// the source of truth for what was requested/clicked/confirmed/skipped/reconciled. Newest first.
	if (p === '/api/approve/audit') {
		const file = path.join(PROBE_ROOT, 'data', 'approve-audit.jsonl');
		const entries = [];
		try { for (const line of fs.readFileSync(file, 'utf8').split('\n')) { if (!line.trim()) continue; try { entries.push(JSON.parse(line)); } catch { /* skip a torn/partial line */ } } }
		catch { /* no audit yet */ }
		const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 300, 1000);
		sendJson(res, 200, { audit: entries.slice(-limit).reverse(), total: entries.length });
		return true;
	}
	if (p !== '/api/approve/state') return false;
	const app = (url.searchParams.get('app') || '').trim();
	const ok = NAME_RE.test(app) && fs.existsSync(stateFor(app)) && fs.existsSync(recipeFor(app));
	let hasApprove = false;
	try { hasApprove = ok && !!JSON.parse(fs.readFileSync(recipeFor(app), 'utf8')).approve; } catch {}
	sendJson(res, 200, { app, loggedIn: NAME_RE.test(app) && fs.existsSync(stateFor(app)), hasApproveRecipe: hasApprove, listUrl: !!listUrlFor(app) });
	return true;
}
