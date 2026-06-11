// webui/tenant-deletion.js - metadata-only tenant deletion orchestration.
//
// The orchestrator connects preflight, artifact byte cleanup, rollback, and
// tombstone manifest generation without opening artifact files or secret
// material. Production byte deletion is delegated to an adapter.

import crypto from 'node:crypto';
import path from 'node:path';
import {
	buildTenantDeletionManifest,
	buildTenantDeletionPreflightManifest,
} from './retention.js';

const ARTIFACT_CLEANUP_MANIFEST_KIND = 'aqa.artifact-byte-cleanup-manifest';
const TENANT_DELETION_ORCHESTRATION_KIND = 'aqa.tenant-deletion-orchestration';
const WINDOWS_ABS_RE = /^[A-Za-z]:[\\/]/;
const SAFE_HASH_RE = /^sha256:[0-9a-f]{64}$/i;

function cleanString(value) {
	return String(value || '').trim();
}

function safeReason(value, fallback) {
	const token = cleanString(value).toLowerCase();
	return /^[a-z0-9][a-z0-9_-]{0,120}$/.test(token) ? token : fallback;
}

function manifestHash(manifest) {
	const copy = { ...manifest };
	delete copy.manifestHash;
	return `sha256:${crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex')}`;
}

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function finding(reason, itemClass, id, message) {
	return { reason, class: itemClass, id: id == null ? '' : String(id), message };
}

function stableArtifactKey(entry) {
	return [
		entry?.id == null ? '' : String(entry.id),
		cleanString(entry?.runId),
		cleanString(entry?.path),
	].join('\0');
}

function safeArtifactPath(value) {
	const raw = cleanString(value);
	if (!raw) return { ok: false, reason: 'missing-artifact-path' };
	if (raw.includes('\0')) return { ok: false, reason: 'nul-byte' };
	if (WINDOWS_ABS_RE.test(raw)) return { ok: false, reason: 'absolute-path' };
	let decoded = raw;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		return { ok: false, reason: 'bad-path-encoding' };
	}
	const normalizedInput = decoded.replace(/\\/g, '/');
	if (normalizedInput.startsWith('/') || WINDOWS_ABS_RE.test(normalizedInput)) {
		return { ok: false, reason: 'absolute-path' };
	}
	if (normalizedInput.split('/').some((part) => part === '..')) {
		return { ok: false, reason: 'path-traversal' };
	}
	const normalized = path.posix.normalize(normalizedInput);
	if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
		return { ok: false, reason: 'path-traversal' };
	}
	if (!normalized.startsWith('artifacts/')) {
		return { ok: false, reason: 'artifact-path-out-of-scope' };
	}
	return { ok: true, path: normalized };
}

function artifactCleanupTarget(artifact, tenantId) {
	const safePath = safeArtifactPath(artifact?.path);
	const deleted = !!artifact?.deletedAt || artifact?.deleted === true;
	return {
		class: 'artifact',
		id: artifact?.id == null ? null : String(artifact.id),
		tenantId: cleanString(artifact?.tenantId),
		jobId: artifact?.jobId || null,
		runId: artifact?.runId || null,
		path: safePath.ok ? safePath.path : cleanString(artifact?.path),
		kind: artifact?.kind || null,
		sha256: cleanString(artifact?.sha256),
		retention: artifact?.retention || 'ephemeral-debug',
		deleted,
		operation: deleted ? 'retain-tombstone' : 'delete-artifact-bytes',
		expectedTenantId: tenantId,
		metadataOnly: true,
		readsRawData: false,
	};
}

function artifactCleanupTargets(artifacts, tenantId) {
	const findings = [];
	const targets = asArray(artifacts)
		.map((artifact) => artifactCleanupTarget(artifact, tenantId))
		.sort((a, b) => stableArtifactKey(a).localeCompare(stableArtifactKey(b)));

	for (const target of targets) {
		if (!target.tenantId) {
			findings.push(finding('missing-item-tenant', 'artifact', target.id || target.path, 'artifact cleanup target requires tenant metadata'));
		} else if (target.tenantId !== tenantId) {
			findings.push(finding('tenant-mismatch', 'artifact', target.id || target.path, 'artifact cleanup target tenant must match deletion tenant'));
		}
		if (!target.id && (!target.runId || !target.path)) {
			findings.push(finding('missing-artifact-identity', 'artifact', target.id || target.path, 'artifact cleanup target requires id or runId/path metadata'));
		}
		const safe = safeArtifactPath(target.path);
		if (!safe.ok) {
			findings.push(finding(safe.reason, 'artifact', target.id || target.path, 'artifact cleanup target path must be a safe artifact path'));
		}
		if (!SAFE_HASH_RE.test(target.sha256)) {
			findings.push(finding('missing-artifact-hash', 'artifact', target.id || target.path, 'artifact cleanup target requires sha256 metadata'));
		}
	}

	return { targets, findings };
}

function adapterMissingFinding(targets) {
	const needsCleanup = targets.some((target) => target.operation === 'delete-artifact-bytes');
	return needsCleanup
		? [finding('artifact-cleanup-adapter-missing', 'artifact', '', 'tenant deletion requires an artifact cleanup adapter')]
		: [];
}

function buildArtifactCleanupManifest({
	tenantId,
	actorId,
	reason,
	createdAt,
	retryOf = null,
	status,
	targets = [],
	operations = [],
	rollbacks = [],
	findings = [],
} = {}) {
	const blocked = findings.length > 0 || ['blocked', 'failed', 'rollback-failed'].includes(status);
	const manifest = {
		schemaVersion: 1,
		manifestKind: ARTIFACT_CLEANUP_MANIFEST_KIND,
		tenantId: cleanString(tenantId),
		actorId: cleanString(actorId),
		reason: cleanString(reason || 'tenant deletion artifact cleanup'),
		createdAt,
		retryOf: retryOf || null,
		metadataOnly: true,
		readsRawArtifacts: false,
		status,
		summary: {
			totalTargets: targets.length,
			cleanupTargets: targets.filter((target) => target.operation === 'delete-artifact-bytes').length,
			retainedTombstones: targets.filter((target) => target.operation === 'retain-tombstone').length,
			completed: operations.filter((op) => op.ok).length,
			failed: operations.filter((op) => !op.ok).length,
			rolledBack: rollbacks.filter((op) => op.ok).length,
			rollbackFailed: rollbacks.filter((op) => !op.ok).length,
		},
		targets,
		operations,
		rollbacks,
		decision: {
			allowed: !blocked,
			blocked,
			failClosed: true,
			findings,
		},
	};
	manifest.manifestHash = manifestHash(manifest);
	return manifest;
}

function normalizeCleanupResult(target, result) {
	const ok = result === true || result?.ok === true;
	const adapterReadsRawData = result?.readsRawData === true || result?.readsRawArtifacts === true || result?.rawContentRead === true;
	return {
		ok: ok && !adapterReadsRawData,
		class: 'artifact',
		id: target.id,
		tenantId: target.tenantId,
		runId: target.runId,
		path: target.path,
		sha256: target.sha256,
		operation: target.operation,
		status: ok && !adapterReadsRawData ? 'completed' : 'failed',
		reason: adapterReadsRawData
			? 'adapter-read-raw-artifact'
			: safeReason(result?.reason || result?.error, ok ? 'artifact-bytes-deleted' : 'artifact-cleanup-failed'),
		metadataOnly: true,
		readsRawData: false,
	};
}

function normalizeRollbackResult(target, result) {
	const ok = result === true || result?.ok === true;
	return {
		ok,
		class: 'artifact',
		id: target.id,
		tenantId: target.tenantId,
		runId: target.runId,
		path: target.path,
		sha256: target.sha256,
		operation: 'rollback-artifact-byte-cleanup',
		status: ok ? 'completed' : 'failed',
		reason: safeReason(result?.reason || result?.error, ok ? 'artifact-cleanup-rolled-back' : 'artifact-cleanup-rollback-failed'),
		metadataOnly: true,
		readsRawData: false,
	};
}

async function cleanupTarget(adapter, target, context) {
	if (target.operation !== 'delete-artifact-bytes') {
		return normalizeCleanupResult(target, { ok: true, reason: 'already tombstoned' });
	}
	try {
		const result = await adapter.cleanupArtifact(target, context);
		return normalizeCleanupResult(target, result);
	} catch (err) {
		return normalizeCleanupResult(target, { ok: false, reason: err?.code || 'artifact-cleanup-exception' });
	}
}

async function rollbackTargets(adapter, completed, context) {
	const rollbacks = [];
	for (const op of [...completed].reverse()) {
		const target = op.target;
		if (!adapter || typeof adapter.rollbackArtifact !== 'function') {
			rollbacks.push(normalizeRollbackResult(target, { ok: false, reason: 'rollback adapter missing' }));
			continue;
		}
		try {
			const result = await adapter.rollbackArtifact(target, { ...context, cleanupOperation: op.operation });
			rollbacks.push(normalizeRollbackResult(target, result));
		} catch (err) {
			rollbacks.push(normalizeRollbackResult(target, { ok: false, reason: err?.code || 'artifact-cleanup-rollback-exception' }));
		}
	}
	return rollbacks;
}

function workflowFrom(preflightManifest, cleanupManifest, deletionManifest = null) {
	const classes = preflightManifest?.classes || {};
	const classOperations = (entries) => [...new Set(asArray(entries).map((entry) => entry.operation).filter(Boolean))].sort();
	return [
		{
			class: 'artifacts',
			count: asArray(classes.artifacts).length,
			operation: 'delete-artifact-bytes-then-tombstone-metadata',
			cleanupStatus: cleanupManifest?.status || 'not-started',
			metadataStatus: deletionManifest ? 'manifested' : 'pending',
			readsRawData: false,
		},
		{
			class: 'jobs',
			count: asArray(classes.jobs).length,
			operations: classOperations(classes.jobs),
			metadataStatus: deletionManifest ? 'manifested' : 'pending',
			readsRawData: false,
		},
		{
			class: 'logs',
			count: asArray(classes.logs).length,
			operations: classOperations(classes.logs),
			metadataStatus: deletionManifest ? 'manifested' : 'pending',
			readsRawData: false,
		},
		{
			class: 'browserSessions',
			count: asArray(classes.browserSessions).length,
			operations: classOperations(classes.browserSessions),
			metadataStatus: deletionManifest ? 'manifested' : 'pending',
			pathsExposed: false,
		},
		{
			class: 'secrets',
			count: asArray(classes.secrets).length,
			operations: classOperations(classes.secrets),
			metadataStatus: deletionManifest ? 'manifested' : 'pending',
			readsSecretBytes: false,
		},
		{
			class: 'exportReferences',
			count: asArray(classes.exportReferences).length,
			operations: classOperations(classes.exportReferences),
			metadataStatus: deletionManifest ? 'manifested' : 'pending',
			readsRawData: false,
		},
	];
}

function buildOrchestrationManifest({
	tenantId,
	actorId,
	reason,
	createdAt,
	retryOf = null,
	status,
	preflightManifest,
	cleanupManifest,
	deletionManifest = null,
	findings = [],
} = {}) {
	const blocked = findings.length > 0 || status !== 'completed';
	const manifest = {
		schemaVersion: 1,
		manifestKind: TENANT_DELETION_ORCHESTRATION_KIND,
		tenantId: cleanString(tenantId),
		actorId: cleanString(actorId),
		reason: cleanString(reason || 'tenant deletion'),
		createdAt,
		retryOf: retryOf || null,
		metadataOnly: true,
		readsRawArtifacts: false,
		readsSecretBytes: false,
		status,
		preflightManifestHash: preflightManifest?.manifestHash || null,
		cleanupManifestHash: cleanupManifest?.manifestHash || null,
		deletionManifestHash: deletionManifest?.manifestHash || null,
		workflow: workflowFrom(preflightManifest, cleanupManifest, deletionManifest),
		decision: {
			allowed: !blocked,
			blocked,
			failClosed: true,
			findings,
		},
	};
	manifest.manifestHash = manifestHash(manifest);
	return manifest;
}

function blockedResult({
	tenantId,
	actorId,
	reason,
	createdAt,
	retryOf,
	preflightManifest,
	cleanupManifest,
	findings,
	stage,
} = {}) {
	const orchestrationManifest = buildOrchestrationManifest({
		tenantId,
		actorId,
		reason,
		createdAt,
		retryOf,
		status: 'blocked',
		preflightManifest,
		cleanupManifest,
		findings,
	});
	return {
		ok: false,
		blocked: true,
		stage,
		tenantId,
		preflightManifest,
		cleanupManifest,
		orchestrationManifest,
		findings,
	};
}

export function createFakeArtifactCleanupAdapter({
	failArtifactIds = [],
	failPaths = [],
	failRollbackArtifactIds = [],
	failRollbackPaths = [],
} = {}) {
	const failedIds = new Set(failArtifactIds.map((value) => String(value)));
	const failedPaths = new Set(failPaths.map((value) => String(value)));
	const rollbackFailedIds = new Set(failRollbackArtifactIds.map((value) => String(value)));
	const rollbackFailedPaths = new Set(failRollbackPaths.map((value) => String(value)));
	const operations = [];
	const rollbacks = [];
	const targetSummary = (target) => ({
		id: target.id,
		tenantId: target.tenantId,
		runId: target.runId,
		path: target.path,
		sha256: target.sha256,
		operation: target.operation,
		metadataOnly: true,
		readsRawData: false,
	});

	return {
		kind: 'fake-artifact-cleanup-adapter',
		metadataOnly: true,
		readsRawArtifacts: false,
		operations,
		rollbacks,
		async cleanupArtifact(target) {
			const summary = targetSummary(target);
			operations.push(summary);
			if ((target.id != null && failedIds.has(String(target.id))) || failedPaths.has(String(target.path))) {
				return { ok: false, reason: 'fake-artifact-cleanup-failure', ...summary };
			}
			return { ok: true, reason: 'fake-artifact-cleanup-success', ...summary };
		},
		async rollbackArtifact(target) {
			const summary = { ...targetSummary(target), operation: 'rollback-artifact-byte-cleanup' };
			rollbacks.push(summary);
			if ((target.id != null && rollbackFailedIds.has(String(target.id))) || rollbackFailedPaths.has(String(target.path))) {
				return { ok: false, reason: 'fake-artifact-rollback-failure', ...summary };
			}
			return { ok: true, reason: 'fake-artifact-rollback-success', ...summary };
		},
	};
}

export async function orchestrateTenantDeletion({
	tenantId,
	actorId,
	reason = 'tenant deletion',
	artifacts = [],
	jobs = [],
	logs = [],
	browserSessions = [],
	secrets = [],
	exportReferences = [],
	artifactCleanupAdapter,
	createdAt,
	now,
	retryOf = null,
} = {}) {
	const created = cleanString(createdAt || now) || new Date().toISOString();
	const tenant = cleanString(tenantId);
	const actor = cleanString(actorId);
	const preflightManifest = buildTenantDeletionPreflightManifest({
		tenantId: tenant,
		actorId: actor,
		reason,
		artifacts,
		jobs,
		logs,
		browserSessions,
		secrets,
		exportReferences,
		createdAt: created,
	});
	const { targets, findings: targetFindings } = artifactCleanupTargets(artifacts, tenant);
	const adapterFindings = artifactCleanupAdapter && typeof artifactCleanupAdapter.cleanupArtifact === 'function'
		? []
		: adapterMissingFinding(targets);
	const preflightFindings = preflightManifest.decision.findings || [];
	const initialFindings = [...preflightFindings, ...targetFindings, ...adapterFindings];

	if (initialFindings.length) {
		const cleanupManifest = buildArtifactCleanupManifest({
			tenantId: tenant,
			actorId: actor,
			reason,
			createdAt: created,
			retryOf,
			status: 'blocked',
			targets,
			findings: initialFindings,
		});
		return blockedResult({
			tenantId: tenant,
			actorId: actor,
			reason,
			createdAt: created,
			retryOf,
			preflightManifest,
			cleanupManifest,
			findings: initialFindings,
			stage: preflightFindings.length ? 'preflight' : 'artifact-cleanup-preflight',
		});
	}

	const context = {
		tenantId: tenant,
		actorId: actor,
		reason,
		createdAt: created,
		retryOf,
	};
	const operations = [];
	const completed = [];
	for (const target of targets) {
		const operation = await cleanupTarget(artifactCleanupAdapter, target, context);
		operations.push(operation);
		if (operation.ok) {
			completed.push({ target, operation });
			continue;
		}
		const rollbacks = await rollbackTargets(artifactCleanupAdapter, completed, context);
		const rollbackFailed = rollbacks.some((entry) => !entry.ok);
		const findings = [
			finding(operation.reason || 'artifact-cleanup-failed', 'artifact', target.id || target.path, 'artifact byte cleanup failed before metadata tombstones were committed'),
			...rollbacks.filter((entry) => !entry.ok).map((entry) => finding(entry.reason || 'artifact-cleanup-rollback-failed', 'artifact', entry.id || entry.path, 'artifact byte cleanup rollback failed')),
		];
		const cleanupManifest = buildArtifactCleanupManifest({
			tenantId: tenant,
			actorId: actor,
			reason,
			createdAt: created,
			retryOf,
			status: rollbackFailed ? 'rollback-failed' : 'failed',
			targets,
			operations,
			rollbacks,
			findings,
		});
		const orchestrationManifest = buildOrchestrationManifest({
			tenantId: tenant,
			actorId: actor,
			reason,
			createdAt: created,
			retryOf,
			status: cleanupManifest.status,
			preflightManifest,
			cleanupManifest,
			findings,
		});
		return {
			ok: false,
			blocked: true,
			partialFailure: true,
			stage: 'artifact-cleanup',
			tenantId: tenant,
			preflightManifest,
			cleanupManifest,
			orchestrationManifest,
			findings,
		};
	}

	const cleanupManifest = buildArtifactCleanupManifest({
		tenantId: tenant,
		actorId: actor,
		reason,
		createdAt: created,
		retryOf,
		status: 'completed',
		targets,
		operations,
		findings: [],
	});
	const tombstonedArtifacts = artifacts.map((artifact) => ({
		...artifact,
		deleted: true,
		deletedAt: artifact?.deletedAt || created,
		deletedBy: artifact?.deletedBy || actor,
		deleteReason: artifact?.deleteReason || reason,
		bytes: null,
	}));
	const deletionManifest = buildTenantDeletionManifest({
		tenantId: tenant,
		actorId: actor,
		reason,
		artifacts: tombstonedArtifacts,
		jobs,
		logs,
		browserSessions,
		secrets,
		exportReferences,
		preflightManifest,
		createdAt: created,
	});
	const orchestrationManifest = buildOrchestrationManifest({
		tenantId: tenant,
		actorId: actor,
		reason,
		createdAt: created,
		retryOf,
		status: 'completed',
		preflightManifest,
		cleanupManifest,
		deletionManifest,
		findings: [],
	});
	return {
		ok: true,
		blocked: false,
		stage: 'completed',
		tenantId: tenant,
		preflightManifest,
		cleanupManifest,
		deletionManifest,
		orchestrationManifest,
	};
}
