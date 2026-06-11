#!/usr/bin/env bash
# Browser-free checks for metadata-only tenant deletion orchestration.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import {
	createFakeArtifactCleanupAdapter,
	orchestrateTenantDeletion,
} from './webui/tenant-deletion.js';

const CREATED_AT = '2099-01-03T00:00:00.000Z';
const hash = (ch) => `sha256:${ch.repeat(64)}`;
const artifact = (overrides = {}) => ({
	id: 'artifact-a1',
	tenantId: 'tenant_a',
	jobId: 'job_done',
	runId: '20990103-010101-1',
	path: 'artifacts/20990103-010101-1/report.json',
	kind: 'report',
	sha256: hash('a'),
	bytes: 42,
	retention: 'ephemeral-debug',
	rawContent: 'do-not-print-raw-artifact',
	...overrides,
});
const readyInputs = (overrides = {}) => ({
	tenantId: 'tenant_a',
	actorId: 'owner_a',
	reason: 'unit-test tenant deletion',
	createdAt: CREATED_AT,
	artifacts: [
		artifact(),
		artifact({
			id: 'artifact-a2',
			path: 'artifacts/20990103-010101-1/results.tsv',
			sha256: hash('b'),
			rawContent: 'do-not-print-raw-results',
		}),
	],
	jobs: [{ id: 'job_done', tenantId: 'tenant_a', status: 'succeeded', runId: '20990103-010101-1', log: ['do-not-print-job-log'] }],
	logs: [{ id: 'log_done', tenantId: 'tenant_a', jobId: 'job_done', event: 'finished', redaction: 'applied', hash: hash('c'), message: 'do-not-print-log-line' }],
	browserSessions: [{ sessionId: 'browser_done', tenantId: 'tenant_a', jobId: 'job_done', state: 'closed', teardownState: 'complete' }],
	secrets: [{ tenantId: 'tenant_a', ref: 'aqa-secret://tenant_a/auth-state/app', kind: 'auth-state', name: 'app', present: true, deleteSupported: true, encrypted: true }],
	exportReferences: [{ tenantId: 'tenant_a', refId: 'expref-invalidated', path: 'artifacts/20990103-010101-1/report.json', status: 'invalidated', invalidatedAt: '2099-01-02T00:00:00.000Z', expiresAt: '2099-01-08T00:00:00.000Z' }],
	...overrides,
});

const adapter = createFakeArtifactCleanupAdapter();
let result = await orchestrateTenantDeletion({ ...readyInputs(), artifactCleanupAdapter: adapter });
assert.equal(result.ok, true, 'ready tenant deletion succeeds');
assert.equal(result.preflightManifest.metadataOnly, true, 'preflight is metadata-only');
assert.equal(result.cleanupManifest.metadataOnly, true, 'cleanup manifest is metadata-only');
assert.equal(result.cleanupManifest.readsRawArtifacts, false, 'cleanup manifest does not read artifact bytes');
assert.equal(result.deletionManifest.manifestKind, 'aqa.tenant-deletion-manifest', 'deletion returns a tenant deletion manifest');
assert.equal(result.orchestrationManifest.manifestKind, 'aqa.tenant-deletion-orchestration', 'orchestration manifest is returned');
assert.equal(result.orchestrationManifest.decision.allowed, true, 'orchestration decision is allowed after cleanup');
assert.equal(result.cleanupManifest.summary.completed, 2, 'all artifact byte cleanup operations completed');
assert.equal(adapter.operations.length, 2, 'fake adapter saw metadata cleanup targets');
assert.deepEqual(adapter.operations.map((op) => op.path).sort(), [
	'artifacts/20990103-010101-1/report.json',
	'artifacts/20990103-010101-1/results.tsv',
], 'adapter receives only scoped artifact paths');
assert.equal(result.deletionManifest.artifacts[0].deletedAt, CREATED_AT, 'tombstone readback includes deletedAt');
assert.equal(result.deletionManifest.artifacts[0].deletedBy, 'owner_a', 'tombstone readback includes actor');
assert.equal(result.deletionManifest.artifacts[0].bytesRemoved, true, 'tombstone readback confirms byte metadata removal');
assert.equal(result.deletionManifest.summary.byClass.jobs, 1, 'job deletion workflow is connected');
assert.equal(result.deletionManifest.summary.byClass.logs, 1, 'log deletion workflow is connected');
assert.equal(result.deletionManifest.summary.byClass.browserSessions, 1, 'browser deletion workflow is connected');
assert.equal(result.deletionManifest.summary.byClass.secrets, 1, 'secret deletion workflow is connected');
assert.equal(result.deletionManifest.summary.byClass.exportReferences, 1, 'export-ref deletion workflow is connected');
assert.match(result.cleanupManifest.manifestHash, /^sha256:[0-9a-f]{64}$/, 'cleanup manifest has an integrity hash');
assert.match(result.orchestrationManifest.manifestHash, /^sha256:[0-9a-f]{64}$/, 'orchestration manifest has an integrity hash');
const serialized = JSON.stringify({ result, adapterOperations: adapter.operations });
for (const marker of ['do-not-print-raw-artifact', 'do-not-print-raw-results', 'do-not-print-job-log', 'do-not-print-log-line']) {
	assert(!serialized.includes(marker), `orchestration must not echo ${marker}`);
}

const heldAdapter = createFakeArtifactCleanupAdapter();
result = await orchestrateTenantDeletion({
	...readyInputs({
		artifacts: [artifact({ retention: 'legal-hold', meta: { legalHold: true, legalHoldReason: 'incident-review' } })],
	}),
	artifactCleanupAdapter: heldAdapter,
});
assert.equal(result.blocked, true, 'legal hold blocks tenant deletion');
assert.equal(result.stage, 'preflight', 'legal hold blocks before cleanup');
assert.equal(heldAdapter.operations.length, 0, 'legal hold prevents artifact cleanup adapter calls');
assert(result.findings.some((f) => f.reason === 'legal-hold'), 'legal hold finding is reported');

const failingAdapter = createFakeArtifactCleanupAdapter({ failArtifactIds: ['artifact-a2'] });
result = await orchestrateTenantDeletion({ ...readyInputs(), artifactCleanupAdapter: failingAdapter });
assert.equal(result.ok, false, 'partial artifact cleanup failure blocks deletion');
assert.equal(result.partialFailure, true, 'partial cleanup failure is explicit');
assert.equal(result.cleanupManifest.status, 'failed', 'successful rollback leaves failed cleanup status');
assert.equal(failingAdapter.operations.length, 2, 'cleanup stops at the failing operation after prior success');
assert.equal(failingAdapter.rollbacks.length, 1, 'prior successful cleanup is rolled back');
assert.equal(result.deletionManifest, undefined, 'metadata tombstone manifest is not committed after cleanup failure');
assert(result.findings.some((f) => f.reason === 'fake-artifact-cleanup-failure'), 'cleanup failure finding is reported');

const retryAdapter = createFakeArtifactCleanupAdapter();
result = await orchestrateTenantDeletion({
	...readyInputs(),
	artifactCleanupAdapter: retryAdapter,
	retryOf: 'cleanup-attempt-1',
});
assert.equal(result.ok, true, 'retry succeeds after previous cleanup failure');
assert.equal(result.cleanupManifest.retryOf, 'cleanup-attempt-1', 'retry linkage is recorded');
assert.equal(retryAdapter.operations.length, 2, 'retry runs cleanup for the scoped artifact targets');

const traversalAdapter = createFakeArtifactCleanupAdapter();
result = await orchestrateTenantDeletion({
	...readyInputs({
		artifacts: [artifact({ path: 'artifacts/20990103-010101-1/%2e%2e/escape.txt' })],
	}),
	artifactCleanupAdapter: traversalAdapter,
});
assert.equal(result.blocked, true, 'encoded path traversal blocks tenant deletion');
assert.equal(result.stage, 'artifact-cleanup-preflight', 'path traversal blocks before adapter cleanup');
assert.equal(traversalAdapter.operations.length, 0, 'unsafe paths never reach the adapter');
assert(result.findings.some((f) => f.reason === 'path-traversal'), 'path traversal finding is reported');

const crossTenantAdapter = createFakeArtifactCleanupAdapter();
result = await orchestrateTenantDeletion({
	...readyInputs({
		artifacts: [artifact({ id: 'artifact-b1', tenantId: 'tenant_b', path: 'artifacts/20990104-010101-2/report.json' })],
		exportReferences: [{ tenantId: 'tenant_b', refId: 'expref-b', path: 'artifacts/20990104-010101-2/report.json', status: 'invalidated', invalidatedAt: '2099-01-02T00:00:00.000Z' }],
	}),
	artifactCleanupAdapter: crossTenantAdapter,
});
assert.equal(result.blocked, true, 'cross-tenant stale metadata blocks tenant deletion');
assert.equal(crossTenantAdapter.operations.length, 0, 'cross-tenant cleanup target never reaches the adapter');
assert(result.findings.some((f) => f.reason === 'tenant-mismatch'), 'tenant mismatch finding is reported');

const activeRefAdapter = createFakeArtifactCleanupAdapter();
result = await orchestrateTenantDeletion({
	...readyInputs({
		exportReferences: [{ tenantId: 'tenant_a', refId: 'expref-active', path: 'artifacts/20990103-010101-1/report.json', status: 'active', expiresAt: '2099-01-08T00:00:00.000Z' }],
	}),
	artifactCleanupAdapter: activeRefAdapter,
});
assert.equal(result.blocked, true, 'active export refs block stale URL reuse');
assert.equal(result.stage, 'preflight', 'active export ref blocks before cleanup');
assert.equal(activeRefAdapter.operations.length, 0, 'active export ref prevents cleanup before invalidation');
assert(result.findings.some((f) => f.reason === 'active-export-reference'), 'active export reference finding is reported');

result = await orchestrateTenantDeletion(readyInputs());
assert.equal(result.blocked, true, 'missing cleanup adapter fails closed');
assert(result.findings.some((f) => f.reason === 'artifact-cleanup-adapter-missing'), 'missing adapter finding is reported');

console.log('  webui-tenant-deletion-unit: tenant deletion orchestrator checks passed');
NODE
)
