import { createRequire } from 'node:module';
import { redactObject, redactText } from './redact.js';

const require = createRequire(import.meta.url);
const runnerContracts = require('../lib/runner-contract.js');

const SUPPORTED_OPS = new Set(['pull', 'claim', 'heartbeat', 'complete', 'cancel']);
const JOB_OPS = new Set(['claim', 'heartbeat', 'complete', 'cancel']);
const OWNED_JOB_OPS = new Set(['heartbeat', 'complete', 'cancel']);
const TERMINAL_STATUSES = new Set(['canceled', 'succeeded', 'failed', 'interrupted', 'expired']);
const DEFAULT_LEASE_MS = 60000;
const MAX_LEASE_MS = 10 * 60 * 1000;
const DEFAULT_MAX_JSON_BYTES = 64 * 1024;
const JOB_ID_RE = /^[A-Za-z0-9_.:-]{1,160}$/;

class RunnerApiError extends Error {
	constructor(status, code, message) {
		super(message);
		this.status = status;
		this.code = code;
		this.runnerApi = true;
	}
}

function apiError(status, code, message) {
	return new RunnerApiError(status, code, message);
}

function compactSecretText(value) {
	return redactText(value, '', 500)
		.replace(/\b(?:sk|ghp|glpat)-[A-Za-z0-9._-]+/ig, '[redacted]')
		.replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
		.replace(/\b(?:aqa-secret|kms|vault|aws-kms|gcp-kms|azure-keyvault):\/\/[^\s"'<>]+/ig, '[redacted-ref]');
}

export function sanitizeRunnerApiError(value, fallback = 'runner API request refused') {
	const text = compactSecretText((value && value.message) || value || fallback);
	return text || fallback;
}

function hasOwn(obj, key) {
	return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function firstString(...values) {
	for (const value of values) {
		if (value == null) continue;
		const text = String(value).trim();
		if (text) return text;
	}
	return '';
}

function headerValue(headers, name) {
	if (!headers) return '';
	if (typeof headers.get === 'function') return firstString(headers.get(name), headers.get(name.toLowerCase()));
	const lower = name.toLowerCase();
	for (const [key, value] of Object.entries(headers)) {
		if (String(key).toLowerCase() === lower) return firstString(Array.isArray(value) ? value[0] : value);
	}
	return '';
}

function bodyObject(body) {
	if (body == null || body === '') return {};
	if (Buffer.isBuffer(body)) {
		if (!body.length) return {};
		return JSON.parse(body.toString('utf8'));
	}
	if (typeof body === 'string') {
		const text = body.trim();
		return text ? JSON.parse(text) : {};
	}
	if (typeof body !== 'object' || Array.isArray(body)) {
		throw apiError(400, 'invalid_json_body', 'runner API expects a JSON object body');
	}
	return body;
}

async function readJsonBody(req, options = {}) {
	if (hasOwn(req, 'body')) return bodyObject(req.body);
	if (!req || typeof req[Symbol.asyncIterator] !== 'function') return {};
	const maxBytes = Number(options.maxJsonBytes) > 0 ? Number(options.maxJsonBytes) : DEFAULT_MAX_JSON_BYTES;
	let bytes = 0;
	let raw = '';
	for await (const chunk of req) {
		const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
		bytes += Buffer.byteLength(text);
		if (bytes > maxBytes) throw apiError(413, 'json_body_too_large', 'runner API JSON body is too large');
		raw += text;
	}
	try {
		return bodyObject(raw);
	} catch {
		throw apiError(400, 'invalid_json_body', 'runner API body is not valid JSON');
	}
}

function pathParts(path) {
	return String(path || '')
		.split('?')[0]
		.split('/')
		.map((part) => part.trim())
		.filter(Boolean);
}

function normalizeOp(value, source) {
	const op = String(value || '').trim().toLowerCase();
	if (!op) return null;
	if (!SUPPORTED_OPS.has(op)) throw apiError(400, 'unsupported_runner_op', `unsupported runner operation from ${source}`);
	return op;
}

function pathOperation(path) {
	const parts = pathParts(path);
	for (let i = parts.length - 1; i >= 0; i -= 1) {
		if (SUPPORTED_OPS.has(parts[i])) return parts[i];
	}
	return null;
}

function resolveOperation({ body, params = {}, path }) {
	const candidates = [
		normalizeOp(params.op, 'params.op'),
		normalizeOp(params.action, 'params.action'),
		normalizeOp(body.op, 'body.op'),
		normalizeOp(body.action, 'body.action'),
		pathOperation(path),
	].filter(Boolean);
	const unique = [...new Set(candidates)];
	if (!unique.length) throw apiError(400, 'missing_runner_op', 'runner operation is required');
	if (unique.length > 1) throw apiError(400, 'ambiguous_runner_op', 'runner operation is ambiguous');
	return unique[0];
}

function pathJobId(path, op) {
	const parts = pathParts(path);
	const jobsIndex = parts.lastIndexOf('jobs');
	if (jobsIndex >= 0 && parts[jobsIndex + 1]) return decodeURIComponent(parts[jobsIndex + 1]);
	const opIndex = parts.lastIndexOf(op);
	if (opIndex >= 0 && parts[opIndex + 1]) return decodeURIComponent(parts[opIndex + 1]);
	return '';
}

function resolveJobId({ body, params = {}, path, op }) {
	if (!JOB_OPS.has(op)) return null;
	const raw = firstString(params.jobId, params.id, body.jobId, pathJobId(path, op));
	if (!raw) throw apiError(400, 'missing_job_id', `${op} requires jobId`);
	if (!JOB_ID_RE.test(raw)) throw apiError(400, 'invalid_job_id', 'jobId is invalid');
	return raw;
}

function requestPath(input = {}) {
	return input.path || input.url || input.originalUrl || input.routePath || '';
}

function requestTokenRef(body, headers) {
	return firstString(
		body.tokenRef,
		body.runnerTokenRef,
		body.WEBUI_RUNNER_TOKEN_REF,
		body.AQA_RUNNER_TOKEN_REF,
		headerValue(headers, 'x-aqa-runner-token-ref'),
		headerValue(headers, 'x-runner-token-ref'),
	);
}

function requestedRunner(body, headers, options = {}) {
	const runner = body.runner && typeof body.runner === 'object' ? body.runner : {};
	return {
		mode: firstString(
			body.runnerMode,
			body.mode,
			runner.mode,
			headerValue(headers, 'x-aqa-runner-mode'),
			options.runnerMode,
			'production',
		),
		runnerId: firstString(
			body.runnerId,
			body.runner_id,
			runner.runnerId,
			runner.id,
			headerValue(headers, 'x-aqa-runner-id'),
			headerValue(headers, 'x-runner-id'),
		),
		tenantId: firstString(
			body.tenantId,
			body.tenant_id,
			body.runnerTenantId,
			runner.tenantId,
			headerValue(headers, 'x-aqa-tenant-id'),
			headerValue(headers, 'x-runner-tenant-id'),
		),
		deploymentId: firstString(
			body.deploymentId,
			body.deployment_id,
			body.runnerDeploymentId,
			runner.deploymentId,
			headerValue(headers, 'x-aqa-runner-deployment-id'),
			headerValue(headers, 'x-runner-deployment-id'),
		),
		tokenRef: requestTokenRef(body, headers),
	};
}

function validateRequestIdentity(fields, options = {}) {
	if (options.requireExplicitRunner !== false) {
		if (!fields.runnerId) throw apiError(401, 'runner_identity_required', 'runnerId is required');
		if (!fields.tenantId) throw apiError(401, 'runner_identity_required', 'tenantId is required');
		if (!fields.deploymentId) throw apiError(401, 'runner_identity_required', 'deploymentId is required');
	}
	try {
		return runnerContracts.validateRunnerIdentity({
			WEBUI_RUNNER_MODE: fields.mode || 'production',
			WEBUI_RUNNER_ID: fields.runnerId,
			WEBUI_RUNNER_TENANT_ID: fields.tenantId,
			WEBUI_RUNNER_DEPLOYMENT_ID: fields.deploymentId,
			WEBUI_RUNNER_TOKEN_REF: fields.tokenRef,
		});
	} catch (e) {
		const msg = String((e && e.message) || e);
		if (/plaintext/i.test(msg)) throw apiError(400, 'plaintext_runner_token_refused', 'runner token must be referenced, not sent in plaintext');
		throw apiError(401, 'runner_identity_refused', 'runner identity is not authorized');
	}
}

function normalizeExpectedIdentity(raw, requested) {
	if (!raw) return null;
	if (raw.runnerId && hasOwn(raw, 'tokenRefHash')) return raw;
	const source = raw.runner && typeof raw.runner === 'object' ? raw.runner : raw;
	return runnerContracts.validateRunnerIdentity({
		WEBUI_RUNNER_MODE: source.mode || requested.mode || 'production',
		WEBUI_RUNNER_ID: source.runnerId || source.id || requested.runnerId,
		WEBUI_RUNNER_TENANT_ID: source.tenantId || requested.tenantId,
		WEBUI_RUNNER_DEPLOYMENT_ID: source.deploymentId || requested.deploymentId,
		WEBUI_RUNNER_TOKEN_REF: source.tokenRef || source.runnerTokenRef || requested.tokenRef,
	});
}

function tokenValidationInput(body, headers, tokenRef) {
	return {
		...body,
		tokenRef,
		runnerTokenRef: tokenRef,
		authorization: firstString(body.authorization, headerValue(headers, 'authorization')),
		Authorization: firstString(body.Authorization, headerValue(headers, 'authorization')),
		token: firstString(body.token, headerValue(headers, 'x-aqa-runner-token'), headerValue(headers, 'x-runner-token')),
		runnerToken: firstString(body.runnerToken, headerValue(headers, 'x-aqa-runner-token'), headerValue(headers, 'x-runner-token')),
	};
}

async function authenticateRunner({ body, headers, requested, requestIdentity }, options = {}) {
	let rawExpected = null;
	if (typeof options.resolveRunnerIdentity === 'function') {
		rawExpected = await options.resolveRunnerIdentity({
			runnerId: requestIdentity.runnerId,
			tenantId: requestIdentity.tenantId,
			deploymentId: requestIdentity.deploymentId,
			mode: requestIdentity.mode,
		}, { body, headers, requested });
	} else {
		rawExpected = options.runnerIdentity || options.identity || null;
	}
	if (!rawExpected) throw apiError(401, 'runner_identity_refused', 'runner identity is not authorized');
	let expected;
	try {
		expected = normalizeExpectedIdentity(rawExpected, requested);
	} catch {
		throw apiError(401, 'runner_identity_refused', 'runner identity is not authorized');
	}
	if (!expected || !expected.ok) throw apiError(401, 'runner_identity_refused', 'runner identity is not authorized');
	if (expected.runnerId !== requestIdentity.runnerId) throw apiError(401, 'runner_identity_refused', 'runner identity is not authorized');
	if (expected.tenantId !== requestIdentity.tenantId) throw apiError(403, 'tenant_scope_refused', 'runner tenant scope is not authorized');
	if (expected.deploymentId !== requestIdentity.deploymentId) {
		throw apiError(401, 'runner_identity_refused', 'runner deployment is not authorized');
	}
	try {
		runnerContracts.validateRunnerTokenRef(tokenValidationInput(body, headers, requested.tokenRef), expected);
	} catch (e) {
		const msg = String((e && e.message) || e);
		if (/plaintext/i.test(msg)) throw apiError(400, 'plaintext_runner_token_refused', 'runner token must be referenced, not sent in plaintext');
		throw apiError(401, 'runner_token_refused', 'runner token reference is not authorized');
	}
	return expected;
}

function nowMs(now) {
	const value = typeof now === 'function' ? now() : (now == null ? Date.now() : now);
	const date = value instanceof Date ? value.getTime() : Number(value);
	if (!Number.isFinite(date)) throw apiError(500, 'invalid_runner_api_clock', 'runner API clock is invalid');
	return Math.trunc(date);
}

function positiveInt(value, fallback, max, label) {
	if (value == null || value === '') return fallback;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) throw apiError(400, `invalid_${label}`, `${label} must be a positive integer`);
	return Math.min(Math.trunc(n), max);
}

function stringList(value, label) {
	if (value == null) return null;
	if (!Array.isArray(value)) throw apiError(400, `invalid_${label}`, `${label} must be an array`);
	const out = value.map((item) => String(item || '').trim()).filter(Boolean);
	return out.length ? out.slice(0, 20) : null;
}

function storeContext({ op, jobId, body, identity, now, leaseMs }) {
	return {
		op,
		jobId,
		runnerId: identity.runnerId,
		tenantId: identity.tenantId,
		runnerTenantId: identity.tenantId,
		runnerDeploymentId: identity.deploymentId,
		now,
		leaseMs,
		kinds: stringList(body.kinds, 'kinds'),
		status: body.status,
		pid: body.pid,
		runId: body.runId,
		exitCode: body.exitCode,
		exitSignal: body.exitSignal,
		timedOut: body.timedOut,
		reason: body.reason,
		result: body.result,
		log: body.log,
		error: body.error,
		failureReason: body.failureReason,
	};
}

function requireStore(store, method) {
	if (!store || typeof store[method] !== 'function') {
		throw apiError(500, 'runner_store_unavailable', `runner store does not implement ${method}`);
	}
	return store[method].bind(store);
}

async function callStore(store, op, jobId, ctx, body) {
	if (op === 'pull') return requireStore(store, 'pull')(ctx, body);
	if (op === 'claim') return requireStore(store, 'claim')(jobId, ctx, body);
	if (op === 'heartbeat') return requireStore(store, 'heartbeat')(jobId, ctx, body);
	if (op === 'complete') return requireStore(store, 'complete')(jobId, ctx, body);
	if (op === 'cancel') return requireStore(store, 'cancel')(jobId, ctx, body);
	throw apiError(400, 'unsupported_runner_op', 'unsupported runner operation');
}

function httpStatusForCode(code, fallback = 409) {
	switch (String(code || '').replace(/_/g, '-')) {
		case 'not-found': return 404;
		case 'tenant-scope':
		case 'tenant-scope-refused':
		case 'foreign-runner':
		case 'foreign-runner-cancel':
			return 403;
		case 'stale-heartbeat':
		case 'already-terminal':
		case 'not-active':
		case 'lease-expired':
			return 409;
		case 'bad-request':
		case 'invalid-status':
			return 400;
		default:
			return fallback;
	}
}

function scrubRunnerSecretKeys(value) {
	if (value == null || typeof value !== 'object') return value;
	if (Array.isArray(value)) return value.map(scrubRunnerSecretKeys);
	const out = {};
	for (const [key, raw] of Object.entries(value)) {
		out[key] = /(^|[_-]?)(token[_-]?ref|runner[_-]?token[_-]?ref)$/i.test(key)
			? '[redacted]'
			: scrubRunnerSecretKeys(raw);
	}
	return out;
}

function publicJob(job) {
	if (!job) return null;
	return redactObject(scrubRunnerSecretKeys(JSON.parse(JSON.stringify(job))), 1200);
}

function assertJobScope(job, identity, op) {
	if (!job) return;
	if (job.tenantId != null && String(job.tenantId) !== String(identity.tenantId)) {
		throw apiError(403, 'tenant_scope_refused', 'runner job is outside tenant scope');
	}
	if (OWNED_JOB_OPS.has(op) && job.workerId != null && String(job.workerId) !== String(identity.runnerId)) {
		throw apiError(403, 'foreign_runner_refused', 'runner does not own this job');
	}
	if (OWNED_JOB_OPS.has(op) && job.workerTenantId != null && String(job.workerTenantId) !== String(identity.tenantId)) {
		throw apiError(403, 'tenant_scope_refused', 'runner job worker tenant is outside scope');
	}
	if (OWNED_JOB_OPS.has(op) && job.workerDeploymentId != null && String(job.workerDeploymentId) !== String(identity.deploymentId)) {
		throw apiError(403, 'foreign_runner_refused', 'runner deployment does not own this job');
	}
}

function normalizeStoreResult(result, { op, identity, leaseMs }) {
	if (result == null) {
		if (op === 'pull') {
			return {
				status: 200,
				body: { ok: true, op, empty: true, job: null, runner: runnerContracts.publicRunnerIdentity(identity), leaseMs },
			};
		}
		throw apiError(404, 'not_found', 'runner job was not found');
	}
	if (result.ok === false) {
		const code = result.code || result.errorCode || 'runner_op_refused';
		throw apiError(result.httpStatus || result.statusCode || httpStatusForCode(code), code, result.message || result.error || 'runner operation refused');
	}
	const job = result.job || null;
	if (op !== 'pull' && !job) throw apiError(404, 'not_found', 'runner job was not found');
	if (op === 'pull' && (result.empty || !job)) {
		return {
			status: result.httpStatus || 200,
			body: { ok: true, op, empty: true, job: null, runner: runnerContracts.publicRunnerIdentity(identity), leaseMs },
		};
	}
	assertJobScope(job, identity, op);
	return {
		status: result.httpStatus || 200,
		body: {
			ok: true,
			op,
			empty: false,
			job: publicJob(job),
			runner: runnerContracts.publicRunnerIdentity(identity),
			leaseMs,
			cancelRequested: !!(result.cancelRequested || job?.cancelRequested),
		},
	};
}

function normalizeApiError(error, op = null) {
	if (error && error.runnerApi) {
		return {
			status: error.status || 400,
			body: {
				ok: false,
				op,
				code: error.code || 'runner_api_refused',
				error: sanitizeRunnerApiError(error),
				failClosed: true,
			},
		};
	}
	const message = String((error && error.message) || error || '');
	if (/plaintext/i.test(message)) {
		return {
			status: 400,
			body: { ok: false, op, code: 'plaintext_runner_token_refused', error: 'runner token must be referenced, not sent in plaintext', failClosed: true },
		};
	}
	return {
		status: error?.statusCode || error?.status || 500,
		body: {
			ok: false,
			op,
			code: error?.code || 'runner_api_error',
			error: sanitizeRunnerApiError(error),
			failClosed: true,
		},
	};
}

export async function handleRunnerApiRequest(input = {}, options = {}) {
	let op = null;
	try {
		const method = String(input.method || 'POST').toUpperCase();
		if (method !== 'POST') throw apiError(405, 'method_not_allowed', 'runner API accepts POST only');
		const body = bodyObject(input.body);
		const headers = input.headers || {};
		const path = requestPath(input);
		const params = input.params || {};
		op = resolveOperation({ body, params, path });
		if (op === 'complete') {
			const status = String(body.status || '').trim();
			if (!TERMINAL_STATUSES.has(status)) throw apiError(400, 'invalid_status', 'complete requires a terminal status');
		}
		const jobId = resolveJobId({ body, params, path, op });
		const requested = requestedRunner(body, headers, options);
		const requestIdentity = validateRequestIdentity(requested, options);
		const identity = await authenticateRunner({ body, headers, requested, requestIdentity }, options);
		const leaseMs = positiveInt(body.leaseMs, options.leaseMs || DEFAULT_LEASE_MS, options.maxLeaseMs || MAX_LEASE_MS, 'leaseMs');
		const ctx = storeContext({ op, jobId, body, identity, now: nowMs(options.now), leaseMs });
		const result = await callStore(options.store, op, jobId, ctx, body);
		return normalizeStoreResult(result, { op, identity, leaseMs });
	} catch (e) {
		return normalizeApiError(e, op);
	}
}

function sendJson(res, status, body) {
	if (res && typeof res.status === 'function' && typeof res.json === 'function') {
		return res.status(status).json(body);
	}
	const text = JSON.stringify(body);
	if (res && typeof res.writeHead === 'function') {
		res.writeHead(status, {
			'Content-Type': 'application/json; charset=utf-8',
			'Content-Length': Buffer.byteLength(text),
		});
		return res.end(text);
	}
	if (res && typeof res.end === 'function') {
		if ('statusCode' in res) res.statusCode = status;
		if (typeof res.setHeader === 'function') res.setHeader('Content-Type', 'application/json; charset=utf-8');
		return res.end(text);
	}
	return { status, body };
}

export function createRunnerApiHandler(options = {}) {
	return async function runnerApiHandler(req, res, next) {
		try {
			const body = await readJsonBody(req, options);
			const out = await handleRunnerApiRequest({
				method: req?.method,
				headers: req?.headers || {},
				params: req?.params || {},
				path: requestPath(req),
				body,
			}, options);
			return sendJson(res, out.status, out.body);
		} catch (e) {
			const out = normalizeApiError(e, null);
			try {
				return sendJson(res, out.status, out.body);
			} catch (sendError) {
				if (typeof next === 'function') return next(sendError);
				throw sendError;
			}
		}
	};
}

export function runnerApiContract() {
	return {
		schemaVersion: 1,
		transport: 'json-http',
		method: 'POST',
		operations: ['pull', 'claim', 'heartbeat', 'complete', 'cancel'],
		identity: {
			required: ['runnerId', 'tenantId', 'deploymentId', 'tokenRef'],
			plaintextTokenAccepted: false,
			tokenRefValidation: 'required-and-hash-matched',
		},
		scope: {
			tenantBound: true,
			heartbeatRequiresOwningRunner: true,
			completeRequiresOwningRunner: true,
			cancelRequiresOwningRunner: true,
		},
		failClosed: true,
	};
}
