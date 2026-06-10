// webui/access.js - local RBAC view and WebUI route authorization.
//
// This is intentionally a thin, deterministic layer over lib/rbac.js. It does
// not authenticate a user; it only applies the locally configured actor/role to
// the localhost control-plane routes.

import { createRequire } from 'node:module';
import { configuredTenant, securityModeSummary } from './security.js';

const require = createRequire(import.meta.url);
const rbac = require('../lib/rbac.js');

function webuiEnv(env = process.env) {
	return {
		...env,
		AQA_ACTOR_ID: env.AQA_ACTOR_ID || env.AQA_WEBUI_ACTOR || env.AQA_WEBUI_ACTOR_ID,
		AQA_ACTOR_ROLE: env.AQA_ACTOR_ROLE || env.AQA_WEBUI_ROLE || env.AQA_WEBUI_ACTOR_ROLE,
	};
}

export function currentActor(env = process.env) {
	return rbac.actorFromEnv(webuiEnv(env));
}

export function actorAccessView(env = process.env) {
	const actor = currentActor(env);
	const tenantId = configuredTenant(env) || 'local';
	const security = securityModeSummary(env);
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

export function requiredPermissionsForPost(p, bodyJson = {}) {
	if (p === '/api/run') return ['run'];
	if (/^\/api\/jobs\/[^/]+\/(?:cancel|stop)$/.test(p)) return ['run'];

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

export function authorizeWebuiPost(p, bodyJson = {}, env = process.env) {
	const actor = currentActor(env);
	const requiredPermissions = requiredPermissionsForPost(p, bodyJson);
	const denials = [];
	for (const permission of requiredPermissions) {
		const auth = rbac.authorize(actor, permission);
		if (!auth.allowed) denials.push(auth.reason);
	}
	return {
		ok: denials.length === 0,
		allowed: denials.length === 0,
		actor,
		requiredPermissions,
		reason: denials.join(' / '),
	};
}
