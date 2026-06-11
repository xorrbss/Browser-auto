#!/usr/bin/env bash
# Browser-free checks for metadata-only secret migration workflow state machine.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import {
	buildSecretMigrationApprovalManifest,
	createFakeSecretBrokerForTests,
	createSecretStore,
} from './webui/secrets.js';
import {
	advanceSecretMigrationWorkflow,
	buildSecretMigrationRollbackEvidence,
	createSecretMigrationWorkflow,
	validateSecretMigrationRollbackEvidence,
} from './webui/secret-migration.js';

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
	};
}

function assertMetadataOnly(value, label, extra = []) {
	const serialized = JSON.stringify(value);
	for (const raw of [
		'appalpha',
		'legacyapp',
		'checkout',
		'SYNTHETIC_AUTH_COPY',
		'SYNTHETIC_AUTH_COPY_ROTATED',
		'SYNTHETIC_LEGACY_COPY',
		'SYNTHETIC_FLOW_COPY',
		...extra,
	]) {
		assert(!serialized.includes(raw), `${label} must not expose ${raw}`);
	}
	assert.equal(value.secretContentsInspected, false, `${label} does not inspect secret contents`);
	assert.equal(value.readsSecretBytes, false, `${label} does not read secret bytes`);
	assert.equal(value.writesSecretBytes, false, `${label} does not write secret bytes`);
	assert.equal(value.deletesPlaintext, false, `${label} does not delete plaintext`);
	assert.equal(value.sideEffects, false, `${label} has no side effects`);
}

let brokerTick = 1000;
const productionBroker = createFakeSecretBrokerForTests({
	keyId: 'unit-production-kms-key',
	provider: 'unit-production-broker',
	testOnly: false,
	productionReady: true,
	now: () => ++brokerTick,
});
let brokerRawReads = 0;
productionBroker.getBytes = async () => {
	brokerRawReads += 1;
	throw new Error('secret migration workflow must not read secret bytes');
};
const productionStore = createSecretStore({
	backend: 'external-broker',
	tenantId: 'tenant_a',
	broker: productionBroker,
});
await productionStore.putBytes({ kind: 'auth-state', name: 'canonical:appalpha', bytes: 'SYNTHETIC_AUTH_COPY' });
await productionStore.putBytes({ kind: 'auth-state', name: 'legacy:legacyapp', bytes: 'SYNTHETIC_LEGACY_COPY' });
await productionStore.putBytes({ kind: 'flow-values', name: 'checkout', bytes: 'SYNTHETIC_FLOW_COPY' });

const requiredSecretRefs = [
	productionStore.ref('auth-state', 'canonical:appalpha'),
	productionStore.ref('auth-state', 'legacy:legacyapp'),
	productionStore.ref('flow-values', 'checkout'),
];
const pathClasses = [
	'fixtures/auth/playwright/*.state.json',
	'approve/*.pw-state.json',
	'flows/*.values.json',
];
const readyPlan = {
	planner: 'webui-secret-migration-plan/v1',
	tenantId: 'tenant_a',
	root: 'repository',
	dryRun: true,
	sanitized: true,
	secretContentsInspected: false,
	migratesSecrets: false,
	operations: [
		readyOperation({ kind: 'auth-state', source: 'canonical-auth-state', pathClass: pathClasses[0] }),
		readyOperation({ kind: 'auth-state', source: 'legacy-auth-state', pathClass: pathClasses[1] }),
		readyOperation({ kind: 'flow-values', source: 'flow-values', pathClass: pathClasses[2] }),
	],
};
const approvalManifest = buildSecretMigrationApprovalManifest({
	tenantId: 'tenant_a',
	requester: 'owner_a',
	purpose: 'unit secret migration workflow dry-run',
	secretRefs: requiredSecretRefs,
	pathClasses,
	approvedBy: 'owner_a',
	approvedAt: '2099-01-01T00:00:00.000Z',
	createdAt: '2099-01-01T00:00:01.000Z',
});

let workflow = createSecretMigrationWorkflow({
	tenantId: 'tenant_a',
	plan: readyPlan,
	requiredSecretRefs,
});
assert.equal(workflow.workflow, 'webui-secret-migration-workflow/v1', 'workflow declares contract');
assert.equal(workflow.state, 'planned', 'workflow starts planned');
assert.equal(workflow.decision, 'requires-operator', 'planned workflow waits for operator approval');
assert.equal(workflow.scope.requiredSecretRefCount, 3, 'required refs are counted without returning refs');
assertMetadataOnly(workflow, 'planned workflow', requiredSecretRefs);

workflow = await advanceSecretMigrationWorkflow(workflow, {
	action: 'approve',
	approvalManifest,
	requiredSecretRefs,
});
assert.equal(workflow.state, 'approved', 'operator approval advances planned workflow');
assert.equal(workflow.approvalManifest.ok, true, 'approval manifest validates');
assert.equal(workflow.approvalManifest.refCount, 3, 'approval manifest reports ref count only');
assertMetadataOnly(workflow, 'approved workflow', requiredSecretRefs);

workflow = await advanceSecretMigrationWorkflow(workflow, {
	action: 'stage',
	approvalManifest,
	requiredSecretRefs,
	secretStore: productionStore,
});
assert.equal(workflow.state, 'staged', 'broker readiness advances approved workflow');
assert.equal(workflow.broker.contractOk, true, 'broker method contract is validated');
assert.equal(workflow.broker.tenantScoped, true, 'broker tenant scope is validated');
assert.equal(workflow.broker.rotationSupported, true, 'broker rotation readiness is validated');
assert.equal(workflow.broker.deleteSupported, true, 'broker delete readiness is validated');
assert.equal(workflow.brokerScope.presentCount, 3, 'required broker metadata is present');
assert.equal(workflow.brokerScope.rotationReadyCount, 3, 'required secret metadata is rotation-ready');
assert.equal(workflow.brokerScope.deleteReadyCount, 3, 'required secret metadata is delete-ready');
assert.equal(workflow.executionContract.allowed, true, 'dry-run execution contract is ready');
assert.equal(brokerRawReads, 0, 'staging never reads broker bytes');
assertMetadataOnly(workflow, 'staged workflow', requiredSecretRefs);

const rotatedMeta = await productionStore.rotate(requiredSecretRefs[0], 'SYNTHETIC_AUTH_COPY_ROTATED');
assert.equal(rotatedMeta.version, 2, 'fake broker rotation lifecycle is observed through metadata');
const brokerMetadata = [];
for (const ref of requiredSecretRefs) {
	brokerMetadata.push(await productionStore.describeSecret(ref));
}
const rollbackEvidence = buildSecretMigrationRollbackEvidence({
	tenantId: 'tenant_a',
	secretRefs: requiredSecretRefs,
	pathClasses,
	brokerMetadata,
	broker: productionBroker.describeConnector(),
	capturedBy: 'owner_a',
	capturedAt: '2099-01-01T00:01:00.000Z',
	reason: 'unit rollback evidence before plaintext retirement',
});
const evidenceCheck = validateSecretMigrationRollbackEvidence(rollbackEvidence, {
	tenantId: 'tenant_a',
	requiredSecretRefs,
});
assert.equal(evidenceCheck.ok, true, 'rollback evidence validates');
assert.equal(evidenceCheck.refCount, 3, 'rollback evidence reports ref count only');
assert.equal(evidenceCheck.readyCheckpointCount, 3, 'rollback evidence validates broker checkpoints');
assert.equal(evidenceCheck.rotationReadyCount, 3, 'rollback evidence validates rotation readiness');
assert.equal(evidenceCheck.deleteReadyCount, 3, 'rollback evidence validates delete readiness');
assert.equal(evidenceCheck.plaintextDeletionDeferred, true, 'rollback evidence keeps plaintext deletion deferred');
assertMetadataOnly({ ...evidenceCheck, ...{
	secretContentsInspected: false,
	readsSecretBytes: false,
	writesSecretBytes: false,
	deletesPlaintext: false,
	sideEffects: false,
} }, 'rollback evidence validation', requiredSecretRefs);

const committed = await advanceSecretMigrationWorkflow(workflow, {
	action: 'commit',
	rollbackEvidence,
	requiredSecretRefs,
});
assert.equal(committed.state, 'committed', 'rollback evidence advances staged workflow to committed metadata state');
assert.equal(committed.allowed, true, 'commit metadata transition is allowed');
assert.equal(committed.rollbackEvidence.ok, true, 'commit response includes sanitized rollback evidence metadata');
assertMetadataOnly(committed, 'committed workflow', requiredSecretRefs);

const rolledBack = await advanceSecretMigrationWorkflow(workflow, {
	action: 'rollback',
	rollbackEvidence,
	requiredSecretRefs,
});
assert.equal(rolledBack.state, 'rolled_back', 'rollback evidence can roll back a staged workflow');
assert.equal(rolledBack.allowed, true, 'rollback metadata transition is allowed');
assertMetadataOnly(rolledBack, 'rolled-back workflow', requiredSecretRefs);

let blocked = await advanceSecretMigrationWorkflow(createSecretMigrationWorkflow({
	tenantId: 'tenant_a',
	plan: readyPlan,
	requiredSecretRefs,
}), {
	action: 'approve',
	requiredSecretRefs,
});
assert.equal(blocked.state, 'blocked', 'missing approval manifest fails closed');
assert.equal(blocked.decision, 'requires-operator', 'missing approval returns requires-operator metadata');
assert(blocked.findings.some((item) => item.reason === 'missing-operator-approval-manifest'), 'missing approval is reported');
assertMetadataOnly(blocked, 'missing-approval workflow', requiredSecretRefs);

const tenantMismatchManifest = buildSecretMigrationApprovalManifest({
	tenantId: 'tenant_b',
	requester: 'owner_b',
	purpose: 'unit tenant mismatch',
	secretRefs: requiredSecretRefs,
	pathClasses,
	approvedBy: 'owner_b',
	approvedAt: '2099-01-01T00:00:00.000Z',
	createdAt: '2099-01-01T00:00:02.000Z',
});
blocked = await advanceSecretMigrationWorkflow(createSecretMigrationWorkflow({
	tenantId: 'tenant_a',
	plan: readyPlan,
	requiredSecretRefs,
}), {
	action: 'approve',
	approvalManifest: tenantMismatchManifest,
	requiredSecretRefs,
});
assert.equal(blocked.state, 'blocked', 'tenant mismatch fails closed');
assert(blocked.findings.some((item) => item.reason === 'secret-migration-tenant-mismatch'), 'tenant mismatch is reported');
assertMetadataOnly(blocked, 'tenant-mismatch workflow', requiredSecretRefs);

const capabilityGapBroker = createFakeSecretBrokerForTests({
	keyId: 'unit-production-kms-key',
	provider: 'unit-production-broker',
	testOnly: false,
	productionReady: true,
});
capabilityGapBroker.getBytes = async () => {
	brokerRawReads += 1;
	throw new Error('capability failure must not read secret bytes');
};
const capabilityGapStore = createSecretStore({
	backend: 'external-broker',
	tenantId: 'tenant_a',
	broker: capabilityGapBroker,
});
await capabilityGapStore.putBytes({ kind: 'auth-state', name: 'canonical:appalpha', bytes: 'SYNTHETIC_AUTH_COPY' });
await capabilityGapStore.putBytes({ kind: 'auth-state', name: 'legacy:legacyapp', bytes: 'SYNTHETIC_LEGACY_COPY' });
await capabilityGapStore.putBytes({ kind: 'flow-values', name: 'checkout', bytes: 'SYNTHETIC_FLOW_COPY' });
capabilityGapBroker.connector.rotationSupported = false;
capabilityGapBroker.connector.deleteSupported = false;
const approvedForGap = await advanceSecretMigrationWorkflow(createSecretMigrationWorkflow({
	tenantId: 'tenant_a',
	plan: readyPlan,
	requiredSecretRefs,
}), {
	action: 'approve',
	approvalManifest,
	requiredSecretRefs,
});
blocked = await advanceSecretMigrationWorkflow(approvedForGap, {
	action: 'stage',
	approvalManifest,
	requiredSecretRefs,
	secretStore: capabilityGapStore,
});
assert.equal(blocked.state, 'blocked', 'missing broker lifecycle capabilities fail closed');
assert(blocked.findings.some((item) => item.reason === 'secret-migration-broker-rotation-unsupported'), 'missing broker rotation is reported');
assert(blocked.findings.some((item) => item.reason === 'secret-migration-broker-delete-unsupported'), 'missing broker delete is reported');
assertMetadataOnly(blocked, 'capability-gap workflow', requiredSecretRefs);

blocked = await advanceSecretMigrationWorkflow(workflow, {
	action: 'commit',
	requiredSecretRefs,
});
assert.equal(blocked.state, 'blocked', 'missing rollback evidence fails closed');
assert.equal(blocked.decision, 'requires-operator', 'missing rollback evidence returns requires-operator metadata');
assert(blocked.findings.some((item) => item.reason === 'missing-secret-migration-rollback-evidence'), 'missing rollback evidence is reported');
assertMetadataOnly(blocked, 'missing-rollback-evidence workflow', requiredSecretRefs);

const partialEvidence = buildSecretMigrationRollbackEvidence({
	tenantId: 'tenant_a',
	secretRefs: [requiredSecretRefs[0]],
	pathClasses,
	brokerMetadata: [brokerMetadata[0]],
	broker: productionBroker.describeConnector(),
	capturedBy: 'owner_a',
	capturedAt: '2099-01-01T00:02:00.000Z',
});
const partialEvidenceCheck = validateSecretMigrationRollbackEvidence(partialEvidence, {
	tenantId: 'tenant_a',
	requiredSecretRefs,
});
assert.equal(partialEvidenceCheck.ok, false, 'partial rollback evidence fails validation');
assert.equal(partialEvidenceCheck.missingRequiredRefCount, 2, 'partial rollback evidence counts missing refs');
blocked = await advanceSecretMigrationWorkflow(workflow, {
	action: 'commit',
	rollbackEvidence: partialEvidence,
	requiredSecretRefs,
});
assert.equal(blocked.state, 'blocked', 'partial rollback evidence blocks commit');
assert(blocked.findings.some((item) => item.reason === 'missing-secret-migration-rollback-ref'), 'missing rollback refs are reported');
assertMetadataOnly(blocked, 'partial-rollback-evidence workflow', requiredSecretRefs);

assert.equal(brokerRawReads, 0, 'all workflow lifecycle checks avoid broker byte reads');
console.log('  webui-secret-migration-workflow-unit: metadata-only workflow lifecycle checks passed');
NODE
)
