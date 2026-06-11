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
import { redactObject, redactText } from './redact.js';

// lib/db.js (CJS): the leaf binds approval to a per-doc TITLE re-verified on the live detail (content guard;
// red-team CRITICAL F1). The title source is REGISTRY-AWARE (P2): the legacy 결재 path reads the `approvals`
// table; a generic registered system reads its `records` table (the recipe-declared title field). A doc with
// no title in EITHER ⇒ refused (can't content-verify). The recipe stays a committed `recipes/<app>.json`
// file (the framework's existing per-system onboarding artifact) — generic vs 결재 differs only in the
// list-URL + title SOURCE, never in the leaf's guards.
const require = createRequire(import.meta.url);
const { openDb, closeDb, getApproval, getSystem, getRecord } = require('../lib/db.js');
const { resolveAuthStatePath, playwrightAuthRel } = require('../lib/engine.js');
import { resolveAction } from '../approve/guards.mjs'; // pure action selector (general-action-rpa Step B) — shared with the leaf
import { buildPreviewRecipe, listCaptureFlows, sweepOldPreviews, assembleActionBlock, enableActionInRecipe } from './capture.js'; // UI approve-capture (Gate-B) Phase 1a/1b/2

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const recipeFor = (app) => path.join(PROBE_ROOT, 'recipes', `${app}.json`);
const approveAuditPath = () => process.env.WEBUI_APPROVE_AUDIT_PATH || path.join(PROBE_ROOT, 'data', 'approve-audit.jsonl');
// Auth state is resolved through lib/engine.js: canonical fixtures/auth/playwright/<app>.state.json first,
// then the legacy approve/<app>.pw-state.json compat fallback — so a login from EITHER webui button
// (시스템 인증 or 결재 로그인) satisfies the approve pipeline.
const stateFor = (app) => resolveAuthStatePath(PROBE_ROOT, 'playwright', app);

function bumpCount(map, key) {
	const k = redactText(String(key || 'unknown').trim() || 'unknown', 'unknown', 120) || 'unknown';
	map[k] = (map[k] || 0) + 1;
}

function auditMode(entry) {
	if (entry.live === true || entry.dryRun === false) return 'live';
	if (entry.live === false || entry.dryRun === true) return 'dry-run';
	return String(entry.mode || 'unknown').trim() || 'unknown';
}

function auditStatus(entry) {
	if (entry.status) return entry.status;
	if (entry.outcome) return entry.outcome;
	if (entry.result && typeof entry.result === 'object' && entry.result.status) return entry.result.status;
	if (entry.ok === true) return 'ok';
	if (entry.ok === false) return 'failed';
	return 'recorded';
}

export function summarizeAuditEntries(entries, malformed = 0) {
	const byStage = {};
	const byMode = {};
	const byStatus = {};
	let latestAt = null;
	for (const entry of entries) {
		if (!entry || typeof entry !== 'object') continue;
		bumpCount(byStage, entry.stage);
		bumpCount(byMode, auditMode(entry));
		bumpCount(byStatus, auditStatus(entry));
		const at = redactText(String(entry.at || '').trim(), '', 120);
		if (at && (!latestAt || at > latestAt)) latestAt = at;
	}
	return {
		total: entries.length,
		malformed,
		latestAt,
		live: byMode.live || 0,
		dryRun: byMode['dry-run'] || 0,
		byStage,
		byMode,
		byStatus,
	};
}

// gwConfig(): parse data/approvals.config for the legacy 결재 inbox (GW_APP + GW_INBOX_URL) and the
// Playwright login coordinates (GW_LOGIN_URL + GW_SUCCESS_URL) used by the webui 결재-로그인 button.
function gwConfig() {
	try {
		const cfg = fs.readFileSync(path.join(PROBE_ROOT, 'data', 'approvals.config'), 'utf8');
		const app = (/^\s*GW_APP\s*=\s*"?([^"\n]+)"?/m.exec(cfg) || [])[1];
		const url = (/^\s*GW_INBOX_URL\s*=\s*"?([^"\n]+)"?/m.exec(cfg) || [])[1];
		const loginUrl = (/^\s*GW_LOGIN_URL\s*=\s*"?([^"\n]+)"?/m.exec(cfg) || [])[1];
		const successUrl = (/^\s*GW_SUCCESS_URL\s*=\s*"?([^"\n]+)"?/m.exec(cfg) || [])[1];
		return { app: app && app.trim(), url: url && url.trim(), loginUrl: loginUrl && loginUrl.trim(), successUrl: successUrl && successUrl.trim() };
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

// successNeedle(glob): auth-pw.mjs confirms login with page.url().includes(needle) — a SUBSTRING, not a glob.
// success_url is stored as a setup/auth.sh glob (e.g. "**/dashboard", "https://x/**"); strip the wildcard
// segments to the longest literal run so the substring match agrees with how the URL actually appears.
export function successNeedle(glob) {
	if (!glob) return '';
	const lits = String(glob).split(/\*+/).filter(Boolean);
	return lits.sort((a, b) => b.length - a.length)[0] || '';
}

// loginUrlFor(app): the Playwright headed-login coordinates the webui 결재-로그인 button spawns auth-pw.mjs
// with. REGISTRY-AWARE + fail-closed, mirroring listUrlFor:
//   • the legacy 결재 app (config GW_APP) → GW_LOGIN_URL / GW_SUCCESS_URL;
//   • a generic registered system → its registry login_url / success_url (same fields setup/auth.sh uses);
//   • neither / incomplete ⇒ null (the route refuses with a clear message).
export function loginUrlFor(app) {
	const cfg = gwConfig();
	if (app && app === cfg.app && cfg.loginUrl && cfg.successUrl) return { loginUrl: cfg.loginUrl, successUrl: cfg.successUrl };
	const db = openDb();
	try { const sys = getSystem(db, app); if (sys && sys.login_url && sys.success_url) return { loginUrl: String(sys.login_url).trim(), successUrl: String(sys.success_url).trim() }; }
	finally { closeDb(db); }
	return null;
}

// titlesFor(app, docs, titleField): per-doc content-binding title. Tries the `approvals` table (legacy 결재)
// THEN the registered system's `records` table (data[titleField]); null when absent in BOTH ⇒ the route
// refuses that doc (no content binding = no approve).
// db0: optional caller-owned handle to reuse (the caller closes it). When omitted, opens+closes its own.
// Lets a caller that already has a connection (e.g. buildTargetSet) avoid a second openDb per request.
export function titlesFor(app, docs, titleField = 'title', db0 = null) {
	const db = db0 || openDb();
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
	} finally { if (!db0) closeDb(db); }
}

// A doc_id is passed as ONE argv element (shell:false) and joined with commas for --docs, so the only
// hard constraint is: no comma / newline, non-empty, bounded length. (Hiworks ids contain Korean/()/-.)
const validDoc = (d) => typeof d === 'string' && d.length > 0 && d.length <= 100 && !/[,\n\r]/.test(d);

const stopPath = () => path.join(PROBE_ROOT, 'data', 'approve-STOP');

// _stageCapture(bodyJson, { live }): shared validation + staging for the capture dry-run (live:false) and the
// capture LIVE-VERIFY (live:true). Builds a NON-committed temp preview recipe (the committed one is untouched),
// the targets file (content-binding title required), and the leaf args. live:true adds --live --max 1 (single
// doc, blast-radius capped) — the operator's conscious live test on a DISPOSABLE doc. Returns { ok, args,
// startedAt, label } or { ok:false, code?, error }.
function _stageCapture(bodyJson, { live }) {
	const app = String(bodyJson.app || '').trim();
	if (!NAME_RE.test(app)) return { ok: false, error: 'invalid app name' };
	const action = String(bodyJson.action || 'approve').trim();
	if (!NAME_RE.test(action)) return { ok: false, error: 'invalid action name' };
	const docId = String(bodyJson.docId || '').trim();
	if (!validDoc(docId)) return { ok: false, error: 'docId: a non-empty string ≤100 chars, no comma/newline' };
	if (!fs.existsSync(recipeFor(app))) return { ok: false, error: `no recipe recipes/${app}.json` };
	let recipeObj;
	try { recipeObj = JSON.parse(fs.readFileSync(recipeFor(app), 'utf8')); } catch { return { ok: false, error: `recipe ${app} unreadable` }; }
	const block = bodyJson.block && typeof bodyJson.block === 'object' && !Array.isArray(bodyJson.block) ? bodyJson.block : null;
	const preview = buildPreviewRecipe(recipeObj, action, block);
	if (!preview) return { ok: false, error: `no action "${action}" to test — provide a block or capture it first` };
	if (!fs.existsSync(stateFor(app))) return { ok: false, error: `no Playwright login for '${app}' — capture/login first` };
	const listUrl = listUrlFor(app);
	if (!listUrl) return { ok: false, error: 'no 대기 list URL (set GW_INBOX_URL in data/approvals.config)' };
	const titleField = (preview.actions[action] && preview.actions[action].titleField) || 'title';
	const title = typeof bodyJson.title === 'string' && bodyJson.title.trim() ? bodyJson.title.trim() : (titlesFor(app, [docId], titleField)[docId] || null);
	if (!title) return { ok: false, error: '문서 제목(title)이 필요합니다 — 먼저 동기화하거나 title을 직접 입력하세요(콘텐츠 바인딩 가드).' };
	sweepOldPreviews(PROBE_ROOT);
	const previewFile = path.join(PROBE_ROOT, 'data', `.capture-preview-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
	const targetsFile = path.join(PROBE_ROOT, 'data', `.approve-targets-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
	try {
		fs.mkdirSync(path.dirname(previewFile), { recursive: true });
		fs.writeFileSync(previewFile, JSON.stringify(preview), { mode: 0o600 });
		fs.writeFileSync(targetsFile, JSON.stringify([{ doc_id: docId, title }]), { mode: 0o600 });
	} catch (e) { return { ok: false, code: 500, error: 'could not stage capture: ' + (e && e.message) }; }
	const args = ['--recipe', path.relative(PROBE_ROOT, previewFile), '--state', stateFor(app), '--list-url', listUrl, '--targets-file', targetsFile];
	if (live) args.push('--live', '--max', '1'); // single doc, capped — the operator's live test on a disposable doc
	if (action !== 'approve') args.push('--action', action);
	return { ok: true, args, startedAt: new Date().toISOString(), label: `CAPTURE ${live ? 'LIVE-VERIFY' : 'dry-run'} ${action} ${app} (${docId})` };
}

// approvePost(p, bodyJson, res, { sendJson, enqueue, nodeLeaf, gitBash }) -> handled?
export function approvePost(p, bodyJson, res, { sendJson, enqueue, nodeLeaf, gitBash }) {
	// KILL-SWITCH: write data/approve-STOP — a running approve leaf stops BEFORE its next doc (red-team
	// F-KILLSWITCH-UNWIRED). Each new run clears it at the leaf's startup, so this only halts the live batch.
	if (p === '/api/approve/stop') {
		try { fs.mkdirSync(path.dirname(stopPath()), { recursive: true }); fs.writeFileSync(stopPath(), String(new Date().toISOString())); sendJson(res, 200, { ok: true, stopped: true }); }
		catch (e) { sendJson(res, 500, { error: 'could not write kill-switch: ' + (e && e.message) }); }
		return true;
	}
	// 결재 로그인 (Playwright): spawn the headed one-time login from the webui instead of
	// the terminal — closes the last CLI step in the operator flow. A real Chrome window opens on the operator's
	// desktop for ID/비번/OTP entry (that human gesture is irreducible — credentials are NOT typed into the webui);
	// setup/auth.sh saves the state to local pilot storage or imports it into the configured secret backend.
	// login_url/success_url come from the registry (generic) or approvals.config (결재).
	if (p === '/api/approve/login') {
		const app = String(bodyJson.app || '').trim();
		if (!NAME_RE.test(app)) { sendJson(res, 400, { error: 'invalid app name' }); return true; }
		const coords = loginUrlFor(app);
		if (!coords) { sendJson(res, 400, { error: `no login URL for '${app}' — register login_url + success_url (generic system) or set GW_LOGIN_URL + GW_SUCCESS_URL in data/approvals.config (결재).` }); return true; }
		const needle = successNeedle(coords.successUrl);
		if (!needle) { sendJson(res, 400, { error: `success URL for '${app}' has no literal segment to match on` }); return true; }
		const outFile = playwrightAuthRel(app);
		const spawnFn = gitBash
			? () => gitBash('setup/auth.sh', [app, coords.loginUrl, coords.successUrl])
			: () => nodeLeaf('approve/auth-pw.mjs', [coords.loginUrl, needle, outFile]);
		const job = enqueue({ kind: 'auth', label: `결재 로그인 ${app} (Playwright)`, spawnFn });
		sendJson(res, 202, { job });
		return true;
	}
	// CAPTURE ASSEMBLE (Gate-B UI, Phase 1b): turn a RECORDED approve flow (flows/<flowName>.flow.json, recorded
	// via the 플로우 tab on a disposable doc) + operator checklist `facts` into a recipe.actions.<form> block
	// (enabled:false, fail-closed). PURE assembly (no model); returns the block for the operator to review +
	// dry-run-test (Phase 1a). Does NOT write the recipe (that is Phase 2 / enable).
	if (p === '/api/approve/capture/assemble') {
		const app = String(bodyJson.app || '').trim();
		if (!NAME_RE.test(app)) { sendJson(res, 400, { error: 'invalid app name' }); return true; }
		const flowName = String(bodyJson.flowName || '').trim();
		if (!NAME_RE.test(flowName)) { sendJson(res, 400, { error: 'invalid flow name (use [A-Za-z0-9_-])' }); return true; }
		const flowPath = path.join(PROBE_ROOT, 'flows', `${flowName}.flow.json`);
		let flow;
		try { flow = JSON.parse(fs.readFileSync(flowPath, 'utf8')); } catch { sendJson(res, 400, { error: `no/unreadable flow flows/${flowName}.flow.json — record it on a disposable doc in the 플로우 tab first` }); return true; }
		const f = bodyJson.facts && typeof bodyJson.facts === 'object' ? bodyJson.facts : {};
		const facts = { confirmName: f.confirmName, openBy: f.openBy, formType: f.formType, amountLabel: f.amountLabel, opinionText: f.opinionText, success: f.success, titleField: f.titleField, idLabelExactlyOne: f.idLabelExactlyOne };
		const r = assembleActionBlock(flow, facts);
		if (!r.ok) { sendJson(res, 400, { error: r.error, missing: r.missing }); return true; }
		sendJson(res, 200, { block: r.block });
		return true;
	}
	// CAPTURE DRY-RUN (Gate-B UI, Phase 1a): test an action's locators on a disposable doc + show per-guard
	// results — NEVER approves (no --live). Tests a recipe's existing action OR an operator-supplied `block`
	// via a NON-committed temp preview recipe; the committed recipe is untouched.
	if (p === '/api/approve/capture/dry-run') {
		const r = _stageCapture(bodyJson, { live: false });
		if (!r.ok) { sendJson(res, r.code || 400, { error: r.error }); return true; }
		const job = enqueue({ kind: 'approve', label: r.label, spawnFn: () => nodeLeaf('approve/approve-run.mjs', r.args) });
		sendJson(res, 202, { job, dryRun: true, docId: String(bodyJson.docId || '').trim(), startedAt: r.startedAt });
		return true;
	}
	// CAPTURE LIVE-VERIFY (Gate-B UI, Phase 2): the SINGLE real 확인 on a DISPOSABLE doc, to confirm the captured
	// action's completion marker BEFORE enabling it. ACTUALLY APPROVES (--live --max 1) ⇒ requires an explicit
	// confirm:true (the operator's conscious live test; disposable docs ONLY, irreversible). Same preview block.
	if (p === '/api/approve/capture/verify') {
		if (bodyJson.confirm !== true) { sendJson(res, 400, { error: '라이브 검증(실제 확인 클릭)에는 confirm:true가 필요합니다 — 반드시 폐기용 문서에서만(되돌릴 수 없음).' }); return true; }
		const r = _stageCapture(bodyJson, { live: true });
		if (!r.ok) { sendJson(res, r.code || 400, { error: r.error }); return true; }
		try { fs.rmSync(stopPath(), { force: true }); } catch {} // the leaf refuses to start while STOP exists
		const job = enqueue({ kind: 'approve', label: r.label, spawnFn: () => nodeLeaf('approve/approve-run.mjs', r.args) });
		sendJson(res, 202, { job, dryRun: false, live: true, docId: String(bodyJson.docId || '').trim(), startedAt: r.startedAt });
		return true;
	}
	// CAPTURE ENABLE (Gate-B UI, Phase 2): atomically write the captured block into the committed recipe with
	// enabled:true + capture metadata — the action becomes usable for batch approve. The OPERATOR is the
	// irreducible gate: requires confirmed:true (they watched the live-verify succeed). NEVER auto-enabled.
	if (p === '/api/approve/capture/enable') {
		const app = String(bodyJson.app || '').trim();
		if (!NAME_RE.test(app)) { sendJson(res, 400, { error: 'invalid app name' }); return true; }
		const action = String(bodyJson.action || '').trim();
		if (!NAME_RE.test(action)) { sendJson(res, 400, { error: 'invalid action name' }); return true; }
		if (bodyJson.confirmed !== true) { sendJson(res, 400, { error: '활성화하려면 라이브 검증을 직접 확인했다는 confirmed:true가 필요합니다(운영자 서명) — 미검증 action을 켜지 않습니다.' }); return true; }
		const block = bodyJson.block && typeof bodyJson.block === 'object' && !Array.isArray(bodyJson.block) ? bodyJson.block : null;
		if (!block) { sendJson(res, 400, { error: 'block (조립된 action 블록)이 필요합니다.' }); return true; }
		if (!fs.existsSync(recipeFor(app))) { sendJson(res, 400, { error: `no recipe recipes/${app}.json` }); return true; }
		let recipeObj;
		try { recipeObj = JSON.parse(fs.readFileSync(recipeFor(app), 'utf8')); } catch { sendJson(res, 400, { error: `recipe ${app} unreadable` }); return true; }
		const meta = { date: new Date().toISOString(), by: process.env.USERNAME || process.env.USER || null, notes: String(bodyJson.notes || '').slice(0, 500) };
		const r = enableActionInRecipe(recipeObj, action, block, meta);
		if (!r.ok) { sendJson(res, 400, { error: r.error }); return true; }
		try {
			const tmp = `${recipeFor(app)}.tmp-${Date.now()}`;
			fs.writeFileSync(tmp, JSON.stringify(r.recipe, null, 2) + '\n', { mode: 0o644 });
			fs.renameSync(tmp, recipeFor(app)); // atomic replace
		} catch (e) { sendJson(res, 500, { error: 'could not write recipe: ' + (e && e.message) }); return true; }
		try { fs.appendFileSync(approveAuditPath(), JSON.stringify({ at: meta.date, doc_id: '-', stage: 'capture-enabled', action, by: meta.by }) + '\n'); } catch {}
		sendJson(res, 200, { ok: true, action, enabled: true });
		return true;
	}
	if (p !== '/api/approve/run') return false;
	const app = String(bodyJson.app || '').trim();
	if (!NAME_RE.test(app)) { sendJson(res, 400, { error: 'invalid app name' }); return true; }
	// which effectful action (default 'approve' — the reference action; Step B). A disabled/uncaptured action
	// is refused below by resolveAction (fail-closed). The model never picks an arbitrary action here.
	const action = String(bodyJson.action || 'approve').trim();
	if (!NAME_RE.test(action)) { sendJson(res, 400, { error: 'invalid action name' }); return true; }
	if (!fs.existsSync(recipeFor(app))) { sendJson(res, 400, { error: `no recipe recipes/${app}.json — onboard this system's approve recipe first` }); return true; }
	// The recipe must have an approve block (else the leaf refuses) — fail fast with a clear message.
	let recipeObj;
	try { recipeObj = JSON.parse(fs.readFileSync(recipeFor(app), 'utf8')); }
	catch { sendJson(res, 400, { error: `recipe ${app} unreadable` }); return true; }
	const av = resolveAction(recipeObj, action); // canonical actions.<action> | legacy approve; fail-closed on missing/disabled
	if (!av.ok) { sendJson(res, 400, { error: `recipe ${app}: ${av.reason}` }); return true; }
	const titleField = av.action.titleField || 'title'; // generic systems: the records field used for the content-binding title
	if (!fs.existsSync(stateFor(app))) { sendJson(res, 400, { error: `no Playwright login for '${app}' — use the 결재 로그인/인증 button or run setup/auth.sh (saves fixtures/auth/playwright/${app}.state.json)` }); return true; }
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

	const args = ['--recipe', `recipes/${app}.json`, '--state', stateFor(app), '--list-url', listUrl, '--targets-file', targetsFile];
	if (!dryRun) args.push('--live', '--max', String(max));
	if (maxAmount) args.push('--max-amount', String(maxAmount));
	if (reviewed) args.push('--reviewed'); // human-reviewed batch: leaf relaxes form-homogeneity (mixed forms are the human's choice)
	if (action !== 'approve') args.push('--action', action); // approve = the default; only non-approve actions pass --action (approve invocation byte-identical)

	// An explicit new run clears any kill-switch (halt) — the leaf REFUSES to start while STOP exists, so the
	// route owns the clear; a queued batch never self-clears (red-team KILLSWITCH-QUEUED).
	try { fs.rmSync(stopPath(), { force: true }); } catch {}
	const label = `${dryRun ? 'DRY' : 'LIVE'} ${reviewed ? '검토' : 'AUTO'}-${action} ${app} (${docs.length}건${!dryRun ? `, max ${max}` : ''}${maxAmount ? `, ≤${maxAmount}원` : ''})`;
	const job = enqueue({ kind: 'approve', label, spawnFn: () => nodeLeaf('approve/approve-run.mjs', args) });
	sendJson(res, 202, { job, dryRun, docs: docs.length });
	return true;
}

// approveGet(p, url, res, { sendJson }) -> handled? Read-only status + the append-only audit viewer.
export function approveGet(p, url, res, { sendJson }) {
	// Audit viewer: the append-only JSONL trail (data/approve-audit.jsonl) the leaf fsyncs every stage to —
	// the source of truth for what was requested/clicked/confirmed/skipped/reconciled. Newest first.
	if (p === '/api/approve/audit') {
		const file = approveAuditPath();
		const entries = [];
		let malformed = 0;
		try { for (const line of fs.readFileSync(file, 'utf8').split('\n')) { if (!line.trim()) continue; try { entries.push(JSON.parse(line)); } catch { malformed++; /* skip a torn/partial line */ } } }
		catch { /* no audit yet */ }
		const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 300, 1000);
		sendJson(res, 200, {
			audit: entries.slice(-limit).reverse().map((entry) => redactObject(entry)),
			total: entries.length,
			summary: summarizeAuditEntries(entries, malformed),
			redaction: 'applied',
			redactionPolicy: { applied: true, helper: 'webui/redact.js', rawExport: 'blocked' },
		});
		return true;
	}
	// CAPTURE flows list (Gate-B UI): the recorded approve flows for an app (read-only; Phase 1b consumes them).
	if (p === '/api/approve/capture/flows') {
		const app = (url.searchParams.get('app') || '').trim();
		if (!NAME_RE.test(app)) { sendJson(res, 400, { error: 'invalid app name' }); return true; }
		sendJson(res, 200, { flows: listCaptureFlows(PROBE_ROOT, app) });
		return true;
	}
	if (p !== '/api/approve/state') return false;
	const app = (url.searchParams.get('app') || '').trim();
	const ok = NAME_RE.test(app) && fs.existsSync(stateFor(app)) && fs.existsSync(recipeFor(app));
	let hasApprove = false;
	try { const rc = JSON.parse(fs.readFileSync(recipeFor(app), 'utf8')); hasApprove = ok && !!((rc.actions && rc.actions.approve) || rc.approve); } catch {}
	sendJson(res, 200, { app, loggedIn: NAME_RE.test(app) && fs.existsSync(stateFor(app)), hasApproveRecipe: hasApprove, listUrl: !!listUrlFor(app) });
	return true;
}
