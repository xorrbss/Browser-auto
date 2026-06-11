#!/usr/bin/env bash
# Browser-free checks for the tenant deletion WebUI route adapter.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import {
	createMemoryTenantDeletionStore,
	createTenantDeletionApi,
} from './webui/tenant-deletion-api.js';
import { createTenantDeletionRoutes } from './webui/tenant-deletion-routes.js';
import { createFakeArtifactCleanupAdapter } from './webui/tenant-deletion.js';

const CREATED_AT = '2099-03-01T00:00:00.000Z';
const APPROVED_AT = '2099-03-01T00:01:00.000Z';
const EXECUTED_AT = '2099-03-01T00:02:00.000Z';
const RETRY_AT = '2099-03-01T00:03:00.000Z';
const hash = (ch) => `sha256:${ch.repeat(64)}`;
const assertHash = (value, label) => assert.match(value, /^sha256:[0-9a-f]{64}$/, label);
const context = {
	mode: 'external',
	tenant: { id: 'tenant_a' },
	tenantId: 'tenant_a',
	actor: { id: 'owner_a', role: 'owner', tenantId: 'tenant_a' },
	auth: { scheme: 'bearer' },
};

function assertSanitized(value, label) {
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
}

const artifact = (overrides = {}) => ({
	id: 'artifact-a1',
	tenantId: 'tenant_a',
	jobId: 'job_done',
	runId: '20990301-010101-1',
	path: 'artifacts/20990301-010101-1/report.json',
	kind: 'report',
	sha256: hash('a'),
	bytes: 123,
	rawContent: 'RAW_ARTIFACT_BODY',
	retention: 'ephemeral-debug',
	...overrides,
});

const readyRequest = (overrides = {}) => ({
	requestId: 'tdel:route-ready',
	tenantId: 'tenant_a',
	reason: 'unit-test tenant deletion route',
	createdAt: CREATED_AT,
	artifacts: [
		artifact(),
		artifact({
			id: 'artifact-a2',
			path: 'artifacts/20990301-010101-1/results.tsv',
			sha256: hash('b'),
			rawContent: 'RAW_RESULTS_BODY',
		}),
	],
	jobs: [{ id: 'job_done', tenantId: 'tenant_a', status: 'succeeded', runId: '20990301-010101-1', log: ['RAW_JOB_LOG'] }],
	logs: [{ id: 'log_done', tenantId: 'tenant_a', jobId: 'job_done', event: 'finished', redaction: 'applied', hash: hash('c'), message: 'RAW_LOG_MESSAGE' }],
	browserSessions: [{ sessionId: 'browser_done', tenantId: 'tenant_a', jobId: 'job_done', state: 'closed', teardownState: 'complete', profilePath: 'RAW_BROWSER_PROFILE' }],
	secrets: [{ tenantId: 'tenant_a', ref: 'aqa-secret://tenant_a/auth-state/app', kind: 'auth-state', name: 'app', present: true, deleteSupported: true, encrypted: true, value: 'RAW_SECRET_VALUE' }],
	exportReferences: [{ tenantId: 'tenant_a', refId: 'expref-invalidated', path: 'artifacts/20990301-010101-1/report.json', status: 'invalidated', invalidatedAt: '2099-02-28T00:00:00.000Z', signedRef: 'aqa-export-ref://tenant_a/metadata-only', cookie: 'RAW_SIGNED_COOKIE' }],
	...overrides,
});

const store = createMemoryTenantDeletionStore();
const api = createTenantDeletionApi({ store });
const routes = createTenantDeletionRoutes({ api });

async function post(path, body, deps = {}) {
	let status = null;
	let payload = null;
	const res = {};
	const handled = await routes.post(path, body, res, {
		sendJson(_res, code, value) {
			status = code;
			payload = value;
		},
		context,
		...deps,
	});
	assert.equal(handled, true, `${path} is handled`);
	assert.notEqual(status, null, `${path} sends a response`);
	return { status, body: payload };
}

async function get(path, deps = {}) {
	const url = new URL(path, 'http://127.0.0.1:4310');
	let status = null;
	let payload = null;
	const handled = await routes.get(url.pathname, url, {}, {
		sendJson(_res, code, value) {
			status = code;
			payload = value;
		},
		context,
		...deps,
	});
	assert.equal(handled, true, `${path} is handled`);
	assert.notEqual(status, null, `${path} sends a response`);
	return { status, body: payload };
}

let response = await post('/api/tenants/tenant_a/deletion/dry-run', readyRequest());
assert.equal(response.status, 200, 'ready dry-run returns 200');
const dryRun = response.body;
assert.equal(dryRun.ok, true, 'ready dry-run is allowed');
assert.equal(dryRun.status, 'dry-run-ready', 'route records dry-run-ready status');
assertHash(dryRun.dryRunManifest.manifestHash, 'route dry-run returns manifest hash');
assert.equal(dryRun.dryRunManifest.scopeSummary.byClass.artifacts, 2, 'route summarizes artifact metadata');
assertSanitized(dryRun, 'route dry-run response');

response = await post('/api/tenant/deletion/dry-run', readyRequest({
	requestId: 'tdel:route-legal-hold',
	artifacts: [artifact({ retention: 'legal-hold', meta: { legalHold: true, legalHoldReason: 'incident-review' } })],
}));
assert.equal(response.status, 409, 'legal hold dry-run returns 409');
assert(response.body.findings.some((f) => f.reason === 'legal-hold'), 'legal hold finding is reported through route');
assertSanitized(response.body, 'route legal hold response');

response = await post('/api/tenant/deletion/dry-run', readyRequest({
	requestId: 'tdel:route-active-refs',
	jobs: [{ id: 'job_active', tenantId: 'tenant_a', status: 'running', log: ['RAW_JOB_LOG'] }],
	browserSessions: [{ sessionId: 'browser_active', tenantId: 'tenant_a', jobId: 'job_active', state: 'open', teardownState: 'not-required' }],
	exportReferences: [{ tenantId: 'tenant_a', refId: 'expref-active', path: 'artifacts/20990301-010101-1/report.json', status: 'active', expiresAt: '2099-03-08T00:00:00.000Z' }],
}));
assert.equal(response.status, 409, 'active refs dry-run returns 409');
for (const reason of ['active-job', 'active-browser-session', 'active-export-reference']) {
	assert(response.body.findings.some((f) => f.reason === reason), `${reason} finding is reported through route`);
}
assertSanitized(response.body, 'route active refs response');

response = await post('/api/tenant/deletion/dry-run', readyRequest({
	requestId: 'tdel:route-tenant-mismatch',
	artifacts: [artifact({ id: 'artifact-b1', tenantId: 'tenant_b' })],
}));
assert.equal(response.status, 409, 'item tenant mismatch dry-run returns 409');
assert(response.body.findings.some((f) => f.reason === 'tenant-mismatch'), 'item tenant mismatch is reported through route');
assertSanitized(response.body, 'route item tenant mismatch response');

response = await get(`/api/tenants/tenant_b/deletion/${encodeURIComponent(dryRun.requestId)}/status`);
assert.equal(response.status, 404, 'route tenant mismatch read is hidden');
assert(response.body.findings.some((f) => f.reason === 'tenant-mismatch'), 'route tenant mismatch finding is reported');
assertSanitized(response.body, 'route tenant mismatch response');

response = await post('/api/tenants/tenant_b/deletion/approve', {
	requestId: dryRun.requestId,
	approvedAt: APPROVED_AT,
	reason: 'wrong tenant approval',
});
assert.equal(response.status, 404, 'route tenant mismatch mutation is hidden');
assert(response.body.findings.some((f) => f.reason === 'tenant-mismatch'), 'route mutation tenant mismatch finding is reported');
assertSanitized(response.body, 'route tenant mismatch mutation response');

response = await post('/api/tenant/deletion/approve', {
	requestId: dryRun.requestId,
	tenantId: 'tenant_a',
	approvedAt: APPROVED_AT,
	reason: 'owner approved metadata-only tenant deletion',
});
assert.equal(response.status, 200, 'approval route returns 200');
const approval = response.body;
assert.equal(approval.ok, true, 'approval route succeeds');
assert.equal(approval.approvalManifest.approvedBy, 'owner_a', 'route binds approval actor from context');
assertHash(approval.approvalManifestHash, 'approval route returns approval manifest hash');
assertSanitized(approval, 'route approval response');

response = await post('/api/tenant/deletion/execute', {
	requestId: dryRun.requestId,
	tenantId: 'tenant_a',
	approvalManifestHash: `sha256:${'0'.repeat(64)}`,
	createdAt: EXECUTED_AT,
}, { artifactCleanupAdapter: createFakeArtifactCleanupAdapter() });
assert.equal(response.status, 409, 'wrong approval hash blocks execute route');
assert(response.body.findings.some((f) => f.reason === 'approval-manifest-hash-mismatch'), 'approval hash mismatch is reported through route');
assertSanitized(response.body, 'route approval hash mismatch response');

const failingAdapter = createFakeArtifactCleanupAdapter({ failArtifactIds: ['artifact-a2'] });
response = await post('/api/tenant/deletion/execute', {
	requestId: dryRun.requestId,
	tenantId: 'tenant_a',
	approvalManifestHash: approval.approvalManifestHash,
	createdAt: EXECUTED_AT,
}, { artifactCleanupAdapter: failingAdapter });
assert.equal(response.status, 409, 'partial cleanup failure returns 409');
const partial = response.body;
assert.equal(partial.attempt.partialFailure, true, 'route exposes partial failure attempt metadata');
assert.equal(partial.cleanupManifest.status, 'failed', 'route returns cleanup manifest for partial failure');
assert.equal(failingAdapter.operations.length, 2, 'route adapter sends metadata cleanup targets to fake adapter');
assert.equal(partial.deletionManifest, null, 'route does not commit tombstone after partial failure');
assert(partial.findings.some((f) => f.reason === 'fake-artifact-cleanup-failure'), 'route surfaces cleanup failure');
assertSanitized(partial, 'route partial execute response');

response = await get(`/api/tenant/deletion/${encodeURIComponent(dryRun.requestId)}/status?tenantId=tenant_a`);
assert.equal(response.status, 200, 'status route returns 200');
assert.equal(response.body.status, 'partial-failure', 'status route records partial failure');
assert.equal(response.body.latestAttempt.partialFailure, true, 'status route returns retry-relevant attempt metadata');
assert.equal(response.body.tombstone.available, false, 'status route shows tombstone unavailable after partial failure');
assertSanitized(response.body, 'route partial status response');

response = await get(`/api/tenant/deletion/${encodeURIComponent(dryRun.requestId)}/tombstone?tenantId=tenant_a`);
assert.equal(response.status, 409, 'tombstone route fails before completed execute');
assert(response.body.findings.some((f) => f.reason === 'tenant-deletion-tombstone-not-ready'), 'tombstone not-ready finding is reported through route');
assertSanitized(response.body, 'route tombstone not-ready response');

const retryAdapter = createFakeArtifactCleanupAdapter();
response = await post('/api/tenant/deletion/retry', {
	requestId: dryRun.requestId,
	tenantId: 'tenant_a',
	approvalManifestHash: approval.approvalManifestHash,
	retryOf: partial.attempt.attemptId,
	createdAt: RETRY_AT,
}, { artifactCleanupAdapter: retryAdapter });
assert.equal(response.status, 200, 'retry route returns 200');
const retry = response.body;
assert.equal(retry.ok, true, 'retry route succeeds');
assert.equal(retry.attempt.retryOf, partial.attempt.attemptId, 'retry route links to partial failure attempt');
assert.equal(retry.deletionManifest.manifestKind, 'aqa.tenant-deletion-manifest', 'retry route commits tombstone manifest');
assert.equal(retry.deletionManifest.summary.tombstoned, 2, 'retry route tombstones scoped artifacts');
assertSanitized(retry, 'route retry response');

response = await get(`/api/tenant/deletion/${encodeURIComponent(dryRun.requestId)}/status?tenantId=tenant_a`);
assert.equal(response.status, 200, 'completed status route returns 200');
assert.equal(response.body.status, 'completed', 'status route records completed retry');
assert.equal(response.body.tombstone.available, true, 'status route exposes tombstone availability');
assertHash(response.body.tombstone.manifestHash, 'status route exposes tombstone hash');
const tombstoneHash = response.body.tombstone.manifestHash;
assertSanitized(response.body, 'route completed status response');

response = await get(`/api/tenant/deletion/${encodeURIComponent(dryRun.requestId)}/read-tombstone?tenantId=tenant_a&tombstoneManifestHash=${encodeURIComponent(tombstoneHash)}`);
assert.equal(response.status, 200, 'tombstone readback route returns 200');
assert.equal(response.body.tombstoneManifest.manifestKind, 'aqa.tenant-deletion-manifest', 'route readback returns tenant deletion manifest');
assert.deepEqual(response.body.tombstoneManifest.summary.artifactIds, ['artifact-a1', 'artifact-a2'], 'route readback lists scoped artifacts');
assert.equal(response.body.tombstoneManifest.classes.secrets[0].readsSecretBytes, false, 'route readback keeps secret deletion bytes-free');
assertSanitized(response.body, 'route tombstone readback response');

console.log('  webui-tenant-deletion-route-unit: tenant deletion route checks passed');
NODE
)
