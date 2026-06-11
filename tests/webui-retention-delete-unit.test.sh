#!/usr/bin/env bash
# Browser-free checks for tenant artifact retention, deletion, and tombstones.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

( cd "$DIR" && AQA_DB_PATH="$TMP/retention.db" node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { artifactReadDecision, artifactRouteMetadata, buildTenantDeletionPreflightManifest, tombstoneArtifact, tombstoneTenantArtifacts } from './webui/retention.js';
import { buildExportManifestFromDb } from './webui/export.js';

const require = createRequire(import.meta.url);
const dbm = require('./lib/db.js');
const db = dbm.openDb();

const hash = (ch) => `sha256:${ch.repeat(64)}`;
const approval = { status: 'approved', approvedBy: 'owner_a', approvedAt: '2099-01-01T00:00:00.000Z' };
const ctxA = { mode: 'local-pilot', tenantId: 'tenant_a', tenant: { id: 'tenant_a' }, actor: { id: 'operator_a', role: 'operator', tenantId: 'tenant_a' } };
const ctxB = { mode: 'local-pilot', tenantId: 'tenant_b', tenant: { id: 'tenant_b' }, actor: { id: 'operator_b', role: 'operator', tenantId: 'tenant_b' } };

try {
	const a1 = dbm.saveWebuiArtifact(db, {
		tenantId: 'tenant_a',
		actorId: 'operator_a',
		jobId: 'job_a',
		runId: '20990104-010101-1',
		path: 'artifacts/20990104-010101-1/report.json',
		kind: 'report',
		sha256: hash('a'),
		bytes: 123,
		redaction: 'text-redacted-on-read',
		redactionStatus: 'redacted',
		scanStatus: 'clean',
		retention: 'ephemeral-debug',
		policyApproval: approval,
	});
	const a2 = dbm.saveWebuiArtifact(db, {
		tenantId: 'tenant_a',
		actorId: 'operator_a',
		jobId: 'job_a',
		runId: '20990104-010101-1',
		path: 'artifacts/20990104-010101-1/results.tsv',
		kind: 'results',
		sha256: hash('b'),
		bytes: 77,
		redaction: 'text-redacted-on-read',
		redactionStatus: 'redacted',
		scanStatus: 'clean',
		retention: 'ephemeral-debug',
		policyApproval: approval,
	});
	const b1 = dbm.saveWebuiArtifact(db, {
		tenantId: 'tenant_b',
		actorId: 'operator_b',
		jobId: 'job_b',
		runId: '20990105-010101-2',
		path: 'artifacts/20990105-010101-2/report.json',
		kind: 'report',
		sha256: hash('c'),
		bytes: 55,
		redaction: 'text-redacted-on-read',
		redactionStatus: 'redacted',
		scanStatus: 'clean',
		retention: 'ephemeral-debug',
		policyApproval: { status: 'approved', approvedBy: 'owner_b', approvedAt: '2099-01-01T00:00:00.000Z' },
	});
	const b2 = dbm.saveWebuiArtifact(db, {
		tenantId: 'tenant_b',
		actorId: 'operator_b',
		jobId: 'job_b',
		runId: '20990105-010101-2',
		path: 'artifacts/20990105-010101-2/results.tsv',
		kind: 'results',
		sha256: hash('d'),
		bytes: 44,
		redaction: 'text-redacted-on-read',
		redactionStatus: 'redacted',
		scanStatus: 'clean',
		retention: 'ephemeral-debug',
		policyApproval: { status: 'approved', approvedBy: 'owner_b', approvedAt: '2099-01-01T00:00:00.000Z' },
	});
	const held = dbm.saveWebuiArtifact(db, {
		tenantId: 'tenant_hold',
		actorId: 'operator_hold',
		jobId: 'job_hold',
		runId: '20990106-010101-3',
		path: 'artifacts/20990106-010101-3/report.json',
		kind: 'report',
		sha256: hash('e'),
		bytes: 11,
		redaction: 'text-redacted-on-read',
		redactionStatus: 'redacted',
		scanStatus: 'clean',
		retention: 'legal-hold',
		policyApproval: { status: 'approved', approvedBy: 'owner_hold', approvedAt: '2099-01-01T00:00:00.000Z' },
		meta: { legalHold: true, legalHoldReason: 'incident-review' },
	});

	const blockedPreflight = buildTenantDeletionPreflightManifest({
		tenantId: 'tenant_a',
		actorId: 'owner_a',
		reason: 'unit-test blocked tenant deletion',
		createdAt: '2099-01-01T00:00:00.000Z',
		artifacts: [{ ...a1, meta: { legalHold: true, legalHoldReason: 'incident-review' } }],
		jobs: [{ id: 'job_active', tenantId: 'tenant_a', status: 'running', retention: 'ephemeral-debug', log: ['password=do-not-print'] }],
		logs: [{ id: 99, tenantId: 'tenant_a', jobId: 'job_active', event: 'line', redaction: 'applied', message: 'token=do-not-print' }],
		browserSessions: [{ sessionId: 'nv_active', tenantId: 'tenant_a', jobId: 'job_active', state: 'open', teardownState: 'not-required' }],
		secrets: [{ tenantId: 'tenant_a', ref: 'aqa-secret://tenant_a/auth-state/app', kind: 'auth-state', name: 'app', present: true, deleteSupported: false }],
		exportReferences: [{ tenantId: 'tenant_a', refId: 'expref-active', path: a1.path, status: 'active', expiresAt: '2099-01-08T00:00:00.000Z' }],
	});
	assert.equal(blockedPreflight.metadataOnly, true, 'tenant deletion preflight is metadata-only');
	assert.equal(blockedPreflight.readsRawArtifacts, false, 'tenant deletion preflight does not read artifact bytes');
	assert.equal(blockedPreflight.readsSecretBytes, false, 'tenant deletion preflight does not read secret bytes');
	assert.equal(blockedPreflight.decision.blocked, true, 'legal holds and active classes block tenant deletion');
	for (const reason of ['legal-hold', 'active-job', 'active-browser-session', 'secret-delete-unsupported', 'active-export-reference']) {
		assert(blockedPreflight.decision.findings.some((f) => f.reason === reason), `${reason} finding is reported`);
	}
	const blockedPreflightJson = JSON.stringify(blockedPreflight);
	assert(!blockedPreflightJson.includes('do-not-print'), 'preflight manifest does not echo raw job/log text');

	const readyPreflight = buildTenantDeletionPreflightManifest({
		tenantId: 'tenant_a',
		actorId: 'owner_a',
		reason: 'unit-test ready tenant deletion',
		createdAt: '2099-01-01T00:00:00.000Z',
		artifacts: [a2],
		jobs: [{ id: 'job_done', tenantId: 'tenant_a', status: 'succeeded', retention: 'ephemeral-debug' }],
		logs: [{ id: 100, tenantId: 'tenant_a', jobId: 'job_done', event: 'finish', redaction: 'applied', hash: hash('f') }],
		browserSessions: [{ sessionId: 'nv_closed', tenantId: 'tenant_a', jobId: 'job_done', state: 'closed', teardownState: 'complete' }],
		secrets: [{ tenantId: 'tenant_a', ref: 'aqa-secret://tenant_a/auth-state/app', kind: 'auth-state', name: 'app', present: true, deleteSupported: true, encrypted: true }],
		exportReferences: [{ tenantId: 'tenant_a', refId: 'expref-invalidated', path: a2.path, status: 'invalidated', invalidatedAt: '2099-01-02T00:00:00.000Z', expiresAt: '2099-01-08T00:00:00.000Z' }],
	});
	assert.equal(readyPreflight.decision.allowed, true, 'completed classes with invalidated export refs pass preflight');
	assert.equal(readyPreflight.summary.byClass.artifacts, 1, 'preflight summarizes artifact class');
	assert.equal(readyPreflight.summary.byClass.jobs, 1, 'preflight summarizes job class');
	assert.equal(readyPreflight.summary.byClass.logs, 1, 'preflight summarizes log class');
	assert.equal(readyPreflight.summary.byClass.browserSessions, 1, 'preflight summarizes browser class');
	assert.equal(readyPreflight.summary.byClass.secrets, 1, 'preflight summarizes secret class');
	assert.equal(readyPreflight.summary.byClass.exportReferences, 1, 'preflight summarizes export reference class');
	assert.match(readyPreflight.manifestHash, /^sha256:[0-9a-f]{64}$/, 'preflight manifest has an integrity hash');

	assert.throws(() => dbm.saveWebuiArtifact(db, { tenantId: 'tenant_a', runId: 'x', path: '../escape.txt', sha256: hash('d') }), /invalid path/, 'path traversal metadata is rejected');
	assert.throws(() => dbm.saveWebuiArtifact(db, { tenantId: 'tenant_a', runId: 'x', path: 'artifacts/x/%2e%2e/escape.txt', sha256: hash('d') }), /invalid path/, 'encoded path traversal metadata is rejected');
	assert.throws(() => dbm.saveWebuiArtifact(db, { tenantId: 'tenant_a', runId: 'x', path: 'C:/tenant/report.json', sha256: hash('d') }), /invalid path/, 'absolute artifact metadata path is rejected');
	const artifactsDir = path.join(process.cwd(), 'artifacts');
	assert.deepEqual(
		artifactRouteMetadata({ artifactsDir, filePath: path.join(artifactsDir, '20990104-010101-1', 'report.json') }),
		{ runId: '20990104-010101-1', artifactPath: 'artifacts/20990104-010101-1/report.json' },
		'artifact route metadata maps an in-root file to run/path metadata',
	);
	assert.equal(
		artifactRouteMetadata({ artifactsDir, filePath: path.join(artifactsDir, '..', 'secret.txt') }),
		null,
		'artifact route metadata refuses traversal outside artifacts root',
	);

	let decision = artifactReadDecision(db, { context: ctxA, runId: a1.runId, artifactPath: a1.path });
	assert.equal(decision.allowed, true, 'same-tenant artifact metadata allows read');

	decision = artifactReadDecision(db, { context: ctxA, runId: a1.runId, artifactPath: 'artifacts/20990104-010101-1/missing.txt' });
	assert.equal(decision.allowed, false, 'guessed path inside a metadata-owned run is denied');

	decision = artifactReadDecision(db, { context: ctxA, runId: b1.runId, artifactPath: b1.path });
	assert.equal(decision.allowed, false, 'tenant A cannot reuse tenant B artifact URL');

	decision = artifactReadDecision(db, { context: ctxB, runId: a1.runId, artifactPath: a1.path });
	assert.equal(decision.allowed, false, 'tenant B cannot read tenant A artifact metadata');

	const allowedManifest = buildExportManifestFromDb(db, {
		tenantId: 'tenant_a',
		artifactIds: [a2.id],
		requester: 'owner_a',
		purpose: 'unit-test sanitized export',
		createdAt: '2099-01-01T00:00:00.000Z',
	});
	assert.equal(allowedManifest.decision.allowed, true, 'same-tenant approved artifact metadata is exportable');
	assert.match(allowedManifest.policyApprovalManifest.manifestHash, /^sha256:[0-9a-f]{64}$/, 'export includes a policy approval manifest hash');

	const crossTenantManifest = buildExportManifestFromDb(db, {
		tenantId: 'tenant_a',
		artifactIds: [b1.id],
		requester: 'owner_a',
		purpose: 'unit-test cross-tenant negative',
		createdAt: '2099-01-01T00:00:00.000Z',
	});
	assert.equal(crossTenantManifest.decision.allowed, false, 'cross-tenant artifact id cannot be exported');
	assert.deepEqual(crossTenantManifest.missingArtifactIds, [String(b1.id)], 'cross-tenant id is treated as unresolved metadata');
	assert(crossTenantManifest.decision.findings.some((f) => f.reason === 'missing-artifact-metadata'), 'cross-tenant export denial is reported without tenant B metadata');

	let deleted = dbm.tombstoneWebuiArtifact(db, { tenantId: 'tenant_b', id: a1.id, actorId: 'operator_b', reason: 'wrong tenant' });
	assert.equal(deleted.denied, true, 'cross-tenant artifact deletion is refused');
	assert.equal(dbm.getWebuiArtifact(db, { tenantId: 'tenant_a', id: a1.id }).deleted, false, 'cross-tenant delete does not tombstone the artifact');

	deleted = dbm.tombstoneWebuiArtifact(db, { tenantId: 'tenant_a', runId: b1.runId, path: b1.path, actorId: 'operator_a', reason: 'wrong tenant path' });
	assert.equal(deleted.denied, true, 'cross-tenant run/path artifact deletion is refused');
	deleted = dbm.tombstoneWebuiArtifact(db, { tenantId: 'tenant_b', runId: b2.runId, path: b2.path, actorId: 'operator_b', reason: 'tenant path delete' });
	assert.equal(deleted.ok, true, 'same-tenant run/path artifact deletion succeeds');
	assert.equal(dbm.getWebuiArtifact(db, { tenantId: 'tenant_b', id: b1.id }).deleted, false, 'run/path delete leaves sibling tenant artifact untouched');

	const heldDelete = tombstoneTenantArtifacts({
		tenantId: 'tenant_hold',
		actorId: 'owner_hold',
		reason: 'tenant deletion',
		now: '2099-01-02T00:00:00.000Z',
	});
	assert.equal(heldDelete.blocked, true, 'tenant deletion is blocked by legal hold metadata');
	assert(heldDelete.preflightManifest.decision.findings.some((f) => f.reason === 'legal-hold'), 'legal hold finding is present in deletion preflight');
	assert.equal(dbm.getWebuiArtifact(db, { tenantId: 'tenant_hold', id: held.id }).deleted, false, 'legal hold prevents tombstoning');

	deleted = tombstoneArtifact({ tenantId: 'tenant_a', id: a1.id, actorId: 'operator_a', reason: 'retention expired', now: '2099-01-02T00:00:00.000Z' });
	assert.equal(deleted.ok, true, 'same-tenant deletion succeeds');
	assert.equal(deleted.artifact.deleted, true, 'same-tenant deletion leaves a tombstone');
	assert.equal(deleted.artifact.bytes, null, 'tombstone drops byte count metadata');
	assert.equal(deleted.artifact.deleteReason, 'retention expired', 'tombstone records delete reason');
	assert.equal(deleted.tombstoneManifest.manifestKind, 'aqa.artifact-tombstone-manifest', 'artifact delete returns a tombstone manifest');
	assert.equal(deleted.tombstoneManifest.artifact.id, String(a1.id), 'tombstone manifest references the artifact id');
	assert.match(deleted.tombstoneManifest.manifestHash, /^sha256:[0-9a-f]{64}$/, 'tombstone manifest has an integrity hash');

	decision = artifactReadDecision(db, { context: ctxA, runId: a1.runId, artifactPath: a1.path });
	assert.equal(decision.code, 410, 'deleted artifact URL is gone');

	const deniedManifest = buildExportManifestFromDb(db, {
		tenantId: 'tenant_a',
		artifactIds: [a1.id],
		requester: 'owner_a',
		purpose: 'unit-test tombstone denial',
	});
	assert.equal(deniedManifest.decision.allowed, false, 'deleted artifact tombstone is not exportable');
	assert(deniedManifest.decision.findings.some((f) => f.reason === 'deleted-artifact'), 'deleted export finding is present');

	const tenantDelete = tombstoneTenantArtifacts({
		tenantId: 'tenant_a',
		actorId: 'owner_a',
		reason: 'tenant deletion',
		now: '2099-01-03T00:00:00.000Z',
	});
	assert.equal(tenantDelete.tombstoned, 1, 'tenant deletion tombstones remaining tenant A artifacts only');
	assert.equal(tenantDelete.deletionManifest.manifestKind, 'aqa.tenant-deletion-manifest', 'tenant deletion returns a manifest');
	assert.equal(tenantDelete.deletionManifest.summary.tombstoned, 1, 'tenant deletion manifest summarizes tombstoned artifacts');
	assert.deepEqual(tenantDelete.deletionManifest.summary.artifactIds, [String(a2.id)], 'tenant deletion manifest lists only tenant A active artifact ids');
	assert.match(tenantDelete.deletionManifest.manifestHash, /^sha256:[0-9a-f]{64}$/, 'tenant deletion manifest has an integrity hash');
	assert.equal(dbm.getWebuiArtifact(db, { tenantId: 'tenant_a', id: a2.id }).deleted, true, 'remaining tenant A artifact is tombstoned');
	assert.equal(dbm.getWebuiArtifact(db, { tenantId: 'tenant_b', id: b1.id }).deleted, false, 'tenant B artifact is untouched');

	console.log('  webui-retention-delete-unit: retention/delete checks passed');
} finally {
	dbm.closeDb(db);
}
NODE
)
