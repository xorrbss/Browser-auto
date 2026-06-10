#!/usr/bin/env bash
# Browser-free unit tests for WebUI local RBAC route authorization.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

(
	cd "$DIR"
	node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { actorAccessView, authorizeWebuiPost, currentActor, requiredPermissionsForPost } from './webui/access.js';

assert.deepEqual(currentActor({ AQA_WEBUI_ACTOR: 'alice', AQA_WEBUI_ROLE: 'viewer' }), { id: 'alice', role: 'viewer' }, 'WebUI env aliases set actor');
assert.deepEqual(currentActor({ AQA_ACTOR_ID: 'bob', AQA_ACTOR_ROLE: 'owner' }), { id: 'bob', role: 'owner' }, 'canonical actor env works');

let view = actorAccessView({ AQA_WEBUI_ACTOR: 'viewer1', AQA_WEBUI_ROLE: 'viewer' });
assert.equal(view.actor.id, 'viewer1', 'actor id is exposed');
assert.equal(view.capabilities.read.allowed, true, 'viewer can read');
assert.equal(view.capabilities.run.allowed, false, 'viewer cannot run');

assert.deepEqual(requiredPermissionsForPost('/api/run'), ['run'], 'suite run requires run permission');
assert.deepEqual(requiredPermissionsForPost('/api/record'), ['record'], 'record requires record permission');
assert.deepEqual(requiredPermissionsForPost('/api/compile'), ['compile'], 'compile requires compile permission');
assert.deepEqual(requiredPermissionsForPost('/api/systems'), ['live-action'], 'system registration is owner gated');
assert.deepEqual(requiredPermissionsForPost('/api/systems/acme/sync'), ['sync'], 'system sync requires sync');
assert.deepEqual(requiredPermissionsForPost('/api/systems/acme/delete'), ['live-action'], 'system delete is owner gated');
assert.deepEqual(requiredPermissionsForPost('/api/approve/run', { dryRun: true }), ['run'], 'approve dry-run is operator gated');
assert.deepEqual(requiredPermissionsForPost('/api/approve/run', { dryRun: false }), ['live-action', 'approve'], 'live approve is owner gated');
assert.deepEqual(requiredPermissionsForPost('/api/agent/plan/abc/confirm'), ['live-action', 'approve'], 'plan confirm is owner gated');

assert.equal(authorizeWebuiPost('/api/run', {}, { AQA_WEBUI_ROLE: 'viewer' }).ok, false, 'viewer cannot start runs');
assert.equal(authorizeWebuiPost('/api/run', {}, { AQA_WEBUI_ROLE: 'operator' }).ok, true, 'operator can start runs');
assert.equal(authorizeWebuiPost('/api/approve/run', { dryRun: true }, { AQA_WEBUI_ROLE: 'operator' }).ok, true, 'operator can dry-run approve');
assert.equal(authorizeWebuiPost('/api/approve/run', { dryRun: false }, { AQA_WEBUI_ROLE: 'operator' }).ok, false, 'operator cannot live approve');
assert.equal(authorizeWebuiPost('/api/approve/run', { dryRun: false }, { AQA_WEBUI_ROLE: 'owner' }).ok, true, 'owner can live approve');
assert.match(authorizeWebuiPost('/api/run', {}, { AQA_WEBUI_ROLE: 'admin' }).reason, /unknown role/, 'unknown role fails closed');

console.log('  webui-rbac-unit: all checks passed');
NODE
)
