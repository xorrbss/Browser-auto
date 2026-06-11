import { createRequire } from 'node:module';
import { handleRunnerApiRequest, sanitizeRunnerApiError } from './runner-api.js';

const require = createRequire(import.meta.url);
const dbmDefault = require('../lib/db.js');
const runnerContracts = require('../lib/runner-contract.js');

const ROUTE_PREFIX = '/api/runner';
const SUPPORTED_OPS = new Set(['pull', 'claim', 'heartbeat', 'complete', 'cancel']);
const JOB_OPS = new Set(['claim', 'heartbeat', 'complete', 'cancel']);
const ACTIVE_STATUSES = new Set(['claimed', 'running', 'canceling']);
const TERMINAL_STATUSES = new Set(['canceled', 'succeeded', 'failed', 'interrupted', 'expired']);

function requestPath(value) {
	const raw = typeof value === 'string' ? value : (value?.pathname || value?.url || value?.originalUrl || value?.path || '');
	return String(raw || '').split('?')[0] || '/';
}

function decodePart(value) {
	try {
		return decodeURIComponent(value);
	} catch {
		return null;
	}
}

function errorBody(code, message, op = null) {
	return {
		ok: false,
		op,
		code,
		error: sanitizeRunnerApiError(message),
		failClosed: true,
	};
}

function defaultSendJson(res, code, obj) {
	const body = JSON.stringify(obj);
	if (res && typeof res.writeHead === 'function') {
		res.writeHead(code, {
			'Content-Type': 'application/json; charset=utf-8',
			'Content-Length': Buffer.byteLength(body),
		});
		return res.end(body);
	}
	if (res && typeof res.status === 'function' && typeof res.json === 'function') {
		return res.status(code).json(obj);
	}
	if (res && typeof res.end === 'function') {
		if ('statusCode' in res) res.statusCode = code;
		if (typeof res.setHeader === 'function') res.setHeader('Content-Type', 'application/json; charset=utf-8');
		return res.end(body);
	}
	return { status: code, body: obj };
}

function sendJson(deps, res, code, obj, req = null) {
	const sender = typeof deps?.sendJson === 'function' ? deps.sendJson : defaultSendJson;
	return sender(res, code, obj, req);
}

export function parseRunnerApiRoute(input) {
	const pathname = requestPath(input).replace(/\/+$/, '') || '/';
	if (pathname !== ROUTE_PREFIX && !pathname.startsWith(`${ROUTE_PREFIX}/`)) {
		return { matched: false };
	}
	const tail = pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '');
	if (!tail) {
		return { matched: true, ok: false, status: 404, code: 'runner_route_not_found', error: 'runner operation path is required' };
	}
	const parts = tail.split('/').filter(Boolean);
	let op = '';
	let jobId = '';
	if (parts[0] === 'jobs') {
		if (parts.length !== 3) {
			return { matched: true, ok: false, status: 404, code: 'runner_route_not_found', error: 'runner job route must be /api/runner/jobs/:jobId/:op' };
		}
		jobId = decodePart(parts[1]);
		op = String(parts[2] || '').toLowerCase();
	} else {
		if (parts.length > 2) {
			return { matched: true, ok: false, status: 404, code: 'runner_route_not_found', error: 'runner operation route has too many path segments' };
		}
		op = String(parts[0] || '').toLowerCase();
		jobId = parts[1] ? decodePart(parts[1]) : '';
	}
	if (!SUPPORTED_OPS.has(op)) {
		return { matched: true, ok: false, status: 404, code: 'unsupported_runner_route', error: 'unsupported runner route' };
	}
	if (jobId == null) {
		return { matched: true, ok: false, status: 400, code: 'invalid_job_id', error: 'jobId is invalid' };
	}
	if (op === 'pull' && jobId) {
		return { matched: true, ok: false, status: 404, code: 'runner_route_not_found', error: 'pull does not accept a jobId path segment' };
	}
	if (JOB_OPS.has(op) && !jobId && parts[0] === 'jobs') {
		return { matched: true, ok: false, status: 400, code: 'missing_job_id', error: `${op} requires jobId` };
	}
	return {
		matched: true,
		ok: true,
		op,
		jobId: jobId || null,
		params: {
			op,
			...(jobId ? { jobId } : {}),
		},
		path: pathname,
	};
}

function closeDb(dbm, db) {
	if (db && typeof dbm.closeDb === 'function') dbm.closeDb(db);
}

function dbCall(dbm, fn) {
	const db = dbm.openDb();
	try {
		return fn(db);
	} finally {
		closeDb(dbm, db);
	}
}

function binding(ctx) {
	return {
		runnerId: ctx.runnerId,
		tenantId: ctx.tenantId,
		runnerTenantId: ctx.runnerTenantId || ctx.tenantId,
		runnerDeploymentId: ctx.runnerDeploymentId,
		now: ctx.now,
		leaseMs: ctx.leaseMs,
	};
}

function activeOwnerRefusal(job, ctx, code = 'foreign-runner') {
	if (!job || !ACTIVE_STATUSES.has(job.status)) return null;
	if (job.workerId != null && String(job.workerId) !== String(ctx.runnerId)) return code;
	if (job.workerTenantId != null && String(job.workerTenantId) !== String(ctx.runnerTenantId || ctx.tenantId)) return 'tenant-scope-refused';
	if (job.workerDeploymentId != null && String(job.workerDeploymentId) !== String(ctx.runnerDeploymentId || '')) return code;
	return null;
}

function scopedJob(dbm, db, jobId, ctx) {
	return dbm.getWebuiJob(db, jobId, ctx.tenantId ? { tenantId: ctx.tenantId } : {});
}

function refused(code, message, httpStatus) {
	return { ok: false, code, message, httpStatus };
}

function precheckActiveJob(dbm, db, jobId, ctx, op) {
	const job = scopedJob(dbm, db, jobId, ctx);
	if (!job) return refused('not-found', 'runner job was not found', 404);
	const ownerCode = activeOwnerRefusal(job, ctx, op === 'cancel' ? 'foreign-runner-cancel' : 'foreign-runner');
	if (ownerCode) return refused(ownerCode, 'runner does not own this job', ownerCode === 'tenant-scope-refused' ? 403 : 403);
	if (op === 'cancel') return { ok: true, job };
	if (TERMINAL_STATUSES.has(job.status)) return refused('already-terminal', 'runner job is already terminal', 409);
	if (!ACTIVE_STATUSES.has(job.status)) return refused('not-active', 'runner job is not active', 409);
	if (op === 'heartbeat' && job.claimExpiresAt != null && Number(job.claimExpiresAt) <= Number(ctx.now)) {
		return refused('stale-heartbeat', 'heartbeat lease expired', 409);
	}
	return { ok: true, job };
}

export function createDurableRunnerApiStore({ dbm = dbmDefault } = {}) {
	return {
		pull(ctx, body = {}) {
			return dbCall(dbm, (db) => {
				const job = dbm.claimNextWebuiJob(db, {
					...binding(ctx),
					requireResumable: body.requireResumable !== false,
					kinds: ctx.kinds,
				});
				return job ? { ok: true, job } : { ok: true, empty: true, job: null };
			});
		},
		claim(jobId, ctx, body = {}) {
			return dbCall(dbm, (db) => {
				const job = dbm.claimWebuiJob(db, jobId, {
					...binding(ctx),
					requireResumable: body.requireResumable !== false,
				});
				return job ? { ok: true, job } : refused('not-found', 'runner job was not found', 404);
			});
		},
		heartbeat(jobId, ctx) {
			return dbCall(dbm, (db) => {
				const checked = precheckActiveJob(dbm, db, jobId, ctx, 'heartbeat');
				if (!checked.ok) return checked;
				const job = dbm.heartbeatWebuiJob(db, jobId, {
					...binding(ctx),
					status: ctx.status || 'running',
					pid: ctx.pid,
					runId: ctx.runId,
				});
				return job ? { ok: true, job, cancelRequested: !!job.cancelRequested } : refused('not-active', 'runner job is not active', 409);
			});
		},
		complete(jobId, ctx) {
			return dbCall(dbm, (db) => {
				const checked = precheckActiveJob(dbm, db, jobId, ctx, 'complete');
				if (!checked.ok) return checked;
				const cancelRequested = checked.job.status === 'canceling' || checked.job.cancelled;
				const job = dbm.completeWebuiJob(db, jobId, {
					...binding(ctx),
					status: cancelRequested ? 'canceled' : ctx.status,
					exitCode: ctx.exitCode,
					result: ctx.result,
					log: ctx.log,
					runId: ctx.runId,
					exitSignal: ctx.exitSignal,
					error: ctx.error,
					failureReason: cancelRequested && !ctx.failureReason ? 'runner cancel requested' : ctx.failureReason,
					timedOut: ctx.timedOut,
				});
				return job ? { ok: true, job } : refused('not-active', 'runner job is not active', 409);
			});
		},
		cancel(jobId, ctx) {
			return dbCall(dbm, (db) => {
				const checked = precheckActiveJob(dbm, db, jobId, ctx, 'cancel');
				if (!checked.ok) return checked;
				const result = dbm.requestWebuiJobCancel(db, jobId, {
					tenantId: ctx.tenantId,
					now: ctx.now,
					reason: ctx.reason || 'runner cancel requested',
				});
				return result.ok ? { ok: true, job: result.job, changed: result.changed } : refused('not-found', 'runner job was not found', 404);
			});
		},
	};
}

function envHasRunnerIdentity(env) {
	return !!(
		String(env.WEBUI_RUNNER_ID || env.AQA_RUNNER_ID || env.WEBUI_WORKER_ID || '').trim()
		&& String(env.WEBUI_RUNNER_TENANT_ID || env.AQA_RUNNER_TENANT_ID || env.WEBUI_TENANT_ID || env.AQA_TENANT_ID || '').trim()
		&& String(env.WEBUI_RUNNER_DEPLOYMENT_ID || env.AQA_RUNNER_DEPLOYMENT_ID || '').trim()
		&& String(env.WEBUI_RUNNER_TOKEN_REF || env.AQA_RUNNER_TOKEN_REF || '').trim()
	);
}

function runnerIdentityEnv(env) {
	return {
		...env,
		WEBUI_RUNNER_TENANT_ID: env.WEBUI_RUNNER_TENANT_ID || env.AQA_RUNNER_TENANT_ID || env.WEBUI_TENANT_ID || env.AQA_TENANT_ID,
	};
}

function sameIdentity(a, b) {
	return !!(
		a && b
		&& String(a.runnerId) === String(b.runnerId)
		&& String(a.tenantId) === String(b.tenantId)
		&& String(a.deploymentId) === String(b.deploymentId)
	);
}

export function createEnvRunnerIdentityResolver(env = process.env) {
	let cached = null;
	return async function resolveEnvRunnerIdentity(requested) {
		if (!envHasRunnerIdentity(env)) return null;
		if (!cached) cached = runnerContracts.validateRunnerIdentity(runnerIdentityEnv(env));
		return sameIdentity(cached, requested) ? cached : null;
	};
}

function routeOptions(deps = {}) {
	const supplied = deps.runnerApi || deps.apiOptions || {};
	const { store, resolveRunnerIdentity, ...rest } = supplied;
	return {
		...rest,
		store: store || deps.store || deps.runnerStore || createDurableRunnerApiStore(),
		resolveRunnerIdentity: resolveRunnerIdentity || deps.resolveRunnerIdentity || createEnvRunnerIdentityResolver(deps.env || process.env),
	};
}

function runnerContractHeaders(headers = {}) {
	const out = {};
	for (const [key, value] of Object.entries(headers || {})) {
		if (/^(authorization|cookie)$/i.test(String(key))) continue;
		out[key] = value;
	}
	return out;
}

export async function runnerApiPost(p, bodyJson, res, deps = {}) {
	const route = parseRunnerApiRoute(p);
	if (!route.matched) return false;
	const req = deps.req || deps.request || {};
	if (!route.ok) {
		sendJson(deps, res, route.status || 404, errorBody(route.code || 'runner_route_not_found', route.error || 'runner route not found'), req);
		return true;
	}
	try {
		const out = await handleRunnerApiRequest({
			method: req.method || deps.method || 'POST',
			headers: runnerContractHeaders(req.headers || deps.headers || {}),
			params: route.params,
			path: route.path,
			body: bodyJson || {},
		}, routeOptions(deps));
		sendJson(deps, res, out.status, out.body, req);
		return true;
	} catch (e) {
		sendJson(deps, res, 500, errorBody('runner_api_route_error', e), req);
		return true;
	}
}
