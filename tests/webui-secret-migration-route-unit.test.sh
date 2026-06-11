#!/usr/bin/env bash
# Browser-free checks for the WebUI secret migration route adapter.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { createSecretMigrationRoutes, secretMigrationRouteContract } from './webui/secret-migration-routes.js';
import { buildSecretMigrationApprovalManifest, makeSecretRef } from './webui/secrets.js';
import { buildSecretMigrationRollbackEvidence } from './webui/secret-migration.js';

const RAW_SECRET = 'RAW_SECRET_ROUTE_BYTES_NEVER_OUTPUT';
const tenantId = 'tenant_route_a';
const operatorContext = {
	mode: 'external',
	tenant: { id: tenantId },
	actor: { id: 'operator_route', role: 'operator', tenantId },
	auth: { scheme: 'bearer' },
};
const viewerContext = {
	mode: 'external',
	tenant: { id: tenantId },
	actor: { id: 'viewer_route', role: 'viewer', tenantId },
	auth: { scheme: 'bearer' },
};

const routes = createSecretMigrationRoutes({
	now: () => '2099-03-01T00:00:00.000Z',
	env: {},
});

function readyOperation({ kind, source, pathClass }) {
	return {
		kind,
		source,
		pathClass,
		status: 'plaintext-with-secure-copy',
		secureStatus: 'secure-present',
		action: 'operator-verify-secure-copy-then-retire-plaintext',
		readyForRetirePlaintext: true,
		blocked: false,
		readsSecretBytes: false,
		writesSecretBytes: false,
		deletesPlaintext: false,
		rawSecret: RAW_SECRET,
	};
}

function planFor(tid) {
	return {
		planner: 'webui-secret-migration-plan/v1',
		tenantId: tid,
		root: 'repository',
		dryRun: true,
		sanitized: true,
		secretContentsInspected: false,
		readsSecretBytes: false,
		migratesSecrets: false,
		operations: [
			readyOperation({
				kind: 'auth-state',
				source: 'canonical-auth-state',
				pathClass: 'fixtures/auth/playwright/*.state.json',
			}),
			readyOperation({
				kind: 'flow-values',
				source: 'flow-values',
				pathClass: 'flows/*.values.json',
			}),
		],
		rawSecret: RAW_SECRET,
	};
}

function refsFor(tid) {
	return [
		makeSecretRef({ tenantId: tid, kind: 'auth-state', name: 'canonical:appalpha' }),
		makeSecretRef({ tenantId: tid, kind: 'flow-values', name: 'checkout' }),
	];
}

function approvalFor(tid, refs) {
	return buildSecretMigrationApprovalManifest({
		tenantId: tid,
		requester: 'owner_route',
		purpose: 'unit route secret migration dry-run',
		secretRefs: refs,
		pathClasses: ['fixtures/auth/playwright/*.state.json', 'flows/*.values.json'],
		approvedBy: 'owner_route',
		approvedAt: '2099-03-01T00:00:00.000Z',
		createdAt: '2099-03-01T00:00:01.000Z',
	});
}

function rollbackEvidenceFor(tid, refs) {
	const brokerMetadata = refs.map((ref, index) => ({
		ref,
		tenantId: tid,
		present: true,
		usable: true,
		managedByBroker: true,
		version: index + 1,
		keyId: 'metadata-only-kms-key',
		rotationSupported: true,
		deleteSupported: true,
		rawSecret: RAW_SECRET,
	}));
	return buildSecretMigrationRollbackEvidence({
		tenantId: tid,
		secretRefs: refs,
		pathClasses: ['fixtures/auth/playwright/*.state.json', 'flows/*.values.json'],
		brokerMetadata,
		broker: {
			provider: 'metadata-only-fake-broker',
			connectorId: 'metadata-only-fake-secret-broker',
			kmsKeyConfigured: true,
			tenantScoped: true,
			encryptedAtRest: true,
			rotationSupported: true,
			deleteSupported: true,
			productionReady: true,
		},
		capturedBy: 'owner_route',
		capturedAt: '2099-03-01T00:01:00.000Z',
		reason: 'unit rollback evidence before plaintext retirement',
	});
}

function response() {
	return { status: 0, body: null };
}

function sendJson(res, status, body) {
	res.status = status;
	res.body = body;
}

function routeDeps(context, headers = {}) {
	return { sendJson, context, headers };
}

async function post(path, body, context = operatorContext, headers = {}) {
	const res = response();
	const handled = await routes.post(path, body || {}, res, routeDeps(context, headers));
	assert.equal(handled, true, `POST ${path} is handled`);
	return res;
}

async function get(path, context = operatorContext) {
	const res = response();
	const url = new URL(`http://127.0.0.1${path}`);
	const handled = await routes.get(url.pathname, url, res, routeDeps(context));
	assert.equal(handled, true, `GET ${path} is handled`);
	return res;
}

function assertSafe(res, label, extraForbidden = []) {
	const text = JSON.stringify(res);
	assert(!text.includes(RAW_SECRET), `${label} must not expose raw secret marker`);
	for (const raw of extraForbidden) {
		assert(!text.includes(raw), `${label} must not expose secret ref ${raw}`);
	}
	assert.equal(res.body.metadataOnly, true, `${label} is metadata-only`);
	assert.equal(res.body.sanitized, true, `${label} is sanitized`);
	assert.equal(res.body.secretContentsInspected, false, `${label} does not inspect secret contents`);
	assert.equal(res.body.readsSecretBytes, false, `${label} does not read secret bytes`);
	assert.equal(res.body.writesSecretBytes, false, `${label} does not write secret bytes`);
	assert.equal(res.body.deletesPlaintext, false, `${label} does not delete plaintext`);
	assert.equal(res.body.sideEffects, false, `${label} has no side effects`);
	assert.equal(res.body.secretByteAccessorCalled, false, `${label} did not call secret byte accessors`);
}

const contract = secretMigrationRouteContract();
assert.equal(contract.contract, 'webui-secret-migration-routes/v1', 'route contract is explicit');
assert.deepEqual(contract.idempotencyRequiredFor, ['plan', 'approve', 'stage', 'commit', 'rollback'], 'mutation idempotency expectation is declared');
assert.equal(await routes.post('/api/not-secret-migration/plan', {}, response(), routeDeps(operatorContext)), false, 'non-secret route falls through');

const requiredSecretRefs = refsFor(tenantId);
const readyPlan = planFor(tenantId);
const approvalManifest = approvalFor(tenantId, requiredSecretRefs);
const rollbackEvidence = rollbackEvidenceFor(tenantId, requiredSecretRefs);

let res = await get(`/api/secret-migration/status?tenantId=${tenantId}`);
assert.equal(res.status, 200, 'status route returns 200');
assert.equal(res.body.state, 'not_planned', 'status starts empty');
assertSafe(res, 'initial status');

res = await post('/api/secret-migration/plan', {
	tenantId,
	plan: readyPlan,
	requiredSecretRefs,
}, null, { 'Idempotency-Key': 'no-context-key' });
assert.equal(res.status, 401, 'missing request tenant context fails closed');
assert.equal(res.body.error, 'secret-migration-tenant-context-required', 'missing tenant context reason is explicit');
assertSafe(res, 'missing context response');

res = await post('/api/secret-migration/plan', {
	tenantId,
	plan: readyPlan,
	requiredSecretRefs,
}, viewerContext, { 'Idempotency-Key': 'viewer-plan-key' });
assert.equal(res.status, 403, 'viewer cannot persist a migration plan');
assert.equal(res.body.error, 'secret-migration-operator-role-required', 'viewer mutation reason is explicit');
assertSafe(res, 'viewer mutation denial');

res = await post('/api/secret-migration/dry-run', {
	tenantId,
	plan: readyPlan,
	requiredSecretRefs,
	rawSecret: RAW_SECRET,
}, viewerContext);
assert.equal(res.status, 200, 'viewer can request metadata-only dry-run preview');
assert.equal(res.body.persisted, false, 'dry-run preview is not persisted');
assert.equal(res.body.workflow.state, 'planned', 'dry-run previews a planned workflow');
assert.equal(res.body.workflow.scope.requiredSecretRefCount, 2, 'dry-run route counts required secret refs without returning them');
assert.equal(res.body.workflow.summary.requiredSecretRefCount, 2, 'dry-run route summary carries sanitized ref counts');
assertSafe(res, 'dry-run route response', requiredSecretRefs);

res = await post('/api/secret-migration/plan', {
	tenantId,
	plan: readyPlan,
	requiredSecretRefs,
});
assert.equal(res.status, 428, 'plan route requires idempotency');
assert.equal(res.body.error, 'missing-idempotency-key', 'missing idempotency reason is explicit');
assertSafe(res, 'missing idempotency response', requiredSecretRefs);

const planBody = {
	tenantId,
	plan: readyPlan,
	requiredSecretRefs,
	brokerMetadata: [{ ref: requiredSecretRefs[0], rawSecret: RAW_SECRET }],
};
res = await post('/api/secret-migration/plan', planBody, operatorContext, { 'Idempotency-Key': 'route-plan-key' });
assert.equal(res.status, 200, 'plan route persists a migration workflow');
assert.equal(res.body.workflow.state, 'planned', 'plan state is stored');
assert.equal(res.body.idempotency.keyPresent, true, 'plan records idempotency metadata');
assertSafe(res, 'plan route response', requiredSecretRefs);

let replay = await post('/api/secret-migration/plan', planBody, operatorContext, { 'Idempotency-Key': 'route-plan-key' });
assert.equal(replay.status, 200, 'same idempotency request replays');
assert.equal(replay.body.idempotency.replay, true, 'replay is marked');
assertSafe(replay, 'plan replay response', requiredSecretRefs);

res = await post('/api/secret-migration/plan', {
	tenantId,
	plan: { ...readyPlan, operations: readyPlan.operations.slice(0, 1) },
	requiredSecretRefs,
}, operatorContext, { 'Idempotency-Key': 'route-plan-key' });
assert.equal(res.status, 409, 'idempotency key with different body conflicts');
assert.equal(res.body.error, 'idempotency-key-conflict', 'idempotency conflict reason is explicit');
assertSafe(res, 'idempotency conflict response', requiredSecretRefs);

res = await post('/api/secret-migration/plan', {
	tenantId: 'tenant_route_b',
	plan: planFor('tenant_route_b'),
	requiredSecretRefs: refsFor('tenant_route_b'),
}, operatorContext, { 'Idempotency-Key': 'tenant-mismatch-key' });
assert.equal(res.status, 400, 'body tenant outside request context fails closed');
assert.equal(res.body.error, 'secret-migration-api-tenant-mismatch', 'tenant mismatch reason is explicit');
assertSafe(res, 'tenant mismatch response', refsFor('tenant_route_b'));

res = await post('/api/secret-migration/approve', {
	tenantId,
	requiredSecretRefs,
}, operatorContext, { 'Idempotency-Key': 'missing-approval-key' });
assert.equal(res.status, 403, 'approve route requires an operator approval manifest');
assert(res.body.workflow.findings.some((item) => item.reason === 'missing-operator-approval-manifest'), 'missing approval finding is surfaced');
assertSafe(res, 'missing approval response', requiredSecretRefs);

res = await get(`/api/secret-migration/status?tenantId=${tenantId}`);
assert.equal(res.body.state, 'planned', 'missing approval does not mutate stored workflow');
assert.equal(res.body.summary.requiredSecretRefCount, 2, 'status route keeps sanitized persisted ref counts');
assertSafe(res, 'status after missing approval', requiredSecretRefs);

res = await post('/api/secret-migration/approve', {
	tenantId,
	requiredSecretRefs,
	operatorApprovalManifest: approvalManifest,
}, operatorContext, { 'Idempotency-Key': 'approve-route-key' });
assert.equal(res.status, 200, 'approved manifest advances workflow');
assert.equal(res.body.workflow.state, 'approved', 'approval state is stored');
assert.equal(res.body.workflow.approvalManifest.ok, true, 'approval manifest validates');
assertSafe(res, 'approve route response', requiredSecretRefs);

res = await post('/api/secret-migration/commit', {
	tenantId,
	requiredSecretRefs,
	rollbackEvidence,
}, operatorContext, { 'Idempotency-Key': 'commit-before-stage-key' });
assert.equal(res.status, 409, 'commit before stage fails closed');
assert(res.body.workflow.findings.some((item) => item.reason === 'secret-migration-transition-not-allowed'), 'invalid transition finding is surfaced');
assertSafe(res, 'invalid transition response', requiredSecretRefs);

res = await post('/api/secret-migration/stage', {
	tenantId,
	requiredSecretRefs,
	brokerMetadata: [
		{ ref: requiredSecretRefs[0], present: true, usable: true, version: 1, keyId: 'metadata-only-kms-key', rawSecret: RAW_SECRET },
		{ ref: requiredSecretRefs[1], present: true, usable: true, version: 1, keyId: 'metadata-only-kms-key', rawSecret: RAW_SECRET },
	],
}, operatorContext, { 'Idempotency-Key': 'stage-route-key' });
assert.equal(res.status, 200, 'stage route accepts metadata-only broker readiness');
assert.equal(res.body.workflow.state, 'staged', 'stage transition is stored');
assert.equal(res.body.workflow.brokerScope.presentCount, 2, 'stage describes required metadata');
assert.equal(res.body.brokerAdapter.secretByteAccessorCalls, 0, 'route staging did not call secret byte accessors');
assert.equal(res.body.secretByteAccessorCalled, false, 'route response proves secret byte accessor was not called');
assertSafe(res, 'stage route response', requiredSecretRefs);

res = await post('/api/secret-migration/commit', {
	tenantId,
	requiredSecretRefs,
	rollbackEvidence,
}, operatorContext, { 'Idempotency-Key': 'commit-route-key' });
assert.equal(res.status, 200, 'commit route accepts rollback evidence');
assert.equal(res.body.workflow.state, 'committed', 'commit metadata state is stored');
assert.equal(res.body.workflow.rollbackEvidence.ok, true, 'rollback evidence is summarized only');
assertSafe(res, 'commit route response', requiredSecretRefs);

res = await post('/api/secret-migration/rollback', {
	tenantId,
	requiredSecretRefs,
	rollbackEvidence,
}, operatorContext, { 'Idempotency-Key': 'rollback-route-key' });
assert.equal(res.status, 200, 'rollback route accepts rollback evidence after commit');
assert.equal(res.body.workflow.state, 'rolled_back', 'rollback metadata state is stored');
assertSafe(res, 'rollback route response', requiredSecretRefs);

res = await get(`/api/secret-migration/status?tenantId=${tenantId}`);
assert.equal(res.status, 200, 'final status route returns 200');
assert.equal(res.body.state, 'rolled_back', 'final status reports latest workflow state');
assertSafe(res, 'final status route response', requiredSecretRefs);

console.log('  webui-secret-migration-route-unit: WebUI route adapter checks passed');
NODE
)
