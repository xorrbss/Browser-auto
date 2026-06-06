// webui/routes-rpa.js — the 결재/RPA control-surface routes, split out of server.js to keep it under
// the 500-line invariant. PURE ROUTING: owns no logic — it delegates to agent.js (NL classify) +
// systems.js (registry) + the job queue, and receives the server's primitives via `deps`. Each
// handler returns true when it consumed the route (so server.js falls through to its other routes).

import { classifyIntent, runQuery, runRecordsQuery } from './agent.js';
import { validSysName, listSystemsView, getSystemView, saveSystem, removeSystem, recordsView, readProposed } from './systems.js';

// rpaPost(p, bodyJson, res, {sendJson, enqueue, gitBash}) -> handled? (async: /api/agent classifies)
export async function rpaPost(p, bodyJson, res, { sendJson, enqueue, gitBash }) {
	// 결재 동기화: bin/fetch-approvals.sh (login -> scrape inbox -> DB). Browser job -> serial queue.
	if (p === '/api/sync') {
		const app = bodyJson.app ? String(bodyJson.app).trim() : '';
		if (app && !validSysName(app)) { sendJson(res, 400, { error: 'invalid app name (use [A-Za-z0-9_-])' }); return true; }
		const job = enqueue({ kind: 'sync', label: app ? `sync ${app}` : 'sync approvals', spawnFn: () => gitBash('bin/fetch-approvals.sh', app ? ['--app', app] : []) });
		sendJson(res, 202, { job });
		return true;
	}

	// 자연어 명령 라우터: on-prem 모델은 분류만(실행 권한 없음). read는 인라인, browser intent는 직렬 큐.
	// approve는 후보 조회만(실행은 2단계). 모델 실패→clarify(행위 진행 안 함).
	if (p === '/api/agent') {
		const text = String(bodyJson.text || '').trim();
		if (!text) { sendJson(res, 400, { error: 'empty command' }); return true; }
		const intent = await classifyIntent(text);
		if (intent.action === 'sync') {
			const job = enqueue({ kind: 'sync', label: 'sync approvals (NL)', spawnFn: () => gitBash('bin/fetch-approvals.sh', []) });
			sendJson(res, 200, { intent, job });
			return true;
		}
		if (intent.action === 'summarize') {
			const args = intent.limit ? ['--limit', String(intent.limit)] : [];
			const job = enqueue({ kind: 'summarize', label: 'summarize (NL)', spawnFn: () => gitBash('bin/enrich-approvals.sh', args) });
			sendJson(res, 200, { intent, job });
			return true;
		}
		if (intent.action === 'query') { sendJson(res, 200, { intent, approvals: runQuery(intent.filter || {}), systems: runRecordsQuery(intent.filter || {}) }); return true; }
		if (intent.action === 'approve') { sendJson(res, 200, { intent, approvals: runQuery(intent.filter || {}), note: '승인 후보입니다. 실제 승인 실행은 아직 비활성(2단계, 항목별 사람 확인 후).' }); return true; }
		sendJson(res, 200, { intent });
		return true;
	}

	// --- Generic RPA system registry (register any data-collection system) ---
	if (p === '/api/systems') {
		const r = saveSystem({ name: String(bodyJson.name || '').trim(), label: bodyJson.label, login_url: bodyJson.login_url, success_url: bodyJson.success_url, target_url: bodyJson.target_url, recipe: bodyJson.recipe });
		r.ok ? sendJson(res, 200, r) : sendJson(res, 400, r);
		return true;
	}
	const mSys = /^\/api\/systems\/([^/]+)\/(auth|analyze|sync|enrich|delete)$/.exec(p);
	if (mSys) {
		let name; try { name = decodeURIComponent(mSys[1]); } catch { sendJson(res, 400, { error: 'bad name' }); return true; }
		if (!validSysName(name)) { sendJson(res, 400, { error: 'invalid system name' }); return true; }
		const action = mSys[2];
		if (action === 'delete') { sendJson(res, 200, removeSystem(name)); return true; }
		const sysv = getSystemView(name);
		if (!sysv) { sendJson(res, 404, { error: 'no such system' }); return true; }
		if (action === 'auth') {
			if (!sysv.login_url || !sysv.success_url) { sendJson(res, 400, { error: 'register login_url + success_url first' }); return true; }
			const job = enqueue({ kind: 'auth', label: `auth ${name}`, spawnFn: () => gitBash('setup/auth.sh', [name, sysv.login_url, sysv.success_url]) });
			sendJson(res, 202, { job });
			return true;
		}
		if (action === 'analyze') {
			const job = enqueue({ kind: 'analyze', label: `analyze ${name}`, spawnFn: () => gitBash('bin/analyze-system.sh', ['--system', name]) });
			sendJson(res, 202, { job });
			return true;
		}
		if (action === 'sync') {
			const job = enqueue({ kind: 'sync', label: `sync ${name}`, spawnFn: () => gitBash('bin/sync-system.sh', ['--system', name]) });
			sendJson(res, 202, { job });
			return true;
		}
		// enrich: per-record detail + on-prem summary onto records (bin/enrich-system.sh). Browser job.
		if (action === 'enrich') {
			const job = enqueue({ kind: 'summarize', label: `enrich ${name}`, spawnFn: () => gitBash('bin/enrich-system.sh', ['--system', name]) });
			sendJson(res, 202, { job });
			return true;
		}
		return true; // matched /api/systems/<name>/<action> but no branch fired — consumed
	}
	return false;
}

// rpaGet(p, url, res, {sendJson, notFound}) -> handled?
export function rpaGet(p, url, res, { sendJson, notFound }) {
	if (p === '/api/systems') { sendJson(res, 200, { systems: listSystemsView() }); return true; }
	const mSysRec = /^\/api\/systems\/([^/]+)\/records$/.exec(p);
	if (mSysRec) {
		let n; try { n = decodeURIComponent(mSysRec[1]); } catch { notFound(res); return true; }
		if (!validSysName(n)) { notFound(res); return true; }
		sendJson(res, 200, { records: recordsView(n, url.searchParams.get('q') || '') });
		return true;
	}
	const mSysProp = /^\/api\/systems\/([^/]+)\/proposed$/.exec(p);
	if (mSysProp) {
		let n; try { n = decodeURIComponent(mSysProp[1]); } catch { notFound(res); return true; }
		if (!validSysName(n)) { notFound(res); return true; }
		sendJson(res, 200, { proposed: readProposed(n) });
		return true;
	}
	return false;
}
