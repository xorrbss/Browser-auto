// lib/rbac.js - deterministic local RBAC contract.
// Pure CommonJS leaf: no external auth, no browser, no action execution.
'use strict';

const ROLES = Object.freeze(['viewer', 'operator', 'owner', 'admin']);
const PERMISSIONS = Object.freeze([
	'read',
	'sync',
	'enrich',
	'auth',
	'record',
	'verify',
	'compile',
	'run',
	'live-action',
	'approve',
]);
const ACTIONS = PERMISSIONS;

const DEFAULT_ACTOR = Object.freeze({
	id: 'local',
	role: 'operator',
});

const ROLE_PERMISSIONS = Object.freeze({
	viewer: Object.freeze(['read']),
	operator: Object.freeze(['read', 'sync', 'enrich', 'auth', 'record', 'verify', 'compile', 'run']),
	owner: PERMISSIONS,
	admin: PERMISSIONS,
});

const ROLE_SET = new Set(ROLES);
const PERMISSION_SET = new Set(PERMISSIONS);
const ROLE_PERMISSION_SETS = Object.freeze(Object.fromEntries(
	Object.entries(ROLE_PERMISSIONS).map(([role, permissions]) => [role, new Set(permissions)]),
));

function cleanString(value) {
	return typeof value === 'string' ? value.trim() : '';
}

function roleOf(actorOrRole) {
	if (typeof actorOrRole === 'string') return cleanString(actorOrRole);
	if (actorOrRole && typeof actorOrRole === 'object') return cleanString(actorOrRole.role);
	return '';
}

function actorFromEnv(env = process.env) {
	const actorId = cleanString(env.AQA_ACTOR_ID) || DEFAULT_ACTOR.id;
	const role = cleanString(env.AQA_ACTOR_ROLE) || DEFAULT_ACTOR.role;
	return Object.freeze({ id: actorId, role });
}

function isKnownRole(role) {
	return ROLE_SET.has(cleanString(role));
}

function isKnownPermission(permission) {
	return PERMISSION_SET.has(cleanString(permission));
}

function permissionsForRole(role) {
	const normalizedRole = cleanString(role);
	const permissions = ROLE_PERMISSIONS[normalizedRole];
	return permissions ? permissions.slice() : [];
}

function can(actorOrRole, permission) {
	const role = roleOf(actorOrRole);
	const normalizedPermission = cleanString(permission);
	if (!ROLE_SET.has(role)) return false;
	if (!PERMISSION_SET.has(normalizedPermission)) return false;
	return ROLE_PERMISSION_SETS[role].has(normalizedPermission);
}

function authorize(actorOrRole, permission) {
	const role = roleOf(actorOrRole);
	const normalizedPermission = cleanString(permission);
	if (!ROLE_SET.has(role)) {
		return { ok: false, allowed: false, reason: `unknown role "${role}"`, role, permission: normalizedPermission };
	}
	if (!PERMISSION_SET.has(normalizedPermission)) {
		return { ok: false, allowed: false, reason: `unknown permission "${normalizedPermission}"`, role, permission: normalizedPermission };
	}
	if (!ROLE_PERMISSION_SETS[role].has(normalizedPermission)) {
		return { ok: false, allowed: false, reason: `role "${role}" lacks permission "${normalizedPermission}"`, role, permission: normalizedPermission };
	}
	return { ok: true, allowed: true, reason: '', role, permission: normalizedPermission };
}

module.exports = {
	ROLES,
	PERMISSIONS,
	ACTIONS,
	DEFAULT_ACTOR,
	ROLE_PERMISSIONS,
	actorFromEnv,
	localActorFromEnv: actorFromEnv,
	isKnownRole,
	isKnownPermission,
	permissionsForRole,
	can,
	authorize,
};
