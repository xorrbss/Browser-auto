// webui/secret-migration.js - metadata-only secret migration workflow skeleton.
//
// This state machine never executes migration side effects and never reads
// secret bytes. Callers provide operator manifests and broker metadata; this
// module validates readiness and returns sanitized workflow metadata only.

import crypto from 'node:crypto';
import {
	parseSecretRef,
	productionSecretMigrationExecutionContract,
	validateSecretBrokerAdapter,
	validateSecretMigrationApprovalManifest,
} from './secrets.js';

const WORKFLOW_CONTRACT = 'webui-secret-migration-workflow/v1';
const ROLLBACK_EVIDENCE_KIND = 'aqa.secret-migration-rollback-evidence';
const WORKFLOW_VERSION = 1;
const TENANT_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SAFE_TEXT_RE = /[^A-Za-z0-9_.:/@* -]/g;
const SAFE_TOKEN_RE = /[^A-Za-z0-9_.:-]/g;
const SAFE_ROLLBACK_STATES = new Set(['captured', 'ready', 'verified', 'approved']);
const STATES = new Set(['planned', 'approved', 'staged', 'committed', 'rolled_back', 'blocked']);
const TRANSITIONS = new Map([
	['approve', new Set(['planned'])],
	['stage', new Set(['approved'])],
	['commit', new Set(['staged'])],
	['rollback', new Set(['staged', 'committed'])],
]);
const METADATA_ONLY_FLAGS = {
	failClosed: true,
	sanitized: true,
	metadataOnly: true,
	secretContentsInspected: false,
	readsSecretBytes: false,
	writesSecretBytes: false,
	deletesPlaintext: false,
	migratesSecrets: false,
	sideEffects: false,
};

export function createSecretMigrationWorkflow(opts = {}) {
	const tenantId = cleanTenant(opts.tenantId || opts.plan?.tenantId || 'local') || 'local';
	const planMeta = sanitizePlan(opts.plan, { tenantId });
	const refScope = validateSecretRefScope(opts.requiredSecretRefs || opts.secretRefs || [], { tenantId });
	const findings = uniqueFindings([...planMeta.findings, ...refScope.findings]);
	const blocked = findings.length > 0;
	return workflowEnvelope({
		tenantId,
		state: blocked ? 'blocked' : 'planned',
		previousState: '',
		requestedAction: 'plan',
		decision: blocked ? blockedDecision(findings) : 'requires-operator',
		requiresOperator: true,
		plan: planMeta.plan,
		scope: refScope,
		findings,
	});
}

export async function advanceSecretMigrationWorkflow(workflow = {}, opts = {}) {
	const action = normalizeAction(opts.action || opts.transition || opts.event);
	const currentState = normalizeState(workflow.state);
	const tenantId = cleanTenant(opts.tenantId || workflow.tenantId || workflow.plan?.tenantId || 'local') || 'local';
	const planMeta = sanitizePlan(opts.plan || workflow.plan, { tenantId });
	const refScope = validateSecretRefScope(opts.requiredSecretRefs || opts.secretRefs || [], { tenantId });
	const baseFindings = uniqueFindings([...planMeta.findings, ...refScope.findings]);
	if (!TRANSITIONS.has(action)) {
		return blockedWorkflow({
			tenantId,
			workflow,
			state: currentState,
			requestedAction: action || 'unknown',
			plan: planMeta.plan,
			scope: refScope,
			findings: [...baseFindings, finding('invalid-secret-migration-transition', 'transition', 'secret migration workflow transition is not supported')],
		});
	}
	if (!TRANSITIONS.get(action).has(currentState)) {
		return blockedWorkflow({
			tenantId,
			workflow,
			state: currentState,
			requestedAction: action,
			plan: planMeta.plan,
			scope: refScope,
			findings: [...baseFindings, finding('secret-migration-transition-not-allowed', currentState || 'state', 'secret migration workflow transition is not allowed from the current state')],
		});
	}
	if (baseFindings.length > 0) {
		return blockedWorkflow({
			tenantId,
			workflow,
			state: currentState,
			requestedAction: action,
			plan: planMeta.plan,
			scope: refScope,
			findings: baseFindings,
		});
	}

	if (action === 'approve') {
		const approval = validateApproval(opts.approvalManifest || opts.operatorApprovalManifest || opts.manifest, {
			tenantId,
			requiredSecretRefs: refScope.refs,
			requireSecretRefs: planMeta.operationCount > 0 || refScope.requiredSecretRefCount > 0,
		});
		const findings = uniqueFindings(approval.findings);
		return workflowEnvelope({
			tenantId,
			state: findings.length > 0 ? 'blocked' : 'approved',
			previousState: currentState,
			requestedAction: action,
			decision: findings.length > 0 ? blockedDecision(findings) : 'approved',
			requiresOperator: findings.length > 0,
			plan: planMeta.plan,
			scope: refScope,
			approvalManifest: approval,
			findings,
		});
	}

	if (action === 'stage') {
		return stageWorkflow({
			tenantId,
			workflow,
			currentState,
			action,
			planMeta,
			refScope,
			approvalManifest: opts.approvalManifest || opts.operatorApprovalManifest || opts.manifest,
			secretStore: opts.secretStore,
			broker: opts.broker,
			env: opts.env,
			dryRun: opts.dryRun,
		});
	}

	const evidence = validateSecretMigrationRollbackEvidence(opts.rollbackEvidence || opts.evidence, {
		tenantId,
		requiredSecretRefs: refScope.refs,
	});
	const findings = uniqueFindings(evidence.findings);
	return workflowEnvelope({
		tenantId,
		state: findings.length > 0 ? 'blocked' : action === 'commit' ? 'committed' : 'rolled_back',
		previousState: currentState,
		requestedAction: action,
		decision: findings.length > 0 ? blockedDecision(findings) : action === 'commit' ? 'committed' : 'rolled_back',
		requiresOperator: findings.length > 0,
		plan: planMeta.plan,
		scope: refScope,
		approvalManifest: workflow.approvalManifest,
		rollbackEvidence: evidence,
		broker: workflow.broker,
		brokerScope: workflow.brokerScope,
		readinessByClass: workflow.readinessByClass,
		findings,
	});
}

export function buildSecretMigrationRollbackEvidence({
	tenantId,
	secretRefs = [],
	pathClasses = [],
	brokerMetadata = [],
	broker = {},
	status = 'captured',
	evidenceId = '',
	capturedBy = '',
	capturedAt = new Date().toISOString(),
	reason = '',
} = {}) {
	const checkpoints = sanitizeRollbackCheckpoints(brokerMetadata);
	const refs = uniqueStrings([
		...secretRefs.map((ref) => String(ref || '').trim()).filter(Boolean),
		...checkpoints.map((checkpoint) => checkpoint.ref).filter(Boolean),
	]);
	const evidence = {
		schemaVersion: WORKFLOW_VERSION,
		evidenceKind: ROLLBACK_EVIDENCE_KIND,
		tenantId: cleanText(tenantId),
		status: cleanToken(status || 'captured'),
		evidenceId: cleanText(evidenceId) || `secret-migration-rollback:${hashJson({ tenantId, refs, capturedAt }).slice(7, 23)}`,
		capturedBy: cleanText(capturedBy),
		capturedAt: cleanText(capturedAt),
		reason: cleanText(reason),
		scope: {
			secretRefs: refs,
			pathClasses: uniqueStrings(pathClasses.map(cleanText).filter(Boolean)),
		},
		broker: {
			provider: cleanText(broker?.provider),
			connectorId: cleanText(broker?.connectorId || broker?.id),
			kmsKeyConfigured: !!(broker?.kmsKeyConfigured || broker?.kmsKeyId || broker?.keyId),
			tenantScoped: !!broker?.tenantScoped,
			encryptedAtRest: !!broker?.encryptedAtRest,
			rotationSupported: !!broker?.rotationSupported,
			deleteSupported: !!broker?.deleteSupported,
			productionReady: !!broker?.productionReady,
			testOnly: !!broker?.testOnly,
		},
		checkpoints,
		rollbackPlan: {
			canRollback: true,
			requiresOperator: true,
			plaintextDeletionDeferred: true,
		},
	};
	evidence.evidenceHash = rollbackEvidenceHash(evidence);
	return evidence;
}

export function validateSecretMigrationRollbackEvidence(evidence = null, opts = {}) {
	const tenantId = cleanTenant(opts.tenantId || 'local') || 'local';
	const required = validateSecretRefScope(opts.requiredSecretRefs || opts.secretRefs || [], { tenantId });
	const meta = {
		present: !!evidence && typeof evidence === 'object',
		ok: false,
		kind: cleanText(evidence?.evidenceKind || evidence?.kind),
		status: cleanToken(evidence?.status),
		tenantId: cleanTenant(evidence?.tenantId) || null,
		evidenceIdPresent: !!cleanText(evidence?.evidenceId || evidence?.id),
		capturedByPresent: !!cleanText(evidence?.capturedBy || evidence?.actorId),
		capturedAtPresent: !!cleanText(evidence?.capturedAt),
		evidenceHashPresent: !!cleanText(evidence?.evidenceHash),
		refCount: 0,
		validRefCount: 0,
		invalidRefCount: 0,
		requiredRefCount: required.requiredSecretRefCount,
		missingRequiredRefCount: 0,
		pathClassCount: 0,
		checkpointCount: 0,
		readyCheckpointCount: 0,
		rotationReadyCount: 0,
		deleteReadyCount: 0,
		rollbackReady: false,
		plaintextDeletionDeferred: false,
		findings: [...required.findings],
	};
	if (!meta.present) {
		meta.findings.push(finding('missing-secret-migration-rollback-evidence', '', 'rollback evidence is required before commit or rollback'));
		return finalizeRollbackEvidence(meta);
	}
	if (meta.kind !== ROLLBACK_EVIDENCE_KIND) {
		meta.findings.push(finding('invalid-secret-migration-rollback-evidence-kind', '', 'rollback evidence has an unexpected kind'));
	}
	if (!SAFE_ROLLBACK_STATES.has(meta.status)) {
		meta.findings.push(finding('secret-migration-rollback-evidence-not-ready', '', 'rollback evidence must be captured and ready'));
	}
	if (!meta.tenantId) {
		meta.findings.push(finding('missing-secret-migration-rollback-tenant', '', 'rollback evidence requires tenant metadata'));
	} else if (meta.tenantId !== tenantId) {
		meta.findings.push(finding('secret-migration-rollback-tenant-mismatch', '', 'rollback evidence tenant must match workflow tenant'));
	}
	if (!meta.evidenceIdPresent) meta.findings.push(finding('missing-secret-migration-rollback-evidence-id', '', 'rollback evidence requires an evidence id'));
	if (!meta.capturedByPresent) meta.findings.push(finding('missing-secret-migration-rollback-captured-by', '', 'rollback evidence requires a capturing operator'));
	if (!meta.capturedAtPresent) meta.findings.push(finding('missing-secret-migration-rollback-captured-at', '', 'rollback evidence requires a capture time'));
	const expectedHash = rollbackEvidenceHash(evidence);
	const evidenceHash = cleanText(evidence.evidenceHash);
	if (!evidenceHash) {
		meta.findings.push(finding('missing-secret-migration-rollback-evidence-hash', '', 'rollback evidence requires an integrity hash'));
	} else if (evidenceHash !== expectedHash) {
		meta.findings.push(finding('secret-migration-rollback-evidence-hash-mismatch', '', 'rollback evidence hash must match its contents'));
	}

	const refs = rollbackEvidenceSecretRefs(evidence);
	const validRefs = new Set();
	meta.refCount = refs.length;
	for (const [index, ref] of refs.entries()) {
		const parsed = parseSecretRef(ref);
		if (!parsed) {
			meta.invalidRefCount += 1;
			meta.findings.push(finding('invalid-secret-migration-rollback-ref', `ref-${index + 1}`, 'rollback evidence contains an invalid secret ref'));
			continue;
		}
		if (parsed.tenantId !== tenantId) {
			meta.invalidRefCount += 1;
			meta.findings.push(finding('secret-migration-rollback-ref-tenant-mismatch', `ref-${index + 1}`, 'rollback evidence secret ref tenant must match workflow tenant'));
			continue;
		}
		validRefs.add(parsed.ref);
	}
	meta.validRefCount = validRefs.size;
	for (const [index, ref] of required.refs.entries()) {
		if (!validRefs.has(ref)) {
			meta.missingRequiredRefCount += 1;
			meta.findings.push(finding('missing-secret-migration-rollback-ref', `required-ref-${index + 1}`, 'rollback evidence does not cover a required secret ref'));
		}
	}
	meta.pathClassCount = uniqueStrings(evidence?.scope?.pathClasses || evidence?.pathClasses || []).length;

	const checkpoints = Array.isArray(evidence.checkpoints) ? evidence.checkpoints : [];
	meta.checkpointCount = checkpoints.length;
	if (checkpoints.length === 0 && required.requiredSecretRefCount > 0) {
		meta.findings.push(finding('missing-secret-migration-rollback-checkpoints', '', 'rollback evidence requires broker metadata checkpoints'));
	}
	for (const [index, checkpoint] of checkpoints.entries()) {
		const entry = `checkpoint-${index + 1}`;
		const parsed = parseSecretRef(checkpoint?.ref);
		if (!parsed) {
			meta.findings.push(finding('invalid-secret-migration-rollback-checkpoint-ref', entry, 'rollback checkpoint contains an invalid secret ref'));
			continue;
		}
		if (parsed.tenantId !== tenantId) {
			meta.findings.push(finding('secret-migration-rollback-checkpoint-tenant-mismatch', entry, 'rollback checkpoint tenant must match workflow tenant'));
		}
		if (!checkpoint.present) meta.findings.push(finding('secret-migration-rollback-checkpoint-missing', entry, 'rollback checkpoint must describe a present broker secret'));
		if (!checkpoint.usable) meta.findings.push(finding('secret-migration-rollback-checkpoint-unusable', entry, 'rollback checkpoint must describe a usable broker secret'));
		if (safeNumber(checkpoint.version) <= 0) meta.findings.push(finding('secret-migration-rollback-checkpoint-version-missing', entry, 'rollback checkpoint requires a broker version'));
		if (!checkpoint.keyIdPresent) meta.findings.push(finding('secret-migration-rollback-checkpoint-key-missing', entry, 'rollback checkpoint requires key metadata'));
		if (!checkpoint.rotationSupported) meta.findings.push(finding('secret-migration-rollback-checkpoint-rotation-unsupported', entry, 'rollback checkpoint requires rotation readiness'));
		if (!checkpoint.deleteSupported) meta.findings.push(finding('secret-migration-rollback-checkpoint-delete-unsupported', entry, 'rollback checkpoint requires deletion readiness'));
		if (checkpoint.present && checkpoint.usable && safeNumber(checkpoint.version) > 0 && checkpoint.keyIdPresent) meta.readyCheckpointCount += 1;
		if (checkpoint.rotationSupported) meta.rotationReadyCount += 1;
		if (checkpoint.deleteSupported) meta.deleteReadyCount += 1;
	}

	const rollbackPlan = evidence.rollbackPlan || {};
	meta.rollbackReady = rollbackPlan.canRollback === true;
	meta.plaintextDeletionDeferred = rollbackPlan.plaintextDeletionDeferred === true;
	if (rollbackPlan.canRollback !== true) meta.findings.push(finding('secret-migration-rollback-plan-not-ready', '', 'rollback plan must be ready before commit or rollback'));
	if (rollbackPlan.requiresOperator !== true) meta.findings.push(finding('secret-migration-rollback-requires-operator-missing', '', 'rollback evidence must preserve operator control'));
	if (rollbackPlan.plaintextDeletionDeferred !== true) meta.findings.push(finding('secret-migration-rollback-plaintext-delete-not-deferred', '', 'rollback evidence must defer plaintext deletion'));

	return finalizeRollbackEvidence(meta);
}

async function stageWorkflow({
	tenantId,
	workflow,
	currentState,
	action,
	planMeta,
	refScope,
	approvalManifest,
	secretStore,
	broker,
	env,
	dryRun,
}) {
	const approval = validateApproval(approvalManifest, {
		tenantId,
		requiredSecretRefs: refScope.refs,
		requireSecretRefs: planMeta.operationCount > 0 || refScope.requiredSecretRefCount > 0,
	});
	const brokerReadiness = validateBrokerReadiness(secretStore?.broker || broker, { env });
	const brokerScope = await describeRequiredSecretMetadata(secretStore, refScope.refs, { tenantId });
	const execution = await productionSecretMigrationExecutionContract({
		tenantId,
		secretStore,
		plan: planMeta.plan,
		approvalManifest,
		requiredSecretRefs: refScope.refs,
		dryRun,
		env,
	});
	const executionMeta = sanitizeExecutionContract(execution);
	const readinessBlocked = executionMeta.blocked
		? [finding('secret-migration-execution-readiness-blocked', '', 'secret migration execution readiness is blocked')]
		: [];
	const findings = uniqueFindings([
		...approval.findings,
		...brokerReadiness.findings,
		...brokerScope.findings,
		...executionMeta.findings,
		...readinessBlocked,
	]);
	return workflowEnvelope({
		tenantId,
		state: findings.length > 0 ? 'blocked' : 'staged',
		previousState: currentState,
		requestedAction: action,
		decision: findings.length > 0 ? blockedDecision(findings) : 'staged',
		requiresOperator: findings.length > 0,
		plan: planMeta.plan,
		scope: refScope,
		approvalManifest: approval,
		broker: mergeBrokerSummaries(executionMeta.broker, brokerReadiness.broker),
		brokerScope,
		readinessByClass: executionMeta.readinessByClass,
		executionContract: executionMeta,
		findings,
	});
}

function validateApproval(manifest, opts = {}) {
	return sanitizeApprovalManifest(validateSecretMigrationApprovalManifest(manifest, opts));
}

function validateBrokerReadiness(broker, opts = {}) {
	const validation = validateSecretBrokerAdapter(broker, { env: opts.env || process.env, requireProductionConnector: true });
	const connector = validation.connector || {};
	const findings = [];
	for (const error of validation.errors || []) {
		findings.push(finding('secret-migration-broker-contract-invalid', 'broker', error));
	}
	if (!validation.contractOk) findings.push(finding('secret-migration-broker-adapter-missing', 'broker', 'secret migration requires a broker adapter method contract'));
	if (!connector.kmsKeyConfigured) findings.push(finding('secret-migration-broker-kms-key-missing', 'broker', 'secret migration requires a configured KMS key id'));
	if (!connector.tenantScoped) findings.push(finding('secret-migration-broker-tenant-scope-missing', 'broker', 'secret migration requires tenant-scoped broker keys'));
	if (!connector.encryptedAtRest) findings.push(finding('secret-migration-broker-encryption-missing', 'broker', 'secret migration requires encrypted-at-rest broker storage'));
	if (!connector.rotationSupported) findings.push(finding('secret-migration-broker-rotation-unsupported', 'broker', 'secret migration requires broker rotation support'));
	if (!connector.deleteSupported) findings.push(finding('secret-migration-broker-delete-unsupported', 'broker', 'secret migration requires broker deletion support'));
	if (connector.testOnly) findings.push(finding('secret-migration-broker-test-only', 'broker', 'test broker capability is not accepted for production migration staging'));
	if (!connector.productionReady) findings.push(finding('secret-migration-broker-not-production-ready', 'broker', 'broker connector must declare production readiness'));
	if (connector.plaintextEnvCredentialsConfigured) findings.push(finding('secret-migration-broker-plaintext-env-credential', 'broker', 'broker configuration must not use plaintext env credential material'));
	return {
		ok: findings.length === 0,
		findings: uniqueFindings(findings),
		broker: {
			backend: broker ? 'external-broker' : '',
			configured: validation.ok,
			contractOk: validation.contractOk,
			provider: cleanText(connector.provider),
			connectorId: cleanText(connector.connectorId),
			kmsKeyConfigured: !!connector.kmsKeyConfigured,
			tenantScoped: !!connector.tenantScoped,
			encryptedAtRest: !!connector.encryptedAtRest,
			rotationSupported: !!connector.rotationSupported,
			deleteSupported: !!connector.deleteSupported,
			testOnly: !!connector.testOnly,
			productionReady: !!connector.productionReady,
			plaintextEnvCredentialsConfigured: !!connector.plaintextEnvCredentialsConfigured,
			plaintextEnvCredentialCount: safeNumber(connector.plaintextEnvCredentialNames?.length),
		},
	};
}

async function describeRequiredSecretMetadata(secretStore, refs = [], { tenantId }) {
	const summary = {
		requiredSecretRefCount: refs.length,
		describedSecretCount: 0,
		presentCount: 0,
		usableCount: 0,
		managedByBrokerCount: 0,
		rotationReadyCount: 0,
		deleteReadyCount: 0,
		versionedCount: 0,
		byKind: {},
		findings: [],
	};
	if (refs.length === 0) return summary;
	if (typeof secretStore?.describeSecret !== 'function') {
		summary.findings.push(finding('secret-migration-secret-store-required', 'broker', 'secret migration staging requires broker metadata access'));
		return summary;
	}
	for (const [index, ref] of refs.entries()) {
		const entry = `ref-${index + 1}`;
		const parsed = parseSecretRef(ref);
		if (!parsed) {
			summary.findings.push(finding('invalid-secret-migration-required-ref', entry, 'required secret ref is invalid'));
			continue;
		}
		if (parsed.tenantId !== tenantId) {
			summary.findings.push(finding('secret-migration-required-ref-tenant-mismatch', entry, 'required secret ref tenant must match workflow tenant'));
			continue;
		}
		increment(summary.byKind, parsed.kind);
		let meta;
		try {
			meta = await secretStore.describeSecret(parsed.ref);
		} catch {
			summary.findings.push(finding('secret-migration-secret-metadata-unreadable', entry, 'broker secret metadata could not be described'));
			continue;
		}
		summary.describedSecretCount += 1;
		if (meta?.tenantId && meta.tenantId !== tenantId) {
			summary.findings.push(finding('secret-migration-secret-metadata-tenant-mismatch', entry, 'broker secret metadata tenant must match workflow tenant'));
		}
		if (!meta?.present) summary.findings.push(finding('secret-migration-secret-metadata-missing', entry, 'broker secret metadata must be present'));
		if (!meta?.usable) summary.findings.push(finding('secret-migration-secret-metadata-unusable', entry, 'broker secret metadata must be usable'));
		if (!meta?.managedByBroker) summary.findings.push(finding('secret-migration-secret-not-managed-by-broker', entry, 'secret must be managed by the broker'));
		if (!meta?.rotationSupported) summary.findings.push(finding('secret-migration-secret-rotation-unsupported', entry, 'secret metadata must confirm rotation readiness'));
		if (!meta?.deleteSupported) summary.findings.push(finding('secret-migration-secret-delete-unsupported', entry, 'secret metadata must confirm deletion readiness'));
		if (safeNumber(meta?.version) <= 0) summary.findings.push(finding('secret-migration-secret-version-missing', entry, 'secret metadata must include a broker version'));
		if (meta?.present) summary.presentCount += 1;
		if (meta?.usable) summary.usableCount += 1;
		if (meta?.managedByBroker) summary.managedByBrokerCount += 1;
		if (meta?.rotationSupported) summary.rotationReadyCount += 1;
		if (meta?.deleteSupported) summary.deleteReadyCount += 1;
		if (safeNumber(meta?.version) > 0) summary.versionedCount += 1;
	}
	summary.findings = uniqueFindings(summary.findings);
	return summary;
}

function sanitizePlan(plan, { tenantId }) {
	const findings = [];
	if (!plan || typeof plan !== 'object') {
		return {
			operationCount: 0,
			plan: emptyPlan(tenantId),
			findings: [finding('missing-secret-migration-plan', '', 'secret migration workflow requires a sanitized migration plan')],
		};
	}
	const planTenant = cleanTenant(plan.tenantId);
	if (planTenant && planTenant !== tenantId) {
		findings.push(finding('secret-migration-plan-tenant-mismatch', '', 'secret migration plan tenant must match workflow tenant'));
	}
	if (plan.dryRun !== true) findings.push(finding('secret-migration-plan-not-dry-run', '', 'secret migration plan must be dry-run'));
	if (plan.secretContentsInspected === true || plan.readsSecretBytes === true || plan.migratesSecrets === true) {
		findings.push(finding('secret-migration-plan-inspects-secret-bytes', '', 'secret migration plan must not inspect secret bytes'));
	}
	const operations = (Array.isArray(plan.operations) ? plan.operations : []).map((op, index) => sanitizeOperation(op, index, findings));
	const sanitized = {
		planner: cleanText(plan.planner || 'webui-secret-migration-plan/v1'),
		tenantId,
		root: 'repository',
		dryRun: true,
		sanitized: true,
		secretContentsInspected: false,
		readsSecretBytes: false,
		writesSecretBytes: false,
		deletesPlaintext: false,
		migratesSecrets: false,
		operations,
		summary: summarizePlanOperations(operations),
	};
	return {
		operationCount: operations.length,
		plan: sanitized,
		findings,
	};
}

function sanitizeOperation(op = {}, index, findings) {
	if (op.readsSecretBytes === true || op.writesSecretBytes === true || op.deletesPlaintext === true) {
		findings.push(finding('secret-migration-operation-side-effect', `operation-${index + 1}`, 'secret migration operation must be metadata-only'));
	}
	return {
		kind: cleanToken(op.kind),
		source: cleanToken(op.source),
		pathClass: cleanText(op.pathClass),
		status: cleanToken(op.status),
		secureStatus: cleanToken(op.secureStatus),
		action: cleanToken(op.action),
		readyForRetirePlaintext: !!op.readyForRetirePlaintext,
		blocked: !!op.blocked,
		blockedReason: op.blocked ? 'operation-blocked' : '',
		readsSecretBytes: false,
		writesSecretBytes: false,
		deletesPlaintext: false,
	};
}

function summarizePlanOperations(operations = []) {
	const summary = {
		totalOperations: operations.length,
		readyForRetirePlaintext: 0,
		blockedOperations: 0,
		byKind: {},
		byPathClass: {},
		byStatus: {},
		bySecureStatus: {},
		byAction: {},
	};
	for (const op of operations) {
		if (op.readyForRetirePlaintext) summary.readyForRetirePlaintext += 1;
		if (op.blocked) summary.blockedOperations += 1;
		increment(summary.byKind, op.kind);
		increment(summary.byPathClass, op.pathClass);
		increment(summary.byStatus, op.status);
		increment(summary.bySecureStatus, op.secureStatus);
		increment(summary.byAction, op.action);
	}
	return summary;
}

function emptyPlan(tenantId) {
	return {
		planner: 'webui-secret-migration-plan/v1',
		tenantId,
		root: 'repository',
		dryRun: true,
		sanitized: true,
		secretContentsInspected: false,
		readsSecretBytes: false,
		writesSecretBytes: false,
		deletesPlaintext: false,
		migratesSecrets: false,
		operations: [],
		summary: summarizePlanOperations([]),
	};
}

function validateSecretRefScope(refs, { tenantId }) {
	const inputRefs = Array.isArray(refs) ? refs : [];
	const scope = {
		requiredSecretRefCount: inputRefs.length,
		validSecretRefCount: 0,
		invalidSecretRefCount: 0,
		tenantMismatchCount: 0,
		byKind: {},
		refs: [],
		findings: [],
	};
	const seen = new Set();
	for (const [index, ref] of inputRefs.entries()) {
		const parsed = parseSecretRef(ref);
		if (!parsed) {
			scope.invalidSecretRefCount += 1;
			scope.findings.push(finding('invalid-secret-migration-required-ref', `required-ref-${index + 1}`, 'required secret ref is invalid'));
			continue;
		}
		if (parsed.tenantId !== tenantId) {
			scope.tenantMismatchCount += 1;
			scope.findings.push(finding('secret-migration-required-ref-tenant-mismatch', `required-ref-${index + 1}`, 'required secret ref tenant must match workflow tenant'));
			continue;
		}
		if (seen.has(parsed.ref)) continue;
		seen.add(parsed.ref);
		scope.refs.push(parsed.ref);
		scope.validSecretRefCount += 1;
		increment(scope.byKind, parsed.kind);
	}
	return scope;
}

function sanitizeApprovalManifest(meta = {}) {
	return {
		present: !!meta.present,
		ok: !!meta.ok,
		kind: cleanText(meta.kind),
		status: cleanToken(meta.status),
		tenantId: cleanTenant(meta.tenantId) || null,
		approvalIdPresent: !!meta.approvalIdPresent,
		approvedByPresent: !!meta.approvedByPresent,
		approvedAtPresent: !!meta.approvedAtPresent,
		manifestHashPresent: !!meta.manifestHashPresent,
		refCount: safeNumber(meta.refCount),
		validRefCount: safeNumber(meta.validRefCount),
		invalidRefCount: safeNumber(meta.invalidRefCount),
		requiredRefCount: safeNumber(meta.requiredRefCount),
		missingRequiredRefCount: safeNumber(meta.missingRequiredRefCount),
		pathClassCount: safeNumber(meta.pathClassCount),
		findings: uniqueFindings(meta.findings || []),
	};
}

function sanitizeExecutionContract(contract = {}) {
	return {
		contract: cleanText(contract.contract),
		tenantId: cleanTenant(contract.tenantId) || null,
		dryRun: contract.dryRun !== false,
		failClosed: true,
		sanitized: true,
		secretContentsInspected: false,
		readsSecretBytes: false,
		writesSecretBytes: false,
		deletesPlaintext: false,
		migratesSecrets: false,
		sideEffects: false,
		decision: cleanToken(contract.decision),
		allowed: !!contract.allowed,
		blocked: !!contract.blocked,
		broker: sanitizeBroker(contract.broker || {}),
		approvalManifest: sanitizeApprovalManifest(contract.approvalManifest || {}),
		readinessByClass: sanitizeReadinessByClass(contract.readinessByClass || []),
		summary: sanitizeExecutionSummary(contract.summary || {}),
		findings: uniqueFindings(contract.findings || []),
	};
}

function sanitizeBroker(broker = {}) {
	return {
		backend: cleanToken(broker.backend),
		configured: !!broker.configured,
		contractOk: !!broker.contractOk,
		provider: cleanText(broker.provider),
		connectorId: cleanText(broker.connectorId),
		kmsKeyConfigured: !!broker.kmsKeyConfigured,
		tenantScoped: !!broker.tenantScoped,
		encryptedAtRest: !!broker.encryptedAtRest,
		rotationSupported: !!broker.rotationSupported,
		deleteSupported: !!broker.deleteSupported,
		testOnly: !!broker.testOnly,
		productionReady: !!broker.productionReady,
		plaintextEnvCredentialsConfigured: !!broker.plaintextEnvCredentialsConfigured,
		plaintextEnvCredentialCount: safeNumber(broker.plaintextEnvCredentialCount),
	};
}

function mergeBrokerSummaries(primary = {}, fallback = {}) {
	const merged = sanitizeBroker({ ...fallback, ...primary });
	if (!merged.backend && fallback.backend) merged.backend = cleanToken(fallback.backend);
	return merged;
}

function sanitizeReadinessByClass(readiness = []) {
	return (Array.isArray(readiness) ? readiness : []).map((entry) => ({
		kind: cleanToken(entry.kind),
		source: cleanToken(entry.source),
		pathClass: cleanText(entry.pathClass),
		total: safeNumber(entry.total),
		pendingMigration: safeNumber(entry.pendingMigration),
		withSecureCopy: safeNumber(entry.withSecureCopy),
		invalidName: safeNumber(entry.invalidName),
		blockedOperations: safeNumber(entry.blockedOperations),
		readyForRetirePlaintext: safeNumber(entry.readyForRetirePlaintext),
		operatorApprovalRequired: !!entry.operatorApprovalRequired,
		approvalRefsValidated: !!entry.approvalRefsValidated,
		rotationSupported: !!entry.rotationSupported,
		deleteSupported: !!entry.deleteSupported,
		dryRunOnly: true,
		ready: !!entry.ready,
		readiness: cleanToken(entry.readiness),
		blocked: !!entry.blocked,
		blockReasons: uniqueStrings((entry.blockReasons || []).map(cleanToken).filter(Boolean)),
		byStatus: sanitizeCounter(entry.byStatus),
		bySecureStatus: sanitizeCounter(entry.bySecureStatus),
		byAction: sanitizeCounter(entry.byAction),
	}));
}

function sanitizeExecutionSummary(summary = {}) {
	return {
		totalOperations: safeNumber(summary.totalOperations),
		totalClasses: safeNumber(summary.totalClasses),
		readyClasses: safeNumber(summary.readyClasses),
		blockedClasses: safeNumber(summary.blockedClasses),
		pendingMigration: safeNumber(summary.pendingMigration),
		withSecureCopy: safeNumber(summary.withSecureCopy),
		invalidName: safeNumber(summary.invalidName),
		findings: safeNumber(summary.findings),
		byReadiness: sanitizeCounter(summary.byReadiness),
		byPathClass: sanitizeCounter(summary.byPathClass, cleanText),
		byFinding: sanitizeCounter(summary.byFinding),
		secretContentsInspected: false,
		migratesSecrets: false,
		dryRunOnly: true,
	};
}

function sanitizeWorkflowScope(scope = {}) {
	return {
		requiredSecretRefCount: safeNumber(scope.requiredSecretRefCount),
		validSecretRefCount: safeNumber(scope.validSecretRefCount),
		invalidSecretRefCount: safeNumber(scope.invalidSecretRefCount),
		tenantMismatchCount: safeNumber(scope.tenantMismatchCount),
		byKind: sanitizeCounter(scope.byKind),
	};
}

function workflowEnvelope({
	tenantId,
	state,
	previousState = '',
	requestedAction = '',
	decision = '',
	requiresOperator = false,
	plan,
	scope,
	approvalManifest = null,
	rollbackEvidence = null,
	broker = null,
	brokerScope = null,
	readinessByClass = [],
	executionContract = null,
	findings = [],
}) {
	const cleanFindings = uniqueFindings(findings);
	const blocked = state === 'blocked' || cleanFindings.length > 0;
	const out = {
		workflow: WORKFLOW_CONTRACT,
		schemaVersion: WORKFLOW_VERSION,
		tenantId,
		state: normalizeState(state) || 'blocked',
		previousState: normalizeState(previousState) || '',
		requestedAction: normalizeAction(requestedAction) || cleanToken(requestedAction),
		decision: cleanToken(decision) || (blocked ? blockedDecision(cleanFindings) : state),
		allowed: !blocked && state !== 'planned',
		blocked,
		requiresOperator: !!requiresOperator || cleanFindings.some((item) => operatorRequiredReason(item.reason)) || state === 'planned',
		...METADATA_ONLY_FLAGS,
		plan: plan || emptyPlan(tenantId),
		scope: sanitizeWorkflowScope(scope),
		summary: summarizeWorkflow({
			state,
			findings: cleanFindings,
			plan,
			scope,
			brokerScope,
			readinessByClass,
		}),
		findings: cleanFindings,
	};
	if (approvalManifest) out.approvalManifest = sanitizeApprovalManifest(approvalManifest);
	if (rollbackEvidence) out.rollbackEvidence = sanitizeRollbackEvidenceMeta(rollbackEvidence);
	if (broker) out.broker = sanitizeBroker(broker);
	if (brokerScope) out.brokerScope = sanitizeBrokerScope(brokerScope);
	if (readinessByClass?.length) out.readinessByClass = sanitizeReadinessByClass(readinessByClass);
	if (executionContract) out.executionContract = sanitizeExecutionContract(executionContract);
	return out;
}

function blockedWorkflow({ tenantId, workflow, state, requestedAction, plan, scope, findings }) {
	const cleanFindings = uniqueFindings(findings);
	return workflowEnvelope({
		tenantId,
		state: 'blocked',
		previousState: normalizeState(state || workflow?.state) || '',
		requestedAction,
		decision: blockedDecision(cleanFindings),
		requiresOperator: cleanFindings.some((item) => operatorRequiredReason(item.reason)),
		plan,
		scope,
		approvalManifest: workflow?.approvalManifest,
		rollbackEvidence: workflow?.rollbackEvidence,
		broker: workflow?.broker,
		brokerScope: workflow?.brokerScope,
		readinessByClass: workflow?.readinessByClass,
		findings: cleanFindings,
	});
}

function summarizeWorkflow({ state, findings, plan, scope, brokerScope, readinessByClass }) {
	const byFinding = {};
	for (const item of findings || []) increment(byFinding, item.reason || 'blocked');
	return {
		state: normalizeState(state) || 'blocked',
		totalOperations: safeNumber(plan?.summary?.totalOperations || plan?.operations?.length),
		requiredSecretRefCount: safeNumber(scope?.requiredSecretRefCount),
		validSecretRefCount: safeNumber(scope?.validSecretRefCount),
		describedSecretCount: safeNumber(brokerScope?.describedSecretCount),
		presentSecretCount: safeNumber(brokerScope?.presentCount),
		readyClasses: (readinessByClass || []).filter((entry) => entry.ready).length,
		blockedClasses: (readinessByClass || []).filter((entry) => entry.blocked).length,
		findings: findings.length,
		byFinding,
		secretContentsInspected: false,
		sideEffects: false,
	};
}

function sanitizeBrokerScope(scope = {}) {
	return {
		requiredSecretRefCount: safeNumber(scope.requiredSecretRefCount),
		describedSecretCount: safeNumber(scope.describedSecretCount),
		presentCount: safeNumber(scope.presentCount),
		usableCount: safeNumber(scope.usableCount),
		managedByBrokerCount: safeNumber(scope.managedByBrokerCount),
		rotationReadyCount: safeNumber(scope.rotationReadyCount),
		deleteReadyCount: safeNumber(scope.deleteReadyCount),
		versionedCount: safeNumber(scope.versionedCount),
		byKind: sanitizeCounter(scope.byKind),
		findings: uniqueFindings(scope.findings || []),
	};
}

function sanitizeRollbackEvidenceMeta(meta = {}) {
	return {
		present: !!meta.present,
		ok: !!meta.ok,
		kind: cleanText(meta.kind),
		status: cleanToken(meta.status),
		tenantId: cleanTenant(meta.tenantId) || null,
		evidenceIdPresent: !!meta.evidenceIdPresent,
		capturedByPresent: !!meta.capturedByPresent,
		capturedAtPresent: !!meta.capturedAtPresent,
		evidenceHashPresent: !!meta.evidenceHashPresent,
		refCount: safeNumber(meta.refCount),
		validRefCount: safeNumber(meta.validRefCount),
		invalidRefCount: safeNumber(meta.invalidRefCount),
		requiredRefCount: safeNumber(meta.requiredRefCount),
		missingRequiredRefCount: safeNumber(meta.missingRequiredRefCount),
		pathClassCount: safeNumber(meta.pathClassCount),
		checkpointCount: safeNumber(meta.checkpointCount),
		readyCheckpointCount: safeNumber(meta.readyCheckpointCount),
		rotationReadyCount: safeNumber(meta.rotationReadyCount),
		deleteReadyCount: safeNumber(meta.deleteReadyCount),
		rollbackReady: !!meta.rollbackReady,
		plaintextDeletionDeferred: !!meta.plaintextDeletionDeferred,
		findings: uniqueFindings(meta.findings || []),
	};
}

function finalizeRollbackEvidence(meta) {
	meta.findings = uniqueFindings(meta.findings);
	meta.ok = meta.findings.length === 0;
	return sanitizeRollbackEvidenceMeta(meta);
}

function sanitizeRollbackCheckpoints(metadata = []) {
	return (Array.isArray(metadata) ? metadata : []).map((meta) => {
		const parsed = parseSecretRef(meta?.ref);
		return {
			ref: parsed?.ref || cleanText(meta?.ref),
			tenantId: parsed?.tenantId || cleanTenant(meta?.tenantId) || '',
			kind: parsed?.kind || cleanToken(meta?.kind),
			present: !!meta?.present,
			usable: meta?.usable !== false && !!meta?.present,
			managedByBroker: !!meta?.managedByBroker || !!meta?.externalBroker,
			version: safeNumber(meta?.version),
			keyIdPresent: !!cleanText(meta?.keyId),
			rotationSupported: !!meta?.rotationSupported,
			deleteSupported: !!meta?.deleteSupported,
		};
	});
}

function rollbackEvidenceSecretRefs(evidence = {}) {
	const scope = evidence?.scope && typeof evidence.scope === 'object' ? evidence.scope : {};
	const refs = Array.isArray(scope.secretRefs)
		? scope.secretRefs
		: Array.isArray(evidence.secretRefs)
			? evidence.secretRefs
			: Array.isArray(evidence.refs)
				? evidence.refs
				: [];
	return refs.map((ref) => String(ref || '').trim()).filter(Boolean);
}

function rollbackEvidenceHash(evidence = {}) {
	const copy = { ...evidence };
	delete copy.evidenceHash;
	return hashJson(copy);
}

function hashJson(value) {
	return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function blockedDecision(findings = []) {
	return findings.some((item) => operatorRequiredReason(item.reason)) ? 'requires-operator' : 'blocked';
}

function operatorRequiredReason(reason) {
	return /approval|operator|rollback-evidence|rollback-captured|rollback-plan/.test(String(reason || ''));
}

function finding(reason, entry = '', message = '') {
	return {
		reason: cleanToken(reason || 'blocked'),
		entry: cleanToken(entry),
		message: cleanText(message),
	};
}

function uniqueFindings(findings = []) {
	const seen = new Set();
	const out = [];
	for (const item of Array.isArray(findings) ? findings : []) {
		const clean = finding(item?.reason, item?.entry, item?.message);
		const key = `${clean.reason}\0${clean.entry}\0${clean.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(clean);
	}
	return out;
}

function uniqueStrings(values = []) {
	return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))].sort();
}

function increment(object, key) {
	const k = cleanToken(key || 'unknown') || 'unknown';
	object[k] = (object[k] || 0) + 1;
}

function sanitizeCounter(counter = {}, keyCleaner = cleanToken) {
	const out = {};
	for (const [key, value] of Object.entries(counter || {})) {
		const cleanKey = keyCleaner(key) || 'unknown';
		out[cleanKey] = safeNumber(value);
	}
	return out;
}

function normalizeAction(value) {
	const action = cleanToken(String(value || '').toLowerCase());
	if (action === 'approved') return 'approve';
	if (action === 'staged') return 'stage';
	if (action === 'committed') return 'commit';
	if (action === 'rolled_back') return 'rollback';
	return action;
}

function normalizeState(value) {
	const state = cleanToken(String(value || '').toLowerCase());
	return STATES.has(state) ? state : '';
}

function cleanTenant(value) {
	const s = String(value || '').trim();
	return TENANT_RE.test(s) ? s : '';
}

function cleanToken(value) {
	return String(value || '').trim().replace(SAFE_TOKEN_RE, '').slice(0, 120);
}

function cleanText(value) {
	return String(value || '').trim().replace(SAFE_TEXT_RE, '').slice(0, 240);
}

function safeNumber(value) {
	const n = Number(value || 0);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
