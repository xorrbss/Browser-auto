#!/usr/bin/env bash
# Browser-free checks for the route-independent tenant deletion JSON helper.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import {
	createMemoryTenantDeletionStore,
	createTenantDeletionApi,
	handleTenantDeletionJson,
} from './webui/tenant-deletion-api.js';
import { createFakeArtifactCleanupAdapter } from './webui/tenant-deletion.js';

const CREATED_AT = '2099-02-01T00:00:00.000Z';
const APPROVED_AT = '2099-02-01T00:01:00.000Z';
const EXECUTED_AT = '2099-02-01T00:02:00.000Z';
const RETRY_AT = '2099-02-01T00:03:00.000Z';
const hash = (ch) => `sha256:${ch.repeat(64)}`;
const assertHash = (value, label) => assert.match(value, /^sha256:[0-9a-f]{64}$/, label);
const assertSanitized = (value, label) => {
	const text = JSON.stringify(value);
	for (const marker of [
		'RAW_ARTIFACT_BODY',
		'RAW_RESULTS_BODY',
		'RAW_JOB_LOG',
		'RAW_LOG_MESSAGE',
		'RAW_BROWSER_PROFILE',
		'RAW_SECRET_VALUE',
		'RAW_SIGNED_COOKIE',
	]) {
		assert(!text.includes(marker), `${label} must not echo ${marker}`);
	}
	assert.equal(value.metadataOnly, true, `${label} is metadata-only`);
	assert.equal(value.readsRawArtifacts, false, `${label} does not read raw artifacts`);
	assert.equal(value.readsSecretBytes, false, `${label} does not read secret bytes`);
};

const artifact = (overrides = {}) => ({
	id: 'artifact-a1',
	tenantId: 'tenant_a',
	jobId: 'job_done',
	runId: '20990201-010101-1',
	path: 'artifacts/20990201-010101-1/report.json',
	kind: 'report',
	sha256: hash('a'),
	bytes: 123,
	rawContent: 'RAW_ARTIFACT_BODY',
	retention: 'ephemeral-debug',
	...overrides,
});

const readyRequest = (overrides = {}) => ({
	action: 'dry-run',
	requestId: 'tdel:unit-ready',
	tenantId: 'tenant_a',
	actorId: 'owner_a',
	reason: 'unit-test tenant deletion api',
	createdAt: CREATED_AT,
	artifacts: [
		artifact(),
		artifact({
			id: 'artifact-a2',
			path: 'artifacts/20990201-010101-1/results.tsv',
			sha256: hash('b'),
			rawContent: 'RAW_RESULTS_BODY',
		}),
	],
	jobs: [{ id: 'job_done', tenantId: 'tenant_a', status: 'succeeded', runId: '20990201-010101-1', log: ['RAW_JOB_LOG'] }],
	logs: [{ id: 'log_done', tenantId: 'tenant_a', jobId: 'job_done', event: 'finished', redaction: 'applied', hash: hash('c'), message: 'RAW_LOG_MESSAGE' }],
	browserSessions: [{ sessionId: 'browser_done', tenantId: 'tenant_a', jobId: 'job_done', state: 'closed', teardownState: 'complete', profilePath: 'RAW_BROWSER_PROFILE' }],
	secrets: [{ tenantId: 'tenant_a', ref: 'aqa-secret://tenant_a/auth-state/app', kind: 'auth-state', name: 'app', present: true, deleteSupported: true, encrypted: true, value: 'RAW_SECRET_VALUE' }],
	exportReferences: [{ tenantId: 'tenant_a', refId: 'expref-invalidated', path: 'artifacts/20990201-010101-1/report.json', status: 'invalidated', invalidatedAt: '2099-01-31T00:00:00.000Z', signedRef: 'aqa-export-ref://tenant_a/metadata-only', cookie: 'RAW_SIGNED_COOKIE' }],
	...overrides,
});

const store = createMemoryTenantDeletionStore();
const api = createTenantDeletionApi({ store });

let dryRun = await api.handle(readyRequest());
assert.equal(dryRun.ok, true, 'ready dry-run is allowed');
assert.equal(dryRun.status, 'dry-run-ready', 'dry-run records ready status');
assert.equal(dryRun.preflightManifest.decision.allowed, true, 'preflight is allowed');
assert.equal(dryRun.dryRunManifest.manifestKind, 'aqa.tenant-deletion-dry-run-manifest', 'dry-run manifest kind is explicit');
assertHash(dryRun.dryRunManifest.manifestHash, 'dry-run manifest has hash');
assertHash(dryRun.dryRunManifest.scopeHash, 'dry-run manifest binds sanitized scope hash');
assert.equal(dryRun.dryRunManifest.scopeSummary.byClass.artifacts, 2, 'dry-run summarizes artifact metadata');
assertSanitized(dryRun, 'dry-run response');

let blocked = await api.handle(readyRequest({
	action: 'dry-run',
	requestId: 'tdel:legal-hold',
	artifacts: [artifact({ retention: 'legal-hold', meta: { legalHold: true, legalHoldReason: 'incident-review' } })],
}));
assert.equal(blocked.blocked, true, 'legal hold blocks dry-run');
assert(blocked.findings.some((f) => f.reason === 'legal-hold'), 'legal hold finding is reported');
assertSanitized(blocked, 'legal hold dry-run');

blocked = await api.handle(readyRequest({
	action: 'dry-run',
	requestId: 'tdel:active-refs',
	jobs: [{ id: 'job_active', tenantId: 'tenant_a', status: 'running', log: ['RAW_JOB_LOG'] }],
	browserSessions: [{ sessionId: 'browser_active', tenantId: 'tenant_a', jobId: 'job_active', state: 'open', teardownState: 'not-required' }],
	exportReferences: [{ tenantId: 'tenant_a', refId: 'expref-active', path: 'artifacts/20990201-010101-1/report.json', status: 'active', expiresAt: '2099-02-08T00:00:00.000Z' }],
}));
assert.equal(blocked.blocked, true, 'active job/browser/export ref blocks dry-run');
for (const reason of ['active-job', 'active-browser-session', 'active-export-reference']) {
	assert(blocked.findings.some((f) => f.reason === reason), `${reason} finding is reported`);
}
assertSanitized(blocked, 'active refs dry-run');

blocked = await api.handle(readyRequest({
	action: 'dry-run',
	requestId: 'tdel:tenant-mismatch',
	artifacts: [artifact({ id: 'artifact-b1', tenantId: 'tenant_b' })],
}));
assert.equal(blocked.blocked, true, 'tenant mismatch blocks dry-run');
assert(blocked.findings.some((f) => f.reason === 'tenant-mismatch'), 'tenant mismatch finding is reported');

let approval = await api.handle({
	action: 'approve',
	requestId: dryRun.requestId,
	tenantId: 'tenant_b',
	approvedBy: 'owner_b',
	approvedAt: APPROVED_AT,
	reason: 'wrong tenant approval',
});
assert.equal(approval.code, 404, 'cross-tenant approval mutation is hidden');
assert(approval.findings.some((f) => f.reason === 'tenant-mismatch'), 'cross-tenant approval reports a tenant mismatch finding');
assertSanitized(approval, 'cross-tenant approval response');

approval = await api.handle({
	action: 'approve',
	requestId: dryRun.requestId,
	tenantId: 'tenant_a',
	approvedBy: 'owner_a',
	approvedAt: APPROVED_AT,
	reason: 'owner approved metadata-only tenant deletion',
});
assert.equal(approval.ok, true, 'approval succeeds after allowed dry-run');
assert.equal(approval.approvalManifest.status, 'approved', 'approval manifest is approved');
assertHash(approval.approvalManifestHash, 'approval manifest hash is returned');
assert.equal(approval.approvalManifest.dryRunManifestHash, dryRun.dryRunManifest.manifestHash, 'approval binds to dry-run hash');
assert.equal(approval.approvalManifest.preflightManifestHash, dryRun.preflightManifest.manifestHash, 'approval binds to preflight hash');
assertSanitized(approval, 'approval response');

let execute = await api.handle({
	action: 'execute',
	requestId: dryRun.requestId,
	tenantId: 'tenant_a',
	approvalManifestHash: `sha256:${'0'.repeat(64)}`,
	createdAt: EXECUTED_AT,
}, { artifactCleanupAdapter: createFakeArtifactCleanupAdapter() });
assert.equal(execute.blocked, true, 'execute requires the exact approval manifest hash');
assert(execute.findings.some((f) => f.reason === 'approval-manifest-hash-mismatch'), 'approval hash mismatch finding is reported');
assertSanitized(execute, 'approval hash mismatch response');

const failingAdapter = createFakeArtifactCleanupAdapter({ failArtifactIds: ['artifact-a2'] });
execute = await api.handle({
	action: 'execute',
	requestId: dryRun.requestId,
	tenantId: 'tenant_a',
	approvalManifestHash: approval.approvalManifestHash,
	createdAt: EXECUTED_AT,
}, { artifactCleanupAdapter: failingAdapter });
assert.equal(execute.ok, false, 'partial artifact cleanup failure blocks execute');
assert.equal(execute.attempt.partialFailure, true, 'partial failure is explicit on the API attempt');
assert.equal(execute.cleanupManifest.status, 'failed', 'cleanup manifest records failed cleanup');
assert.equal(failingAdapter.operations.length, 2, 'failing fake adapter sees metadata targets only');
assert.equal(failingAdapter.rollbacks.length, 1, 'partial failure rolls back previous cleanup');
assert.equal(execute.deletionManifest, null, 'no tombstone manifest is committed after partial failure');
assert(execute.findings.some((f) => f.reason === 'fake-artifact-cleanup-failure'), 'cleanup failure finding is surfaced');
assertSanitized(execute, 'partial failure execute response');

let status = await api.handle({ action: 'status', requestId: dryRun.requestId, tenantId: 'tenant_a' });
assert.equal(status.status, 'partial-failure', 'status records partial failure');
assert.equal(status.tombstone.available, false, 'tombstone is unavailable after partial failure');
assert.equal(status.latestAttempt.partialFailure, true, 'status returns retry-relevant attempt metadata');
assertSanitized(status, 'partial failure status');

let tombstone = await api.handle({ action: 'read-tombstone', requestId: dryRun.requestId, tenantId: 'tenant_a' });
assert.equal(tombstone.blocked, true, 'tombstone readback fails before completed execute');
assert(tombstone.findings.some((f) => f.reason === 'tenant-deletion-tombstone-not-ready'), 'not-ready tombstone finding is reported');

const retryAdapter = createFakeArtifactCleanupAdapter();
const retry = await api.handle({
	action: 'retry',
	requestId: dryRun.requestId,
	tenantId: 'tenant_a',
	approvalManifestHash: approval.approvalManifestHash,
	retryOf: execute.attempt.attemptId,
	createdAt: RETRY_AT,
}, { artifactCleanupAdapter: retryAdapter });
assert.equal(retry.ok, true, 'retry succeeds with the same approval hash and clean fake adapter');
assert.equal(retry.attempt.retryOf, execute.attempt.attemptId, 'retry links to the failed attempt');
assert.equal(retry.cleanupManifest.retryOf, execute.attempt.attemptId, 'cleanup manifest records retry linkage');
assert.equal(retry.deletionManifest.manifestKind, 'aqa.tenant-deletion-manifest', 'retry commits tenant deletion manifest');
assert.equal(retry.deletionManifest.summary.tombstoned, 2, 'retry tombstones scoped artifacts');
assert.equal(retry.deletionManifest.artifacts[0].bytesRemoved, true, 'tombstone metadata records bytes removed');
assert.equal(retryAdapter.operations.length, 2, 'retry uses fake metadata cleanup adapter');
assertSanitized(retry, 'retry execute response');

status = await api.handle({ action: 'status', requestId: dryRun.requestId, tenantId: 'tenant_a' });
assert.equal(status.status, 'completed', 'status records completed retry');
assert.equal(status.tombstone.available, true, 'status exposes tombstone availability');
assertHash(status.tombstone.manifestHash, 'status exposes tombstone manifest hash');
assertSanitized(status, 'completed status');

tombstone = await api.handle({
	action: 'read-tombstone',
	requestId: dryRun.requestId,
	tenantId: 'tenant_a',
	tombstoneManifestHash: status.tombstone.manifestHash,
});
assert.equal(tombstone.ok, true, 'tombstone readback succeeds for same tenant');
assert.equal(tombstone.tombstoneManifest.manifestKind, 'aqa.tenant-deletion-manifest', 'readback returns tenant deletion tombstone manifest');
assert.deepEqual(tombstone.tombstoneManifest.summary.artifactIds, ['artifact-a1', 'artifact-a2'], 'tombstone readback lists scoped artifacts');
assert.equal(tombstone.tombstoneManifest.classes.secrets[0].readsSecretBytes, false, 'secret deletion metadata is bytes-free');
assertSanitized(tombstone, 'tombstone readback response');

const crossTenantStatus = await api.handle({ action: 'status', requestId: dryRun.requestId, tenantId: 'tenant_b' });
assert.equal(crossTenantStatus.code, 404, 'cross-tenant status read is hidden');
assert(crossTenantStatus.findings.some((f) => f.reason === 'tenant-mismatch'), 'cross-tenant status reports a tenant mismatch finding');

const oneShotStore = createMemoryTenantDeletionStore();
const oneShotDryRun = await handleTenantDeletionJson(readyRequest({
	action: 'dry-run',
	requestId: 'tdel:oneshot',
}), { store: oneShotStore });
assert.equal(oneShotDryRun.ok, true, 'standalone handleTenantDeletionJson supports injected stores');

console.log('  webui-tenant-deletion-api-unit: tenant deletion JSON helper checks passed');
NODE
)
