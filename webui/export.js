// webui/export.js - metadata-only export manifest scaffolding.
//
// This module does not read artifact bytes. It turns tenant-scoped artifact
// metadata into a policy-gated manifest and delegates the fail-closed decision
// to the shared secret/export scanner.

import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { scanExportBundle } from './secrets.js';

const require = createRequire(import.meta.url);
const dbm = require('../lib/db.js');
const TENANT_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SAFE_POLICY_APPROVAL_STATES = new Set(['approved', 'allow', 'allowed']);
const WINDOWS_ABS_RE = /^[A-Za-z]:[\\/]/;
const EXPORT_MANIFEST_KIND = 'aqa.sanitized-export-manifest';
const POLICY_APPROVAL_MANIFEST_KIND = 'aqa.policy-approval-manifest';
const SIGNED_EXPORT_REFERENCE_KIND = 'aqa.signed-export-reference';
const DEFAULT_EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function cleanString(value) {
	return String(value || '').trim();
}

function cleanOptionalTenant(value) {
	const s = cleanString(value);
	return s && TENANT_RE.test(s) ? s : '';
}

function normalizedStatus(value) {
	return cleanString(value).toLowerCase();
}

function exportEntries(bundle = {}) {
	return Array.isArray(bundle) ? bundle : Array.isArray(bundle?.files) ? bundle.files : Array.isArray(bundle?.entries) ? bundle.entries : [];
}

function exportEntryLabel(entry, index) {
	const raw = String(entry?.path || entry?.file || entry?.name || `entry-${index + 1}`);
	return raw.replace(/\\/g, '/').split('/').filter(Boolean).slice(-3).join('/') || `entry-${index + 1}`;
}

function finding(reason, entry, message) {
	return { reason, entry, message };
}

function uniqueStrings(values) {
	return [...new Set((values || []).map(cleanString).filter(Boolean))].sort();
}

function exportSafePath(value) {
	const raw = cleanString(value);
	if (!raw) return { ok: false, reason: 'missing-path' };
	if (raw.includes('\0')) return { ok: false, reason: 'nul-byte' };
	if (WINDOWS_ABS_RE.test(raw)) return { ok: false, reason: 'absolute-path' };
	let decoded = raw;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		return { ok: false, reason: 'bad-path-encoding' };
	}
	const p = decoded.replace(/\\/g, '/');
	if (p.startsWith('/') || WINDOWS_ABS_RE.test(p)) return { ok: false, reason: 'absolute-path' };
	if (p.split('/').some((part) => part === '..')) return { ok: false, reason: 'path-traversal' };
	const normalized = path.posix.normalize(p);
	if (normalized === '.' || normalized.startsWith('../') || normalized === '..') return { ok: false, reason: 'path-traversal' };
	return { ok: true, path: normalized };
}

function policyApprovalMetadata(entry) {
	const policy = entry?.policyApproval || entry?.policy || entry?.metadata?.policyApproval || {};
	if (typeof policy === 'string') {
		return {
			status: normalizedStatus(policy),
			approvedBy: cleanString(entry?.policyApprovedBy || entry?.approvedBy || entry?.metadata?.policyApprovedBy),
			approvedAt: cleanString(entry?.policyApprovedAt || entry?.approvedAt || entry?.metadata?.policyApprovedAt),
			approvalId: cleanString(entry?.policyApprovalId || entry?.approvalId || entry?.metadata?.policyApprovalId),
			manifestHash: cleanString(entry?.policyApprovalManifestHash || entry?.policyManifestHash || entry?.metadata?.policyApprovalManifestHash),
			reason: cleanString(entry?.policyReason || entry?.reason || entry?.metadata?.policyReason),
		};
	}
	return {
		status: normalizedStatus(policy.status || policy.decision || (policy.approved === true ? 'approved' : '') || entry?.policyApprovalStatus || entry?.metadata?.policyApprovalStatus),
		approvedBy: cleanString(policy.approvedBy || policy.actorId || entry?.policyApprovedBy || entry?.approvedBy || entry?.metadata?.policyApprovedBy),
		approvedAt: cleanString(policy.approvedAt || entry?.policyApprovedAt || entry?.approvedAt || entry?.metadata?.policyApprovedAt),
		approvalId: cleanString(policy.approvalId || policy.id || entry?.policyApprovalId || entry?.approvalId || entry?.metadata?.policyApprovalId),
		manifestHash: cleanString(policy.manifestHash || policy.policyManifestHash || entry?.policyApprovalManifestHash || entry?.policyManifestHash || entry?.metadata?.policyApprovalManifestHash),
		reason: cleanString(policy.reason || entry?.policyReason || entry?.reason || entry?.metadata?.policyReason),
	};
}

function manifestHash(manifest) {
	const copy = { ...manifest };
	delete copy.manifestHash;
	return `sha256:${crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex')}`;
}

function exportScopeHash(manifest) {
	const copy = { ...manifest };
	delete copy.manifestHash;
	delete copy.decision;
	delete copy.signedReferences;
	return `sha256:${crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex')}`;
}

function toTimeMs(value) {
	if (value == null || value === '') return null;
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	const n = Number(value);
	if (Number.isFinite(n) && /^\d+$/.test(String(value).trim())) return n;
	const t = Date.parse(String(value));
	return Number.isFinite(t) ? t : NaN;
}

function isoFromMs(ms) {
	return new Date(ms).toISOString();
}

function exportExpiryMetadata(bundle = {}, opts = {}) {
	const raw = bundle?.expiresAt || bundle?.expiration?.expiresAt || opts.expiresAt;
	const now = toTimeMs(opts.now) ?? Date.now();
	const expiresMs = toTimeMs(raw);
	const meta = {
		present: raw != null && raw !== '',
		expiresAt: cleanString(raw),
		expiresAtMs: expiresMs,
		nowMs: now,
		findings: [],
	};
	if (!meta.present) {
		meta.findings.push(finding('missing-export-expiry', '', 'export manifest requires an expiration time'));
	} else if (!Number.isFinite(expiresMs)) {
		meta.findings.push(finding('invalid-export-expiry', '', 'export expiration must be a valid timestamp'));
	} else if (expiresMs <= now) {
		meta.findings.push(finding('expired-export', '', 'export manifest is expired'));
	}
	meta.ok = meta.findings.length === 0;
	return meta;
}

function exportReferenceKeyForEntry(entry) {
	const id = entry?.id == null ? '' : String(entry.id);
	const pathValue = entry?.path || entry?.file || entry?.name || '';
	return `${id}\0${String(pathValue)}`;
}

function exportReferenceKey(ref) {
	const id = ref?.entryId == null ? '' : String(ref.entryId);
	return `${id}\0${String(ref?.path || '')}`;
}

function signedReferenceEntryMetadata(entry = {}) {
	return {
		sha256: cleanString(entry.sha256),
		jobId: cleanString(entry.jobId),
		runId: cleanString(entry.runId),
	};
}

function cacheMetadata(entry = {}) {
	const metadata = entry?.metadata && typeof entry.metadata === 'object' ? entry.metadata : {};
	const cache = entry?.cache && typeof entry.cache === 'object'
		? entry.cache
		: entry?.artifactCache && typeof entry.artifactCache === 'object'
			? entry.artifactCache
			: metadata.cache && typeof metadata.cache === 'object'
				? metadata.cache
				: {};
	const pathValue = cleanString(entry?.path || entry?.file || entry?.name).replace(/\\/g, '/').toLowerCase();
	const scope = normalizedStatus(entry.cacheScope || entry.cache_scope || cache.scope || metadata.cacheScope || metadata.cache_scope);
	const tenantId = cleanOptionalTenant(entry.cacheTenantId || entry.cacheTenant || cache.tenantId || cache.tenant || metadata.cacheTenantId || metadata.cacheTenant);
	const key = cleanString(entry.cacheKey || entry.cache_key || cache.key || cache.id || metadata.cacheKey || metadata.cache_key);
	const shared = entry.sharedCache === true
		|| entry.shared_cache === true
		|| cache.shared === true
		|| cache.global === true
		|| ['shared', 'global', 'cross-tenant', 'cross_tenant', 'public'].includes(scope)
		|| /(?:^|\/)(?:shared-cache|cache\/shared|shared\/cache)(?:\/|$)/.test(pathValue);
	return { scope, tenantId, key, shared };
}

function signedReferencePayload(ref) {
	return {
		schemaVersion: Number(ref?.schemaVersion || 1),
		kind: cleanString(ref?.kind || ref?.manifestKind || SIGNED_EXPORT_REFERENCE_KIND),
		tenantId: cleanString(ref?.tenantId),
		entryId: ref?.entryId == null ? null : String(ref.entryId),
		jobId: cleanString(ref?.jobId),
		runId: cleanString(ref?.runId),
		path: cleanString(ref?.path),
		sha256: cleanString(ref?.sha256),
		exportScopeHash: cleanString(ref?.exportScopeHash),
		issuedAt: cleanString(ref?.issuedAt),
		expiresAt: cleanString(ref?.expiresAt),
	};
}

function signedReferenceSignature(ref) {
	return `sha256:${crypto.createHash('sha256').update(JSON.stringify(signedReferencePayload(ref))).digest('hex')}`;
}

function scanExportSignedReferences(bundle = {}, { tenantId, entries, exportExpiresAtMs, now, requireSignedReferences } = {}) {
	const refs = Array.isArray(bundle?.signedReferences) ? bundle.signedReferences : [];
	const findings = [];
	if (requireSignedReferences && !refs.length) {
		findings.push(finding('missing-signed-references', '', 'export manifest requires scoped signed references'));
	}
	const expectedScopeHash = exportScopeHash(bundle);
	const entriesByKey = new Map((entries || []).map((entry) => [exportReferenceKeyForEntry(entry), entry]));
	const refKeys = new Set();
	for (const [index, ref] of refs.entries()) {
		const label = exportEntryLabel(ref, index);
		const refKey = exportReferenceKey(ref);
		refKeys.add(refKey);
		const expectedEntry = entriesByKey.get(refKey);
		if (requireSignedReferences && !expectedEntry) {
			findings.push(finding('signed-reference-unmatched-entry', label, 'signed reference must match an export item'));
		}
		const refTenant = cleanOptionalTenant(ref?.tenantId);
		if (!refTenant) findings.push(finding('missing-signed-reference-tenant', label, 'signed reference requires tenant metadata'));
		else if (tenantId && refTenant !== tenantId) findings.push(finding('signed-reference-tenant-mismatch', label, 'signed reference tenant must match export tenant'));

		const safePath = exportSafePath(ref?.path);
		if (!safePath.ok) findings.push(finding(safePath.reason, label, 'signed reference path must be a safe relative path'));

		const kind = cleanString(ref?.kind || ref?.manifestKind);
		if (kind && kind !== SIGNED_EXPORT_REFERENCE_KIND) findings.push(finding('invalid-signed-reference-kind', label, 'signed reference has an unexpected kind'));

		const status = normalizedStatus(ref?.status || 'active');
		if (['invalidated', 'revoked', 'deleted', 'expired'].includes(status) || ref?.invalidatedAt) {
			findings.push(finding('signed-reference-invalidated', label, 'signed reference has been invalidated'));
		} else if (status && status !== 'active') {
			findings.push(finding('signed-reference-not-active', label, 'signed reference must be active'));
		}

		const refExpiresMs = toTimeMs(ref?.expiresAt);
		if (!ref?.expiresAt) {
			findings.push(finding('missing-signed-reference-expiry', label, 'signed reference requires an expiration time'));
		} else if (!Number.isFinite(refExpiresMs)) {
			findings.push(finding('invalid-signed-reference-expiry', label, 'signed reference expiration must be valid'));
		} else {
			if (refExpiresMs <= now) findings.push(finding('signed-reference-expired', label, 'signed reference is expired'));
			if (Number.isFinite(exportExpiresAtMs) && refExpiresMs > exportExpiresAtMs) {
				findings.push(finding('signed-reference-outlives-export', label, 'signed reference must not outlive the export manifest'));
			}
		}

		if (!ref?.exportScopeHash) {
			findings.push(finding('missing-signed-reference-scope-hash', label, 'signed reference requires an export scope hash'));
		} else if (ref.exportScopeHash !== expectedScopeHash) {
			findings.push(finding('signed-reference-scope-mismatch', label, 'signed reference must bind to this export scope'));
		}

		if (!ref?.signature) {
			findings.push(finding('missing-signed-reference-signature', label, 'signed reference requires a deterministic signature'));
		} else if (ref.signature !== signedReferenceSignature(ref)) {
			findings.push(finding('signed-reference-signature-mismatch', label, 'signed reference signature must match its metadata payload'));
		}

		if (expectedEntry) {
			const entryMeta = signedReferenceEntryMetadata(expectedEntry);
			const refMeta = signedReferenceEntryMetadata(ref);
			if (entryMeta.sha256 && !refMeta.sha256) findings.push(finding('missing-signed-reference-digest', label, 'signed reference must bind the artifact digest'));
			if (entryMeta.sha256 && refMeta.sha256 && entryMeta.sha256 !== refMeta.sha256) findings.push(finding('signed-reference-digest-mismatch', label, 'signed reference digest must match the export item'));
			if (entryMeta.jobId && refMeta.jobId && entryMeta.jobId !== refMeta.jobId) findings.push(finding('signed-reference-job-mismatch', label, 'signed reference job must match the export item'));
			if (entryMeta.runId && refMeta.runId && entryMeta.runId !== refMeta.runId) findings.push(finding('signed-reference-run-mismatch', label, 'signed reference run must match the export item'));
		}
	}
	if (requireSignedReferences) {
		for (const [index, entry] of entries.entries()) {
			if (!refKeys.has(exportReferenceKeyForEntry(entry))) {
				findings.push(finding('missing-signed-reference', exportEntryLabel(entry, index), 'every export item requires a signed reference'));
			}
		}
	}
	return { refs, findings };
}

export function buildExportSignedReferences(manifest, {
	issuedAt = manifest?.createdAt || new Date().toISOString(),
	expiresAt = manifest?.expiresAt,
	ttlMs = DEFAULT_EXPORT_TTL_MS,
} = {}) {
	const entries = exportEntries(manifest);
	const issuedMs = toTimeMs(issuedAt) ?? Date.now();
	const finalExpiresAt = cleanString(expiresAt) || isoFromMs(issuedMs + ttlMs);
	const scopeHash = exportScopeHash({ ...manifest, signedReferences: [] });
	return entries.map((entry, index) => {
		const ref = {
			schemaVersion: 1,
			kind: SIGNED_EXPORT_REFERENCE_KIND,
			refId: `expref:${crypto.createHash('sha256').update(JSON.stringify({
				scopeHash,
				index,
				id: entry?.id == null ? null : String(entry.id),
				path: entry?.path || '',
			})).digest('hex').slice(0, 20)}`,
			tenantId: cleanString(entry?.tenantId || manifest?.tenantId),
			entryId: entry?.id == null ? null : String(entry.id),
			jobId: cleanString(entry?.jobId),
			runId: cleanString(entry?.runId),
			path: cleanString(entry?.path || entry?.file || entry?.name),
			sha256: cleanString(entry?.sha256),
			exportScopeHash: scopeHash,
			issuedAt: cleanString(issuedAt),
			expiresAt: finalExpiresAt,
			status: 'active',
			invalidatedAt: null,
			invalidationReason: '',
		};
		ref.signedRef = `aqa-export-ref://${ref.tenantId}/${ref.refId}`;
		ref.signature = signedReferenceSignature(ref);
		return ref;
	});
}

export function invalidateExportSignedReferences(references = [], {
	artifactIds = [],
	paths = [],
	runIds = [],
	jobIds = [],
	reason = 'tenant deletion',
	invalidatedAt = new Date().toISOString(),
} = {}) {
	const artifactSet = new Set(artifactIds.map((v) => String(v)));
	const pathSet = new Set(paths.map((v) => String(v)));
	const runSet = new Set(runIds.map((v) => String(v)));
	const jobSet = new Set(jobIds.map((v) => String(v)));
	return (Array.isArray(references) ? references : []).map((ref) => {
		const match = (ref.entryId != null && artifactSet.has(String(ref.entryId)))
			|| (ref.path && pathSet.has(String(ref.path)))
			|| (ref.runId && runSet.has(String(ref.runId)))
			|| (ref.jobId && jobSet.has(String(ref.jobId)));
		if (!match) return { ...ref };
		return {
			...ref,
			status: 'invalidated',
			invalidatedAt,
			invalidationReason: cleanString(reason || 'invalidated'),
		};
	});
}

function approvalManifestEntry(artifact) {
	const entry = artifactExportEntry(artifact);
	return {
		id: entry.id == null ? null : String(entry.id),
		jobId: entry.jobId || null,
		runId: entry.runId || null,
		path: entry.path || '',
		kind: entry.kind || null,
		sha256: entry.sha256 || '',
		retention: entry.retention || 'ephemeral-debug',
		scanStatus: entry.scanStatus || 'unknown',
		redactionStatus: entry.redactionStatus || 'unknown',
		deleted: !!entry.deleted,
	};
}

function inferredPolicyApproval(entries) {
	const approvals = entries.map(policyApprovalMetadata);
	const firstApproved = approvals.find((p) => SAFE_POLICY_APPROVAL_STATES.has(p.status) && p.approvedBy && p.approvedAt);
	const allApproved = entries.length > 0 && approvals.every((p) => SAFE_POLICY_APPROVAL_STATES.has(p.status) && p.approvedBy && p.approvedAt);
	return {
		status: allApproved ? 'approved' : 'missing',
		approvedBy: firstApproved?.approvedBy || '',
		approvedAt: firstApproved?.approvedAt || '',
		reason: approvals.find((p) => p.reason)?.reason || '',
	};
}

function policyApprovalManifestMetadata(manifest) {
	if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
		return {
			present: false,
			ok: false,
			findings: [finding('missing-policy-approval-manifest', '', 'export requires a policy approval manifest')],
		};
	}
	const meta = {
		present: true,
		kind: cleanString(manifest.manifestKind || manifest.kind),
		status: normalizedStatus(manifest.status || manifest.decision || (manifest.approved === true ? 'approved' : '')),
		tenantId: cleanOptionalTenant(manifest.tenantId || manifest.tenant?.id),
		approvalId: cleanString(manifest.approvalId || manifest.id),
		approvedBy: cleanString(manifest.approvedBy || manifest.actorId || manifest.approver),
		approvedAt: cleanString(manifest.approvedAt),
		manifestHash: cleanString(manifest.manifestHash),
		expectedHash: manifestHash(manifest),
		findings: [],
	};
	if (meta.kind && meta.kind !== POLICY_APPROVAL_MANIFEST_KIND) {
		meta.findings.push(finding('invalid-policy-manifest-kind', '', 'policy approval manifest has an unexpected kind'));
	}
	if (!SAFE_POLICY_APPROVAL_STATES.has(meta.status)) meta.findings.push(finding('missing-policy-approval', '', 'policy approval manifest must be approved'));
	if (!meta.tenantId) meta.findings.push(finding('missing-policy-manifest-tenant', '', 'policy approval manifest requires tenant metadata'));
	if (!meta.approvalId) meta.findings.push(finding('missing-policy-approval-id', '', 'policy approval manifest requires an approval id'));
	if (!meta.approvedBy) meta.findings.push(finding('missing-policy-approver', '', 'policy approval manifest requires an approver'));
	if (!meta.approvedAt) meta.findings.push(finding('missing-policy-approved-at', '', 'policy approval manifest requires an approval time'));
	if (!meta.manifestHash) {
		meta.findings.push(finding('missing-policy-manifest-hash', '', 'policy approval manifest requires an integrity hash'));
	} else if (meta.manifestHash !== meta.expectedHash) {
		meta.findings.push(finding('policy-manifest-hash-mismatch', '', 'policy approval manifest hash must match its contents'));
	}
	meta.ok = meta.findings.length === 0;
	return meta;
}

export function buildPolicyApprovalManifest({
	tenantId,
	requester,
	purpose,
	artifacts = [],
	artifactIds = [],
	jobIds = [],
	runIds = [],
	paths = [],
	status,
	approvalId,
	approvedBy,
	approvedAt,
	reason,
	expiresAt,
	createdAt = new Date().toISOString(),
} = {}) {
	const entries = artifacts.map(approvalManifestEntry);
	const approvedByValue = cleanString(approvedBy);
	const approvedAtValue = cleanString(approvedAt);
	const statusValue = normalizedStatus(status) || (approvedByValue && approvedAtValue ? 'approved' : 'missing');
	const manifest = {
		schemaVersion: 1,
		manifestKind: POLICY_APPROVAL_MANIFEST_KIND,
		tenantId: cleanString(tenantId),
		status: statusValue,
		approvalId: '',
		approvedBy: approvedByValue,
		approvedAt: approvedAtValue,
		requester: cleanString(requester),
		purpose: cleanString(purpose),
		reason: cleanString(reason),
		createdAt,
		expiresAt: cleanString(expiresAt),
		scope: {
			artifactIds: uniqueStrings([...artifactIds, ...entries.map((entry) => entry.id)]),
			jobIds: uniqueStrings([...jobIds, ...entries.map((entry) => entry.jobId)]),
			runIds: uniqueStrings([...runIds, ...entries.map((entry) => entry.runId)]),
			paths: uniqueStrings([...paths, ...entries.map((entry) => entry.path)]),
			artifactCount: entries.length,
		},
		entries,
	};
	const approvalSeed = { ...manifest, approvalId: '' };
	manifest.approvalId = cleanString(approvalId) || `approval:${crypto.createHash('sha256').update(JSON.stringify(approvalSeed)).digest('hex').slice(0, 16)}`;
	manifest.manifestHash = manifestHash(manifest);
	return manifest;
}

export function policyApprovalFromManifest(policyManifest) {
	const meta = policyApprovalManifestMetadata(policyManifest);
	return {
		status: meta.status || 'missing',
		approvedBy: meta.approvedBy || '',
		approvedAt: meta.approvedAt || '',
		approvalId: meta.approvalId || '',
		manifestHash: meta.manifestHash || '',
		reason: cleanString(policyManifest?.reason),
	};
}

export function applyPolicyApprovalManifest(artifacts = [], policyManifest) {
	const approval = policyApprovalFromManifest(policyManifest);
	return artifacts.map((artifact) => {
		const existing = artifact?.policyApproval && typeof artifact.policyApproval === 'object' ? artifact.policyApproval : {};
		return {
			...artifact,
			policyApproval: {
				...existing,
				...approval,
			},
		};
	});
}

export function artifactExportEntry(artifact) {
	const policy = artifact?.policyApproval && typeof artifact.policyApproval === 'object' ? artifact.policyApproval : {};
	const policyStatus = typeof artifact?.policyApproval === 'string'
		? artifact.policyApproval
		: (policy.status || policy.decision || artifact?.policyApprovalStatus || artifact?.policy_approval || 'missing');
	return {
		id: artifact?.id,
		tenantId: artifact?.tenantId,
		jobId: artifact?.jobId || null,
		runId: artifact?.runId,
		path: artifact?.path,
		kind: artifact?.kind || null,
		sha256: artifact?.sha256,
		bytes: artifact?.bytes ?? null,
		retention: artifact?.retention || 'ephemeral-debug',
		scanStatus: artifact?.scanStatus || 'unknown',
		redactionStatus: artifact?.redactionStatus || artifact?.redaction || 'unknown',
		policyApproval: {
			status: policyStatus,
			approvedBy: policy.approvedBy || artifact?.policyApprovedBy || '',
			approvedAt: policy.approvedAt || artifact?.policyApprovedAt || '',
			reason: policy.reason || artifact?.policyReason || '',
			approvalId: policy.approvalId || artifact?.policyApprovalId || '',
			manifestHash: policy.manifestHash || artifact?.policyApprovalManifestHash || '',
		},
		cacheKey: artifact?.cacheKey || artifact?.cache_key || artifact?.cache?.key || artifact?.metadata?.cacheKey || '',
		cacheScope: artifact?.cacheScope || artifact?.cache_scope || artifact?.cache?.scope || artifact?.metadata?.cacheScope || '',
		cacheTenantId: artifact?.cacheTenantId || artifact?.cacheTenant || artifact?.cache?.tenantId || artifact?.metadata?.cacheTenantId || '',
		sharedCache: artifact?.sharedCache === true || artifact?.shared_cache === true || artifact?.cache?.shared === true,
		createdAt: artifact?.createdAt || null,
		deletedAt: artifact?.deletedAt || null,
		deleted: !!artifact?.deletedAt || artifact?.deleted === true,
	};
}

export function scanExportManifest(bundle = {}, opts = {}) {
	const base = scanExportBundle(bundle, opts);
	const findings = [...base.findings];
	const tenantId = cleanOptionalTenant(bundle?.tenantId || opts.tenantId);
	const requester = cleanString(bundle?.requester || bundle?.requestedBy || opts.requester);
	const purpose = cleanString(bundle?.purpose || opts.purpose);
	const entries = exportEntries(bundle);
	const expiry = exportExpiryMetadata(bundle, opts);
	findings.push(...expiry.findings);
	if (!tenantId) findings.push(finding('missing-export-tenant', '', 'export requires a valid tenant'));
	if (!requester) findings.push(finding('missing-export-requester', '', 'export requires requester metadata'));
	if (!purpose) findings.push(finding('missing-export-purpose', '', 'export requires purpose metadata'));

	const requirePolicyManifest = opts.requirePolicyApprovalManifest !== false;
	const policyManifest = policyApprovalManifestMetadata(bundle?.policyApprovalManifest || bundle?.approvalManifest || bundle?.policyManifest);
	if (requirePolicyManifest) findings.push(...policyManifest.findings);
	if (policyManifest.present && policyManifest.tenantId && tenantId && policyManifest.tenantId !== tenantId) {
		findings.push(finding('policy-manifest-tenant-mismatch', '', 'policy approval manifest tenant must match export tenant'));
	}

	for (const [index, entry] of entries.entries()) {
		const label = exportEntryLabel(entry, index);
		const pathValue = entry?.path || entry?.file || entry?.name || '';
		const safePath = exportSafePath(pathValue);
		if (!safePath.ok) findings.push(finding(safePath.reason, label, 'export path must be a safe relative path'));

		const entryTenant = cleanOptionalTenant(entry?.tenantId || entry?.tenant || entry?.metadata?.tenantId);
		if (!entryTenant) {
			findings.push(finding('missing-item-tenant', label, 'every export item requires tenant metadata'));
		} else if (tenantId && entryTenant !== tenantId) {
			findings.push(finding('tenant-mismatch', label, 'export item tenant must match bundle tenant'));
		}

		const policy = policyApprovalMetadata(entry);
		if (!SAFE_POLICY_APPROVAL_STATES.has(policy.status)) {
			findings.push(finding('missing-policy-approval', label, 'export requires per-item policy approval'));
		}
		if (!policy.approvedBy) findings.push(finding('missing-policy-approver', label, 'policy approval requires an approver'));
		if (!policy.approvedAt) findings.push(finding('missing-policy-approved-at', label, 'policy approval requires an approval time'));
		if (requirePolicyManifest || policyManifest.present) {
			if (!policy.approvalId) findings.push(finding('missing-policy-approval-id', label, 'policy approval requires a manifest approval id'));
			if (!policy.manifestHash) {
				findings.push(finding('missing-policy-manifest-hash', label, 'policy approval requires a manifest hash'));
			} else if (policyManifest.ok && policy.manifestHash !== policyManifest.manifestHash) {
				findings.push(finding('policy-manifest-hash-mismatch', label, 'entry policy approval must reference the bundle policy manifest hash'));
			}
			if (policyManifest.ok && policy.approvalId && policy.approvalId !== policyManifest.approvalId) {
				findings.push(finding('policy-approval-id-mismatch', label, 'entry policy approval must reference the bundle policy approval id'));
			}
		}
		if (entry?.deletedAt || entry?.deleted === true || entry?.metadata?.deletedAt) {
			findings.push(finding('deleted-artifact', label, 'deleted artifact tombstones are not exportable'));
		}

		const cache = cacheMetadata(entry);
		if (cache.shared) findings.push(finding('shared-cache-reference', label, 'shared or global artifact cache references are not exportable'));
		if (cache.key && !cache.tenantId) findings.push(finding('missing-cache-tenant', label, 'artifact cache metadata must be tenant-scoped'));
		if (cache.tenantId && tenantId && cache.tenantId !== tenantId) findings.push(finding('cache-tenant-mismatch', label, 'artifact cache tenant must match export tenant'));
	}

	const isManifest = cleanString(bundle?.manifestKind || bundle?.kind) === EXPORT_MANIFEST_KIND;
	const requireSignedReferences = opts.requireSignedReferences === true || (isManifest && opts.requireSignedReferences !== false);
	const signedReferences = scanExportSignedReferences(bundle, {
		tenantId,
		entries,
		exportExpiresAtMs: expiry.expiresAtMs,
		now: expiry.nowMs,
		requireSignedReferences,
	});
	findings.push(...signedReferences.findings);

	const allowed = findings.length === 0;
	return {
		...base,
		ok: allowed,
		allowed,
		blocked: !allowed,
		decision: allowed ? 'allowed' : 'blocked',
		tenantId,
		requester,
		purpose,
		expiresAt: expiry.expiresAt,
		exportScopeHash: exportScopeHash(bundle),
		scanner: 'webui-export-manifest-gate/v1',
		findings,
	};
}

export function buildExportManifest({
	tenantId,
	requester,
	purpose,
	artifacts = [],
	createdAt = new Date().toISOString(),
	expiresAt,
	ttlMs = DEFAULT_EXPORT_TTL_MS,
	policyApprovalManifest = null,
	approvedBy,
	approvedAt,
	approvalId,
	approvalReason,
	approvalExpiresAt,
	approvalStatus,
} = {}) {
	const createdMs = toTimeMs(createdAt) ?? Date.now();
	const finalExpiresAt = cleanString(expiresAt) || isoFromMs(createdMs + ttlMs);
	const baseEntries = artifacts.map(artifactExportEntry);
	const inferred = inferredPolicyApproval(baseEntries);
	const approvalManifest = policyApprovalManifest || buildPolicyApprovalManifest({
		tenantId,
		requester,
		purpose,
		artifacts: baseEntries,
		status: approvalStatus || inferred.status,
		approvalId,
		approvedBy: cleanString(approvedBy) || inferred.approvedBy,
		approvedAt: cleanString(approvedAt) || inferred.approvedAt,
		reason: approvalReason || inferred.reason,
		expiresAt: approvalExpiresAt,
		createdAt,
	});
	const entries = applyPolicyApprovalManifest(baseEntries, approvalManifest).map(artifactExportEntry);
	const manifest = {
		schemaVersion: 1,
		manifestKind: EXPORT_MANIFEST_KIND,
		tenantId: cleanString(tenantId),
		requester: cleanString(requester),
		purpose: cleanString(purpose),
		createdAt,
		expiresAt: finalExpiresAt,
		policyApprovalManifest: approvalManifest,
		entries,
	};
	manifest.signedReferences = buildExportSignedReferences(manifest, {
		issuedAt: createdAt,
		expiresAt: finalExpiresAt,
	});
	const decision = scanExportManifest(manifest, { tenantId: manifest.tenantId });
	manifest.decision = {
		allowed: decision.allowed,
		blocked: decision.blocked,
		scanner: decision.scanner,
		findings: decision.findings,
	};
	manifest.manifestHash = manifestHash(manifest);
	return manifest;
}

export function assertExportManifestAllowed(manifest) {
	const result = scanExportManifest(manifest, { tenantId: manifest?.tenantId });
	if (!result.allowed) {
		const reasons = [...new Set(result.findings.map((f) => f.reason))].join(', ') || 'blocked';
		const err = new Error(`export manifest blocked: ${reasons}`);
		err.result = result;
		throw err;
	}
	return { ...result, manifestHash: manifestHash(manifest) };
}

export function buildExportManifestFromDb(db, { tenantId, artifactIds = [], requester, purpose, createdAt } = {}) {
	const artifacts = artifactIds.map((id) => dbm.getWebuiArtifact(db, { tenantId, id, includeDeleted: true }));
	const present = artifacts.filter(Boolean);
	const manifest = buildExportManifest({ tenantId, requester, purpose, artifacts: present, createdAt });
	if (present.length !== artifactIds.length) {
		manifest.missingArtifactIds = artifactIds.filter((_id, index) => !artifacts[index]).map((id) => String(id));
		manifest.decision.allowed = false;
		manifest.decision.blocked = true;
		manifest.decision.findings.push({
			reason: 'missing-artifact-metadata',
			entry: '',
			message: 'every export item must resolve to tenant-scoped artifact metadata',
		});
		manifest.manifestHash = manifestHash(manifest);
	}
	return manifest;
}
