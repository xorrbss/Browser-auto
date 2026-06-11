// webui/tenant-deletion-routes.js - metadata-only tenant deletion route adapter.
//
// This module does not read artifact bytes, auth state, values sidecars, job
// logs, browser profiles, or secret material. It only normalizes WebUI route
// inputs and delegates dry-run/approval/execution state to tenant-deletion-api.

import { createTenantDeletionApi } from './tenant-deletion-api.js';

const TENANT_RE = /^[A-Za-z0-9_-]{1,80}$/;
const ACTION_ALIASES = Object.freeze({
	'approve': 'approve',
	'approval': 'approve',
	'dry-run': 'dry-run',
	'dryrun': 'dry-run',
	'execute': 'execute',
	'read-tombstone': 'read-tombstone',
	'read-tombstone-manifest': 'read-tombstone',
	'retry': 'retry',
	'status': 'status',
	'tombstone': 'read-tombstone',
});
const READ_ACTIONS = new Set(['status', 'read-tombstone']);
const DEFAULT_API = createTenantDeletionApi();

function cleanString(value) {
	return String(value || '').trim();
}

function normalizeAction(value) {
	const key = cleanString(value).toLowerCase().replace(/_/g, '-');
	return ACTION_ALIASES[key] || '';
}

function decodeSegment(value) {
	try {
		return decodeURIComponent(String(value || ''));
	} catch {
		return null;
	}
}

function denied(code, reason, message, extra = {}) {
	return {
		ok: false,
		code,
		allowed: false,
		blocked: true,
		error: reason,
		reason,
		metadataOnly: true,
		readsRawArtifacts: false,
		readsSecretBytes: false,
		findings: [{
			reason,
			class: 'tenant',
			id: cleanString(extra.requestId || extra.tenantId || ''),
			message,
		}],
		...extra,
	};
}

function sendResult(res, sendJson, result) {
	const code = Number.isInteger(result?.code) ? result.code : result?.ok ? 200 : result?.blocked ? 409 : 400;
	sendJson(res, code, result);
	return true;
}

function parseTail(tenantId, tail) {
	const rawParts = cleanString(tail).split('/').filter(Boolean);
	const parts = [];
	for (const part of rawParts) {
		const decoded = decodeSegment(part);
		if (decoded == null) return { bad: true };
		parts.push(decoded);
	}
	if (!parts.length) return { tenantId };

	const firstAction = normalizeAction(parts[0]);
	if (firstAction) {
		return { tenantId, action: firstAction, requestId: cleanString(parts[1]) };
	}

	const secondAction = normalizeAction(parts[1]);
	return {
		tenantId,
		requestId: cleanString(parts[0]),
		action: secondAction,
	};
}

function parseTenantDeletionPath(pathname) {
	const p = cleanString(pathname).replace(/\/+$/, '') || '/';
	let m = /^\/api\/tenant\/deletion(?:\/(.+))?$/.exec(p);
	if (m) return parseTail('', m[1] || '');
	m = /^\/api\/tenants\/([^/]+)\/deletion(?:\/(.+))?$/.exec(p);
	if (!m) return null;
	const tenantId = decodeSegment(m[1]);
	if (tenantId == null) return { bad: true };
	return parseTail(tenantId, m[2] || '');
}

function queryValue(url, names) {
	if (!url?.searchParams) return '';
	for (const name of names) {
		const value = cleanString(url.searchParams.get(name));
		if (value) return value;
	}
	return '';
}

function contextTenantId(context) {
	return cleanString(context?.tenantId || context?.tenant?.id || context?.actor?.tenantId);
}

function inputTenantId(input = {}) {
	return cleanString(input.tenantId || input.tenant?.id);
}

function contextActorId(context) {
	return cleanString(context?.actor?.id || context?.actorId);
}

function inputActorId(action, input = {}) {
	if (action === 'approve') return cleanString(input.approvedBy || input.actorId || input.actor?.id);
	if (action === 'execute' || action === 'retry') return cleanString(input.executedBy || input.actorId || input.actor?.id);
	return cleanString(input.actorId || input.actor?.id);
}

function resolveTenant({ parsed, input, url, context }) {
	const contextTenant = contextTenantId(context);
	const pathTenant = cleanString(parsed.tenantId);
	const queryTenant = queryValue(url, ['tenantId', 'tenant']);
	const bodyTenant = inputTenantId(input);
	for (const tenantId of [contextTenant, pathTenant, queryTenant, bodyTenant].filter(Boolean)) {
		if (!TENANT_RE.test(tenantId)) {
			return { error: denied(400, 'invalid-tenant-id', 'tenant id is invalid', { tenantId }) };
		}
	}
	const tenantId = contextTenant || pathTenant || queryTenant || bodyTenant;
	for (const candidate of [pathTenant, queryTenant, bodyTenant].filter(Boolean)) {
		if (tenantId && candidate !== tenantId) {
			return {
				error: denied(404, 'tenant-mismatch', 'tenant deletion request was not found for this tenant', {
					tenantId,
					requestId: cleanString(input.requestId || parsed.requestId),
				}),
			};
		}
	}
	return { tenantId };
}

function resolveActor(action, input, context) {
	const contextActor = contextActorId(context);
	const bodyActor = inputActorId(action, input);
	if (contextActor && bodyActor && contextActor !== bodyActor) {
		return { error: denied(403, 'actor-mismatch', 'request actor does not match the authenticated actor') };
	}
	return { actorId: contextActor || bodyActor };
}

function routeOptions(deps = {}) {
	const opts = {};
	for (const key of ['artifactCleanupAdapter', 'allowNonFakeAdapters', 'now']) {
		if (deps[key] !== undefined) opts[key] = deps[key];
	}
	return opts;
}

function buildInput(method, parsed, bodyJson = {}, url = null, deps = {}) {
	if (parsed?.bad) return { error: denied(400, 'bad-tenant-deletion-route', 'tenant deletion route contains a bad path segment') };
	const input = { ...(bodyJson && typeof bodyJson === 'object' && !Array.isArray(bodyJson) ? bodyJson : {}) };
	const queryAction = queryValue(url, ['action', 'op', 'kind']);
	const bodyAction = normalizeAction(input.action || input.op || input.kind);
	const pathAction = normalizeAction(parsed.action);
	if (pathAction && bodyAction && pathAction !== bodyAction) {
		return { error: denied(400, 'tenant-deletion-action-mismatch', 'tenant deletion action in path and body must match') };
	}
	const action = pathAction || bodyAction || normalizeAction(queryAction);
	if (!action) {
		return { error: denied(400, 'missing-tenant-deletion-action', 'action must be dry-run, approve, execute, retry, status, or read-tombstone') };
	}
	if (method === 'GET' && !READ_ACTIONS.has(action)) {
		return { error: denied(405, 'tenant-deletion-action-method-not-allowed', 'tenant deletion read routes support only status and read-tombstone') };
	}

	input.action = action;
	if (!input.requestId && parsed.requestId) input.requestId = parsed.requestId;
	if (!input.requestId) input.requestId = queryValue(url, ['requestId', 'id']);
	if (!input.manifestHash) input.manifestHash = queryValue(url, ['manifestHash', 'tombstoneManifestHash']);
	if (!input.tombstoneManifestHash) input.tombstoneManifestHash = queryValue(url, ['tombstoneManifestHash']);

	const tenant = resolveTenant({ parsed, input, url, context: deps.context });
	if (tenant.error) return tenant;
	if (tenant.tenantId && !input.tenantId) input.tenantId = tenant.tenantId;

	const actor = resolveActor(action, input, deps.context);
	if (actor.error) return actor;
	if (actor.actorId) {
		if (!input.actorId) input.actorId = actor.actorId;
		if (action === 'approve' && !input.approvedBy) input.approvedBy = actor.actorId;
		if ((action === 'execute' || action === 'retry') && !input.executedBy) input.executedBy = actor.actorId;
	}

	return { input };
}

async function handleRoute(method, pathname, bodyJson, url, res, deps = {}) {
	const parsed = parseTenantDeletionPath(pathname);
	if (!parsed) return false;
	const sendJson = deps.sendJson;
	if (typeof sendJson !== 'function') throw new Error('tenant deletion routes require deps.sendJson');
	const built = buildInput(method, parsed, bodyJson, url, deps);
	if (built.error) return sendResult(res, sendJson, built.error);
	const api = deps.api || DEFAULT_API;
	const result = await api.handle(built.input, routeOptions(deps));
	return sendResult(res, sendJson, result);
}

export function createTenantDeletionRoutes(options = {}) {
	const api = options.api || createTenantDeletionApi(options);
	return Object.freeze({
		api,
		post(p, bodyJson, res, deps = {}) {
			return handleRoute('POST', p, bodyJson, null, res, { ...options, ...deps, api });
		},
		get(p, url, res, deps = {}) {
			return handleRoute('GET', p, {}, url, res, { ...options, ...deps, api });
		},
	});
}

export async function tenantDeletionPost(p, bodyJson, res, deps = {}) {
	return handleRoute('POST', p, bodyJson, null, res, deps);
}

export async function tenantDeletionGet(p, url, res, deps = {}) {
	return handleRoute('GET', p, {}, url, res, deps);
}
