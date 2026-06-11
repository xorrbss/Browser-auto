// webui/routes-rpa.js — the 결재/RPA control-surface routes, split out of server.js to keep it under
// the 500-line invariant. PURE ROUTING: owns no logic — it delegates to agent.js (NL classify) +
// systems.js (registry) + the job queue, and receives the server's primitives via `deps`. Each
// handler returns true when it consumed the route (so server.js falls through to its other routes).

import { classifyIntent, runQuery } from './agent.js';
import { validSysName, listSystemsView, getSystemView, saveSystem, removeSystem, recordsView, readProposed, systemState, systemActions, allActionsView, systemEgressGate } from './systems.js';

function childEnvForContext(context) {
	const tenantId = String(context?.tenantId || context?.tenant?.id || context?.actor?.tenantId || '').trim();
	const actorId = String(context?.actor?.id || context?.actorId || '').trim();
	const env = {};
	if (tenantId) {
		env.AQA_TENANT_ID = tenantId;
		env.WEBUI_TENANT_ID = tenantId;
	}
	if (actorId) {
		env.AQA_ACTOR_ID = actorId;
		env.WEBUI_ACTOR_ID = actorId;
	}
	return Object.keys(env).length ? env : null;
}

function runScopedRecordsQuery(filter = {}, context = null) {
	const kw = filter.keyword || filter.dept || filter.drafter || '';
	return listSystemsView(context).map((s) => {
		const records = recordsView(s.name, kw || '', context).slice(0, Number.isInteger(filter.limit) ? filter.limit : 200);
		return records.length ? { system: s.name, label: s.label || s.name, records } : null;
	}).filter(Boolean);
}

// rpaPost(p, bodyJson, res, {sendJson, enqueue, authSpawn, nodeLeaf, context}) -> handled? (async: /api/agent classifies)
export async function rpaPost(p, bodyJson, res, deps) {
	const { sendJson, enqueue, authSpawn, nodeLeaf, context } = deps;
	const childEnv = childEnvForContext(context);
	if (p === '/api/sync') {
		sendJson(res, 410, { error: 'legacy approvals sync was removed; register a Playwright system and use /api/systems/:name/sync.' });
		return true;
	}

	// 자연어 명령 라우터: on-prem 모델은 분류만(실행 권한 없음). read는 인라인, browser intent는 직렬 큐.
	// approve는 후보 조회만(실행은 2단계). 모델 실패→clarify(행위 진행 안 함).
		if (p === '/api/agent') {
		const text = String(bodyJson.text || '').trim();
		if (!text) { sendJson(res, 400, { error: 'empty command' }); return true; }
			const intent = await classifyIntent(text);
			if (intent.action === 'sync') {
				sendJson(res, 410, { intent, error: 'legacy approvals sync was removed; use a registered Playwright system sync.' });
				return true;
			}
			if (intent.action === 'summarize') {
				sendJson(res, 410, { intent, error: 'legacy approvals enrichment was removed; use a registered Playwright system enrich.' });
				return true;
			}
		if (intent.action === 'query') { sendJson(res, 200, { intent, approvals: runQuery(intent.filter || {}), systems: runScopedRecordsQuery(intent.filter || {}, context) }); return true; }
		if (intent.action === 'approve') { sendJson(res, 200, { intent, approvals: runQuery(intent.filter || {}), note: '승인 후보입니다. 실제 승인 실행은 아직 비활성(2단계, 항목별 사람 확인 후).' }); return true; }
		// review = PREPARE the human checkbox-review surface: optionally summarize (read/on-prem), then the UI
		// shows the 결재 checkbox review. NEVER approves — the model has NO path to the approve route; the human
		// checks the items and clicks 선택 항목 결재 (that separate route is the only approve execution).
			if (intent.action === 'review') {
				const resp = { intent, surface: 'approvals-review' };
				if (intent.summarize) resp.error = 'legacy approvals enrichment was removed; use a registered Playwright system enrich.';
				sendJson(res, 200, resp);
				return true;
			}
		sendJson(res, 200, { intent });
		return true;
	}

	// --- Generic RPA system registry (register any data-collection system) ---
	if (p === '/api/systems') {
		if (bodyJson.engine && bodyJson.engine !== 'playwright') {
			sendJson(res, 400, { error: 'system.engine: WebUI is Playwright-only' });
			return true;
		}
		const r = saveSystem({
			name: String(bodyJson.name || '').trim(),
			label: bodyJson.label,
			engine: 'playwright',
			login_url: bodyJson.login_url,
			success_url: bodyJson.success_url,
			target_url: bodyJson.target_url,
			recipe: bodyJson.recipe,
			egress: bodyJson.egress,
			egressProfile: bodyJson.egressProfile,
			egressAllowlist: bodyJson.egressAllowlist,
			targetAllowlist: bodyJson.targetAllowlist,
			allowedOrigins: bodyJson.allowedOrigins,
			resolvedHosts: bodyJson.resolvedHosts,
			resolvedIps: bodyJson.resolvedIps,
			resolvedIpMap: bodyJson.resolvedIpMap,
			requireResolvedIps: bodyJson.requireResolvedIps,
		}, context);
		r.ok ? sendJson(res, 200, r) : sendJson(res, 400, r);
		return true;
	}
	const mSys = /^\/api\/systems\/([^/]+)\/(auth|analyze|sync|enrich|delete)$/.exec(p);
	if (mSys) {
		let name; try { name = decodeURIComponent(mSys[1]); } catch { sendJson(res, 400, { error: 'bad name' }); return true; }
		if (!validSysName(name)) { sendJson(res, 400, { error: 'invalid system name' }); return true; }
		const action = mSys[2];
		if (action === 'delete') { sendJson(res, 200, removeSystem(name, context)); return true; }
		const sysv = getSystemView(name, context);
		if (!sysv) { sendJson(res, 404, { error: 'no such system' }); return true; }
		const egress = systemEgressGate(sysv, action);
		if (!egress.ok) { sendJson(res, 400, { error: egress.reason }); return true; }
		if (action === 'auth') {
			if (!sysv.login_url || !sysv.success_url) { sendJson(res, 400, { error: 'register login_url + success_url first' }); return true; }
			// authSpawn (server.js systemAuthSpawn) converts the success-URL glob to auth-pw.mjs's substring
			// needle — there is deliberately NO inline fallback here (a raw glob needle would never match).
			const job = enqueue({
				kind: 'auth',
				label: `auth ${name} (playwright)`,
				nonResumableReason: 'headed auth requires the original human login session',
				spawnFn: () => authSpawn('playwright', name, sysv.login_url, sysv.success_url),
			});
			sendJson(res, 202, { job });
			return true;
		}
		if (action === 'analyze') {
			const job = enqueue({
				kind: 'analyze',
				label: `analyze ${name} (playwright)`,
				commandSpec: { runner: 'nodeLeaf', script: 'bin/pw-rpa.mjs', args: ['analyze', '--system', name] },
				spawnFn: () => nodeLeaf('bin/pw-rpa.mjs', ['analyze', '--system', name], childEnv),
			});
			sendJson(res, 202, { job });
			return true;
		}
		if (action === 'sync') {
			const job = enqueue({
				kind: 'sync',
				label: `sync ${name} (playwright)`,
				commandSpec: { runner: 'nodeLeaf', script: 'bin/pw-rpa.mjs', args: ['sync', '--system', name] },
				spawnFn: () => nodeLeaf('bin/pw-rpa.mjs', ['sync', '--system', name], childEnv),
			});
			sendJson(res, 202, { job });
			return true;
		}
		// enrich: per-record detail + on-prem summary onto records (bin/enrich-system.sh). Browser job.
		if (action === 'enrich') {
			const job = enqueue({
				kind: 'summarize',
				label: `enrich ${name} (playwright)`,
				commandSpec: { runner: 'nodeLeaf', script: 'bin/pw-rpa.mjs', args: ['enrich', '--system', name] },
				spawnFn: () => nodeLeaf('bin/pw-rpa.mjs', ['enrich', '--system', name], childEnv),
			});
			sendJson(res, 202, { job });
			return true;
		}
		return true; // matched /api/systems/<name>/<action> but no branch fired — consumed
	}
	return false;
}

// rpaGet(p, url, res, {sendJson, notFound}) -> handled?
export function rpaGet(p, url, res, { sendJson, notFound, context }) {
	if (p === '/api/actions') { sendJson(res, 200, { actions: allActionsView(context) }); return true; }
	if (p === '/api/systems') { sendJson(res, 200, { systems: listSystemsView(context) }); return true; }
	const mSysState = /^\/api\/systems\/([^/]+)\/state$/.exec(p);
	if (mSysState) {
		let n; try { n = decodeURIComponent(mSysState[1]); } catch { notFound(res); return true; }
		if (!validSysName(n)) { notFound(res); return true; }
		const st = systemState(n, null, context);
		st ? sendJson(res, 200, st) : notFound(res, 'no such system');
		return true;
	}
	const mSysActions = /^\/api\/systems\/([^/]+)\/actions$/.exec(p);
	if (mSysActions) {
		let n; try { n = decodeURIComponent(mSysActions[1]); } catch { notFound(res); return true; }
		if (!validSysName(n)) { notFound(res); return true; }
		const actions = systemActions(n, null, context);
		actions ? sendJson(res, 200, { actions }) : notFound(res, 'no such system');
		return true;
	}
	const mSysRec = /^\/api\/systems\/([^/]+)\/records$/.exec(p);
	if (mSysRec) {
		let n; try { n = decodeURIComponent(mSysRec[1]); } catch { notFound(res); return true; }
		if (!validSysName(n)) { notFound(res); return true; }
		sendJson(res, 200, { records: recordsView(n, url.searchParams.get('q') || '', context) });
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
