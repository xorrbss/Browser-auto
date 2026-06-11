'use strict';

const crypto = require('node:crypto');
const dbm = require('./db.js');
const auditSink = require('./audit-sink.js');
const auditOutboxWorker = require('./audit-outbox-worker.js');

const TRUE_RE = /^(1|true|yes|on)$/i;
const PRODUCTION_MODE_RE = /^(prod|production|external)$/i;
const PLAINTEXT_TOKEN_RE = /^(bearer\s+|basic\s+|eyJ[A-Za-z0-9_-]*\.|sk-|ghp_|glpat-)/i;
const SECRET_REF_RE = /^(aqa-secret:|kms:\/\/|vault:\/\/|secret:\/\/|aws-secretsmanager:|azure-keyvault:\/\/|gcp-secretmanager:\/\/)/i;

function envBool(env, ...names) {
	return names.some((name) => TRUE_RE.test(String(env[name] || '').trim()));
}

function sha256(value) {
	return `sha256:${crypto.createHash('sha256').update(String(value || '')).digest('hex')}`;
}

function cleanRunnerIdentity(value, fallback, label) {
	let out = value != null ? String(value).trim() : '';
	if (!out) out = fallback;
	out = String(out || '').replace(/[^A-Za-z0-9_.@:-]+/g, '_').slice(0, 120);
	if (!out || out.includes('\0')) throw new Error(`${label}: invalid`);
	return out;
}

function optionalRunnerIdentity(value, label) {
	const out = value != null ? String(value).trim() : '';
	if (!out) return null;
	return cleanRunnerIdentity(out, '', label);
}

function cleanRunnerTokenRef(value) {
	const ref = String(value || '').trim();
	if (!ref) return '';
	if (ref.includes('\0') || ref.length > 512) throw new Error('runner token reference is invalid');
	if (PLAINTEXT_TOKEN_RE.test(ref)) {
		throw new Error('runner token must be referenced, not stored in plaintext env');
	}
	if (!SECRET_REF_RE.test(ref)) {
		throw new Error('runner token reference must use a supported secret reference');
	}
	return ref;
}

function plaintextRunnerTokenPresent(input = {}) {
	return !!(
		input.WEBUI_RUNNER_TOKEN
		|| input.AQA_RUNNER_TOKEN
		|| input.runnerToken
		|| input.token
		|| input.authorization
		|| input.Authorization
	);
}

function runnerTokenRefFrom(input = {}) {
	return input.WEBUI_RUNNER_TOKEN_REF
		|| input.AQA_RUNNER_TOKEN_REF
		|| input.runnerTokenRef
		|| input.tokenRef
		|| '';
}

function validateRunnerIdentity(input = process.env) {
	const env = input || {};
	const production = envBool(env, 'WEBUI_RUNNER_PRODUCTION', 'AQA_RUNNER_PRODUCTION')
		|| PRODUCTION_MODE_RE.test(String(env.WEBUI_RUNNER_MODE || env.AQA_RUNNER_MODE || env.mode || env.runnerMode || '').trim());
	const explicitTenantBinding = !!String(env.WEBUI_RUNNER_TENANT_ID || env.AQA_RUNNER_TENANT_ID || env.tenantId || '').trim();
	const runnerId = cleanRunnerIdentity(
		env.WEBUI_RUNNER_ID || env.AQA_RUNNER_ID || env.WEBUI_WORKER_ID || env.runnerId || env.id,
		`worker-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
		'runnerId',
	);
	const tenantSource = production
		? (env.WEBUI_RUNNER_TENANT_ID || env.AQA_RUNNER_TENANT_ID || env.tenantId)
		: (env.WEBUI_RUNNER_TENANT_ID || env.AQA_RUNNER_TENANT_ID || env.tenantId || env.WEBUI_TENANT_ID || env.AQA_TENANT_ID);
	const tenantId = cleanRunnerIdentity(tenantSource, production ? '' : 'local', 'runnerTenantId');
	const deploymentId = cleanRunnerIdentity(
		env.WEBUI_RUNNER_DEPLOYMENT_ID || env.AQA_RUNNER_DEPLOYMENT_ID || env.deploymentId,
		production ? '' : 'local',
		'runnerDeploymentId',
	);
	if (plaintextRunnerTokenPresent(env)) {
		throw new Error('runner token must be referenced, not stored in plaintext env');
	}
	const tokenRef = cleanRunnerTokenRef(runnerTokenRefFrom(env));
	if (production && !tokenRef) throw new Error('production runner requires WEBUI_RUNNER_TOKEN_REF');
	return {
		schemaVersion: 1,
		mode: production ? 'production' : 'local',
		runnerId,
		tenantId,
		deploymentId,
		tenantBound: !!tenantId,
		tenantBindingRequired: production || explicitTenantBinding,
		deploymentBound: !!deploymentId,
		tokenRefConfigured: !!tokenRef,
		tokenRefHash: tokenRef ? sha256(tokenRef) : null,
		plaintextToken: false,
		ok: true,
	};
}

function publicRunnerIdentity(identity) {
	const runner = identity || validateRunnerIdentity();
	return {
		schemaVersion: runner.schemaVersion || 1,
		mode: runner.mode,
		runnerId: runner.runnerId,
		tenantId: runner.tenantId,
		deploymentId: runner.deploymentId,
		tenantBound: !!runner.tenantBound,
		tenantBindingRequired: !!runner.tenantBindingRequired,
		deploymentBound: !!runner.deploymentBound,
		tokenRefConfigured: !!runner.tokenRefConfigured,
		tokenRefHash: runner.tokenRefHash || null,
		plaintextToken: false,
		ok: !!runner.ok,
	};
}

function validateRunnerTokenRef(request = {}, identity = validateRunnerIdentity()) {
	if (plaintextRunnerTokenPresent(request)) {
		throw new Error('runner token must be referenced, not stored in plaintext env');
	}
	const raw = cleanRunnerTokenRef(runnerTokenRefFrom(request));
	if (identity.tokenRefConfigured) {
		if (!raw) throw new Error('runner token reference required for this runner identity');
		const actual = sha256(raw);
		if (actual !== identity.tokenRefHash) {
			throw new Error('runner token reference mismatch');
		}
		return { ok: true, tokenRefConfigured: true, tokenRefHash: actual };
	}
	return raw
		? { ok: true, tokenRefConfigured: true, tokenRefHash: sha256(raw) }
		: { ok: true, tokenRefConfigured: false, tokenRefHash: null };
}

function runnerDbOptions(identity, request = {}) {
	const runner = identity || validateRunnerIdentity(request.env || process.env);
	validateRunnerTokenRef(request, runner);
	const tenantId = runner.tenantBindingRequired
		? runner.tenantId
		: optionalRunnerIdentity(request.tenantId || request.runnerTenantId || request.runner_tenant_id, 'tenantId');
	return {
		runnerId: runner.runnerId,
		tenantId,
		runnerTenantId: runner.tenantBindingRequired ? runner.tenantId : tenantId,
		runnerDeploymentId: runner.deploymentId || optionalRunnerIdentity(request.runnerDeploymentId || request.deploymentId, 'runnerDeploymentId'),
	};
}

function claimNextRunnerJob(db, options = {}) {
	const identity = options.identity || validateRunnerIdentity(options.env || process.env);
	const binding = runnerDbOptions(identity, options);
	const job = dbm.claimNextWebuiJob(db, {
		...binding,
		now: options.now,
		leaseMs: options.leaseMs,
		requireResumable: options.requireResumable !== false,
		kinds: options.kinds,
	});
	return { ok: !!job, empty: !job, op: 'pull', job, runner: publicRunnerIdentity(identity) };
}

function claimRunnerJob(db, jobId, options = {}) {
	const identity = options.identity || validateRunnerIdentity(options.env || process.env);
	const binding = runnerDbOptions(identity, options);
	const job = dbm.claimWebuiJob(db, jobId, {
		...binding,
		now: options.now,
		leaseMs: options.leaseMs,
		requireResumable: options.requireResumable !== false,
	});
	return { ok: !!job, op: 'claim', job, runner: publicRunnerIdentity(identity) };
}

function heartbeatRunnerJob(db, jobId, options = {}) {
	const identity = options.identity || validateRunnerIdentity(options.env || process.env);
	const binding = runnerDbOptions(identity, options);
	const job = dbm.heartbeatWebuiJob(db, jobId, {
		...binding,
		now: options.now,
		leaseMs: options.leaseMs,
		status: options.status || 'running',
		pid: options.pid,
		runId: options.runId,
	});
	return { ok: !!job, op: 'heartbeat', job, cancelRequested: !!job?.cancelRequested, runner: publicRunnerIdentity(identity) };
}

function completeRunnerJob(db, jobId, options = {}) {
	const identity = options.identity || validateRunnerIdentity(options.env || process.env);
	const binding = runnerDbOptions(identity, options);
	const current = dbm.getWebuiJob(db, jobId, binding.tenantId ? { tenantId: binding.tenantId } : {});
	const cancelRequested = !!current && (current.status === 'canceling' || current.cancelled);
	const terminalStatus = cancelRequested ? 'canceled' : options.status;
	const job = dbm.completeWebuiJob(db, jobId, {
		...binding,
		now: options.now,
		status: terminalStatus,
		exitCode: options.exitCode,
		result: options.result,
		log: options.log,
		runId: options.runId,
		exitSignal: options.exitSignal,
		error: options.error,
		failureReason: cancelRequested && !options.failureReason ? 'runner cancel requested' : options.failureReason,
		timedOut: options.timedOut,
	});
	return { ok: !!job, op: 'complete', job, runner: publicRunnerIdentity(identity) };
}

function cancelRunnerJob(db, jobId, options = {}) {
	const identity = options.identity || validateRunnerIdentity(options.env || process.env);
	const binding = runnerDbOptions(identity, options);
	const req = dbm.requestWebuiJobCancel(db, jobId, {
		tenantId: binding.tenantId,
		now: options.now,
		reason: options.reason || 'runner cancel requested',
	});
	return { ...req, op: 'cancel', runner: publicRunnerIdentity(identity) };
}

async function deliverAuditOutboxBatch(db, options = {}) {
	return auditOutboxWorker.drainAuditOutbox(db, options);
}

function createAuditOutboxDeliveryWorker(options = {}) {
	return auditOutboxWorker.createAuditOutboxDrainWorker(options);
}

function buildRunnerContract({
	env = process.env,
	runner,
	workerId,
	leaseMs = 60000,
	heartbeatIntervalMs = 5000,
	heartbeatStaleMs = 60000,
	auditSinkPublicConfig = auditSink.auditSinkPublicConfig,
	auditSinkDeploymentReadiness = auditSink.auditSinkDeploymentReadiness,
	redactError = (e) => String((e && e.message) || e || ''),
} = {}) {
	const identity = runner || validateRunnerIdentity(env);
	let sink;
	try { sink = auditSinkPublicConfig(env); }
	catch (e) { sink = { enabled: false, mode: 'invalid', error: redactError(e) }; }
	let sinkDeployment;
	try { sinkDeployment = auditSinkDeploymentReadiness(env, { production: true }); }
	catch (e) {
		sinkDeployment = {
			schemaVersion: 1,
			ok: false,
			productionReady: false,
			mode: 'invalid',
			releaseBlockers: ['audit sink deployment readiness could not be evaluated'],
			error: redactError(e),
		};
	}
	return {
		schemaVersion: 1,
		workerId: workerId || identity.runnerId,
		runner: publicRunnerIdentity(identity),
		preflight: {
			ok: identity.ok,
			checks: ['runner-id', 'tenant-binding', 'deployment-binding', 'token-reference'],
			failClosed: true,
			tokenReferenceValidation: identity.tokenRefConfigured ? 'required-and-hash-matched' : 'plaintext-refused',
		},
		leaseMs,
		heartbeatIntervalMs,
		heartbeatStaleMs,
		claim: {
			pull: 'claimNextWebuiJob',
			claim: 'claimWebuiJob',
			heartbeat: 'heartbeatWebuiJob',
			complete: 'completeWebuiJob',
			states: ['queued', 'claimed', 'running', 'canceling', 'canceled', 'succeeded', 'failed', 'interrupted', 'expired'],
			requireResumableDefault: true,
		},
		cancel: {
			queued: 'canceled',
			claimed: 'canceling',
			running: 'canceling',
			idempotent: true,
		},
		reconcile: {
			retryStaleResumable: true,
			terminalUnknown: 'interrupted',
		},
		auditSink: sink,
		auditSinkDeployment: sinkDeployment,
		auditOutbox: {
			table: 'webui_audit_outbox',
			statuses: ['pending', 'delivered', 'failed', 'dead-letter'],
			payload: 'hash-only',
			worker: {
				connectorInterface: 'deliverAuditOutbox(envelope)',
				connectorContext: ['auditId', 'outboxId', 'sinkId', 'tenantId', 'now'],
				envelope: 'metadata-only-target-and-redacted-payload',
				credentialRef: 'tenant-scoped-secret-ref',
				plaintextCredentialEnvAccepted: false,
				failClosedWithoutConnector: true,
				retry: 'exponential-backoff',
				failureClassification: ['connector-missing', 'auth', 'throttle', 'server', 'client', 'network', 'timeout', 'unknown'],
			},
		},
	};
}

module.exports = {
	validateRunnerIdentity,
	validateRunnerDeployment: validateRunnerIdentity,
	validateRunnerTokenRef,
	cleanRunnerTokenRef,
	publicRunnerIdentity,
	buildRunnerContract,
	claimNextRunnerJob,
	claimRunnerJob,
	heartbeatRunnerJob,
	completeRunnerJob,
	cancelRunnerJob,
	deliverAuditOutboxBatch,
	createAuditOutboxDeliveryWorker,
};
