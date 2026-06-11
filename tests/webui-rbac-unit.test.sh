#!/usr/bin/env bash
# Browser-free unit tests for WebUI local RBAC route authorization.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

(
	cd "$DIR"
	node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import {
	actorAccessView,
	authorizeWebuiPost,
	authorizeWebuiRequest,
	currentActor,
	readRoutePermissionMatrix,
	requiredPermissionsForPost,
	requiredPermissionsForRead,
	requiredPermissionsForRoute,
	routeFamilyForPath,
} from './webui/access.js';

assert.deepEqual(currentActor({ AQA_WEBUI_ACTOR: 'alice', AQA_WEBUI_ROLE: 'viewer' }), { id: 'alice', role: 'viewer' }, 'WebUI env aliases set actor');
assert.deepEqual(currentActor({ AQA_ACTOR_ID: 'bob', AQA_ACTOR_ROLE: 'owner' }), { id: 'bob', role: 'owner' }, 'canonical actor env works');

let view = actorAccessView({ AQA_WEBUI_ACTOR: 'viewer1', AQA_WEBUI_ROLE: 'viewer' });
assert.equal(view.actor.id, 'viewer1', 'actor id is exposed');
assert.equal(view.capabilities.read.allowed, true, 'viewer can read');
assert.equal(view.capabilities.run.allowed, false, 'viewer cannot run');

const viewerContext = {
	mode: 'external',
	tenant: { id: 'tenant_a' },
	actor: { id: 'viewer_ctx', role: 'viewer', tenantId: 'tenant_a' },
	auth: { scheme: 'bearer' },
};
const operatorContext = {
	mode: 'external',
	tenant: { id: 'tenant_a' },
	actor: { id: 'operator_ctx', role: 'operator', tenantId: 'tenant_a' },
	auth: { scheme: 'bearer' },
};
const ownerContext = {
	mode: 'external',
	tenant: { id: 'tenant_a' },
	actor: { id: 'owner_ctx', role: 'owner', tenantId: 'tenant_a' },
	auth: { scheme: 'bearer' },
};
const adminContext = {
	mode: 'external',
	tenant: { id: 'tenant_a' },
	actor: { id: 'admin_ctx', role: 'admin', tenantId: 'tenant_a' },
	auth: { scheme: 'bearer' },
};
const actorTenantMismatchContext = {
	mode: 'external',
	tenant: { id: 'tenant_a' },
	actor: { id: 'owner_mismatch', role: 'owner', tenantId: 'tenant_b' },
	auth: { scheme: 'bearer' },
};

assert.deepEqual(currentActor(viewerContext), { id: 'viewer_ctx', role: 'viewer' }, 'request context sets actor');
view = actorAccessView(viewerContext);
assert.equal(view.tenantId, 'tenant_a', 'request context tenant is exposed');
assert.equal(view.security.auth, 'bearer', 'request context auth scheme is exposed');
view = actorAccessView(adminContext);
assert.equal(view.capabilities.approve.allowed, true, 'admin has owner-level capabilities');

assert.deepEqual(requiredPermissionsForRead('/'), ['read'], 'page read requires read');
assert.deepEqual(requiredPermissionsForRead('/artifacts/run/report.json'), ['read'], 'artifact read requires read');
assert.deepEqual(requiredPermissionsForRead('/api/jobs/j1/stream'), ['read'], 'SSE read requires read');
assert.deepEqual(requiredPermissionsForRead('/api/secret-migration/status'), ['run'], 'secret migration GET is operator gated');
assert.deepEqual(requiredPermissionsForRead('/api/tenant/deletion/req_1/status'), ['run'], 'tenant deletion GET is operator gated');
assert.deepEqual(requiredPermissionsForRead('/api/tenants/tenant_a/deletion/req_1/tombstone'), ['run'], 'tenant deletion tombstone GET is operator gated');
assert.deepEqual(requiredPermissionsForRead('/api/release-checklist'), ['run'], 'release checklist GET is operator gated');
assert.deepEqual(requiredPermissionsForRead('/api/approve/audit'), ['run'], 'audit detail GET is operator gated');
assert.deepEqual(requiredPermissionsForRead('/api/admin/routes'), ['run'], 'admin detail GET is operator gated');
assert.deepEqual(requiredPermissionsForRead('/api/readiness'), ['read'], 'readiness summary remains viewer-readable');
assert.deepEqual(requiredPermissionsForRead('/vnc.html'), ['live-action'], 'noVNC-style routes are effectful-gated');
assert.equal(routeFamilyForPath('/'), 'page', 'page route family is explicit');
assert.equal(routeFamilyForPath('/api/runs'), 'api', 'API route family is explicit');
assert.equal(routeFamilyForPath('/artifacts/run/report.json'), 'artifact', 'artifact route family is explicit');
assert.equal(routeFamilyForPath('/api/jobs/j1/stream'), 'sse', 'SSE route family is explicit');
assert.equal(routeFamilyForPath('/api/secret-migration/status'), 'secret-migration', 'secret migration route family is explicit');
assert.equal(routeFamilyForPath('/api/tenant/deletion/req_1/status'), 'tenant-deletion', 'tenant deletion route family is explicit');
assert.equal(routeFamilyForPath('/api/release-checklist'), 'release-checklist', 'release checklist route family is explicit');
assert.equal(routeFamilyForPath('/api/approve/audit'), 'audit', 'audit route family is explicit');
assert.equal(routeFamilyForPath('/api/admin/routes'), 'admin', 'admin route family is explicit');
assert.equal(routeFamilyForPath('/api/export'), 'export', 'export route family is explicit');
assert.equal(routeFamilyForPath('/api/retention/delete'), 'retention', 'retention route family is explicit');
assert.equal(routeFamilyForPath('/api/tenants/tenant_a/settings/security'), 'tenant-settings', 'tenant settings route family is explicit');
assert.equal(routeFamilyForPath('/vnc.html'), 'novnc', 'noVNC route family is explicit');
const readMatrix = readRoutePermissionMatrix();
assert(readMatrix.some((rule) => rule.id === 'secret-migration-metadata' && rule.permissions.includes('run')), 'read route matrix documents secret migration gate');
assert(readMatrix.some((rule) => rule.id === 'viewer-redacted-summary' && rule.viewerAccess === 'redacted-summary'), 'read route matrix documents viewer summary allowance');

assert.deepEqual(requiredPermissionsForRoute('GET', '/api/runs'), ['read'], 'GET route requires read');
assert.deepEqual(requiredPermissionsForRoute('HEAD', '/artifacts/run/report.json'), ['read'], 'HEAD artifact route requires read');
assert.deepEqual(requiredPermissionsForRoute('HEAD', '/api/release-checklist'), ['run'], 'HEAD sensitive route requires operator read');
assert.deepEqual(requiredPermissionsForRoute('DELETE', '/artifacts/run/report.json'), ['live-action'], 'artifact delete is owner gated');

assert.deepEqual(requiredPermissionsForPost('/api/run'), ['run'], 'suite run requires run permission');
assert.deepEqual(requiredPermissionsForPost('/api/session/logout'), ['read'], 'logout is authenticated self-service');
assert.deepEqual(requiredPermissionsForPost('/api/tenant/users'), ['live-action'], 'tenant user management is owner gated');
assert.deepEqual(requiredPermissionsForPost('/api/record'), ['record'], 'record requires record permission');
assert.deepEqual(requiredPermissionsForPost('/api/verify'), ['verify'], 'verify requires verify permission');
assert.deepEqual(requiredPermissionsForPost('/api/compile'), ['compile'], 'compile requires compile permission');
assert.deepEqual(requiredPermissionsForPost('/api/auth'), ['auth'], 'auth setup requires auth permission');
assert.deepEqual(requiredPermissionsForPost('/api/systems'), ['live-action'], 'system registration is owner gated');
assert.deepEqual(requiredPermissionsForPost('/api/systems/acme/sync'), ['sync'], 'system sync requires sync');
assert.deepEqual(requiredPermissionsForPost('/api/systems/acme/enrich'), ['enrich'], 'system enrich requires enrich');
assert.deepEqual(requiredPermissionsForPost('/api/systems/acme/delete'), ['live-action'], 'system delete is owner gated');
assert.deepEqual(requiredPermissionsForPost('/api/approve/run', { dryRun: true }), ['run'], 'approve dry-run is operator gated');
assert.deepEqual(requiredPermissionsForPost('/api/approve/run', { dryRun: false }), ['live-action', 'approve'], 'live approve is owner gated');
assert.deepEqual(requiredPermissionsForPost('/api/agent/plan/abc/confirm'), ['live-action', 'approve'], 'plan confirm is owner gated');
assert.deepEqual(requiredPermissionsForPost('/api/export'), ['live-action'], 'artifact export release is owner gated');
assert.deepEqual(requiredPermissionsForPost('/api/retention/delete'), ['live-action'], 'retention delete is owner gated');

assert.equal(authorizeWebuiPost('/api/run', {}, { AQA_WEBUI_ROLE: 'viewer' }).ok, false, 'viewer cannot start runs');
assert.equal(authorizeWebuiPost('/api/run', {}, { AQA_WEBUI_ROLE: 'operator' }).ok, true, 'operator can start runs');
assert.equal(authorizeWebuiPost('/api/approve/run', { dryRun: true }, { AQA_WEBUI_ROLE: 'operator' }).ok, true, 'operator can dry-run approve');
assert.equal(authorizeWebuiPost('/api/approve/run', { dryRun: false }, { AQA_WEBUI_ROLE: 'operator' }).ok, false, 'operator cannot live approve');
assert.equal(authorizeWebuiPost('/api/approve/run', { dryRun: false }, { AQA_WEBUI_ROLE: 'owner' }).ok, true, 'owner can live approve');
assert.equal(authorizeWebuiPost('/api/approve/run', { dryRun: false }, { AQA_WEBUI_ROLE: 'admin' }).ok, true, 'admin can live approve');
assert.match(authorizeWebuiPost('/api/run', {}, { AQA_WEBUI_ROLE: 'auditor' }).reason, /unknown role/, 'unknown role fails closed');

assert.equal(authorizeWebuiRequest('GET', '/api/runs', {}, viewerContext).ok, true, 'viewer can read through request context');
assert.equal(authorizeWebuiRequest('GET', '/api/readiness', {}, viewerContext).ok, true, 'viewer can read redacted readiness summary');
assert.equal(authorizeWebuiRequest('GET', '/api/secret-migration/status', {}, viewerContext).ok, false, 'viewer cannot read secret migration metadata');
assert.equal(authorizeWebuiRequest('GET', '/api/secret-migration/status', {}, operatorContext).ok, true, 'operator can read secret migration metadata');
assert.equal(authorizeWebuiRequest('GET', '/api/secret-migration/status', {}, ownerContext).ok, true, 'owner can read secret migration metadata');
assert.equal(authorizeWebuiRequest('GET', '/api/secret-migration/status', {}, adminContext).ok, true, 'admin can read secret migration metadata');
assert.equal(authorizeWebuiRequest('HEAD', '/api/release-checklist', {}, viewerContext).ok, false, 'viewer cannot HEAD release checklist metadata');
assert.equal(authorizeWebuiRequest('HEAD', '/api/release-checklist', {}, operatorContext).ok, true, 'operator can HEAD release checklist metadata');
assert.equal(authorizeWebuiRequest('POST', '/api/run', {}, viewerContext).ok, false, 'viewer mutation denied through request context');
assert.equal(authorizeWebuiRequest('POST', '/api/run', {}, operatorContext).ok, true, 'operator mutation allowed through request context');
assert.equal(authorizeWebuiRequest('POST', '/api/run', { tenantId: 'tenant_a' }, operatorContext).ok, true, 'same-tenant job enqueue body is allowed');
assert.equal(authorizeWebuiRequest('POST', '/api/run', { tenantId: 'tenant_b' }, operatorContext).ok, false, 'cross-tenant job enqueue body is denied');
assert.match(authorizeWebuiRequest('POST', '/api/run', { tenantId: 'tenant_b' }, operatorContext).reason, /request body tenant mismatch/, 'cross-tenant job enqueue denial names body tenant mismatch');
assert.equal(authorizeWebuiRequest('POST', '/api/jobs/job1/cancel', { tenantId: 'tenant_a' }, operatorContext).ok, true, 'same-tenant job cancel body is allowed');
assert.equal(authorizeWebuiRequest('POST', '/api/jobs/job1/cancel', { tenantId: 'tenant_b' }, operatorContext).ok, false, 'cross-tenant job cancel body is denied');
assert.equal(authorizeWebuiRequest('POST', '/api/approve/run', { dryRun: false }, operatorContext).ok, false, 'operator live/effectful denied through request context');
assert.equal(authorizeWebuiRequest('POST', '/api/approve/run', { dryRun: false }, ownerContext).ok, true, 'owner live/effectful allowed through request context');
assert.equal(authorizeWebuiRequest('POST', '/api/tenants/tenant_a/settings/security', {}, ownerContext).ok, true, 'same-tenant settings mutation is allowed for owner');
assert.equal(authorizeWebuiRequest('POST', '/api/tenants/tenant_b/settings/security', {}, ownerContext).ok, false, 'cross-tenant settings mutation is denied');
assert.match(authorizeWebuiRequest('POST', '/api/tenants/tenant_b/settings/security', {}, ownerContext).reason, /route tenant mismatch/, 'cross-tenant settings denial names route tenant mismatch');
assert.match(authorizeWebuiRequest('POST', '/api/tenants/%E0%A4/settings/security', {}, ownerContext).reason, /invalid route tenant/, 'invalid route tenant is denied');
assert.match(authorizeWebuiRequest('POST', '/api/run', { tenantId: '../tenant_a' }, operatorContext).reason, /invalid request body tenant/, 'invalid body tenant is denied');
assert.equal(authorizeWebuiRequest('POST', '/api/tenants/tenant_a/settings/security', {}, actorTenantMismatchContext).ok, false, 'actor tenant mismatch is denied');
assert.equal(authorizeWebuiRequest('GET', '/api/release-checklist', {}, {}).ok, true, 'local pilot default operator can read release checklist metadata');

const routeMatrix = [
	['GET', '/api/runs', {}, { viewer: true, operator: true, owner: true, admin: true }, 'read API'],
	['GET', '/api/readiness', {}, { viewer: true, operator: true, owner: true, admin: true }, 'readiness summary'],
	['GET', '/artifacts/run/report.json', {}, { viewer: true, operator: true, owner: true, admin: true }, 'artifact read'],
	['GET', '/api/jobs/job1/stream', {}, { viewer: true, operator: true, owner: true, admin: true }, 'job stream read'],
	['GET', '/api/secret-migration/status', {}, { viewer: false, operator: true, owner: true, admin: true }, 'secret migration metadata'],
	['HEAD', '/api/tenant/deletion/req_1/status', {}, { viewer: false, operator: true, owner: true, admin: true }, 'tenant deletion metadata'],
	['GET', '/api/release-checklist', {}, { viewer: false, operator: true, owner: true, admin: true }, 'release checklist metadata'],
	['GET', '/api/approve/audit', {}, { viewer: false, operator: true, owner: true, admin: true }, 'audit detail'],
	['GET', '/api/admin/routes', {}, { viewer: false, operator: true, owner: true, admin: true }, 'admin detail'],
	['POST', '/api/run', {}, { viewer: false, operator: true, owner: true, admin: true }, 'run enqueue'],
	['POST', '/api/jobs/job1/cancel', {}, { viewer: false, operator: true, owner: true, admin: true }, 'job cancel'],
	['POST', '/api/auth', {}, { viewer: false, operator: true, owner: true, admin: true }, 'auth setup'],
	['POST', '/api/record', {}, { viewer: false, operator: true, owner: true, admin: true }, 'record'],
	['POST', '/api/verify', {}, { viewer: false, operator: true, owner: true, admin: true }, 'verify'],
	['POST', '/api/compile', {}, { viewer: false, operator: true, owner: true, admin: true }, 'compile'],
	['POST', '/api/systems/acme/sync', {}, { viewer: false, operator: true, owner: true, admin: true }, 'system sync'],
	['POST', '/api/systems/acme/enrich', {}, { viewer: false, operator: true, owner: true, admin: true }, 'system enrich'],
	['POST', '/api/systems', {}, { viewer: false, operator: false, owner: true, admin: true }, 'system registration'],
	['POST', '/api/systems/acme/delete', {}, { viewer: false, operator: false, owner: true, admin: true }, 'system delete'],
	['POST', '/api/tenant/users', {}, { viewer: false, operator: false, owner: true, admin: true }, 'tenant users'],
	['POST', '/api/settings/security', {}, { viewer: false, operator: false, owner: true, admin: true }, 'tenant settings'],
	['POST', '/api/tenants/tenant_a/settings/security', {}, { viewer: false, operator: false, owner: true, admin: true }, 'tenant-scoped settings'],
	['POST', '/api/export', {}, { viewer: false, operator: false, owner: true, admin: true }, 'artifact export release'],
	['POST', '/api/retention/delete', {}, { viewer: false, operator: false, owner: true, admin: true }, 'retention delete'],
	['POST', '/api/approve/run', { dryRun: true }, { viewer: false, operator: true, owner: true, admin: true }, 'approve dry-run'],
	['POST', '/api/approve/run', { dryRun: false }, { viewer: false, operator: false, owner: true, admin: true }, 'approve live'],
	['GET', '/api/novnc/sessions/nv_1', {}, { viewer: false, operator: false, owner: true, admin: true }, 'noVNC session'],
	['DELETE', '/artifacts/run/report.json', {}, { viewer: false, operator: false, owner: true, admin: true }, 'artifact delete'],
];
const contexts = { viewer: viewerContext, operator: operatorContext, owner: ownerContext, admin: adminContext };
for (const [method, route, body, expected, label] of routeMatrix) {
	for (const [role, context] of Object.entries(contexts)) {
		const decision = authorizeWebuiRequest(method, route, body, context);
		assert.equal(decision.ok, expected[role], `${role} ${label} authorization`);
	}
}

console.log('  webui-rbac-unit: all checks passed');
NODE
)
