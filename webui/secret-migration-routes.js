// webui/secret-migration-routes.js - WebUI route adapter for metadata-only secret migration.
//
// This module is intentionally transport-only. It adapts server.js-style route
// calls to webui/secret-migration-api.js without reading auth state, values
// sidecars, artifacts, or secret bytes.

import { createSecretMigrationApi } from './secret-migration-api.js';

const ROUTE_CONTRACT = 'webui-secret-migration-routes/v1';
const ROUTE_RE = /^\/api\/secret-migration(?:\/([^/?#]+))?\/?$/;
const ACTIONS = new Set(['dry-run', 'plan', 'approve', 'stage', 'commit', 'rollback', 'status']);
const READ_ACTIONS = new Set(['dry-run', 'status']);
const OPERATOR_ROLES = new Set(['operator', 'owner', 'admin']);
const TENANT_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SAFE_TOKEN_RE = /[^A-Za-z0-9_.:-]/g;
const SAFE_TEXT_RE = /[^A-Za-z0-9_.:/@* -]/g;
const DEFAULT_MAX_JSON_BYTES = 256 * 1024;
const METADATA_ONLY_FLAGS = Object.freeze({
	failClosed: true,
	sanitized: true,
	metadataOnly: true,
	secretContentsInspected: false,
	readsSecretBytes: false,
	writesSecretBytes: false,
	deletesPlaintext: false,
	migratesSecrets: false,
	sideEffects: false,
	secretByteAccessorCalled: false,
});

export function isSecretMigrationRoutePath(pathname = '') {
	return ROUTE_RE.test(String(pathname || '').split('?')[0]);
}

export function createSecretMigrationRoutes(opts = {}) {
	const api = opts.api || createSecretMigrationApi(opts.apiOptions || opts);
	const routeOptions = { ...opts, api };

	return Object.freeze({
		api,
		async post(pathname, bodyJson = {}, res = null, deps = {}) {
			return dispatchRoute({
				method: 'POST',
				pathname,
				bodyJson,
				res,
				deps,
				api,
				opts: routeOptions,
			});
		},
		async get(pathname, url, res = null, deps = {}) {
			return dispatchRoute({
				method: 'GET',
				pathname,
				url,
				bodyJson: {},
				res,
				deps,
				api,
				opts: routeOptions,
			});
		},
		async handle(req, res, next) {
			try {
				const url = requestUrl(req);
				if (!isSecretMigrationRoutePath(url.pathname)) {
					if (typeof next === 'function') return next();
					return false;
				}
				const method = cleanToken(String(req?.method || 'GET').toUpperCase());
				if (method === 'GET' || method === 'HEAD') {
					if (method === 'HEAD') {
						if (typeof res?.writeHead === 'function') res.writeHead(200, { 'Content-Length': 0 });
						if (typeof res?.end === 'function') res.end();
						return true;
					}
					return dispatchRoute({
						method: 'GET',
						pathname: url.pathname,
						url,
						bodyJson: {},
						res,
						deps: { request: req, sendJson: sendJsonResponse },
						api,
						opts: routeOptions,
					});
				}
				if (method !== 'POST') {
					sendJsonResponse(res, 405, failureBody({
						action: pathAction(url.pathname) || 'unknown',
						tenantId: contextTenant(requestContextFrom({ request: req })),
						reason: 'method-not-allowed',
						message: 'secret migration routes accept GET status and POST actions only',
					}));
					return true;
				}
				const bodyJson = await readJsonBody(req, routeOptions);
				return dispatchRoute({
					method,
					pathname: url.pathname,
					url,
					bodyJson,
					res,
					deps: { request: req, sendJson: sendJsonResponse },
					api,
					opts: routeOptions,
				});
			} catch (error) {
				const status = error?.statusCode || error?.status || 400;
				sendJsonResponse(res, status, failureBody({
					action: 'unknown',
					tenantId: '',
					reason: status === 413 ? 'json-body-too-large' : 'invalid-json-body',
					message: status === 413 ? 'secret migration JSON body is too large' : 'secret migration route requires a JSON object body',
				}));
				return true;
			}
		},
		contract() {
			return secretMigrationRouteContract();
		},
	});
}

const DEFAULT_ROUTES = createSecretMigrationRoutes();

export async function secretMigrationPost(pathname, bodyJson, res, deps = {}) {
	return DEFAULT_ROUTES.post(pathname, bodyJson, res, deps);
}

export async function secretMigrationGet(pathname, url, res, deps = {}) {
	return DEFAULT_ROUTES.get(pathname, url, res, deps);
}

export function secretMigrationRouteContract() {
	return {
		contract: ROUTE_CONTRACT,
		basePath: '/api/secret-migration',
		actions: [...ACTIONS],
		methods: {
			GET: ['status'],
			POST: [...ACTIONS],
		},
		tenantScoped: true,
		idempotencyRequiredFor: ['plan', 'approve', 'stage', 'commit', 'rollback'],
		operatorRequiredFor: ['plan', 'approve', 'stage', 'commit', 'rollback'],
		approvalManifestRequiredFor: ['approve', 'stage'],
		rollbackEvidenceRequiredFor: ['commit', 'rollback'],
		metadataOnly: true,
		failClosed: true,
	};
}

async function dispatchRoute({ method, pathname, url, bodyJson, res, deps, api, opts }) {
	const route = parseRoute(pathname, url, bodyJson);
	if (!route.handled) return false;
	const context = requestContextFrom(deps);
	const gate = authorizeRoute({ action: route.action, method, context, opts });
	if (!gate.ok) {
		sendWithDeps(res, gate.status, gate.body, deps);
		return true;
	}
	const response = await api.handle({
		method,
		url: route.url.toString(),
		path: route.url.pathname,
		headers: headerSource(deps),
		context,
		action: route.action,
		body: withScopedTenant(bodyJson, context),
	});
	sendWithDeps(res, response.status, response.body, deps);
	return true;
}

function parseRoute(pathname, url, bodyJson = {}) {
	const parsedUrl = normalizeUrl(url || pathname || '/api/secret-migration');
	const path = String(pathname || parsedUrl.pathname || '').split('?')[0];
	const match = ROUTE_RE.exec(path);
	if (!match) return { handled: false, action: '', url: parsedUrl };
	const action = normalizeAction(match[1] || bodyJson?.action || (parsedUrl.pathname === '/api/secret-migration' ? parsedUrl.searchParams.get('action') : ''));
	return {
		handled: true,
		action,
		url: parsedUrl,
	};
}

function authorizeRoute({ action, method, context, opts }) {
	const tenantId = contextTenant(context);
	if (!tenantId) {
		return {
			ok: false,
			status: 401,
			body: failureBody({
				action: action || 'unknown',
				tenantId,
				reason: 'secret-migration-tenant-context-required',
				message: 'secret migration routes require an authenticated tenant context',
			}),
		};
	}
	if (!action || !ACTIONS.has(action)) return { ok: true, tenantId };
	const role = actorRole(context);
	const operatorRequired = opts.requireOperatorRole !== false && !READ_ACTIONS.has(action);
	if (method === 'POST' && operatorRequired && !OPERATOR_ROLES.has(role)) {
		return {
			ok: false,
			status: 403,
			body: failureBody({
				action,
				tenantId,
				reason: 'secret-migration-operator-role-required',
				message: 'secret migration mutations require an operator, owner, or admin role',
			}),
		};
	}
	return { ok: true, tenantId };
}

function requestContextFrom(deps = {}) {
	if (deps.context && typeof deps.context === 'object') return deps.context;
	if (typeof deps.context === 'function') return deps.context(deps.request);
	if (deps.request?.context) return deps.request.context;
	if (deps.req?.context) return deps.req.context;
	return null;
}

function withScopedTenant(bodyJson = {}, context = null) {
	const body = bodyJson && typeof bodyJson === 'object' && !Array.isArray(bodyJson) ? { ...bodyJson } : {};
	const tenantId = contextTenant(context);
	if (tenantId && !body.tenantId) body.tenantId = tenantId;
	return body;
}

function contextTenant(context = null) {
	const tenantId = String(context?.tenant?.id || context?.tenantId || context?.actor?.tenantId || '').trim();
	return TENANT_RE.test(tenantId) ? tenantId : '';
}

function actorRole(context = null) {
	return cleanToken(String(context?.actor?.role || context?.role || '').toLowerCase());
}

function pathAction(pathname = '') {
	const match = ROUTE_RE.exec(String(pathname || '').split('?')[0]);
	return normalizeAction(match?.[1] || '');
}

function normalizeAction(value) {
	const raw = cleanToken(String(value || '').toLowerCase().replace(/_/g, '-'));
	if (raw === 'dryrun') return 'dry-run';
	if (raw === 'approved') return 'approve';
	if (raw === 'staged') return 'stage';
	if (raw === 'committed') return 'commit';
	if (raw === 'rolled-back') return 'rollback';
	return raw;
}

function headerSource(deps = {}) {
	return deps.headers || deps.request?.headers || deps.req?.headers || {};
}

function sendWithDeps(res, status, body, deps = {}) {
	if (typeof deps.sendJson === 'function') return deps.sendJson(res, status, body, deps.request || deps.req || null);
	return sendJsonResponse(res, status, body);
}

function sendJsonResponse(res, status, body) {
	if (!res) return { status, body };
	const text = JSON.stringify(body);
	if (typeof res.writeHead === 'function') {
		res.writeHead(status, {
			'Content-Type': 'application/json; charset=utf-8',
			'Content-Length': Buffer.byteLength(text),
		});
		if (typeof res.end === 'function') return res.end(text);
		return undefined;
	}
	if (typeof res.status === 'function' && typeof res.json === 'function') return res.status(status).json(body);
	if ('statusCode' in res) res.statusCode = status;
	if (typeof res.setHeader === 'function') res.setHeader('Content-Type', 'application/json; charset=utf-8');
	if (typeof res.end === 'function') return res.end(text);
	return { status, body };
}

function failureBody({ action, tenantId, reason, message }) {
	return {
		ok: false,
		api: ROUTE_CONTRACT,
		action: normalizeAction(action) || cleanToken(action || 'unknown'),
		tenantId: cleanTenant(tenantId) || 'local',
		state: 'blocked',
		decision: 'blocked',
		blocked: true,
		requiresOperator: /operator|approval|rollback/.test(String(reason || '')),
		...METADATA_ONLY_FLAGS,
		error: cleanToken(reason || 'secret-migration-route-blocked'),
		findings: [{
			reason: cleanToken(reason || 'secret-migration-route-blocked'),
			entry: '',
			message: cleanText(message || 'secret migration route request was refused'),
		}],
	};
}

async function readJsonBody(req, opts = {}) {
	if (Object.prototype.hasOwnProperty.call(req || {}, 'body')) return normalizeJsonBody(req.body);
	if (!req || typeof req[Symbol.asyncIterator] !== 'function') return {};
	const maxBytes = Number(opts.maxJsonBytes) > 0 ? Number(opts.maxJsonBytes) : DEFAULT_MAX_JSON_BYTES;
	let bytes = 0;
	let raw = '';
	for await (const chunk of req) {
		const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
		bytes += Buffer.byteLength(text);
		if (bytes > maxBytes) {
			const error = new Error('secret migration JSON body is too large');
			error.status = 413;
			throw error;
		}
		raw += text;
	}
	return normalizeJsonBody(raw);
}

function normalizeJsonBody(value) {
	if (value == null || value === '') return {};
	if (Buffer.isBuffer(value)) return normalizeJsonBody(value.toString('utf8'));
	if (typeof value === 'string') {
		const text = value.trim();
		if (!text) return {};
		const parsed = JSON.parse(text);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('secret migration JSON body must be an object');
		return parsed;
	}
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('secret migration JSON body must be an object');
	return value;
}

function requestUrl(req) {
	return normalizeUrl(req?.url || req?.path || '/api/secret-migration/status', req?.headers?.host);
}

function normalizeUrl(value, host = '127.0.0.1') {
	if (value instanceof URL) return value;
	try {
		return new URL(String(value || ''), `http://${host || '127.0.0.1'}`);
	} catch {
		return new URL('http://127.0.0.1/api/secret-migration/status');
	}
}

function cleanTenant(value) {
	const text = String(value || '').trim();
	return TENANT_RE.test(text) ? text : '';
}

function cleanToken(value) {
	return String(value || '').trim().replace(SAFE_TOKEN_RE, '').slice(0, 160);
}

function cleanText(value) {
	return String(value || '').trim().replace(SAFE_TEXT_RE, '').slice(0, 240);
}
