#!/usr/bin/env bash
# Browser-free checks for the WebUI export secret-scan gate skeleton.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import {
	applyPolicyApprovalManifest,
	assertExportManifestAllowed,
	buildExportManifest,
	buildExportSignedReferences,
	buildPolicyApprovalManifest,
	invalidateExportSignedReferences,
	scanExportManifest,
} from './webui/export.js';

const APPROVED_AT = '2099-01-01T00:00:00.000Z';
const CREATED_AT = '2099-01-01T00:00:01.000Z';
const EXPIRES_AT = '2099-01-08T00:00:01.000Z';
const cleanEntry = (overrides = {}) => ({
	tenantId: 'tenant_a',
	id: overrides.id,
	path: 'artifacts/20990101-010101-1/report.json',
	redactionStatus: 'redacted',
	scanStatus: 'clean',
	text: '{"status":"pass","message":"all clear"}',
	...overrides,
});
const baseBundle = (files, overrides = {}) => ({
	tenantId: 'tenant_a',
	requester: 'owner_a',
	purpose: 'unit-test sanitized export',
	expiresAt: EXPIRES_AT,
	files,
	...overrides,
});
const approvedBundle = (files, overrides = {}) => {
	const policyApprovalManifest = buildPolicyApprovalManifest({
		tenantId: overrides.tenantId || 'tenant_a',
		requester: overrides.requester || 'owner_a',
		purpose: overrides.purpose || 'unit-test sanitized export',
		artifacts: files,
		approvedBy: overrides.approvedBy || 'owner_a',
		approvedAt: overrides.approvedAt || APPROVED_AT,
		createdAt: overrides.createdAt || CREATED_AT,
		approvalId: overrides.approvalId,
	});
	return {
		...baseBundle(applyPolicyApprovalManifest(files, policyApprovalManifest), overrides),
		policyApprovalManifest,
	};
};

let result = scanExportManifest(approvedBundle([cleanEntry()]));
assert.equal(result.allowed, true, 'clean scanned/redacted export is allowed');
assert.equal(assertExportManifestAllowed(approvedBundle([
	cleanEntry({ path: 'summary.txt', redactionStatus: 'not-required', scanStatus: 'passed', text: 'summary only' }),
])).allowed, true, 'assert helper returns clean result');

result = scanExportManifest({ ...approvedBundle([cleanEntry()]), expiresAt: '2020-01-01T00:00:00.000Z' });
assert.equal(result.blocked, true, 'expired export manifests are blocked');
assert(result.findings.some((f) => f.reason === 'expired-export'), 'expired export finding is reported');

const signedBundle = approvedBundle([cleanEntry({ id: 'artifact-a1' })]);
signedBundle.signedReferences = buildExportSignedReferences(signedBundle, { issuedAt: CREATED_AT, expiresAt: EXPIRES_AT });
result = scanExportManifest(signedBundle, { requireSignedReferences: true });
assert.equal(result.allowed, true, 'active scoped signed references are accepted');
assert.match(signedBundle.signedReferences[0].signature, /^sha256:[0-9a-f]{64}$/, 'signed reference has deterministic signature');

const digestBoundBundle = approvedBundle([cleanEntry({
	id: 'artifact-digest',
	jobId: 'job_digest',
	runId: '20990101-010101-1',
	sha256: `sha256:${'a'.repeat(64)}`,
})]);
digestBoundBundle.signedReferences = buildExportSignedReferences(digestBoundBundle, { issuedAt: CREATED_AT, expiresAt: EXPIRES_AT });
result = scanExportManifest(digestBoundBundle, { requireSignedReferences: true });
assert.equal(result.allowed, true, 'digest-bound signed reference is accepted when metadata matches');

const digestMismatchBundle = {
	...digestBoundBundle,
	signedReferences: digestBoundBundle.signedReferences.map((ref) => ({
		...ref,
		sha256: `sha256:${'b'.repeat(64)}`,
	})),
};
result = scanExportManifest(digestMismatchBundle, { requireSignedReferences: true });
assert.equal(result.blocked, true, 'signed reference digest mismatch blocks stale artifact reuse');
assert(result.findings.some((f) => f.reason === 'signed-reference-digest-mismatch'), 'signed reference digest mismatch is reported');

const jobMismatchBundle = {
	...digestBoundBundle,
	signedReferences: digestBoundBundle.signedReferences.map((ref) => ({
		...ref,
		jobId: 'job_other',
	})),
};
result = scanExportManifest(jobMismatchBundle, { requireSignedReferences: true });
assert.equal(result.blocked, true, 'signed reference job mismatch blocks stale job artifact reuse');
assert(result.findings.some((f) => f.reason === 'signed-reference-job-mismatch'), 'signed reference job mismatch is reported');

const unsignedBundle = approvedBundle([cleanEntry({ id: 'artifact-a2' })]);
result = scanExportManifest(unsignedBundle, { requireSignedReferences: true });
assert.equal(result.blocked, true, 'missing signed references fail closed when required');
assert(result.findings.some((f) => f.reason === 'missing-signed-references'), 'missing signed references are reported');

const invalidatedBundle = {
	...signedBundle,
	signedReferences: invalidateExportSignedReferences(signedBundle.signedReferences, {
		artifactIds: ['artifact-a1'],
		reason: 'tenant deletion',
		invalidatedAt: '2099-01-02T00:00:00.000Z',
	}),
};
result = scanExportManifest(invalidatedBundle, { requireSignedReferences: true });
assert.equal(result.blocked, true, 'invalidated signed references block export reuse');
assert(result.findings.some((f) => f.reason === 'signed-reference-invalidated'), 'invalidated signed reference is reported');

const expiredRefBundle = approvedBundle([cleanEntry({ id: 'artifact-a3' })]);
expiredRefBundle.signedReferences = buildExportSignedReferences(expiredRefBundle, {
	issuedAt: '2020-01-01T00:00:00.000Z',
	expiresAt: '2020-01-02T00:00:00.000Z',
});
result = scanExportManifest(expiredRefBundle, { requireSignedReferences: true });
assert.equal(result.blocked, true, 'expired signed references block export reuse');
assert(result.findings.some((f) => f.reason === 'signed-reference-expired'), 'expired signed reference is reported');

result = scanExportManifest(baseBundle([cleanEntry()]));
assert.equal(result.blocked, true, 'missing policy approval manifest blocks export');
assert(result.findings.some((f) => f.reason === 'missing-policy-approval-manifest'), 'missing policy manifest is reported');

result = scanExportManifest(approvedBundle([
		cleanEntry({ path: 'fixtures/auth/playwright/app.state.json', text: '{}' }),
		cleanEntry({ path: 'flows/demo.values.json', text: '{}' }),
		cleanEntry({ path: 'artifacts/run/local.sqlite', text: '' }),
]));
assert.equal(result.blocked, true, 'secret-bearing paths are blocked');
assert(result.findings.some((f) => f.reason === 'secret-directory'), 'auth/values path is classified');
assert(result.findings.some((f) => f.reason === 'secret-file'), 'DB file is classified');

result = scanExportManifest(approvedBundle([cleanEntry({
		path: 'artifacts/run/report.json',
		text: 'Authorization: Bearer raw_export_token Cookie: sid=raw_cookie access_token=raw_access',
})]));
assert.equal(result.blocked, true, 'raw cookie/token patterns block export');
assert(result.findings.some((f) => f.reason === 'raw-secret-pattern'), 'raw secret finding is reported');
const findingText = JSON.stringify(result.findings);
for (const raw of ['raw_export_token', 'raw_cookie', 'raw_access']) {
	assert(!findingText.includes(raw), `findings must not echo ${raw}`);
}

const unknownStatusBundle = {
	tenantId: 'tenant_a',
	requester: 'owner_a',
	purpose: 'unit-test sanitized export',
	expiresAt: EXPIRES_AT,
	files: [
		cleanEntry({ path: 'artifacts/run/report.json', redactionStatus: undefined, scanStatus: 'clean', text: 'already summarized' }),
		cleanEntry({ path: 'artifacts/run/results.tsv', scanStatus: undefined, redactionStatus: 'redacted', text: 'name\tpass' }),
	],
};
const unknownPolicy = buildPolicyApprovalManifest({
	tenantId: 'tenant_a',
	requester: 'owner_a',
	purpose: 'unit-test sanitized export',
	artifacts: unknownStatusBundle.files,
	approvedBy: 'owner_a',
	approvedAt: APPROVED_AT,
	createdAt: CREATED_AT,
});
unknownStatusBundle.policyApprovalManifest = unknownPolicy;
unknownStatusBundle.files = applyPolicyApprovalManifest(unknownStatusBundle.files, unknownPolicy);
result = scanExportManifest(unknownStatusBundle);
assert.equal(result.blocked, true, 'unknown redaction/scan status blocks export');
assert(result.findings.some((f) => f.reason === 'unknown-redaction-status'), 'unknown redaction is reported');
assert(result.findings.some((f) => f.reason === 'unknown-scan-status'), 'unknown scan status is reported');

assert.throws(() => assertExportManifestAllowed(unknownStatusBundle), /export manifest blocked/, 'assert helper fails closed');

result = scanExportManifest(approvedBundle([
		cleanEntry({ path: '../report.json' }),
		cleanEntry({ path: 'artifacts/run/%2e%2e/report.json' }),
		cleanEntry({ path: 'C:\\tenant\\report.json' }),
]));
assert.equal(result.blocked, true, 'path traversal and absolute paths block export');
assert(result.findings.some((f) => f.reason === 'path-traversal'), 'path traversal is reported');
assert(result.findings.some((f) => f.reason === 'absolute-path'), 'absolute path is reported');

result = scanExportManifest(approvedBundle([
		cleanEntry({ tenantId: 'tenant_b' }),
		cleanEntry({ tenantId: undefined }),
]));
assert.equal(result.blocked, true, 'tenant mismatch/missing tenant blocks export');
assert(result.findings.some((f) => f.reason === 'tenant-mismatch'), 'tenant mismatch is reported');
assert(result.findings.some((f) => f.reason === 'missing-item-tenant'), 'missing item tenant is reported');

result = scanExportManifest(approvedBundle([
	cleanEntry({ path: 'artifacts/20990101-010101-1/cache/shared/report.json' }),
	cleanEntry({ id: 'cache-key-only', cacheKey: 'shared-report-cache' }),
	cleanEntry({ id: 'cache-tenant-mismatch', cacheKey: 'tenant-b-report-cache', cacheTenantId: 'tenant_b' }),
]));
assert.equal(result.blocked, true, 'shared and cross-tenant cache metadata blocks export reuse');
assert(result.findings.some((f) => f.reason === 'shared-cache-reference'), 'shared cache reference is reported');
assert(result.findings.some((f) => f.reason === 'missing-cache-tenant'), 'cache key without tenant scope is reported');
assert(result.findings.some((f) => f.reason === 'cache-tenant-mismatch'), 'cache tenant mismatch is reported');

const policyGap = buildPolicyApprovalManifest({
	tenantId: 'tenant_a',
	requester: 'owner_a',
	purpose: 'unit-test sanitized export',
	artifacts: [cleanEntry()],
	approvedBy: 'owner_a',
	approvedAt: APPROVED_AT,
	createdAt: CREATED_AT,
});
result = scanExportManifest(baseBundle([
	cleanEntry({ policyApproval: undefined }),
	cleanEntry({ policyApproval: { status: 'approved', approvedBy: '', approvedAt: '', approvalId: policyGap.approvalId, manifestHash: policyGap.manifestHash } }),
	...applyPolicyApprovalManifest([cleanEntry({ deletedAt: '2099-01-02T00:00:00.000Z' })], policyGap),
], { policyApprovalManifest: policyGap }));
assert.equal(result.blocked, true, 'policy metadata and tombstone gaps block export');
assert(result.findings.some((f) => f.reason === 'missing-policy-approval'), 'missing policy approval is reported');
assert(result.findings.some((f) => f.reason === 'missing-policy-approver'), 'missing policy approver is reported');
assert(result.findings.some((f) => f.reason === 'missing-policy-approved-at'), 'missing policy timestamp is reported');
assert(result.findings.some((f) => f.reason === 'deleted-artifact'), 'deleted artifact is reported');

const mismatchedPolicy = buildPolicyApprovalManifest({
	tenantId: 'tenant_a',
	requester: 'owner_a',
	purpose: 'unit-test sanitized export',
	artifacts: [cleanEntry()],
	approvedBy: 'owner_a',
	approvedAt: APPROVED_AT,
	createdAt: CREATED_AT,
	approvalId: 'approval:entry',
});
const otherPolicy = buildPolicyApprovalManifest({
	tenantId: 'tenant_a',
	requester: 'owner_a',
	purpose: 'unit-test sanitized export',
	artifacts: [cleanEntry({ path: 'artifacts/other/report.json' })],
	approvedBy: 'owner_a',
	approvedAt: APPROVED_AT,
	createdAt: CREATED_AT,
	approvalId: 'approval:other',
});
result = scanExportManifest(baseBundle(applyPolicyApprovalManifest([cleanEntry()], mismatchedPolicy), { policyApprovalManifest: otherPolicy }));
assert.equal(result.blocked, true, 'policy manifest hash mismatch blocks export');
assert(result.findings.some((f) => f.reason === 'policy-manifest-hash-mismatch'), 'policy manifest mismatch is reported');

const manifest = buildExportManifest({
	tenantId: 'tenant_a',
	requester: 'owner_a',
	purpose: 'unit-test sanitized export',
	createdAt: CREATED_AT,
	artifacts: [{
		id: 1,
		tenantId: 'tenant_a',
		runId: '20990101-010101-1',
		path: 'artifacts/20990101-010101-1/sanitized-report.json',
		kind: 'report',
		sha256: `sha256:${'a'.repeat(64)}`,
		bytes: 25,
		retention: 'tenant-approved-archive',
		scanStatus: 'clean',
		redactionStatus: 'redacted',
		policyApproval: 'approved',
		policyApprovedBy: 'owner_a',
		policyApprovedAt: APPROVED_AT,
	}],
});
assert.equal(manifest.decision.allowed, true, 'sanitized metadata manifest is allowed');
assert.match(manifest.manifestHash, /^sha256:[0-9a-f]{64}$/, 'manifest has a deterministic hash');
assert.equal(assertExportManifestAllowed(manifest).allowed, true, 'manifest assert helper allows sanitized metadata');

const sharedCacheManifest = buildExportManifest({
	tenantId: 'tenant_a',
	requester: 'owner_a',
	purpose: 'unit-test shared cache negative',
	createdAt: CREATED_AT,
	artifacts: [{
		id: 'cache-built',
		tenantId: 'tenant_a',
		runId: '20990101-010101-1',
		path: 'artifacts/20990101-010101-1/cache-built.json',
		kind: 'report',
		sha256: `sha256:${'c'.repeat(64)}`,
		bytes: 25,
		retention: 'tenant-approved-archive',
		scanStatus: 'clean',
		redactionStatus: 'redacted',
		policyApproval: 'approved',
		policyApprovedBy: 'owner_a',
		policyApprovedAt: APPROVED_AT,
		cacheScope: 'shared',
		cacheKey: 'shared-cache-key',
		cacheTenantId: 'tenant_a',
	}],
});
assert.equal(sharedCacheManifest.decision.allowed, false, 'generated export manifests preserve and block shared cache metadata');
assert(sharedCacheManifest.decision.findings.some((f) => f.reason === 'shared-cache-reference'), 'generated manifest shared cache finding is reported');

const fakeSanitized = approvedBundle([
	cleanEntry({
		path: 'artifacts/20990101-010101-1/sanitized-report.json',
		kind: 'report',
		text: '{"status":"pass","credential":"removed","notes":"operator-reviewed fixture"}',
	}),
	cleanEntry({
		path: 'artifacts/20990101-010101-1/results.tsv',
		kind: 'results',
		redactionStatus: 'not-required',
		scanStatus: 'passed',
		text: 'name\tstatus\nfake-sanitized\tpass\n',
	}),
], { purpose: 'deterministic fake sanitized export' });
result = scanExportManifest(fakeSanitized);
assert.equal(result.allowed, true, 'deterministic fake sanitized export is allowed');
const fakeSanitizedAgain = approvedBundle([
	cleanEntry({
		path: 'artifacts/20990101-010101-1/sanitized-report.json',
		kind: 'report',
		text: '{"status":"pass","credential":"removed","notes":"operator-reviewed fixture"}',
	}),
	cleanEntry({
		path: 'artifacts/20990101-010101-1/results.tsv',
		kind: 'results',
		redactionStatus: 'not-required',
		scanStatus: 'passed',
		text: 'name\tstatus\nfake-sanitized\tpass\n',
	}),
], { purpose: 'deterministic fake sanitized export' });
assert.equal(fakeSanitized.policyApprovalManifest.manifestHash, fakeSanitizedAgain.policyApprovalManifest.manifestHash, 'fake sanitized approval manifest hash is deterministic');

console.log('  webui-export-gate-unit: export scan gate checks passed');
NODE
)
