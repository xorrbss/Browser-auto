// webui/access.js - request-context RBAC view and WebUI route authorization.
//
// This is intentionally a thin, deterministic layer over lib/rbac.js. It does
// not authenticate a user; it authorizes the authenticated request context
// produced by webui/security.js, with local-pilot env fallback for development.

import { createRequire } from 'node:module';
import { configuredTenant, securityModeSummary } from './security.js';
import { isNoVncRoutePath } from './novnc.js';

const require = createRequire(import.meta.url);
const rbac = require('../lib/rbac.js');
const TENANT_RE = /^[A-Za-z0-9_-]{1,80}$/;

const READ_ROUTE_PERMISSION_MATRIX = Object.freeze([
	Object.freeze({
		id: 'novnc-session',
		family: 'novnc',
		permissions: Object.freeze(['live-action']),
		viewerAccess: 'denied',
		description: 'noVNC session stubs are live-action gated',
		match: (p) => isNoVncRoutePath(p),
	}),
	Object.freeze({
		id: 'secret-migration-metadata',
		family: 'secret-migration',
		permissions: Object.freeze(['run']),
		viewerAccess: 'denied',
		description: 'secret migration status and workflow metadata are operator-readable only',
		match: (p) => /^\/api\/secret-migration(?:\/|$)/.test(p),
	}),
	Object.freeze({
		id: 'tenant-deletion-metadata',
		family: 'tenant-deletion',
		permissions: Object.freeze(['run']),
		viewerAccess: 'denied',
		description: 'tenant deletion status and tombstone metadata are operator-readable only',
		match: (p) => /^\/api\/tenant\/deletion(?:\/|$)/.test(p) || /^\/api\/tenants\/[^/]+\/deletion(?:\/|$)/.test(p),
	}),
	Object.freeze({
		id: 'release-checklist',
		family: 'release-checklist',
		permissions: Object.freeze(['run']),
		viewerAccess: 'denied',
		description: 'release checklist handoff metadata is operator-readable only',
		match: (p) => p === '/api/release-checklist',
	}),
	Object.freeze({
		id: 'audit-detail',
		family: 'audit',
		permissions: Object.freeze(['run']),
		viewerAccess: 'denied',
		description: 'audit detail readback is operator-readable only',
		match: (p) => /^\/api\/approve\/audit(?:\/|$)/.test(p) || /^\/api\/audit(?:\/|$)/.test(p),
	}),
	Object.freeze({
		id: 'admin-detail',
		family: 'admin',
		permissions: Object.freeze(['run']),
		viewerAccess: 'denied',
		description: 'admin/auth/approval detail metadata is operator-readable only',
		match: (p) => /^\/api\/admin(?:\/|$)/.test(p) || /^\/api\/auth(?:\/|$)/.test(p) || p === '/api/approvals',
	}),
	Object.freeze({
		id: 'viewer-redacted-summary',
		family: 'summary',
		permissions: Object.freeze(['read']),
		viewerAccess: 'redacted-summary',
		description: 'viewer-readable summaries and redacted reports',
		match: (p) => (
			p === '/'
			|| /^\/api\/(?:runs|trends|readiness|rbac|session|flows|queue)(?:\/|$)/.test(p)
			|| /^\/api\/jobs\/[^/]+(?:\/(?:stream|result))?$/.test(p)
			|| /^\/artifacts(?:\/|$)/.test(p)
		),
	}),
	Object.freeze({
		id: 'default-read',
		family: 'default',
		permissions: Object.freeze(['read']),
		viewerAccess: 'read',
		description: 'default authenticated read surface',
		match: () => true,
	}),
]);

function webuiEnv(env = process.env) {
	return {
		...env,
		AQA_ACTOR_ID: env.AQA_ACTOR_ID || env.AQA_WEBUI_ACTOR || env.AQA_WEBUI_ACTOR_ID,
		AQA_ACTOR_ROLE: env.AQA_ACTOR_ROLE || env.AQA_WEBUI_ROLE || env.AQA_WEBUI_ACTOR_ROLE,
	};
}

function unwrapContext(source) {
	if (source && typeof source === 'object' && source.context) return source.context;
	if (source && typeof source === 'object' && source.actor && (source.tenant || source.tenantId)) return source;
	return null;
}

function actorFromContext(context) {
	return {
		id: String(context?.actor?.id || '').trim() || 'unknown',
		role: String(context?.actor?.role || '').trim(),
	};
}

function tenantFromSource(source) {
	const context = unwrapContext(source);
	if (context) return String(context.tenant?.id || context.tenantId || '').trim();
	return configuredTenant(source) || 'local';
}

function pathOnly(p) {
	return String(p || '').split('?')[0];
}

function decodeSegment(value) {
	try {
		return decodeURIComponent(String(value || ''));
	} catch {
		return '';
	}
}

function routeTenantId(p) {
	const m = /^\/api\/tenants\/([^/]+)(?:\/|$)/.exec(pathOnly(p));
	if (!m) return '';
	const tenantId = decodeSegment(m[1]).trim();
	return TENANT_RE.test(tenantId) ? tenantId : '!invalid-tenant-id';
}

function bodyTenantId(bodyJson = {}) {
	if (!bodyJson || typeof bodyJson !== 'object' || Array.isArray(bodyJson)) return '';
	const value = bodyJson.tenantId || bodyJson.tenant?.id || bodyJson.tenant;
	const tenantId = typeof value === 'string' ? value.trim() : '';
	return !tenantId || TENANT_RE.test(tenantId) ? tenantId : '!invalid-tenant-id';
}

function shouldEnforceTenantScope(source) {
	const context = unwrapContext(source);
	return !!context && context.localBypass !== true;
}

function tenantScopeDenials({ source, p, bodyJson }) {
	if (!shouldEnforceTenantScope(source)) return [];
	const context = unwrapContext(source);
	const tenantId = tenantFromSource(source);
	const denials = [];
	const actorTenantId = String(context?.actor?.tenantId || '').trim();
	const pathTenantId = routeTenantId(p);
	const requestBodyTenantId = bodyTenantId(bodyJson);
	if (actorTenantId && tenantId && actorTenantId !== tenantId) denials.push('actor tenant mismatch');
	if (pathTenantId === '!invalid-tenant-id') denials.push('invalid route tenant');
	else if (pathTenantId && tenantId && pathTenantId !== tenantId) denials.push('route tenant mismatch');
	if (requestBodyTenantId === '!invalid-tenant-id') denials.push('invalid request body tenant');
	else if (requestBodyTenantId && tenantId && requestBodyTenantId !== tenantId) denials.push('request body tenant mismatch');
	return denials;
}

export function currentActor(source = process.env) {
	const context = unwrapContext(source);
	return context ? actorFromContext(context) : rbac.actorFromEnv(webuiEnv(source));
}

export function actorAccessView(source = process.env) {
	const context = unwrapContext(source);
	const actor = currentActor(source);
	const tenantId = tenantFromSource(source);
	const security = context
		? {
			mode: context.mode,
			external: context.mode === 'external',
			configured: true,
			tenantId,
			actor: { ...actor, tenantId },
			auth: context.auth?.scheme || 'request-context',
			localBypass: !!context.localBypass,
		}
		: securityModeSummary(source);
	const capabilities = Object.fromEntries(rbac.PERMISSIONS.map((permission) => {
		const auth = rbac.authorize(actor, permission);
		return [permission, { allowed: auth.allowed, reason: auth.reason }];
	}));
	return {
		actor: {
			id: actor.id,
			role: actor.role,
			tenantId,
			permissions: rbac.permissionsForRole(actor.role),
		},
		tenantId,
		security,
		role: actor.role,
		roles: rbac.ROLES,
		permissions: rbac.permissionsForRole(actor.role),
		allPermissions: rbac.PERMISSIONS,
		capabilities,
	};
}

export function routeFamilyForPath(p) {
	const path = pathOnly(p);
	if (isNoVncRoutePath(p)) return 'novnc';
	if (/^\/api\/secret-migration(?:\/|$)/.test(path)) return 'secret-migration';
	if (/^\/api\/tenant\/deletion(?:\/|$)/.test(path) || /^\/api\/tenants\/[^/]+\/deletion(?:\/|$)/.test(path)) return 'tenant-deletion';
	if (path === '/api/release-checklist') return 'release-checklist';
	if (/^\/api\/approve\/audit(?:\/|$)/.test(path) || /^\/api\/audit(?:\/|$)/.test(path)) return 'audit';
	if (/^\/api\/admin(?:\/|$)/.test(path) || /^\/api\/auth(?:\/|$)/.test(path) || path === '/api/approvals') return 'admin';
	if (/^\/api\/(?:export|exports)(?:\/|$)/.test(path)) return 'export';
	if (/^\/api\/(?:retention|artifacts)(?:\/|$)/.test(path)) return 'retention';
	if (/^\/api\/(?:tenant|tenants|users|settings)(?:\/|$)/.test(path)) return 'tenant-settings';
	if (/^\/artifacts(?:\/|$)/.test(path)) return 'artifact';
	if (/^\/api\/jobs\/[^/]+\/stream$/.test(path)) return 'sse';
	if (/^\/api(?:\/|$)/.test(path)) return 'api';
	return 'page';
}

export function readRoutePermissionMatrix() {
	return READ_ROUTE_PERMISSION_MATRIX.map((rule) => ({
		id: rule.id,
		family: rule.family,
		permissions: [...rule.permissions],
		viewerAccess: rule.viewerAccess,
		description: rule.description,
	}));
}

function readRuleForPath(p) {
	return READ_ROUTE_PERMISSION_MATRIX.find((rule) => rule.match(pathOnly(p))) || READ_ROUTE_PERMISSION_MATRIX.at(-1);
}

export function requiredPermissionsForRead(p) {
	return [...readRuleForPath(p).permissions];
}

function cleanAction(value) {
	return String(value || '').trim().toLowerCase().replace(/_/g, '-');
}

function secretMigrationAction(p, bodyJson = {}) {
	const match = /^\/api\/secret-migration(?:\/([^/?#]+))?/.exec(p);
	const pathAction = cleanAction(match?.[1]);
	const bodyAction = cleanAction(bodyJson.action || bodyJson.op || bodyJson.kind);
	return pathAction || bodyAction;
}

function tenantDeletionAction(p, bodyJson = {}) {
	const bodyAction = cleanAction(bodyJson.action || bodyJson.op || bodyJson.kind);
	if (bodyAction) return bodyAction;
	const parts = String(p || '').split('/').filter(Boolean);
	const deletionIndex = parts.indexOf('deletion');
	if (deletionIndex < 0) return '';
	const first = cleanAction(parts[deletionIndex + 1]);
	const second = cleanAction(parts[deletionIndex + 2]);
	const known = new Set(['dry-run', 'dryrun', 'approve', 'approval', 'execute', 'retry', 'status', 'read-tombstone', 'read-tombstone-manifest', 'tombstone']);
	if (known.has(first)) return first;
	if (known.has(second)) return second;
	return '';
}

export function requiredPermissionsForPost(p, bodyJson = {}) {
	if (p === '/api/run') return ['run'];
	if (/^\/api\/jobs\/[^/]+\/(?:cancel|stop)$/.test(p)) return ['run'];
	if (p === '/api/session/logout') return ['read'];
	if (/^\/api\/runner(?:\/|$)/.test(p)) return ['run'];
	if (/^\/api\/secret-migration(?:\/|$)/.test(p)) {
		const action = secretMigrationAction(p, bodyJson);
		return action === 'dry-run' || action === 'status' ? ['read'] : ['run'];
	}
	if (/^\/api\/tenant\/deletion(?:\/|$)/.test(p) || /^\/api\/tenants\/[^/]+\/deletion(?:\/|$)/.test(p)) {
		const action = tenantDeletionAction(p, bodyJson);
		if (action === 'dry-run' || action === 'dryrun' || action === 'status' || action === 'read-tombstone' || action === 'read-tombstone-manifest' || action === 'tombstone') return ['run'];
		return ['live-action'];
	}
	if (/^\/api\/(?:export|exports)(?:\/|$)/.test(p)) return ['live-action'];
	if (/^\/api\/(?:retention|artifacts)(?:\/|$)/.test(p)) return ['live-action'];
	if (/^\/api\/(?:tenant|tenants|users|settings)(?:\/|$)/.test(p)) return ['live-action'];

	if (p === '/api/record') return ['record'];
	if (p === '/api/verify') return ['verify'];
	if (p === '/api/compile') return ['compile'];
	if (p === '/api/auth' || /^\/api\/auth\/[^/]+\/delete$/.test(p)) return ['auth'];
	if (/^\/api\/flows\/[^/]+\/(?:resolve|resolve-clicked-record|resolve-first-record|values)$/.test(p)) return ['record'];

	if (p === '/api/sync') return ['sync'];
	if (p === '/api/agent' || p === '/api/agent/plan' || p === '/api/agent/plans') return ['run'];
	const mPlan = /^\/api\/agent\/plans?\/[^/]+\/([^/]+)(?:\/|$)?/.exec(p);
	if (mPlan) {
		if (mPlan[1] === 'confirm') return ['live-action', 'approve'];
		return ['run'];
	}

	if (p === '/api/systems') return ['live-action'];
	const mSystem = /^\/api\/systems\/[^/]+\/(auth|analyze|sync|enrich|delete)$/.exec(p);
	if (mSystem) {
		if (mSystem[1] === 'auth') return ['auth'];
		if (mSystem[1] === 'sync') return ['sync'];
		if (mSystem[1] === 'analyze' || mSystem[1] === 'enrich') return ['enrich'];
		if (mSystem[1] === 'delete') return ['live-action'];
	}

	if (p === '/api/approve/stop') return ['run'];
	if (p === '/api/approve/login') return ['auth'];
	if (p === '/api/approve/capture/assemble') return ['record'];
	if (p === '/api/approve/capture/dry-run') return ['run'];
	if (p === '/api/approve/capture/verify' || p === '/api/approve/capture/enable') return ['live-action', 'approve'];
	if (p === '/api/approve/run') return bodyJson && bodyJson.dryRun === false ? ['live-action', 'approve'] : ['run'];

	return [];
}

function mutatingMethod(method) {
	return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase());
}

export function requiredPermissionsForRoute(method, p, bodyJson = {}) {
	if (isNoVncRoutePath(p)) return ['live-action'];
	const m = String(method || '').toUpperCase();
	if (m === 'GET' || m === 'HEAD') return requiredPermissionsForRead(p);
	if (m === 'POST') return requiredPermissionsForPost(p, bodyJson);
	if (m === 'DELETE' && /^\/artifacts(?:\/|$)/.test(p)) return ['live-action'];
	if (mutatingMethod(m)) {
		if (/^\/api\/(?:tenant|tenants|users)(?:\/|$)/.test(p)) return ['live-action'];
		return ['live-action'];
	}
	return [];
}

export function authorizeWebuiRequest(method, p, bodyJson = {}, source = process.env) {
	const actor = currentActor(source);
	const tenantId = tenantFromSource(source);
	const requiredPermissions = requiredPermissionsForRoute(method, p, bodyJson);
	const denials = tenantScopeDenials({ source, p, bodyJson });
	if (!tenantId) denials.push('tenant context missing');
	if (!rbac.isKnownRole(actor.role)) denials.push(`unknown role "${actor.role}"`);
	for (const permission of requiredPermissions) {
		const auth = rbac.authorize(actor, permission);
		if (!auth.allowed) denials.push(auth.reason);
	}
	return {
		ok: denials.length === 0,
		allowed: denials.length === 0,
		actor,
		tenantId,
		routeFamily: routeFamilyForPath(p),
		requiredPermissions,
		reason: denials.join(' / '),
	};
}

export function authorizeWebuiPost(p, bodyJson = {}, source = process.env) {
	return authorizeWebuiRequest('POST', p, bodyJson, source);
}
