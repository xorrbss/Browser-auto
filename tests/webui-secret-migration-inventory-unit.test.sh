#!/usr/bin/env bash
# Browser-free checks for metadata-only plaintext secret migration inventory.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/fixtures/auth/playwright" "$TMP/approve" "$TMP/flows"
cat > "$TMP/fixtures/auth/playwright/appalpha.state.json" <<'JSON'
{"cookies":[{"name":"session","value":"AUTH_SECRET_ALPHA"}],"origins":[]}
JSON
cat > "$TMP/approve/legacyapp.pw-state.json" <<'JSON'
{"cookies":[{"name":"legacy","value":"AUTH_SECRET_LEGACY"}],"origins":[]}
JSON
cat > "$TMP/flows/checkout.values.json" <<'JSON'
{"input_1":"VALUE_SECRET_CHECKOUT"}
JSON
cat > "$TMP/flows/bad.name.values.json" <<'JSON'
{"input_1":"VALUE_SECRET_BAD_NAME"}
JSON

( cd "$DIR" && TMP="$TMP" node --input-type=module - <<'NODE'
import path from 'node:path';
import assert from 'node:assert/strict';
import {
	buildSecretMigrationApprovalManifest,
	createFakeSecretBrokerForTests,
	createSecretStore,
	inventoryPlaintextSecretMigration,
	planPlaintextSecretMigration,
	productionSecretMigrationExecutionContract,
	validateSecretMigrationApprovalManifest,
} from './webui/secrets.js';

const rootDir = process.env.TMP;
let inventory = await inventoryPlaintextSecretMigration({ rootDir, tenantId: 'tenant_a' });
assert.equal(inventory.scanner, 'webui-secret-migration-inventory/v1', 'inventory declares scanner');
assert.equal(inventory.root, 'repository', 'inventory does not expose the root path');
assert.equal(inventory.summary.total, 4, 'all plaintext candidates are counted');
assert.equal(inventory.summary.byKind['auth-state'], 2, 'auth states are counted');
assert.equal(inventory.summary.byKind['flow-values'], 2, 'flow values are counted');
assert.equal(inventory.summary.byPathClass['fixtures/auth/playwright/*.state.json'], 1, 'canonical auth path class is counted');
assert.equal(inventory.summary.byPathClass['approve/*.pw-state.json'], 1, 'legacy auth path class is counted');
assert.equal(inventory.summary.byPathClass['flows/*.values.json'], 2, 'flow values path class is counted');
assert.equal(inventory.summary.pendingMigration, 3, 'valid plaintext files are pending without a secure copy');
assert.equal(inventory.summary.invalidName, 1, 'invalid names are counted without exposing names');

for (const entry of inventory.entries) {
	assert(!('path' in entry), 'entry does not expose path');
	assert(!('fullPath' in entry), 'entry does not expose fullPath');
	assert(!('file' in entry), 'entry does not expose file name');
	assert(!('name' in entry), 'entry does not expose app or flow name');
	assert(['auth-state', 'flow-values'].includes(entry.kind), 'entry includes kind');
	assert(entry.pathClass.includes('*'), 'entry exposes only wildcard path class');
	assert(entry.status, 'entry includes migration status');
}

let serialized = JSON.stringify(inventory);
for (const raw of [
	rootDir,
	'appalpha',
	'legacyapp',
	'checkout',
	'bad.name',
	'AUTH_SECRET_ALPHA',
	'AUTH_SECRET_LEGACY',
	'VALUE_SECRET_CHECKOUT',
	'VALUE_SECRET_BAD_NAME',
]) {
	assert(!serialized.includes(raw), `inventory must not expose ${raw}`);
}

const store = createSecretStore({
	backend: 'encrypted-local',
	rootDir: path.join(rootDir, 'secret-store'),
	tenantId: 'tenant_a',
	keyMaterial: 'inventory-local-test-key',
});
await store.putBytes({ kind: 'auth-state', name: 'canonical:appalpha', bytes: '{"cookies":[],"origins":[]}' });
await store.putBytes({ kind: 'flow-values', name: 'checkout', bytes: '{"input_1":"MIGRATED_VALUE_SECRET"}' });

inventory = await inventoryPlaintextSecretMigration({ rootDir, tenantId: 'tenant_a', secretStore: store });
assert.equal(inventory.summary.withSecureCopy, 2, 'secure copies are detected by metadata');
assert.equal(inventory.summary.pendingMigration, 1, 'remaining valid plaintext is still pending');
assert.equal(inventory.summary.bySecureStatus['secure-present'], 2, 'secure-present status is counted');
assert.equal(inventory.summary.bySecureStatus['secure-missing'], 2, 'secure-missing status covers pending and invalid entries');

serialized = JSON.stringify(inventory);
for (const raw of ['appalpha', 'checkout', 'MIGRATED_VALUE_SECRET', rootDir]) {
	assert(!serialized.includes(raw), `secure inventory must not expose ${raw}`);
}

const plan = await planPlaintextSecretMigration({ inventory });
assert.equal(plan.planner, 'webui-secret-migration-plan/v1', 'migration plan declares planner');
assert.equal(plan.dryRun, true, 'migration plan is dry-run only');
assert.equal(plan.sanitized, true, 'migration plan is sanitized');
assert.equal(plan.secretContentsInspected, false, 'migration plan does not inspect secret contents');
assert.equal(plan.migratesSecrets, false, 'migration plan does not migrate secret bytes');
assert.equal(plan.operations.length, inventory.entries.length, 'one sanitized operation per inventory entry');
assert.equal(plan.summary.readyForRetirePlaintext, 2, 'secure copies are planned for operator-verified retirement');
assert.equal(plan.summary.byAction['operator-verify-secure-copy-then-retire-plaintext'], 2, 'retire action is counted');
assert.equal(plan.operations.some((op) => op.action === 'manual-review-invalid-name'), true, 'invalid names require manual review');
for (const op of plan.operations) {
	assert(!('path' in op), 'plan operation does not expose path');
	assert(!('file' in op), 'plan operation does not expose file name');
	assert(!('name' in op), 'plan operation does not expose app or flow name');
	assert.equal(op.readsSecretBytes, false, 'plan operation does not read bytes');
	assert.equal(op.writesSecretBytes, false, 'plan operation does not write bytes');
	assert.equal(op.deletesPlaintext, false, 'plan operation does not delete without operator approval');
}

serialized = JSON.stringify(plan);
for (const raw of [
	rootDir,
	'appalpha',
	'legacyapp',
	'checkout',
	'bad.name',
	'AUTH_SECRET_ALPHA',
	'AUTH_SECRET_LEGACY',
	'VALUE_SECRET_CHECKOUT',
	'VALUE_SECRET_BAD_NAME',
	'MIGRATED_VALUE_SECRET',
]) {
	assert(!serialized.includes(raw), `migration plan must not expose ${raw}`);
}

let brokerTick = 2000;
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
	throw new Error('production migration contract must not read secret bytes');
};
const productionStore = createSecretStore({
	backend: 'external-broker',
	tenantId: 'tenant_a',
	broker: productionBroker,
});
await productionStore.putBytes({ kind: 'auth-state', name: 'canonical:appalpha', bytes: 'PROD_AUTH_COPY_ALPHA' });
await productionStore.putBytes({ kind: 'auth-state', name: 'legacy:legacyapp', bytes: 'PROD_AUTH_COPY_LEGACY' });
await productionStore.putBytes({ kind: 'flow-values', name: 'checkout', bytes: 'PROD_VALUE_COPY_CHECKOUT' });

const productionInventory = await inventoryPlaintextSecretMigration({ rootDir, tenantId: 'tenant_a', secretStore: productionStore });
const productionPlan = await planPlaintextSecretMigration({ inventory: productionInventory });
const requiredSecretRefs = [
	productionStore.ref('auth-state', 'canonical:appalpha'),
	productionStore.ref('auth-state', 'legacy:legacyapp'),
	productionStore.ref('flow-values', 'checkout'),
];
const approvalManifest = buildSecretMigrationApprovalManifest({
	tenantId: 'tenant_a',
	requester: 'owner_a',
	purpose: 'unit production KMS secret migration dry-run',
	secretRefs: requiredSecretRefs,
	pathClasses: [
		'fixtures/auth/playwright/*.state.json',
		'approve/*.pw-state.json',
		'flows/*.values.json',
	],
	approvedBy: 'owner_a',
	approvedAt: '2099-01-01T00:00:00.000Z',
	createdAt: '2099-01-01T00:00:01.000Z',
});

let approvalCheck = validateSecretMigrationApprovalManifest(approvalManifest, {
	tenantId: 'tenant_a',
	requiredSecretRefs,
});
assert.equal(approvalCheck.ok, true, 'operator approval manifest validates covered secret refs');
assert.equal(approvalCheck.validRefCount, 3, 'approval manifest counts valid refs without returning them');

let execution = await productionSecretMigrationExecutionContract({
	rootDir,
	tenantId: 'tenant_a',
	secretStore: productionStore,
	plan: productionPlan,
	approvalManifest,
	requiredSecretRefs,
});
assert.equal(execution.contract, 'webui-secret-production-migration-execution/v1', 'production execution contract declares version');
assert.equal(execution.dryRun, true, 'production execution contract defaults to dry-run');
assert.equal(execution.failClosed, true, 'production execution contract is fail-closed');
assert.equal(execution.sideEffects, false, 'production execution contract has no side effects');
assert.equal(execution.secretContentsInspected, false, 'production execution contract does not inspect secret contents');
assert.equal(execution.readsSecretBytes, false, 'production execution contract does not read bytes');
assert.equal(execution.writesSecretBytes, false, 'production execution contract does not write bytes');
assert.equal(execution.deletesPlaintext, false, 'production execution contract does not delete plaintext');
assert.equal(execution.migratesSecrets, false, 'production execution contract does not migrate bytes locally');
assert.equal(execution.broker.rotationSupported, true, 'production broker rotation capability is validated');
assert.equal(execution.broker.deleteSupported, true, 'production broker deletion capability is validated');
assert.equal(execution.approvalManifest.ok, true, 'sanitized approval manifest metadata is returned');
assert.equal(execution.approvalManifest.refCount, 3, 'sanitized approval manifest reports ref count only');
assert.equal(execution.summary.readyClasses, 2, 'classes with secure copies are ready for operator retirement dry-run');
assert.equal(execution.summary.blockedClasses, 1, 'invalid plaintext class remains blocked');
assert.equal(execution.blocked, true, 'invalid plaintext names keep the overall contract blocked');
assert(execution.readinessByClass.some((entry) => entry.pathClass === 'fixtures/auth/playwright/*.state.json' && entry.ready), 'canonical auth class is ready');
assert(execution.readinessByClass.some((entry) => entry.pathClass === 'approve/*.pw-state.json' && entry.ready), 'legacy auth class is ready');
const flowClass = execution.readinessByClass.find((entry) => entry.pathClass === 'flows/*.values.json');
assert(flowClass.blocked, 'flow values class is blocked by the invalid fixture name');
assert(flowClass.blockReasons.includes('invalid-plaintext-name'), 'invalid-name blocker is reported by class');
assert.equal(brokerRawReads, 0, 'production migration contract never reads broker bytes');

serialized = JSON.stringify(execution);
for (const raw of [
	rootDir,
	'appalpha',
	'legacyapp',
	'checkout',
	'bad.name',
	'PROD_AUTH_COPY_ALPHA',
	'PROD_AUTH_COPY_LEGACY',
	'PROD_VALUE_COPY_CHECKOUT',
]) {
	assert(!serialized.includes(raw), `production execution contract must not expose ${raw}`);
}

execution = await productionSecretMigrationExecutionContract({
	rootDir,
	tenantId: 'tenant_a',
	secretStore: productionStore,
	plan: productionPlan,
	requiredSecretRefs,
});
assert.equal(execution.blocked, true, 'missing operator approval manifest blocks production execution contract');
assert(execution.findings.some((f) => f.reason === 'missing-operator-approval-manifest'), 'missing approval manifest is reported');

const invalidRefManifest = buildSecretMigrationApprovalManifest({
	tenantId: 'tenant_a',
	requester: 'owner_a',
	purpose: 'unit invalid ref check',
	secretRefs: ['not-a-secret-ref'],
	approvedBy: 'owner_a',
	approvedAt: '2099-01-01T00:00:00.000Z',
	createdAt: '2099-01-01T00:00:02.000Z',
});
approvalCheck = validateSecretMigrationApprovalManifest(invalidRefManifest, {
	tenantId: 'tenant_a',
	requiredSecretRefs,
});
assert.equal(approvalCheck.ok, false, 'invalid approval manifest refs fail validation');
assert(approvalCheck.findings.some((f) => f.reason === 'invalid-secret-migration-ref'), 'invalid ref is reported without raw ref text');
assert(approvalCheck.findings.some((f) => f.reason === 'missing-approved-secret-migration-ref'), 'missing required refs are reported');
assert(!JSON.stringify(approvalCheck).includes('not-a-secret-ref'), 'invalid ref value is not echoed');

const lifecycleGapBroker = createFakeSecretBrokerForTests({
	keyId: 'unit-production-kms-key',
	provider: 'unit-production-broker',
	testOnly: false,
	productionReady: true,
});
lifecycleGapBroker.connector.rotationSupported = false;
lifecycleGapBroker.connector.deleteSupported = false;
const lifecycleGapStore = createSecretStore({
	backend: 'external-broker',
	tenantId: 'tenant_a',
	broker: lifecycleGapBroker,
});
execution = await productionSecretMigrationExecutionContract({
	rootDir,
	tenantId: 'tenant_a',
	secretStore: lifecycleGapStore,
	plan: productionPlan,
	approvalManifest,
	requiredSecretRefs,
});
assert.equal(execution.blocked, true, 'missing rotation/deletion capability blocks production execution contract');
assert(execution.findings.some((f) => f.reason === 'production-secret-broker-rotation-unsupported'), 'missing rotation capability is reported');
assert(execution.findings.some((f) => f.reason === 'production-secret-broker-delete-unsupported'), 'missing deletion capability is reported');

execution = await productionSecretMigrationExecutionContract({
	rootDir,
	tenantId: 'tenant_a',
	secretStore: productionStore,
	plan: productionPlan,
	approvalManifest,
	requiredSecretRefs,
	dryRun: false,
});
assert.equal(execution.blocked, true, 'non-dry-run production execution fails closed locally');
assert.equal(execution.sideEffects, false, 'non-dry-run request still has no side effects');
assert(execution.findings.some((f) => f.reason === 'production-secret-migration-non-dry-run-refused'), 'non-dry-run refusal is reported');
assert.equal(brokerRawReads, 0, 'negative execution checks also avoid byte reads');

console.log('  webui-secret-migration-inventory-unit: sanitized migration inventory and plan checks passed');
NODE
)
