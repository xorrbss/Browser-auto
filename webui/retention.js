// webui/retention.js - tenant-scoped artifact retention/read decisions.
//
// Route helpers here operate on metadata only. File streaming remains in
// server.js after this module says the tenant/run/path is allowed.

import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dbm = require('../lib/db.js');
const ARTIFACT_TOMBSTONE_MANIFEST_KIND = 'aqa.artifact-tombstone-manifest';
const TENANT_DELETION_MANIFEST_KIND = 'aqa.tenant-deletion-manifest';
const TENANT_DELETION_PREFLIGHT_MANIFEST_KIND = 'aqa.tenant-deletion-preflight-manifest';
const ACTIVE_JOB_STATUSES = new Set(['queued', 'claimed', 'running', 'canceling']);
const ACTIVE_BROWSER_STATES = new Set(['open']);

function contextTenantId(context) {
	return String(context?.tenantId || context?.tenant?.id || context?.actor?.tenantId || process.env.WEBUI_TENANT_ID || process.env.AQA_TENANT_ID || 'local').trim() || 'local';
}

function contextActorId(context) {
	return String(context?.actor?.id || context?.actorId || process.env.WEBUI_ACTOR_ID || process.env.AQA_ACTOR_ID || 'local').trim() || 'local';
}

function isExternalContext(context) {
	return context?.mode === 'external' || /^(1|true|yes|on)$/i.test(String(process.env.WEBUI_EXTERNAL_MODE || process.env.AQA_EXTERNAL_MODE || ''));
}

function deny(code, reason) {
	return { ok: false, allowed: false, code, reason };
}

function allow(reason, artifact = null) {
	return { ok: true, allowed: true, code: 200, reason, artifact };
}

function cleanString(value) {
	return String(value || '').trim();
}

function manifestHash(manifest) {
	const copy = { ...manifest };
	delete copy.manifestHash;
	return `sha256:${crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex')}`;
}

function normalizedStatus(value) {
	return cleanString(value).toLowerCase();
}

function bool(value) {
	return value === true || value === 1 || /^(1|true|yes|on)$/i.test(String(value || ''));
}

function metadataLegalHold(record) {
	const meta = record?.meta && typeof record.meta === 'object' ? record.meta : {};
	const retention = normalizedStatus(record?.retention || meta.retention || meta.retentionClass);
	const hold = record?.legalHold ?? record?.legal_hold ?? record?.incidentHold ?? record?.incident_hold
		?? record?.deletionHold ?? record?.deletion_hold ?? meta.legalHold ?? meta.legal_hold
		?? meta.incidentHold ?? meta.incident_hold ?? meta.deletionHold ?? meta.deletion_hold;
	const holdUntil = cleanString(record?.legalHoldUntil || record?.holdUntil || record?.incidentHoldUntil || meta.legalHoldUntil || meta.holdUntil || meta.incidentHoldUntil);
	const reason = cleanString(record?.legalHoldReason || record?.holdReason || record?.incidentHoldReason || meta.legalHoldReason || meta.holdReason || meta.incidentHoldReason);
	const active = bool(hold) || retention === 'legal-hold' || retention === 'incident-hold' || !!holdUntil;
	return {
		active,
		reason: reason || (retention === 'legal-hold' || retention === 'incident-hold' ? retention : active ? 'legal hold' : ''),
		until: holdUntil || null,
	};
}

function deletionFinding(reason, itemClass, id, message) {
	return { reason, class: itemClass, id: id == null ? '' : String(id), message };
}

function ensureTenant(findings, itemClass, entry, expectedTenant) {
	if (!expectedTenant) return;
	if (!entry.tenantId) {
		findings.push(deletionFinding('missing-item-tenant', itemClass, entry.id || entry.ref || entry.path, `${itemClass} metadata requires tenant id`));
	} else if (entry.tenantId !== expectedTenant) {
		findings.push(deletionFinding('tenant-mismatch', itemClass, entry.id || entry.ref || entry.path, `${itemClass} tenant must match deletion tenant`));
	}
}

function artifactDeletionEntry(artifact) {
	const hold = metadataLegalHold(artifact);
	return {
		class: 'artifact',
		id: artifact?.id == null ? null : String(artifact.id),
		tenantId: cleanString(artifact?.tenantId),
		jobId: artifact?.jobId || null,
		runId: artifact?.runId || null,
		path: artifact?.path || '',
		kind: artifact?.kind || null,
		sha256: artifact?.sha256 || '',
		retention: artifact?.retention || 'ephemeral-debug',
		deleteAfter: artifact?.deleteAfter || null,
		deleted: !!artifact?.deletedAt || artifact?.deleted === true,
		legalHold: hold,
		operation: artifact?.deletedAt || artifact?.deleted === true ? 'retain-tombstone' : 'tombstone-artifact',
		readsRawData: false,
	};
}

function jobDeletionEntry(job) {
	const hold = metadataLegalHold(job);
	return {
		class: 'job',
		id: job?.id == null ? null : String(job.id),
		tenantId: cleanString(job?.tenantId),
		kind: job?.kind || 'job',
		status: normalizedStatus(job?.status),
		runId: job?.runId || null,
		retention: job?.retention || 'ephemeral-debug',
		deleteAfter: job?.deleteAfter || null,
		legalHold: hold,
		operation: ACTIVE_JOB_STATUSES.has(normalizedStatus(job?.status)) ? 'cancel-before-delete' : 'tombstone-job-metadata',
		logLineCount: Array.isArray(job?.log) ? job.log.length : 0,
		readsRawData: false,
	};
}

function logDeletionEntry(log, index) {
	const hold = metadataLegalHold(log);
	return {
		class: 'log',
		id: log?.id == null ? `log-${index + 1}` : String(log.id),
		tenantId: cleanString(log?.tenantId),
		jobId: log?.jobId || null,
		source: log?.source || (log?.event ? 'job-audit' : 'job-log'),
		event: log?.event || null,
		status: log?.status || null,
		redaction: log?.redaction || log?.redactionStatus || 'unknown',
		hash: log?.hash || null,
		retention: log?.retention || 'audit-linked-evidence',
		legalHold: hold,
		operation: 'tombstone-log-reference',
		readsRawData: false,
	};
}

function browserDeletionEntry(session) {
	const hold = metadataLegalHold(session);
	const state = normalizedStatus(session?.state || (session?.closed ? 'closed' : session?.finished ? 'finished' : session?.expired ? 'expired' : 'open'));
	const teardownState = normalizedStatus(session?.teardownState || session?.teardown?.state || (state === 'closed' ? 'complete' : 'not-required'));
	return {
		class: 'browser',
		id: session?.sessionId || session?.id || null,
		sessionId: session?.sessionId || session?.id || null,
		tenantId: cleanString(session?.tenantId),
		jobId: session?.jobId || null,
		state,
		teardownState,
		retention: session?.retention || 'ephemeral-debug',
		legalHold: hold,
		operation: state === 'open' ? 'close-browser-session-before-delete' : teardownState === 'complete' ? 'delete-browser-state-reference' : 'complete-browser-teardown-before-delete',
		readsRawData: false,
		pathsExposed: false,
	};
}

function secretDeletionEntry(secret) {
	const hold = metadataLegalHold(secret);
	return {
		class: 'secret',
		id: secret?.ref || `${secret?.kind || 'secret'}:${secret?.name || 'unknown'}`,
		ref: secret?.ref || null,
		tenantId: cleanString(secret?.tenantId),
		kind: secret?.kind || 'secret',
		name: secret?.name || '',
		backend: secret?.backend || '',
		present: secret?.present !== false,
		deleteSupported: secret?.deleteSupported === true,
		encrypted: secret?.encrypted === true,
		externalBroker: secret?.externalBroker === true,
		legalHold: hold,
		operation: 'delete-secret-reference',
		readsSecretBytes: false,
		pathsExposed: false,
	};
}

function exportReferenceDeletionEntry(ref) {
	const hold = metadataLegalHold(ref);
	const status = normalizedStatus(ref?.status || 'active');
	return {
		class: 'export-reference',
		id: ref?.refId || ref?.signedRef || null,
		refId: ref?.refId || null,
		signedRef: ref?.signedRef || null,
		tenantId: cleanString(ref?.tenantId),
		entryId: ref?.entryId == null ? null : String(ref.entryId),
		jobId: ref?.jobId || null,
		runId: ref?.runId || null,
		path: ref?.path || '',
		status,
		expiresAt: ref?.expiresAt || null,
		invalidatedAt: ref?.invalidatedAt || null,
		legalHold: hold,
		operation: status === 'invalidated' || ref?.invalidatedAt ? 'retain-invalidated-export-reference' : 'invalidate-export-reference',
		readsRawData: false,
	};
}

function summarizeDeletionClasses(classes) {
	const byClass = {};
	let total = 0;
	for (const [key, entries] of Object.entries(classes)) {
		const n = Array.isArray(entries) ? entries.length : 0;
		byClass[key] = n;
		total += n;
	}
	return { total, byClass };
}

function validateDeletionPreflight({ tenantId, actorId, classes }) {
	const findings = [];
	if (!tenantId) findings.push(deletionFinding('missing-deletion-tenant', 'tenant', '', 'tenant deletion preflight requires a tenant id'));
	if (!actorId) findings.push(deletionFinding('missing-deletion-actor', 'tenant', '', 'tenant deletion preflight requires an actor id'));

	for (const [itemClass, entries] of Object.entries(classes)) {
		for (const entry of entries) {
			ensureTenant(findings, itemClass, entry, tenantId);
			if (entry.legalHold?.active) {
				findings.push(deletionFinding('legal-hold', itemClass, entry.id || entry.ref || entry.path, 'tenant deletion is blocked by legal or incident hold'));
			}
			if (itemClass === 'jobs' && ACTIVE_JOB_STATUSES.has(entry.status)) {
				findings.push(deletionFinding('active-job', itemClass, entry.id, 'active job must finish or be canceled before tenant deletion'));
			}
			if (itemClass === 'browserSessions') {
				if (ACTIVE_BROWSER_STATES.has(entry.state)) {
					findings.push(deletionFinding('active-browser-session', itemClass, entry.id, 'active browser session must be closed before tenant deletion'));
				} else if (entry.teardownState && !['complete', 'not-required'].includes(entry.teardownState)) {
					findings.push(deletionFinding('browser-teardown-pending', itemClass, entry.id, 'browser session teardown must complete before tenant deletion'));
				}
			}
			if (itemClass === 'secrets' && entry.present && entry.deleteSupported !== true) {
				findings.push(deletionFinding('secret-delete-unsupported', itemClass, entry.id || entry.ref, 'secret backend must support deletion before tenant deletion'));
			}
			if (itemClass === 'exportReferences' && entry.status !== 'invalidated' && !entry.invalidatedAt) {
				findings.push(deletionFinding('active-export-reference', itemClass, entry.id || entry.path, 'signed export references must be invalidated before tenant deletion'));
			}
		}
	}
	return findings;
}

function artifactTombstoneEntry(artifact) {
	return {
		id: artifact?.id == null ? null : String(artifact.id),
		tenantId: artifact?.tenantId || '',
		jobId: artifact?.jobId || null,
		runId: artifact?.runId || null,
		path: artifact?.path || '',
		kind: artifact?.kind || null,
		sha256: artifact?.sha256 || '',
		retention: artifact?.retention || 'ephemeral-debug',
		deletedAt: artifact?.deletedAt || null,
		deletedBy: artifact?.deletedBy || null,
		deleteReason: artifact?.deleteReason || '',
		bytesRemoved: artifact?.bytes == null,
	};
}

export function buildArtifactTombstoneManifest(artifact, {
	tenantId,
	actorId,
	reason,
	deletedAt,
	createdAt = artifact?.deletedAt || deletedAt || new Date().toISOString(),
} = {}) {
	const entry = artifactTombstoneEntry(artifact);
	const manifest = {
		schemaVersion: 1,
		manifestKind: ARTIFACT_TOMBSTONE_MANIFEST_KIND,
		tenantId: cleanString(tenantId || entry.tenantId),
		actorId: cleanString(actorId || entry.deletedBy),
		reason: cleanString(reason || entry.deleteReason || 'deleted'),
		createdAt,
		artifact: entry,
	};
	manifest.manifestHash = manifestHash(manifest);
	return manifest;
}

export function buildTenantDeletionManifest({
	tenantId,
	actorId,
	reason = 'tenant deletion',
	artifacts = [],
	jobs = [],
	logs = [],
	browserSessions = [],
	secrets = [],
	exportReferences = [],
	preflightManifest = null,
	createdAt = new Date().toISOString(),
} = {}) {
	const entries = artifacts.map(artifactTombstoneEntry)
		.sort((a, b) => String(a.id || '').localeCompare(String(b.id || '')) || a.path.localeCompare(b.path));
	const classes = {
		artifacts: entries,
		jobs: jobs.map(jobDeletionEntry),
		logs: logs.map(logDeletionEntry),
		browserSessions: browserSessions.map(browserDeletionEntry),
		secrets: secrets.map(secretDeletionEntry),
		exportReferences: exportReferences.map(exportReferenceDeletionEntry),
	};
	const summary = summarizeDeletionClasses(classes);
	const manifest = {
		schemaVersion: 1,
		manifestKind: TENANT_DELETION_MANIFEST_KIND,
		tenantId: cleanString(tenantId),
		actorId: cleanString(actorId),
		reason: cleanString(reason || 'tenant deletion'),
		createdAt,
		summary: {
			...summary,
			tombstoned: entries.length,
			artifactIds: entries.map((entry) => entry.id).filter(Boolean),
			runIds: [...new Set(entries.map((entry) => entry.runId).filter(Boolean))].sort(),
		},
		preflightManifestHash: preflightManifest?.manifestHash || null,
		artifacts: entries,
		classes,
	};
	manifest.manifestHash = manifestHash(manifest);
	return manifest;
}

export function buildTenantDeletionPreflightManifest({
	tenantId,
	actorId,
	reason = 'tenant deletion preflight',
	artifacts = [],
	jobs = [],
	logs = [],
	browserSessions = [],
	secrets = [],
	exportReferences = [],
	createdAt = new Date().toISOString(),
} = {}) {
	const classes = {
		artifacts: artifacts.map(artifactDeletionEntry),
		jobs: jobs.map(jobDeletionEntry),
		logs: logs.map(logDeletionEntry),
		browserSessions: browserSessions.map(browserDeletionEntry),
		secrets: secrets.map(secretDeletionEntry),
		exportReferences: exportReferences.map(exportReferenceDeletionEntry),
	};
	const tenant = cleanString(tenantId);
	const actor = cleanString(actorId);
	const findings = validateDeletionPreflight({ tenantId: tenant, actorId: actor, classes });
	const classSummary = summarizeDeletionClasses(classes);
	const legalHoldCount = Object.values(classes).flat().filter((entry) => entry.legalHold?.active).length;
	const allowed = findings.length === 0;
	const manifest = {
		schemaVersion: 1,
		manifestKind: TENANT_DELETION_PREFLIGHT_MANIFEST_KIND,
		tenantId: tenant,
		actorId: actor,
		reason: cleanString(reason || 'tenant deletion preflight'),
		createdAt,
		metadataOnly: true,
		readsRawArtifacts: false,
		readsSecretBytes: false,
		classes,
		summary: {
			...classSummary,
			legalHoldCount,
			blockedCount: findings.length,
			plannedOperations: Object.values(classes).flat().map((entry) => ({
				class: entry.class,
				id: entry.id || entry.ref || entry.path || '',
				operation: entry.operation,
			})),
		},
		decision: {
			allowed,
			blocked: !allowed,
			failClosed: true,
			findings,
		},
	};
	manifest.manifestHash = manifestHash(manifest);
	return manifest;
}

export function tenantDeletionPreflightFromDb(db, {
	tenantId,
	actorId,
	reason,
	browserSessions = [],
	secrets = [],
	exportReferences = [],
	createdAt = new Date().toISOString(),
} = {}) {
	const tenant = cleanString(tenantId);
	const artifacts = dbm.listWebuiArtifacts(db, { tenantId: tenant, includeDeleted: false, limit: 1000 });
	const jobs = dbm.listWebuiJobs(db, { tenantId: tenant, limit: 500 });
	const logs = dbm.listWebuiJobAudit(db, { tenantId: tenant, limit: 1000 });
	return buildTenantDeletionPreflightManifest({
		tenantId: tenant,
		actorId,
		reason,
		artifacts,
		jobs,
		logs,
		browserSessions,
		secrets,
		exportReferences,
		createdAt,
	});
}

export function artifactRouteMetadata({ artifactsDir, filePath }) {
	const rel = path.relative(path.resolve(artifactsDir), path.resolve(filePath));
	if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
	const parts = rel.split(path.sep).filter(Boolean);
	if (parts.length < 2) return null;
	const runId = parts[0];
	const artifactPath = `artifacts/${parts.join('/')}`;
	return { runId, artifactPath };
}

export function artifactReadDecision(db, { context = null, runId, artifactPath } = {}) {
	const tenantId = contextTenantId(context);
	const rowsForRun = dbm.listWebuiArtifacts(db, { runId, includeDeleted: true, limit: 1000 });
	const exactRows = rowsForRun.filter((row) => row.path === artifactPath);
	const sameTenantRows = rowsForRun.filter((row) => row.tenantId === tenantId);

	if (!rowsForRun.length) {
		return isExternalContext(context)
			? deny(404, 'artifact metadata missing')
			: allow('local-pilot metadata fallback');
	}

	if (!sameTenantRows.length) return deny(404, 'artifact not found');
	if (!exactRows.length) return deny(404, 'artifact metadata missing for path');

	const artifact = exactRows.find((row) => row.tenantId === tenantId);
	if (!artifact) return deny(404, 'artifact not found');
	if (artifact.deletedAt) return deny(410, 'artifact deleted');
	return allow('tenant metadata matched', artifact);
}

export function authorizeArtifactRead({ context = null, runId, artifactPath } = {}) {
	const db = dbm.openDb();
	try {
		return artifactReadDecision(db, { context, runId, artifactPath });
	} finally {
		dbm.closeDb(db);
	}
}

export function tombstoneArtifact({ tenantId, actorId, id, runId, path: artifactPath, reason, now } = {}) {
	const db = dbm.openDb();
	try {
		const result = dbm.tombstoneWebuiArtifact(db, {
			tenantId,
			actorId,
			id,
			runId,
			path: artifactPath,
			reason,
			now,
		});
		if (result.artifact) {
			result.tombstoneManifest = buildArtifactTombstoneManifest(result.artifact, {
				tenantId,
				actorId,
				reason,
				deletedAt: result.artifact.deletedAt,
				createdAt: result.artifact.deletedAt || now,
			});
		}
		return result;
	} finally {
		dbm.closeDb(db);
	}
}

export function tombstoneTenantArtifacts({ tenantId, actorId, reason, now } = {}) {
	const db = dbm.openDb();
	try {
		const before = dbm.listWebuiArtifacts(db, { tenantId, includeDeleted: false, limit: 1000 });
		const preflightManifest = tenantDeletionPreflightFromDb(db, {
			tenantId,
			actorId: actorId || contextActorId(null),
			reason,
			createdAt: now || new Date().toISOString(),
		});
		if (preflightManifest.decision.blocked) {
			return {
				ok: false,
				blocked: true,
				tenantId: cleanString(tenantId),
				tombstoned: 0,
				deleted: 0,
				reason: 'tenant deletion preflight blocked',
				preflightManifest,
			};
		}
		const beforeIds = new Set(before.map((artifact) => artifact.id));
		const actor = actorId || contextActorId(null);
		const result = dbm.tombstoneTenantWebuiArtifacts(db, {
			tenantId,
			actorId: actor,
			reason,
			now,
		});
		const after = dbm.listWebuiArtifacts(db, { tenantId, includeDeleted: true, limit: 1000 })
			.filter((artifact) => beforeIds.has(artifact.id));
		result.deletionManifest = buildTenantDeletionManifest({
			tenantId: result.tenantId || tenantId,
			actorId: actor,
			reason,
			artifacts: after,
			jobs: preflightManifest.classes.jobs,
			logs: preflightManifest.classes.logs,
			preflightManifest,
			createdAt: now || new Date().toISOString(),
		});
		result.preflightManifest = preflightManifest;
		return result;
	} finally {
		dbm.closeDb(db);
	}
}
