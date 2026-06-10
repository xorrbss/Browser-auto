#!/usr/bin/env bash
# Browser-free unit tests for the deterministic local RBAC helper.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

(
	cd "$DIR"
	node <<'NODE'
const assert = require('node:assert/strict');
const rbac = require('./lib/rbac.js');

assert.deepEqual(rbac.ROLES, ['viewer', 'operator', 'owner'], 'role order is stable');
assert.deepEqual(rbac.PERMISSIONS, ['read', 'sync', 'enrich', 'auth', 'record', 'verify', 'compile', 'run', 'live-action', 'approve'], 'permission order is stable');
assert.equal(rbac.ACTIONS, rbac.PERMISSIONS, 'ACTIONS aliases permission strings');

assert.equal(rbac.can('viewer', 'read'), true, 'viewer can read');
for (const permission of rbac.PERMISSIONS.filter((p) => p !== 'read')) {
	assert.equal(rbac.can('viewer', permission), false, `viewer cannot ${permission}`);
}

for (const permission of ['read', 'sync', 'enrich', 'auth', 'record', 'verify', 'compile', 'run']) {
	assert.equal(rbac.can('operator', permission), true, `operator can ${permission}`);
}
assert.equal(rbac.can('operator', 'live-action'), false, 'operator cannot live-action');
assert.equal(rbac.can('operator', 'approve'), false, 'operator cannot approve');

for (const permission of rbac.PERMISSIONS) {
	assert.equal(rbac.can('owner', permission), true, `owner can ${permission}`);
}

assert.equal(rbac.can('admin', 'read'), false, 'unknown role fails closed');
assert.equal(rbac.can('owner', 'delete'), false, 'unknown permission fails closed');
assert.match(rbac.authorize('admin', 'read').reason, /unknown role/, 'unknown role gets explicit denial reason');
assert.match(rbac.authorize('owner', 'delete').reason, /unknown permission/, 'unknown permission gets explicit denial reason');
assert.match(rbac.authorize('viewer', 'run').reason, /lacks permission/, 'known role lacking a permission is denied');
assert.equal(rbac.authorize({ id: 'dev1', role: 'owner' }, 'approve').ok, true, 'actor object authorizes by role');

assert.deepEqual(rbac.permissionsForRole('viewer'), ['read'], 'viewer permissions are listed');
assert.deepEqual(rbac.permissionsForRole('admin'), [], 'unknown role has no permissions');
const copy = rbac.permissionsForRole('operator');
copy.push('approve');
assert.equal(rbac.can('operator', 'approve'), false, 'permissionsForRole returns a defensive copy');

assert.deepEqual(rbac.actorFromEnv({}), { id: 'local', role: 'operator' }, 'default local actor is operator');
assert.deepEqual(rbac.localActorFromEnv({}), { id: 'local', role: 'operator' }, 'localActorFromEnv aliases actorFromEnv');
assert.deepEqual(rbac.actorFromEnv({ AQA_ACTOR_ID: 'alice', AQA_ACTOR_ROLE: 'viewer' }), { id: 'alice', role: 'viewer' }, 'env sets actor id and role');
assert.deepEqual(rbac.actorFromEnv({ AQA_ACTOR_ID: '  bob  ', AQA_ACTOR_ROLE: ' owner ' }), { id: 'bob', role: 'owner' }, 'env values are trimmed');
const badEnvActor = rbac.actorFromEnv({ AQA_ACTOR_ROLE: 'admin' });
assert.equal(badEnvActor.role, 'admin', 'unknown env role is preserved for audit');
assert.equal(rbac.can(badEnvActor, 'read'), false, 'unknown env role fails closed');

console.log('  rbac-unit: all checks passed');
NODE
)
