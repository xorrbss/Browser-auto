// webui/secrets-migration-production.js - fail-closed production migration execution
// contract: broker readiness, per-class readiness rollups, and execution summaries.

import {
	EXTERNAL_BROKER_BACKEND,
	cleanTenant,
	cleanMetadataText,
	safeNonNegativeNumber,
	finding,
	increment,
	envValue,
} from './secrets-core.js';
import { validateSecretBrokerAdapter } from './secrets-policy.js';
import { createSecretStore } from './secrets-store-broker.js';
import {
	SECRET_MIGRATION_CONTRACT_VERSION,
	inventoryPlaintextSecretMigration,
	planPlaintextSecretMigration,
	validateSecretMigrationApprovalManifest,
} from './secrets-migration.js';

export async function productionSecretMigrationExecutionContract(opts = {}) {
	const env = opts.env || process.env;
	const tenantId = cleanTenant(opts.tenantId || envValue(env, 'WEBUI_TENANT_ID', 'AQA_TENANT_ID') || 'local');
	const dryRun = opts.dryRun !== false;
	const store = opts.secretStore || createSecretStore({
		env,
		tenantId,
		backend: EXTERNAL_BROKER_BACKEND,
		broker: opts.broker,
	});
	const inventory = opts.inventory || (opts.plan ? null : await inventoryPlaintextSecretMigration({ ...opts, tenantId, secretStore: store }));
	const plan = opts.plan || await planPlaintextSecretMigration({ ...opts, tenantId, secretStore: store, inventory });
	const operations = Array.isArray(plan?.operations) ? plan.operations : [];
	const requiredRefs = Array.isArray(opts.requiredSecretRefs || opts.secretRefs)
		? (opts.requiredSecretRefs || opts.secretRefs)
		: [];
	const requireOperatorApproval = opts.requireOperatorApproval !== false && (operations.length > 0 || requiredRefs.length > 0);
	const approvalManifest = validateSecretMigrationApprovalManifest(opts.approvalManifest || opts.operatorApprovalManifest || opts.manifest, {
		tenantId,
		requiredSecretRefs: requiredRefs,
		requireSecretRefs: requireOperatorApproval,
	});
	const brokerReadiness = productionBrokerReadiness(store, env);
	const findings = [...brokerReadiness.findings];
	if (requireOperatorApproval) findings.push(...approvalManifest.findings);
	if (!dryRun) {
		findings.push(finding('production-secret-migration-non-dry-run-refused', '', 'local production migration contract is dry-run only and does not execute secret bytes'));
	}
	const approvalOk = !requireOperatorApproval || approvalManifest.ok;
	const readinessByClass = migrationReadinessByClass(operations, {
		dryRun,
		brokerOk: brokerReadiness.ok,
		approvalOk,
		rotationSupported: brokerReadiness.broker.rotationSupported,
		deleteSupported: brokerReadiness.broker.deleteSupported,
	});
	const allowed = findings.length === 0 && readinessByClass.every((entry) => entry.ready);
	return {
		contract: 'webui-secret-production-migration-execution/v1',
		schemaVersion: SECRET_MIGRATION_CONTRACT_VERSION,
		tenantId,
		root: 'repository',
		dryRun,
		failClosed: true,
		sanitized: true,
		secretContentsInspected: false,
		readsSecretBytes: false,
		writesSecretBytes: false,
		deletesPlaintext: false,
		migratesSecrets: false,
		sideEffects: false,
		decision: allowed ? 'dry-run-ready' : 'blocked',
		allowed,
		blocked: !allowed,
		broker: brokerReadiness.broker,
		approvalManifest: sanitizeApprovalManifestMeta(approvalManifest),
		readinessByClass,
		summary: summarizeMigrationExecution(readinessByClass, operations, findings),
		findings,
	};
}

function sanitizeApprovalManifestMeta(meta = {}) {
	return {
		present: !!meta.present,
		ok: !!meta.ok,
		kind: meta.kind || '',
		status: meta.status || '',
		tenantId: meta.tenantId || null,
		approvalIdPresent: !!meta.approvalIdPresent,
		approvedByPresent: !!meta.approvedByPresent,
		approvedAtPresent: !!meta.approvedAtPresent,
		manifestHashPresent: !!meta.manifestHashPresent,
		refCount: safeNonNegativeNumber(meta.refCount),
		validRefCount: safeNonNegativeNumber(meta.validRefCount),
		invalidRefCount: safeNonNegativeNumber(meta.invalidRefCount),
		requiredRefCount: safeNonNegativeNumber(meta.requiredRefCount),
		missingRequiredRefCount: safeNonNegativeNumber(meta.missingRequiredRefCount),
		pathClassCount: safeNonNegativeNumber(meta.pathClassCount),
		findings: Array.isArray(meta.findings) ? meta.findings : [],
	};
}

function productionBrokerReadiness(store, env = process.env) {
	const findings = [];
	const backend = store?.backend || '';
	let validation = null;
	let connector = store?.connector || null;
	if (backend !== EXTERNAL_BROKER_BACKEND) {
		findings.push(finding('production-secret-broker-required', 'broker', 'production secret migration requires WEBUI_SECRET_STORE_BACKEND=external-broker'));
	} else {
		validation = validateSecretBrokerAdapter(store?.broker, { env: store?.env || env, requireProductionConnector: true });
		connector = validation.connector || {};
		for (const error of validation.errors || []) {
			findings.push(finding('production-secret-broker-contract-invalid', 'broker', error));
		}
		if (!validation.contractOk) {
			findings.push(finding('production-secret-broker-adapter-missing', 'broker', 'production secret migration requires a broker adapter method contract'));
		}
		if (!connector.kmsKeyConfigured) {
			findings.push(finding('production-secret-broker-kms-key-missing', 'broker', 'production secret migration requires a configured KMS key id'));
		}
		if (!connector.tenantScoped) {
			findings.push(finding('production-secret-broker-tenant-scope-missing', 'broker', 'production secret migration requires tenant-scoped broker keys'));
		}
		if (!connector.encryptedAtRest) {
			findings.push(finding('production-secret-broker-encryption-missing', 'broker', 'production secret migration requires encrypted-at-rest broker storage'));
		}
		if (!connector.rotationSupported) {
			findings.push(finding('production-secret-broker-rotation-unsupported', 'broker', 'production secret migration requires key rotation support'));
		}
		if (!connector.deleteSupported) {
			findings.push(finding('production-secret-broker-delete-unsupported', 'broker', 'production secret migration requires deletion support'));
		}
		if (connector.testOnly) {
			findings.push(finding('production-secret-broker-test-only', 'broker', 'test secret broker is not allowed for production migration execution'));
		}
		if (!connector.productionReady) {
			findings.push(finding('production-secret-broker-not-production-ready', 'broker', 'production secret broker connector must declare productionReady=true'));
		}
		if (connector.plaintextEnvCredentialsConfigured) {
			findings.push(finding('production-secret-broker-plaintext-env-credential', 'broker', 'production secret broker configuration must not use plaintext env credential material'));
		}
	}
	return {
		ok: findings.length === 0,
		findings: uniqueFindings(findings),
		broker: {
			backend,
			configured: backend === EXTERNAL_BROKER_BACKEND && !!validation?.ok,
			contractOk: !!validation?.contractOk,
			provider: cleanMetadataText(connector?.provider),
			connectorId: cleanMetadataText(connector?.connectorId),
			kmsKeyConfigured: !!connector?.kmsKeyConfigured,
			tenantScoped: !!connector?.tenantScoped,
			encryptedAtRest: !!connector?.encryptedAtRest,
			rotationSupported: !!connector?.rotationSupported,
			deleteSupported: !!connector?.deleteSupported,
			testOnly: !!connector?.testOnly,
			productionReady: !!connector?.productionReady,
			plaintextEnvCredentialsConfigured: !!connector?.plaintextEnvCredentialsConfigured,
			plaintextEnvCredentialCount: safeNonNegativeNumber(connector?.plaintextEnvCredentialNames?.length),
		},
	};
}

function migrationReadinessByClass(operations = [], context = {}) {
	const classes = new Map();
	for (const op of operations) {
		const key = `${op.kind}\0${op.source}\0${op.pathClass}`;
		if (!classes.has(key)) {
			classes.set(key, {
				kind: op.kind,
				source: op.source,
				pathClass: op.pathClass,
				total: 0,
				pendingMigration: 0,
				withSecureCopy: 0,
				invalidName: 0,
				blockedOperations: 0,
				readyForRetirePlaintext: 0,
				byStatus: {},
				bySecureStatus: {},
				byAction: {},
				blockReasons: new Set(),
			});
		}
		const entry = classes.get(key);
		entry.total += 1;
		increment(entry.byStatus, op.status);
		increment(entry.bySecureStatus, op.secureStatus);
		increment(entry.byAction, op.action);
		if (op.status === 'plaintext-pending-migration') entry.pendingMigration += 1;
		if (op.status === 'plaintext-with-secure-copy') entry.withSecureCopy += 1;
		if (op.status === 'invalid-name') entry.invalidName += 1;
		if (op.readyForRetirePlaintext) entry.readyForRetirePlaintext += 1;
		if (op.blocked) {
			entry.blockedOperations += 1;
			entry.blockReasons.add(cleanMetadataText(op.blockedReason || 'operation blocked'));
		}
	}
	const out = [];
	for (const entry of classes.values()) {
		if (!context.brokerOk) entry.blockReasons.add('production-broker-not-ready');
		if (!context.rotationSupported) entry.blockReasons.add('production-broker-rotation-unsupported');
		if (!context.deleteSupported) entry.blockReasons.add('production-broker-delete-unsupported');
		if (!context.approvalOk) entry.blockReasons.add('operator-approval-not-ready');
		if (!context.dryRun) entry.blockReasons.add('non-dry-run-refused');
		if (entry.invalidName > 0) entry.blockReasons.add('invalid-plaintext-name');
		if (entry.pendingMigration > 0) entry.blockReasons.add('secure-copy-missing');
		const blockReasons = [...entry.blockReasons].filter(Boolean).sort();
		const ready = blockReasons.length === 0 && entry.total > 0 && entry.readyForRetirePlaintext === entry.total;
		out.push({
			kind: entry.kind,
			source: entry.source,
			pathClass: entry.pathClass,
			total: entry.total,
			pendingMigration: entry.pendingMigration,
			withSecureCopy: entry.withSecureCopy,
			invalidName: entry.invalidName,
			blockedOperations: entry.blockedOperations,
			readyForRetirePlaintext: entry.readyForRetirePlaintext,
			operatorApprovalRequired: entry.total > 0,
			approvalRefsValidated: !!context.approvalOk,
			rotationSupported: !!context.rotationSupported,
			deleteSupported: !!context.deleteSupported,
			dryRunOnly: true,
			ready,
			readiness: ready ? 'ready-for-operator-retirement-dry-run' : 'blocked',
			blocked: !ready,
			blockReasons,
			byStatus: entry.byStatus,
			bySecureStatus: entry.bySecureStatus,
			byAction: entry.byAction,
		});
	}
	return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.source.localeCompare(b.source) || a.pathClass.localeCompare(b.pathClass));
}

function summarizeMigrationExecution(readinessByClass = [], operations = [], findings = []) {
	const byReadiness = {};
	const byPathClass = {};
	const byFinding = {};
	let readyClasses = 0;
	let blockedClasses = 0;
	let pendingMigration = 0;
	let withSecureCopy = 0;
	let invalidName = 0;
	for (const entry of readinessByClass) {
		increment(byReadiness, entry.readiness);
		increment(byPathClass, entry.pathClass);
		if (entry.ready) readyClasses += 1;
		if (entry.blocked) blockedClasses += 1;
		pendingMigration += entry.pendingMigration;
		withSecureCopy += entry.withSecureCopy;
		invalidName += entry.invalidName;
	}
	for (const item of findings) {
		increment(byFinding, item.reason || 'blocked');
	}
	return {
		totalOperations: operations.length,
		totalClasses: readinessByClass.length,
		readyClasses,
		blockedClasses,
		pendingMigration,
		withSecureCopy,
		invalidName,
		findings: findings.length,
		byReadiness,
		byPathClass,
		byFinding,
		secretContentsInspected: false,
		migratesSecrets: false,
		dryRunOnly: true,
	};
}

function uniqueFindings(findings) {
	const seen = new Set();
	const out = [];
	for (const item of findings) {
		const key = `${item.reason}\0${item.entry}\0${item.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}
