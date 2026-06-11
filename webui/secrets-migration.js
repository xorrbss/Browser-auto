// webui/secrets-migration.js - plaintext secret migration inventory/plan (dry-run,
// sanitized) and the operator approval manifest builder/validator with integrity hash.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
	PROBE_ROOT,
	cleanTenant,
	cleanOptionalTenant,
	cleanMetadataText,
	normalizedStatus,
	finding,
	uniqueCleanStrings,
	increment,
	parseSecretRef,
} from './secrets-core.js';
import { createSecretStore } from './secrets-store-broker.js';

export const SECRET_MIGRATION_APPROVAL_MANIFEST_KIND = 'aqa.secret-migration-approval-manifest';
export const SECRET_MIGRATION_CONTRACT_VERSION = 1;
const SAFE_OPERATOR_APPROVAL_STATES = new Set(['approved', 'allow', 'allowed']);

const MIGRATION_NAME_RE = /^[A-Za-z0-9_-]+$/;
const PLAINTEXT_MIGRATION_SOURCES = Object.freeze([
	{
		kind: 'auth-state',
		source: 'canonical',
		dir: ['fixtures', 'auth', 'playwright'],
		suffix: '.state.json',
		pathClass: 'fixtures/auth/playwright/*.state.json',
		secretName: (name) => `canonical:${name}`,
	},
	{
		kind: 'auth-state',
		source: 'legacy',
		dir: ['approve'],
		suffix: '.pw-state.json',
		pathClass: 'approve/*.pw-state.json',
		secretName: (name) => `legacy:${name}`,
	},
	{
		kind: 'flow-values',
		source: 'flow-values',
		dir: ['flows'],
		suffix: '.values.json',
		pathClass: 'flows/*.values.json',
		secretName: (name) => name,
	},
]);

export async function inventoryPlaintextSecretMigration(opts = {}) {
	const rootDir = path.resolve(opts.rootDir || PROBE_ROOT);
	const tenantId = cleanTenant(opts.tenantId || 'local');
	const store = opts.secretStore || createSecretStore({ env: opts.env || process.env, tenantId });
	const entries = [];
	for (const source of PLAINTEXT_MIGRATION_SOURCES) {
		const dir = path.join(rootDir, ...source.dir);
		let files;
		try {
			files = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.isFile() || !file.name.endsWith(source.suffix)) continue;
			const baseName = file.name.slice(0, -source.suffix.length);
			const validName = MIGRATION_NAME_RE.test(baseName);
			let statOk = false;
			try {
				const st = await fs.promises.stat(path.join(dir, file.name));
				statOk = st.isFile();
			} catch {
				statOk = false;
			}
			if (!statOk) continue;
			let secureStatus = secureMigrationStatus(store);
			if (validName && store?.secureBackend && store?.configured) {
				try {
					const meta = await store.describeSecret({ tenantId, kind: source.kind, name: source.secretName(baseName) });
					secureStatus = meta.present && meta.usable ? 'secure-present' : 'secure-missing';
				} catch {
					secureStatus = 'secure-unreadable';
				}
			}
			const status = !validName
				? 'invalid-name'
				: secureStatus === 'secure-present'
					? 'plaintext-with-secure-copy'
					: 'plaintext-pending-migration';
			entries.push({
				kind: source.kind,
				source: source.source,
				pathClass: source.pathClass,
				status,
				secureStatus,
			});
		}
	}
	return {
		scanner: 'webui-secret-migration-inventory/v1',
		tenantId,
		root: 'repository',
		entries,
		summary: summarizeMigrationInventory(entries),
	};
}

export async function planPlaintextSecretMigration(opts = {}) {
	const inventory = opts.inventory || await inventoryPlaintextSecretMigration(opts);
	const operations = inventory.entries.map((entry) => migrationPlanOperation(entry));
	return {
		planner: 'webui-secret-migration-plan/v1',
		tenantId: cleanTenant(inventory.tenantId || opts.tenantId || 'local'),
		root: 'repository',
		dryRun: true,
		sanitized: true,
		secretContentsInspected: false,
		migratesSecrets: false,
		operations,
		summary: summarizeMigrationPlan(inventory.summary, operations),
	};
}

export function buildSecretMigrationApprovalManifest({
	tenantId,
	requester,
	purpose,
	secretRefs = [],
	pathClasses = [],
	status,
	approvalId,
	approvedBy,
	approvedAt,
	reason,
	expiresAt,
	createdAt = new Date().toISOString(),
} = {}) {
	const approvedByValue = cleanMetadataText(approvedBy);
	const approvedAtValue = cleanMetadataText(approvedAt);
	const statusValue = normalizedStatus(status) || (approvedByValue && approvedAtValue ? 'approved' : 'missing');
	const manifest = {
		schemaVersion: SECRET_MIGRATION_CONTRACT_VERSION,
		manifestKind: SECRET_MIGRATION_APPROVAL_MANIFEST_KIND,
		tenantId: cleanMetadataText(tenantId),
		status: statusValue,
		approvalId: '',
		approvedBy: approvedByValue,
		approvedAt: approvedAtValue,
		requester: cleanMetadataText(requester),
		purpose: cleanMetadataText(purpose),
		reason: cleanMetadataText(reason),
		createdAt: cleanMetadataText(createdAt),
		expiresAt: cleanMetadataText(expiresAt),
		scope: {
			secretRefs: uniqueCleanStrings(secretRefs),
			pathClasses: uniqueCleanStrings(pathClasses),
		},
	};
	const approvalSeed = { ...manifest, approvalId: '' };
	manifest.approvalId = cleanMetadataText(approvalId) || `secret-migration:${crypto.createHash('sha256').update(JSON.stringify(approvalSeed)).digest('hex').slice(0, 16)}`;
	manifest.manifestHash = secretMigrationManifestHash(manifest);
	return manifest;
}

export function validateSecretMigrationApprovalManifest(manifest, opts = {}) {
	const tenantId = cleanOptionalTenant(opts.tenantId);
	const requiredRefs = Array.isArray(opts.requiredSecretRefs || opts.requiredRefs)
		? (opts.requiredSecretRefs || opts.requiredRefs)
		: [];
	if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
		return {
			present: false,
			ok: false,
			refCount: 0,
			validRefCount: 0,
			invalidRefCount: 0,
			requiredRefCount: requiredRefs.length,
			missingRequiredRefCount: requiredRefs.length,
			findings: [finding('missing-operator-approval-manifest', '', 'production secret migration requires an operator approval manifest')],
		};
	}
	const meta = {
		present: true,
		kind: cleanMetadataText(manifest.manifestKind || manifest.kind),
		status: normalizedStatus(manifest.status || manifest.decision || (manifest.approved === true ? 'approved' : '')),
		tenantId: cleanOptionalTenant(manifest.tenantId || manifest.tenant?.id),
		approvalIdPresent: !!cleanMetadataText(manifest.approvalId || manifest.id),
		approvedByPresent: !!cleanMetadataText(manifest.approvedBy || manifest.actorId || manifest.approver),
		approvedAtPresent: !!cleanMetadataText(manifest.approvedAt),
		manifestHashPresent: !!cleanMetadataText(manifest.manifestHash),
		expectedHash: secretMigrationManifestHash(manifest),
		refCount: 0,
		validRefCount: 0,
		invalidRefCount: 0,
		requiredRefCount: requiredRefs.length,
		missingRequiredRefCount: 0,
		pathClassCount: 0,
		findings: [],
	};
	if (meta.kind && meta.kind !== SECRET_MIGRATION_APPROVAL_MANIFEST_KIND) {
		meta.findings.push(finding('invalid-secret-migration-manifest-kind', '', 'operator approval manifest has an unexpected kind'));
	}
	if (!SAFE_OPERATOR_APPROVAL_STATES.has(meta.status)) {
		meta.findings.push(finding('missing-secret-migration-approval', '', 'operator approval manifest must be approved'));
	}
	if (!meta.tenantId) {
		meta.findings.push(finding('missing-secret-migration-tenant', '', 'operator approval manifest requires tenant metadata'));
	} else if (tenantId && meta.tenantId !== tenantId) {
		meta.findings.push(finding('secret-migration-tenant-mismatch', '', 'operator approval manifest tenant must match migration tenant'));
	}
	if (!meta.approvalIdPresent) meta.findings.push(finding('missing-secret-migration-approval-id', '', 'operator approval manifest requires an approval id'));
	if (!meta.approvedByPresent) meta.findings.push(finding('missing-secret-migration-approver', '', 'operator approval manifest requires an approver'));
	if (!meta.approvedAtPresent) meta.findings.push(finding('missing-secret-migration-approved-at', '', 'operator approval manifest requires an approval time'));
	const manifestHash = cleanMetadataText(manifest.manifestHash);
	if (!manifestHash) {
		meta.findings.push(finding('missing-secret-migration-manifest-hash', '', 'operator approval manifest requires an integrity hash'));
	} else if (manifestHash !== meta.expectedHash) {
		meta.findings.push(finding('secret-migration-manifest-hash-mismatch', '', 'operator approval manifest hash must match its contents'));
	}

	const refs = approvalManifestSecretRefs(manifest);
	const validRefs = new Set();
	meta.refCount = refs.length;
	for (const [index, ref] of refs.entries()) {
		const parsed = parseSecretRef(ref);
		if (!parsed) {
			meta.invalidRefCount += 1;
			meta.findings.push(finding('invalid-secret-migration-ref', `ref-${index + 1}`, 'operator approval manifest contains an invalid secret ref'));
			continue;
		}
		if (tenantId && parsed.tenantId !== tenantId) {
			meta.invalidRefCount += 1;
			meta.findings.push(finding('secret-migration-ref-tenant-mismatch', `ref-${index + 1}`, 'operator approval manifest secret ref tenant must match migration tenant'));
			continue;
		}
		validRefs.add(parsed.ref);
	}
	meta.validRefCount = validRefs.size;
	if (opts.requireSecretRefs !== false && refs.length === 0) {
		meta.findings.push(finding('missing-secret-migration-refs', '', 'operator approval manifest must reference approved secret refs'));
	}
	for (const [index, ref] of requiredRefs.entries()) {
		const parsed = parseSecretRef(ref);
		if (!parsed) {
			meta.findings.push(finding('invalid-required-secret-migration-ref', `required-ref-${index + 1}`, 'required secret migration ref is invalid'));
			continue;
		}
		if (!validRefs.has(parsed.ref)) {
			meta.missingRequiredRefCount += 1;
			meta.findings.push(finding('missing-approved-secret-migration-ref', `required-ref-${index + 1}`, 'operator approval manifest does not cover a required secret ref'));
		}
	}
	meta.pathClassCount = uniqueCleanStrings(manifest?.scope?.pathClasses || manifest?.pathClasses || []).length;
	meta.ok = meta.findings.length === 0;
	return meta;
}

function secretMigrationManifestHash(manifest = {}) {
	const copy = { ...manifest };
	delete copy.manifestHash;
	return `sha256:${crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex')}`;
}

function approvalManifestSecretRefs(manifest = {}) {
	const scope = manifest?.scope && typeof manifest.scope === 'object' ? manifest.scope : {};
	const refs = Array.isArray(scope.secretRefs)
		? scope.secretRefs
		: Array.isArray(manifest.secretRefs)
			? manifest.secretRefs
			: Array.isArray(manifest.refs)
				? manifest.refs
				: [];
	return refs.map((ref) => String(ref || '').trim()).filter(Boolean);
}

function secureMigrationStatus(store) {
	if (!store?.secureBackend) return 'secure-backend-not-configured';
	if (!store?.configured) return 'secure-backend-unavailable';
	return 'secure-missing';
}

function summarizeMigrationInventory(entries) {
	const summary = {
		total: entries.length,
		byKind: {},
		byPathClass: {},
		byStatus: {},
		bySecureStatus: {},
		pendingMigration: 0,
		withSecureCopy: 0,
		invalidName: 0,
	};
	for (const entry of entries) {
		increment(summary.byKind, entry.kind);
		increment(summary.byPathClass, entry.pathClass);
		increment(summary.byStatus, entry.status);
		increment(summary.bySecureStatus, entry.secureStatus);
		if (entry.status === 'plaintext-pending-migration') summary.pendingMigration += 1;
		if (entry.status === 'plaintext-with-secure-copy') summary.withSecureCopy += 1;
		if (entry.status === 'invalid-name') summary.invalidName += 1;
	}
	return summary;
}

function migrationPlanOperation(entry) {
	let action = 'operator-migrate-to-secure-store';
	let blockedReason = '';
	let readyForRetirePlaintext = false;
	if (entry.status === 'invalid-name') {
		action = 'manual-review-invalid-name';
		blockedReason = 'plaintext candidate name is not safe for automated planning';
	} else if (entry.status === 'plaintext-with-secure-copy') {
		action = 'operator-verify-secure-copy-then-retire-plaintext';
		readyForRetirePlaintext = true;
	} else if (entry.secureStatus === 'secure-backend-not-configured') {
		action = 'configure-secure-secret-backend';
		blockedReason = 'secure secret backend is not configured';
	} else if (entry.secureStatus === 'secure-backend-unavailable') {
		action = 'repair-secure-secret-backend';
		blockedReason = 'secure secret backend is unavailable';
	} else if (entry.secureStatus === 'secure-unreadable') {
		action = 'manual-review-secure-secret';
		blockedReason = 'secure secret metadata is unreadable';
	}
	return {
		kind: entry.kind,
		source: entry.source,
		pathClass: entry.pathClass,
		status: entry.status,
		secureStatus: entry.secureStatus,
		action,
		blocked: !!blockedReason,
		blockedReason,
		operatorApprovalRequired: true,
		readyForRetirePlaintext,
		readsSecretBytes: false,
		writesSecretBytes: false,
		deletesPlaintext: false,
	};
}

function summarizeMigrationPlan(inventorySummary = {}, operations = []) {
	const byAction = {};
	let blocked = 0;
	let readyForRetirePlaintext = 0;
	for (const op of operations) {
		increment(byAction, op.action);
		if (op.blocked) blocked += 1;
		if (op.readyForRetirePlaintext) readyForRetirePlaintext += 1;
	}
	return {
		total: inventorySummary.total || operations.length,
		pendingMigration: inventorySummary.pendingMigration || 0,
		withSecureCopy: inventorySummary.withSecureCopy || 0,
		invalidName: inventorySummary.invalidName || 0,
		blocked,
		readyForRetirePlaintext,
		byAction,
		requiresOperatorApproval: operations.length > 0,
		secretContentsInspected: false,
		migratesSecrets: false,
	};
}
