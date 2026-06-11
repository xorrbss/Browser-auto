#!/usr/bin/env bash
# Browser-free checks for the route-independent secret migration API helper.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import {
	createSecretMigrationApi,
	createMetadataOnlySecretBrokerAdapter,
} from './webui/secret-migration-api.js';
import {
	buildSecretMigrationApprovalManifest,
	makeSecretRef,
} from './webui/secrets.js';
import {
	buildSecretMigrationRollbackEvidence,
} from './webui/secret-migration.js';

const RAW_SECRET = 'SECRET_BYTES_NEVER_OUTPUT';
const api = createSecretMigrationApi({
	now: () => '2099-01-01T00:00:00.000Z',
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
		secretBytes: RAW_SECRET,
	};
}

function planFor(tenantId) {
	return {
		planner: 'webui-secret-migration-plan/v1',
		tenantId,
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
		ignoredSecretNote: RAW_SECRET,
	};
}

function refsFor(tenantId) {
	return [
		makeSecretRef({ tenantId, kind: 'auth-state', name: 'canonical:appalpha' }),
		makeSecretRef({ tenantId, kind: 'flow-values', name: 'checkout' }),
	];
}

function approvalFor(tenantId, refs) {
	return buildSecretMigrationApprovalManifest({
		tenantId,
		requester: 'owner_a',
		purpose: 'unit API secret migration dry-run',
		secretRefs: refs,
		pathClasses: ['fixtures/auth/playwright/*.state.json', 'flows/*.values.json'],
		approvedBy: 'owner_a',
		approvedAt: '2099-01-01T00:00:00.000Z',
		createdAt: '2099-01-01T00:00:01.000Z',
	});
}

function rollbackEvidenceFor(tenantId, refs) {
	const brokerMetadata = refs.map((ref, index) => ({
		ref,
		tenantId,
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
		tenantId,
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
		capturedBy: 'owner_a',
		capturedAt: '2099-01-01T00:02:00.000Z',
		reason: 'unit rollback evidence before plaintext retirement',
	});
}

function assertSafeResponse(response, label, extraForbidden = []) {
	const serialized = JSON.stringify(response);
	assert(!serialized.includes(RAW_SECRET), `${label} must not expose raw secret-shaped input`);
	for (const raw of extraForbidden) {
		assert(!serialized.includes(raw), `${label} must not expose ${raw}`);
	}
	assert.equal(response.body.metadataOnly, true, `${label} is metadata-only`);
	assert.equal(response.body.sanitized, true, `${label} is sanitized`);
	assert.equal(response.body.secretContentsInspected, false, `${label} does not inspect secret contents`);
	assert.equal(response.body.readsSecretBytes, false, `${label} does not read secret bytes`);
	assert.equal(response.body.writesSecretBytes, false, `${label} does not write secret bytes`);
	assert.equal(response.body.deletesPlaintext, false, `${label} does not delete plaintext`);
	assert.equal(response.body.sideEffects, false, `${label} has no side effects`);
	assert.equal(response.body.secretByteAccessorCalled, false, `${label} does not call byte accessors`);
}

const tenantId = 'tenant_a';
const requiredSecretRefs = refsFor(tenantId);
const readyPlan = planFor(tenantId);
const approvalManifest = approvalFor(tenantId, requiredSecretRefs);
const rollbackEvidence = rollbackEvidenceFor(tenantId, requiredSecretRefs);

let response = await api.handle({
	method: 'POST',
	url: '/api/secret-migration/dry-run',
	context: { tenantId, actor: { id: 'operator_a' } },
	body: {
		tenantId,
		plan: readyPlan,
		requiredSecretRefs,
		rawSecret: RAW_SECRET,
	},
});
assert.equal(response.status, 200, 'dry-run returns a successful JSON contract');
assert.equal(response.body.ok, true, 'dry-run is not blocked');
assert.equal(response.body.persisted, false, 'dry-run does not mutate workflow status');
assert.equal(response.body.workflow.state, 'planned', 'dry-run creates a planned workflow preview');
assert.equal(response.body.workflow.scope.requiredSecretRefCount, 2, 'dry-run counts required secret refs without returning them');
assert.equal(response.body.workflow.summary.requiredSecretRefCount, 2, 'dry-run summary carries sanitized ref counts');
assertSafeResponse(response, 'dry-run response', requiredSecretRefs);

response = await api.handle({
	method: 'GET',
	url: '/api/secret-migration/status?tenantId=tenant_a',
	context: { tenantId },
});
assert.equal(response.body.state, 'not_planned', 'dry-run leaves status empty');
assert.equal(response.body.hasWorkflow, false, 'dry-run preview is not persisted as status');
assert.equal(response.body.summary.requiredSecretRefCount, 0, 'empty status has no persisted secret refs');
assertSafeResponse(response, 'empty status response');

const planRequest = {
	method: 'POST',
	url: '/api/secret-migration/plan',
	headers: { 'Idempotency-Key': 'plan-key-1' },
	context: { tenantId },
	body: {
		tenantId,
		plan: readyPlan,
		requiredSecretRefs,
		brokerMetadata: [{ ref: requiredSecretRefs[0], rawSecret: RAW_SECRET }],
	},
};
const planned = await api.handle(planRequest);
assert.equal(planned.status, 200, 'plan stores planned workflow');
assert.equal(planned.body.ok, true, 'plan is accepted');
assert.equal(planned.body.persisted, true, 'plan persists status');
assert.equal(planned.body.workflow.state, 'planned', 'planned workflow waits for approval');
assert.equal(planned.body.idempotency.keyPresent, true, 'plan records idempotency metadata');
assertSafeResponse(planned, 'plan response', requiredSecretRefs);

const plannedReplay = await api.handle(planRequest);
assert.equal(plannedReplay.status, 200, 'same idempotency key replays original plan');
assert.equal(plannedReplay.body.idempotency.replay, true, 'plan replay is marked');
assert.equal(plannedReplay.body.workflow.state, 'planned', 'replayed plan keeps original state');
assertSafeResponse(plannedReplay, 'plan idempotency replay', requiredSecretRefs);

const planConflict = await api.handle({
	...planRequest,
	body: {
		...planRequest.body,
		plan: { ...readyPlan, operations: readyPlan.operations.slice(0, 1) },
	},
});
assert.equal(planConflict.status, 409, 'same idempotency key with a different body conflicts');
assert.equal(planConflict.body.ok, false, 'idempotency conflict is fail-closed');
assert.equal(planConflict.body.error, 'idempotency-key-conflict', 'idempotency conflict reason is explicit');
assertSafeResponse(planConflict, 'idempotency conflict response', requiredSecretRefs);

const tenantMismatch = await api.handle({
	method: 'POST',
	url: '/api/secret-migration/plan',
	headers: { 'Idempotency-Key': 'tenant-mismatch-key' },
	context: { tenantId },
	body: {
		tenantId: 'tenant_b',
		plan: planFor('tenant_b'),
		requiredSecretRefs: refsFor('tenant_b'),
	},
});
assert.equal(tenantMismatch.status, 400, 'tenant mismatch fails closed');
assert.equal(tenantMismatch.body.error, 'secret-migration-api-tenant-mismatch', 'tenant mismatch is explicit');
assertSafeResponse(tenantMismatch, 'tenant mismatch response', refsFor('tenant_b'));

const missingApproval = await api.handle({
	method: 'POST',
	url: '/api/secret-migration/approve',
	headers: { 'Idempotency-Key': 'missing-approval-key' },
	context: { tenantId },
	body: {
		tenantId,
		requiredSecretRefs,
	},
});
assert.equal(missingApproval.status, 403, 'missing operator approval manifest fails closed');
assert.equal(missingApproval.body.ok, false, 'missing approval is blocked');
assert(missingApproval.body.workflow.findings.some((item) => item.reason === 'missing-operator-approval-manifest'), 'missing approval finding is present');
assertSafeResponse(missingApproval, 'missing approval response', requiredSecretRefs);

response = await api.handle({
	method: 'GET',
	url: '/api/secret-migration/status',
	context: { tenantId },
});
assert.equal(response.body.state, 'planned', 'missing approval does not mutate the stored planned workflow');
assertSafeResponse(response, 'planned status after missing approval', requiredSecretRefs);

response = await api.handle({
	method: 'POST',
	url: '/api/secret-migration/approve',
	headers: { 'Idempotency-Key': 'approve-key-1' },
	context: { tenantId },
	body: {
		tenantId,
		requiredSecretRefs,
		operatorApprovalManifest: approvalManifest,
	},
});
assert.equal(response.status, 200, 'approved manifest advances the API workflow');
assert.equal(response.body.workflow.state, 'approved', 'approval transition is recorded');
assert.equal(response.body.workflow.approvalManifest.ok, true, 'approval manifest is validated and summarized');
assert.equal(response.body.workflow.approvalManifest.refCount, 2, 'approval response reports ref count only');
assertSafeResponse(response, 'approve response', requiredSecretRefs);

const invalidTransition = await api.handle({
	method: 'POST',
	url: '/api/secret-migration/commit',
	headers: { 'Idempotency-Key': 'commit-too-soon-key' },
	context: { tenantId },
	body: {
		tenantId,
		requiredSecretRefs,
		rollbackEvidence,
	},
});
assert.equal(invalidTransition.status, 409, 'commit before stage fails closed');
assert.equal(invalidTransition.body.ok, false, 'invalid transition is blocked');
assert(invalidTransition.body.workflow.findings.some((item) => item.reason === 'secret-migration-transition-not-allowed'), 'invalid transition finding is present');
assertSafeResponse(invalidTransition, 'invalid transition response', requiredSecretRefs);

response = await api.handle({
	method: 'GET',
	url: '/api/secret-migration/status',
	context: { tenantId },
});
assert.equal(response.body.state, 'approved', 'invalid transition does not mutate the stored approved workflow');
assertSafeResponse(response, 'approved status response', requiredSecretRefs);

response = await api.handle({
	method: 'POST',
	url: '/api/secret-migration/stage',
	headers: { 'Idempotency-Key': 'stage-key-1' },
	context: { tenantId },
	body: {
		tenantId,
		requiredSecretRefs,
		brokerMetadata: [
			{ ref: requiredSecretRefs[0], present: true, usable: true, version: 1, keyId: 'metadata-only-kms-key', rawSecret: RAW_SECRET },
			{ ref: requiredSecretRefs[1], present: true, usable: true, version: 1, keyId: 'metadata-only-kms-key', rawSecret: RAW_SECRET },
		],
	},
});
assert.equal(response.status, 200, 'metadata-only broker staging succeeds');
assert.equal(response.body.workflow.state, 'staged', 'stage transition is recorded');
assert.equal(response.body.workflow.broker.contractOk, true, 'broker method contract validates');
assert.equal(response.body.workflow.broker.tenantScoped, true, 'tenant-scoped broker is required');
assert.equal(response.body.workflow.brokerScope.presentCount, 2, 'stage describes only required secret metadata');
assert.equal(response.body.workflow.executionContract.allowed, true, 'stage exposes dry-run execution readiness');
assert.equal(response.body.brokerAdapter.metadataOnly, true, 'stage uses metadata-only fake adapter');
assert.equal(response.body.brokerAdapter.secretByteAccessorCalls, 0, 'stage did not call secret byte accessors');
assert(response.body.brokerAdapter.describeSecretCalls >= 2, 'stage uses metadata reads for required refs');
assertSafeResponse(response, 'stage response', requiredSecretRefs);

response = await api.handle({
	method: 'POST',
	url: '/api/secret-migration/commit',
	headers: { 'Idempotency-Key': 'commit-key-1' },
	context: { tenantId },
	body: {
		tenantId,
		requiredSecretRefs,
		rollbackEvidence,
	},
});
assert.equal(response.status, 200, 'commit with rollback evidence succeeds');
assert.equal(response.body.workflow.state, 'committed', 'commit metadata transition is recorded');
assert.equal(response.body.workflow.rollbackEvidence.ok, true, 'commit returns sanitized rollback evidence metadata');
assertSafeResponse(response, 'commit response', requiredSecretRefs);

response = await api.handle({
	method: 'POST',
	url: '/api/secret-migration/rollback',
	headers: { 'Idempotency-Key': 'rollback-key-1' },
	context: { tenantId },
	body: {
		tenantId,
		requiredSecretRefs,
		rollbackEvidence,
	},
});
assert.equal(response.status, 200, 'rollback after commit succeeds');
assert.equal(response.body.workflow.state, 'rolled_back', 'rollback transition is recorded');
assertSafeResponse(response, 'rollback response', requiredSecretRefs);

response = await api.handle({
	method: 'GET',
	url: '/api/secret-migration/status',
	context: { tenantId },
});
assert.equal(response.status, 200, 'status endpoint returns JSON');
assert.equal(response.body.state, 'rolled_back', 'status reports latest workflow state');
assert.equal(response.body.workflow.summary.requiredSecretRefCount, 2, 'status reports sanitized ref counts');
assertSafeResponse(response, 'final status response', requiredSecretRefs);

const missingIdempotency = await api.handle({
	method: 'POST',
	url: '/api/secret-migration/plan',
	context: { tenantId: 'tenant_c' },
	body: {
		tenantId: 'tenant_c',
		plan: planFor('tenant_c'),
		requiredSecretRefs: refsFor('tenant_c'),
	},
});
assert.equal(missingIdempotency.status, 428, 'mutations require an idempotency key');
assert.equal(missingIdempotency.body.error, 'missing-idempotency-key', 'missing idempotency reason is explicit');
assertSafeResponse(missingIdempotency, 'missing idempotency response', refsFor('tenant_c'));

const adapter = createMetadataOnlySecretBrokerAdapter({
	tenantId: 'tenant_z',
	secretRefs: refsFor('tenant_z'),
});
assert.equal(adapter.summary().metadataOnly, true, 'exported fake adapter is metadata-only');
assert.equal(adapter.summary().secretByteAccessorCalls, 0, 'adapter starts with no byte accessor calls');
await adapter.broker.describeSecret(refsFor('tenant_z')[0]);
assert.equal(adapter.summary().describeSecretCalls, 1, 'adapter supports metadata describe calls');
assert.equal(adapter.summary().secretByteAccessorCalls, 0, 'metadata describe does not touch bytes');

console.log('  webui-secret-migration-api-unit: route-independent API workflow checks passed');
NODE
)
