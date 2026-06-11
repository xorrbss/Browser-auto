// webui/tenant-deletion-api.js - route-independent tenant deletion JSON helper.
//
// This module is intentionally metadata-only. It coordinates dry-run,
// approval, execution, retry, status, and tombstone readback without reading
// artifact bytes, browser state, secret material, or log bodies.

import crypto from 'node:crypto';
import { buildTenantDeletionPreflightManifest } from './retention.js';
import { orchestrateTenantDeletion } from './tenant-deletion.js';

const DRY_RUN_MANIFEST_KIND = 'aqa.tenant-deletion-dry-run-manifest';
const APPROVAL_MANIFEST_KIND = 'aqa.tenant-deletion-approval-manifest';
const HASH_RE = /^sha256:[0-9a-f]{64}$/i;
const ID_RE = /^[A-Za-z0-9_.:-]{1,180}$/;
const SAFE_APPROVAL_STATES = new Set(['approved', 'allow', 'allowed']);

function cleanString(value) {
	return String(value || '').trim();
}

function asArray(value) {
	return Array.isArray(value) ? value : [];
}

function cloneJson(value) {
	return value == null ? value : JSON.parse(JSON.stringify(value));
}

function manifestHash(manifest) {
	const copy = { ...manifest };
	delete copy.manifestHash;
	return `sha256:${crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex')}`;
}

function hashObject(value) {
	return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function finding(reason, itemClass, id, message) {
	return { reason, class: itemClass, id: id == null ? '' : String(id), message };
}

function safeId(value) {
	const id = cleanString(value);
	return id && ID_RE.test(id) ? id : '';
}

function copyString(out, key, value) {
	const text = cleanString(value);
	if (text) out[key] = text;
}

function copyValue(out, key, value) {
	if (value !== undefined && value !== null && value !== '') out[key] = value;
}

function safeMeta(input) {
	const source = input?.meta && typeof input.meta === 'object' && !Array.isArray(input.meta) ? input.meta : {};
	const allowed = {};
	for (const key of [
		'retention',
		'retentionClass',
		'legalHold',
		'legal_hold',
		'incidentHold',
		'incident_hold',
		'deletionHold',
		'deletion_hold',
		'legalHoldUntil',
		'holdUntil',
		'incidentHoldUntil',
		'legalHoldReason',
		'holdReason',
		'incidentHoldReason',
	]) {
		copyValue(allowed, key, source[key]);
	}
	return Object.keys(allowed).length ? allowed : null;
}

function copyHoldFields(out, input) {
	for (const key of [
		'legalHold',
		'legal_hold',
		'incidentHold',
		'incident_hold',
		'deletionHold',
		'deletion_hold',
		'legalHoldUntil',
		'holdUntil',
		'incidentHoldUntil',
		'legalHoldReason',
		'holdReason',
		'incidentHoldReason',
	]) {
		copyValue(out, key, input?.[key]);
	}
	const meta = safeMeta(input);
	if (meta) out.meta = meta;
}

function sanitizeArtifact(artifact = {}) {
	const out = {};
	copyString(out, 'id', artifact.id);
	copyString(out, 'tenantId', artifact.tenantId);
	copyString(out, 'jobId', artifact.jobId);
	copyString(out, 'runId', artifact.runId);
	copyString(out, 'path', artifact.path);
	copyString(out, 'kind', artifact.kind);
	copyString(out, 'sha256', artifact.sha256);
	copyString(out, 'retention', artifact.retention);
	copyString(out, 'deleteAfter', artifact.deleteAfter);
	copyString(out, 'deletedAt', artifact.deletedAt);
	copyString(out, 'deletedBy', artifact.deletedBy);
	copyString(out, 'deleteReason', artifact.deleteReason);
	if (artifact.deleted === true) out.deleted = true;
	copyHoldFields(out, artifact);
	return out;
}

function sanitizeJob(job = {}) {
	const out = {};
	copyString(out, 'id', job.id);
	copyString(out, 'tenantId', job.tenantId);
	copyString(out, 'kind', job.kind);
	copyString(out, 'status', job.status);
	copyString(out, 'runId', job.runId);
	copyString(out, 'retention', job.retention);
	copyString(out, 'deleteAfter', job.deleteAfter);
	copyHoldFields(out, job);
	return out;
}

function sanitizeLog(log = {}, index = 0) {
	const out = {};
	copyString(out, 'id', log.id ?? `log-${index + 1}`);
	copyString(out, 'tenantId', log.tenantId);
	copyString(out, 'jobId', log.jobId);
	copyString(out, 'source', log.source);
	copyString(out, 'event', log.event);
	copyString(out, 'status', log.status);
	copyString(out, 'redaction', log.redaction);
	copyString(out, 'redactionStatus', log.redactionStatus);
	copyString(out, 'hash', log.hash);
	copyString(out, 'retention', log.retention);
	copyHoldFields(out, log);
	return out;
}

function sanitizeBrowserSession(session = {}) {
	const out = {};
	copyString(out, 'id', session.id || session.sessionId);
	copyString(out, 'sessionId', session.sessionId || session.id);
	copyString(out, 'tenantId', session.tenantId);
	copyString(out, 'jobId', session.jobId);
	copyString(out, 'state', session.state);
	copyString(out, 'teardownState', session.teardownState || session.teardown?.state);
	copyString(out, 'retention', session.retention);
	if (session.closed === true) out.closed = true;
	if (session.finished === true) out.finished = true;
	if (session.expired === true) out.expired = true;
	copyHoldFields(out, session);
	return out;
}

function sanitizeSecret(secret = {}) {
	const out = {};
	copyString(out, 'id', secret.id);
	copyString(out, 'ref', secret.ref);
	copyString(out, 'tenantId', secret.tenantId);
	copyString(out, 'kind', secret.kind);
	copyString(out, 'name', secret.name);
	copyString(out, 'backend', secret.backend);
	for (const key of ['present', 'deleteSupported', 'encrypted', 'externalBroker']) {
		if (typeof secret[key] === 'boolean') out[key] = secret[key];
	}
	copyHoldFields(out, secret);
	return out;
}

function sanitizeExportReference(ref = {}) {
	const out = {};
	copyString(out, 'id', ref.id || ref.refId || ref.signedRef);
	copyString(out, 'refId', ref.refId);
	copyString(out, 'signedRef', ref.signedRef);
	copyString(out, 'tenantId', ref.tenantId);
	copyString(out, 'entryId', ref.entryId);
	copyString(out, 'jobId', ref.jobId);
	copyString(out, 'runId', ref.runId);
	copyString(out, 'path', ref.path);
	copyString(out, 'status', ref.status);
	copyString(out, 'expiresAt', ref.expiresAt);
	copyString(out, 'invalidatedAt', ref.invalidatedAt);
	copyHoldFields(out, ref);
	return out;
}

function sanitizeScope(input = {}) {
	return {
		artifacts: asArray(input.artifacts).map(sanitizeArtifact),
		jobs: asArray(input.jobs).map(sanitizeJob),
		logs: asArray(input.logs).map(sanitizeLog),
		browserSessions: asArray(input.browserSessions).map(sanitizeBrowserSession),
		secrets: asArray(input.secrets).map(sanitizeSecret),
		exportReferences: asArray(input.exportReferences).map(sanitizeExportReference),
	};
}

function scopeSummary(scope) {
	const byClass = {
		artifacts: scope.artifacts.length,
		jobs: scope.jobs.length,
		logs: scope.logs.length,
		browserSessions: scope.browserSessions.length,
		secrets: scope.secrets.length,
		exportReferences: scope.exportReferences.length,
	};
	return {
		total: Object.values(byClass).reduce((sum, count) => sum + count, 0),
		byClass,
		artifactIds: scope.artifacts.map((entry) => entry.id).filter(Boolean).sort(),
		runIds: [...new Set(scope.artifacts.map((entry) => entry.runId).filter(Boolean))].sort(),
	};
}

function timestamp(value, fallback) {
	const raw = cleanString(value);
	if (raw) return raw;
	if (typeof fallback === 'function') return timestamp(fallback(), new Date().toISOString());
	if (fallback != null) return cleanString(fallback);
	return new Date().toISOString();
}

function requestTimestamp(input, opts = {}) {
	return timestamp(input?.createdAt || input?.now || input?.at, opts.now);
}

function nextId(prefix, store, seed) {
	const explicit = safeId(seed);
	if (explicit) return explicit;
	const n = store.nextSequence ? store.nextSequence() : 1;
	return `${prefix}:${hashObject({ prefix, n }).slice('sha256:'.length, 'sha256:'.length + 20)}`;
}

function preflightFor(record, createdAt = record.createdAt) {
	return buildTenantDeletionPreflightManifest({
		tenantId: record.tenantId,
		actorId: record.actorId,
		reason: record.reason,
		...record.scope,
		createdAt,
	});
}

function buildDryRunManifest(record, preflightManifest) {
	const manifest = {
		schemaVersion: 1,
		manifestKind: DRY_RUN_MANIFEST_KIND,
		requestId: record.requestId,
		tenantId: record.tenantId,
		actorId: record.actorId,
		reason: record.reason,
		createdAt: record.createdAt,
		metadataOnly: true,
		readsRawArtifacts: false,
		readsSecretBytes: false,
		scopeHash: record.scopeHash,
		scopeSummary: scopeSummary(record.scope),
		preflightManifestHash: preflightManifest.manifestHash,
		decision: {
			allowed: preflightManifest.decision.allowed,
			blocked: preflightManifest.decision.blocked,
			failClosed: true,
			findings: preflightManifest.decision.findings,
		},
	};
	manifest.manifestHash = manifestHash(manifest);
	return manifest;
}

function buildApprovalManifest(record, input = {}, opts = {}) {
	const approvedAt = timestamp(input.approvedAt || input.createdAt || input.now, opts.now);
	const approvedBy = cleanString(input.approvedBy || input.actorId || input.actor?.id);
	const requestedStatus = cleanString(input.status || input.decision || 'approved').toLowerCase();
	const findings = [];
	if (!approvedBy) findings.push(finding('missing-approval-actor', 'approval', record.requestId, 'tenant deletion approval requires an approver'));
	if (!approvedAt) findings.push(finding('missing-approval-time', 'approval', record.requestId, 'tenant deletion approval requires a timestamp'));
	if (!SAFE_APPROVAL_STATES.has(requestedStatus)) findings.push(finding('missing-approval-decision', 'approval', record.requestId, 'tenant deletion approval decision must be approved'));
	if (record.dryRunManifest?.decision?.blocked) findings.push(finding('dry-run-blocked', 'approval', record.requestId, 'blocked tenant deletion dry-run cannot be approved'));
	const status = findings.length ? 'blocked' : 'approved';
	const manifest = {
		schemaVersion: 1,
		manifestKind: APPROVAL_MANIFEST_KIND,
		requestId: record.requestId,
		tenantId: record.tenantId,
		actorId: approvedBy,
		approvedBy,
		approvedAt,
		approvalId: '',
		status,
		reason: cleanString(input.reason || record.reason),
		createdAt: approvedAt,
		metadataOnly: true,
		readsRawArtifacts: false,
		readsSecretBytes: false,
		scopeHash: record.scopeHash,
		dryRunManifestHash: record.dryRunManifest?.manifestHash || '',
		preflightManifestHash: record.preflightManifest?.manifestHash || '',
		decision: {
			allowed: findings.length === 0,
			blocked: findings.length > 0,
			failClosed: true,
			findings,
		},
	};
	manifest.approvalId = safeId(input.approvalId) || `tdap:${hashObject({ ...manifest, approvalId: '' }).slice('sha256:'.length, 'sha256:'.length + 20)}`;
	manifest.manifestHash = manifestHash(manifest);
	return manifest;
}

function verifyApproval(record, input = {}) {
	const findings = [];
	if (!record.approvalManifest) {
		findings.push(finding('missing-approval-manifest', 'approval', record.requestId, 'tenant deletion execute requires an approval manifest'));
		return findings;
	}
	const expectedHash = manifestHash(record.approvalManifest);
	if (record.approvalManifest.manifestHash !== expectedHash) {
		findings.push(finding('stored-approval-manifest-hash-mismatch', 'approval', record.requestId, 'stored approval manifest hash must match its contents'));
	}
	if (record.approvalManifest.status !== 'approved' || record.approvalManifest.decision?.allowed !== true) {
		findings.push(finding('approval-not-allowed', 'approval', record.requestId, 'approval manifest must be allowed before execute'));
	}
	const supplied = cleanString(input.approvalManifestHash || input.approvalHash || input.approval?.manifestHash);
	if (!HASH_RE.test(supplied)) {
		findings.push(finding('missing-approval-manifest-hash', 'approval', record.requestId, 'execute requires the approval manifest hash'));
	} else if (supplied !== record.approvalManifest.manifestHash) {
		findings.push(finding('approval-manifest-hash-mismatch', 'approval', record.requestId, 'approval manifest hash must match the approved dry-run'));
	}
	if (record.approvalManifest.dryRunManifestHash !== record.dryRunManifest?.manifestHash) {
		findings.push(finding('approval-dry-run-hash-mismatch', 'approval', record.requestId, 'approval manifest must bind to the current dry-run hash'));
	}
	return findings;
}

function adapterFindings(adapter, opts = {}) {
	const findings = [];
	if (!adapter) return findings;
	if (typeof adapter.cleanupArtifact !== 'function') {
		findings.push(finding('artifact-cleanup-adapter-invalid', 'artifact', '', 'artifact cleanup adapter must expose cleanupArtifact'));
	}
	if (adapter.metadataOnly !== true || adapter.readsRawArtifacts === true || adapter.readsRawData === true) {
		findings.push(finding('artifact-cleanup-adapter-not-metadata-only', 'artifact', '', 'artifact cleanup adapter must be metadata-only'));
	}
	if (opts.allowNonFakeAdapters !== true && adapter.kind !== 'fake-artifact-cleanup-adapter') {
		findings.push(finding('artifact-cleanup-adapter-not-fake', 'artifact', '', 'tenant deletion API helper only accepts the fake metadata-only adapter by default'));
	}
	return findings;
}

function publicAttempt(attempt) {
	if (!attempt) return null;
	return {
		attemptId: attempt.attemptId,
		requestId: attempt.requestId,
		tenantId: attempt.tenantId,
		status: attempt.status,
		stage: attempt.stage,
		ok: attempt.ok,
		blocked: attempt.blocked,
		partialFailure: !!attempt.partialFailure,
		retryOf: attempt.retryOf || null,
		createdAt: attempt.createdAt,
		metadataOnly: true,
		readsRawArtifacts: false,
		readsSecretBytes: false,
		preflightManifestHash: attempt.preflightManifestHash || null,
		cleanupManifestHash: attempt.cleanupManifestHash || null,
		deletionManifestHash: attempt.deletionManifestHash || null,
		orchestrationManifestHash: attempt.orchestrationManifestHash || null,
		tombstoneManifestHash: attempt.tombstoneManifestHash || null,
		summary: attempt.summary || {},
		findings: attempt.findings || [],
	};
}

function publicStatus(record) {
	const latestAttempt = record.attempts[record.attempts.length - 1] || null;
	return {
		ok: true,
		code: 200,
		requestId: record.requestId,
		tenantId: record.tenantId,
		actorId: record.actorId,
		status: record.status,
		reason: record.reason,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		metadataOnly: true,
		readsRawArtifacts: false,
		readsSecretBytes: false,
		scopeHash: record.scopeHash,
		scopeSummary: scopeSummary(record.scope),
		dryRun: {
			manifestHash: record.dryRunManifest?.manifestHash || null,
			preflightManifestHash: record.preflightManifest?.manifestHash || null,
			allowed: record.dryRunManifest?.decision?.allowed === true,
			blocked: record.dryRunManifest?.decision?.blocked === true,
			findings: record.dryRunManifest?.decision?.findings || [],
		},
		approval: record.approvalManifest ? {
			approvalId: record.approvalManifest.approvalId,
			manifestHash: record.approvalManifest.manifestHash,
			status: record.approvalManifest.status,
			approvedBy: record.approvalManifest.approvedBy,
			approvedAt: record.approvalManifest.approvedAt,
		} : null,
		attempts: record.attempts.map(publicAttempt),
		latestAttempt: publicAttempt(latestAttempt),
		tombstone: {
			available: !!record.tombstoneManifest,
			manifestHash: record.tombstoneManifest?.manifestHash || null,
		},
	};
}

function denied(code, reason, itemClass, id, message, extra = {}) {
	return {
		ok: false,
		code,
		allowed: false,
		blocked: true,
		error: reason,
		reason,
		metadataOnly: true,
		readsRawArtifacts: false,
		readsSecretBytes: false,
		findings: [finding(reason, itemClass, id, message)],
		...extra,
	};
}

function loadRecord(store, input = {}) {
	const requestId = cleanString(input.requestId || input.id);
	if (!requestId) return { error: denied(400, 'missing-request-id', 'tenant', '', 'requestId is required') };
	const record = store.get(requestId);
	if (!record) return { error: denied(404, 'tenant-deletion-request-not-found', 'tenant', requestId, 'tenant deletion request was not found') };
	const tenant = cleanString(input.tenantId || input.tenant?.id);
	if (tenant && tenant !== record.tenantId) {
		return { error: denied(404, 'tenant-mismatch', 'tenant', requestId, 'tenant deletion request was not found for this tenant') };
	}
	return { record };
}

function attemptFromResult(record, result, { attemptId, retryOf, createdAt }) {
	const status = result.ok
		? 'completed'
		: result.partialFailure
			? 'partial-failure'
			: result.blocked
				? 'blocked'
				: 'failed';
	return {
		attemptId,
		requestId: record.requestId,
		tenantId: record.tenantId,
		status,
		stage: result.stage || status,
		ok: result.ok === true,
		blocked: result.blocked === true,
		partialFailure: result.partialFailure === true,
		retryOf: retryOf || null,
		createdAt,
		metadataOnly: true,
		readsRawArtifacts: false,
		readsSecretBytes: false,
		preflightManifestHash: result.preflightManifest?.manifestHash || null,
		cleanupManifestHash: result.cleanupManifest?.manifestHash || null,
		deletionManifestHash: result.deletionManifest?.manifestHash || null,
		orchestrationManifestHash: result.orchestrationManifest?.manifestHash || null,
		tombstoneManifestHash: result.deletionManifest?.manifestHash || null,
		summary: {
			cleanup: result.cleanupManifest?.summary || null,
			deletion: result.deletionManifest?.summary || null,
		},
		findings: result.findings || result.orchestrationManifest?.decision?.findings || [],
	};
}

function blockedAttempt(record, findings, { attemptId, retryOf, createdAt, stage = 'execute-preflight' }) {
	return {
		attemptId,
		requestId: record.requestId,
		tenantId: record.tenantId,
		status: 'blocked',
		stage,
		ok: false,
		blocked: true,
		partialFailure: false,
		retryOf: retryOf || null,
		createdAt,
		metadataOnly: true,
		readsRawArtifacts: false,
		readsSecretBytes: false,
		findings,
		summary: {},
	};
}

function publicExecution(record, attempt, result = null, code = null) {
	return {
		ok: attempt.ok,
		code: code || (attempt.ok ? 200 : 409),
		allowed: attempt.ok,
		blocked: !attempt.ok,
		requestId: record.requestId,
		tenantId: record.tenantId,
		status: record.status,
		attempt: publicAttempt(attempt),
		metadataOnly: true,
		readsRawArtifacts: false,
		readsSecretBytes: false,
		preflightManifest: result?.preflightManifest || null,
		cleanupManifest: result?.cleanupManifest || null,
		deletionManifest: result?.deletionManifest || null,
		orchestrationManifest: result?.orchestrationManifest || null,
		tombstoneManifest: result?.deletionManifest || null,
		findings: attempt.findings || [],
	};
}

export function createMemoryTenantDeletionStore(initialRecords = []) {
	const records = new Map();
	let sequence = 0;
	for (const record of initialRecords) {
		if (record?.requestId) records.set(record.requestId, cloneJson(record));
	}
	return {
		nextSequence() {
			sequence += 1;
			return sequence;
		},
		get(requestId) {
			const record = records.get(cleanString(requestId));
			return record ? cloneJson(record) : null;
		},
		put(record) {
			records.set(record.requestId, cloneJson(record));
			return cloneJson(record);
		},
		list({ tenantId } = {}) {
			const tenant = cleanString(tenantId);
			return [...records.values()]
				.filter((record) => !tenant || record.tenantId === tenant)
				.map(cloneJson);
		},
	};
}

export function buildTenantDeletionApprovalManifest(record, input = {}, opts = {}) {
	return buildApprovalManifest(record, input, opts);
}

export function createTenantDeletionApi(defaultOptions = {}) {
	const store = defaultOptions.store || createMemoryTenantDeletionStore();

	async function dryRun(input = {}, opts = {}) {
		const createdAt = requestTimestamp(input, { ...defaultOptions, ...opts });
		const tenantId = cleanString(input.tenantId || input.tenant?.id);
		const actorId = cleanString(input.actorId || input.actor?.id);
		const reason = cleanString(input.reason || 'tenant deletion dry-run');
		const scope = sanitizeScope(input);
		const requestId = nextId('tdel', store, input.requestId || input.id);
		const record = {
			requestId,
			tenantId,
			actorId,
			reason,
			createdAt,
			updatedAt: createdAt,
			scope,
			scopeHash: hashObject(scope),
			status: 'dry-run',
			attempts: [],
			approvalManifest: null,
			tombstoneManifest: null,
		};
		record.preflightManifest = preflightFor(record, createdAt);
		record.dryRunManifest = buildDryRunManifest(record, record.preflightManifest);
		record.status = record.dryRunManifest.decision.blocked ? 'blocked' : 'dry-run-ready';
		store.put(record);
		return {
			ok: record.dryRunManifest.decision.allowed,
			code: record.dryRunManifest.decision.allowed ? 200 : 409,
			allowed: record.dryRunManifest.decision.allowed,
			blocked: record.dryRunManifest.decision.blocked,
			requestId,
			tenantId,
			status: record.status,
			metadataOnly: true,
			readsRawArtifacts: false,
			readsSecretBytes: false,
			dryRunManifest: record.dryRunManifest,
			preflightManifest: record.preflightManifest,
			findings: record.dryRunManifest.decision.findings,
		};
	}

	async function approve(input = {}, opts = {}) {
		const loaded = loadRecord(store, input);
		if (loaded.error) return loaded.error;
		const record = loaded.record;
		const approvalManifest = buildApprovalManifest(record, input, { ...defaultOptions, ...opts });
		record.approvalManifest = approvalManifest;
		record.updatedAt = approvalManifest.createdAt;
		record.status = approvalManifest.decision.allowed ? 'approved' : 'approval-blocked';
		store.put(record);
		return {
			ok: approvalManifest.decision.allowed,
			code: approvalManifest.decision.allowed ? 200 : 409,
			allowed: approvalManifest.decision.allowed,
			blocked: approvalManifest.decision.blocked,
			requestId: record.requestId,
			tenantId: record.tenantId,
			status: record.status,
			metadataOnly: true,
			readsRawArtifacts: false,
			readsSecretBytes: false,
			approvalManifest,
			approvalManifestHash: approvalManifest.manifestHash,
			findings: approvalManifest.decision.findings,
		};
	}

	async function execute(input = {}, opts = {}) {
		const loaded = loadRecord(store, input);
		if (loaded.error) return loaded.error;
		const record = loaded.record;
		if (record.status === 'completed') {
			return denied(409, 'tenant-deletion-already-completed', 'tenant', record.requestId, 'completed tenant deletion requests cannot be executed again');
		}
		const createdAt = requestTimestamp(input, { ...defaultOptions, ...opts });
		const attemptId = nextId('tdat', store, input.attemptId);
		const retryOf = cleanString(input.retryOf);
		const findings = [
			...verifyApproval(record, input),
			...adapterFindings(opts.artifactCleanupAdapter || defaultOptions.artifactCleanupAdapter, {
				allowNonFakeAdapters: opts.allowNonFakeAdapters ?? defaultOptions.allowNonFakeAdapters,
			}),
		];
		if (findings.length) {
			const attempt = blockedAttempt(record, findings, { attemptId, retryOf, createdAt });
			record.attempts.push(attempt);
			record.status = 'blocked';
			record.updatedAt = createdAt;
			store.put(record);
			return publicExecution(record, attempt, null, 409);
		}
		const result = await orchestrateTenantDeletion({
			tenantId: record.tenantId,
			actorId: cleanString(input.actorId || input.executedBy || record.approvalManifest?.approvedBy || record.actorId),
			reason: record.reason,
			...record.scope,
			artifactCleanupAdapter: opts.artifactCleanupAdapter || defaultOptions.artifactCleanupAdapter,
			createdAt,
			retryOf,
		});
		const attempt = attemptFromResult(record, result, { attemptId, retryOf, createdAt });
		record.attempts.push(attempt);
		record.status = attempt.ok ? 'completed' : attempt.status;
		record.updatedAt = createdAt;
		if (result.deletionManifest) record.tombstoneManifest = result.deletionManifest;
		store.put(record);
		return publicExecution(record, attempt, result);
	}

	async function retry(input = {}, opts = {}) {
		const loaded = loadRecord(store, input);
		if (loaded.error) return loaded.error;
		const record = loaded.record;
		const retryOf = cleanString(input.retryOf || input.attemptId || record.attempts[record.attempts.length - 1]?.attemptId);
		const source = retryOf ? record.attempts.find((attempt) => attempt.attemptId === retryOf) : null;
		if (!source || !['partial-failure', 'failed', 'blocked'].includes(source.status)) {
			return denied(409, 'retry-source-not-failed', 'tenant', record.requestId, 'retry requires a previous failed or partial tenant deletion attempt');
		}
		return execute({ ...input, retryOf }, opts);
	}

	async function status(input = {}) {
		const loaded = loadRecord(store, input);
		if (loaded.error) return loaded.error;
		return publicStatus(loaded.record);
	}

	async function readTombstone(input = {}) {
		const loaded = loadRecord(store, input);
		if (loaded.error) return loaded.error;
		const record = loaded.record;
		if (!record.tombstoneManifest) {
			return denied(409, 'tenant-deletion-tombstone-not-ready', 'tenant', record.requestId, 'tenant deletion tombstone is available only after completed execute');
		}
		const expected = cleanString(input.manifestHash || input.tombstoneManifestHash);
		if (expected && expected !== record.tombstoneManifest.manifestHash) {
			return denied(404, 'tombstone-manifest-hash-mismatch', 'tenant', record.requestId, 'tenant deletion tombstone was not found for this manifest hash');
		}
		return {
			ok: true,
			code: 200,
			requestId: record.requestId,
			tenantId: record.tenantId,
			status: record.status,
			metadataOnly: true,
			readsRawArtifacts: false,
			readsSecretBytes: false,
			tombstoneManifest: record.tombstoneManifest,
		};
	}

	async function handle(input = {}, opts = {}) {
		const action = cleanString(input.action || input.op || input.kind).toLowerCase().replace(/_/g, '-');
		switch (action) {
			case 'dry-run':
			case 'dryrun':
				return dryRun(input, opts);
			case 'approve':
				return approve(input, opts);
			case 'execute':
				return execute(input, opts);
			case 'retry':
				return retry(input, opts);
			case 'status':
				return status(input);
			case 'read-tombstone':
			case 'read-tombstone-manifest':
			case 'tombstone':
				return readTombstone(input);
			default:
				return denied(400, 'unknown-tenant-deletion-action', 'tenant', action, 'action must be dry-run, approve, execute, retry, status, or read-tombstone');
		}
	}

	return Object.freeze({
		store,
		dryRun,
		approve,
		execute,
		retry,
		status,
		readTombstone,
		handle,
	});
}

export async function handleTenantDeletionJson(input = {}, options = {}) {
	const api = options.api || createTenantDeletionApi(options);
	return api.handle(input, options);
}

