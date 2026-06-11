#!/usr/bin/env bash
# Browser-free unit tests for the external runner contract and audit outbox worker.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

(
	cd "$DIR"
	AQA_DB_PATH="$TMP/runner-contract.db" node - <<'NODE'
const runner = require('./lib/runner-contract.js');
const dbm = require('./lib/db.js');

const assert = (cond, msg) => { if (!cond) { console.error('  runner-contract-unit: ' + msg); process.exit(1); } };
const assertThrows = (fn, pattern, label) => {
	try { fn(); }
	catch (e) {
		assert(pattern.test((e && e.message) || String(e)), label);
		return;
	}
	assert(false, label);
};
const assertRejects = async (fn, pattern, label) => {
	try { await fn(); }
	catch (e) {
		assert(pattern.test((e && e.message) || String(e)), label);
		return;
	}
	assert(false, label);
};

(async () => {
const tokenRef = 'kms://tenant-a/runner';
const identity = runner.validateRunnerIdentity({
	WEBUI_RUNNER_MODE: 'production',
	WEBUI_RUNNER_ID: 'runner-a',
	WEBUI_RUNNER_TENANT_ID: 'tenant_a',
	WEBUI_RUNNER_DEPLOYMENT_ID: 'prod-a',
	WEBUI_RUNNER_TOKEN_REF: tokenRef,
});
assert(identity.mode === 'production' && identity.tenantBindingRequired, 'production identity is tenant-bound');
assert(identity.tokenRefConfigured && /^sha256:[0-9a-f]{64}$/.test(identity.tokenRefHash), 'identity stores only token-ref hash');
assert(!JSON.stringify(identity).includes(tokenRef), 'identity does not echo raw token ref');
assertThrows(
	() => runner.validateRunnerIdentity({ WEBUI_RUNNER_MODE: 'production', WEBUI_RUNNER_ID: 'runner-a', WEBUI_RUNNER_TENANT_ID: 'tenant_a', WEBUI_RUNNER_DEPLOYMENT_ID: 'prod-a' }),
	/TOKEN_REF/,
	'production identity requires token ref',
);
assertThrows(
	() => runner.validateRunnerIdentity({ WEBUI_RUNNER_MODE: 'production', WEBUI_RUNNER_ID: 'runner-a', WEBUI_RUNNER_TENANT_ID: 'tenant_a', WEBUI_RUNNER_DEPLOYMENT_ID: 'prod-a', WEBUI_RUNNER_TOKEN_REF: 'raw-token-ref' }),
	/supported secret reference/,
	'production identity requires a supported secret reference',
);
assertThrows(
	() => runner.validateRunnerIdentity({ WEBUI_RUNNER_ID: 'runner-a', WEBUI_RUNNER_TOKEN: 'plain-runner-token' }),
	/plaintext/,
	'identity rejects plaintext runner token env',
);
assertThrows(
	() => runner.validateRunnerTokenRef({ token: 'plain-runner-token' }, identity),
	/plaintext/,
	'request rejects plaintext runner token body',
);
assertThrows(
	() => runner.validateRunnerTokenRef({ tokenRef: 'kms://tenant-a/other-runner' }, identity),
	/mismatch/,
	'request token ref must match configured runner identity',
);
assert(runner.validateRunnerTokenRef({ tokenRef }, identity).ok, 'matching token ref validates');

const db = dbm.openDb();
try {
	dbm.saveWebuiJob(db, {
		id: 'job-a',
		tenantId: 'tenant_a',
		actorId: 'actor-a',
		kind: 'unit',
		label: 'runner contract job',
		status: 'queued',
		command: { schemaVersion: 1, runner: 'gitBash', script: 'run.sh', args: ['unit'] },
		resumable: true,
		maxAttempts: 2,
	});
	dbm.saveWebuiJob(db, {
		id: 'job-b',
		tenantId: 'tenant_a',
		actorId: 'actor-a',
		kind: 'unit',
		label: 'runner cancel job',
		status: 'queued',
		command: { schemaVersion: 1, runner: 'gitBash', script: 'run.sh', args: ['unit'] },
		resumable: true,
		maxAttempts: 1,
	});
	dbm.saveWebuiJob(db, {
		id: 'job-c',
		tenantId: 'tenant_a',
		actorId: 'actor-a',
		kind: 'unit',
		label: 'runner cancel cannot succeed',
		status: 'queued',
		command: { schemaVersion: 1, runner: 'gitBash', script: 'run.sh', args: ['unit'] },
		resumable: true,
		maxAttempts: 1,
	});
	const claim = runner.claimNextRunnerJob(db, { identity, tokenRef, now: 1000, leaseMs: 5000 });
	assert(claim.ok && claim.job.id === 'job-a' && claim.job.status === 'claimed', 'runner pull claims next resumable job');
	assert(claim.job.workerId === 'runner-a' && claim.job.workerTenantId === 'tenant_a' && claim.job.workerDeploymentId === 'prod-a', 'claim binds runner identity');
	const wrongIdentity = runner.validateRunnerIdentity({
		WEBUI_RUNNER_MODE: 'production',
		WEBUI_RUNNER_ID: 'runner-b',
		WEBUI_RUNNER_TENANT_ID: 'tenant_a',
		WEBUI_RUNNER_DEPLOYMENT_ID: 'prod-b',
		WEBUI_RUNNER_TOKEN_REF: 'kms://tenant-a/runner-b',
	});
	const wrongHeartbeat = runner.heartbeatRunnerJob(db, 'job-a', { identity: wrongIdentity, tokenRef: 'kms://tenant-a/runner-b', now: 1100 });
	assert(!wrongHeartbeat.ok, 'heartbeat refuses mismatched runner binding');
	const heartbeat = runner.heartbeatRunnerJob(db, 'job-a', { identity, tokenRef, now: 1200, leaseMs: 5000, pid: 1234, runId: 'run-a' });
	assert(heartbeat.ok && heartbeat.job.status === 'running' && heartbeat.job.pid === 1234, 'heartbeat advances claimed job to running');
	const cancelRunning = runner.cancelRunnerJob(db, 'job-a', { identity, tokenRef, now: 1300, reason: 'unit cancel' });
	assert(cancelRunning.ok && cancelRunning.job.status === 'canceling', 'runner cancel requests running job cancellation');
	const complete = runner.completeRunnerJob(db, 'job-a', { identity, tokenRef, now: 1400, status: 'canceled', exitCode: 0, result: { status: 'cancelled' } });
	assert(complete.ok && complete.job.status === 'canceled' && complete.job.cancelled, 'runner complete finalizes canceled job');
	const cancelQueued = runner.cancelRunnerJob(db, 'job-b', { identity, tokenRef, now: 1500, reason: 'queued cancel' });
	const cancelQueuedAgain = runner.cancelRunnerJob(db, 'job-b', { identity, tokenRef, now: 1501, reason: 'queued cancel duplicate' });
	assert(cancelQueued.ok && cancelQueued.terminal && cancelQueued.job.status === 'canceled', 'runner cancel can terminal queued job');
	assert(cancelQueuedAgain.ok && cancelQueuedAgain.changed === false, 'runner cancel is idempotent');
	const cancelClaim = runner.claimRunnerJob(db, 'job-c', { identity, tokenRef, now: 1510, leaseMs: 5000 });
	assert(cancelClaim.ok && cancelClaim.job.status === 'claimed', 'runner claim fixture for cancel terminal guard succeeds');
	const cancelClaimReq = runner.cancelRunnerJob(db, 'job-c', { identity, tokenRef, now: 1520, reason: 'cancel before success report' });
	assert(cancelClaimReq.ok && cancelClaimReq.job.status === 'canceling', 'claimed job cancel moves to canceling');
	const cancelCannotSucceed = runner.completeRunnerJob(db, 'job-c', { identity, tokenRef, now: 1530, status: 'succeeded', exitCode: 0, result: { status: 'ok' } });
	assert(cancelCannotSucceed.ok && cancelCannotSucceed.job.status === 'canceled', 'cancel-requested job cannot be completed as succeeded');

	const target = {
		host: 'audit.example.test',
		origin: 'https://audit.example.test',
		urlHash: 'sha256:' + '1'.repeat(64),
		credentialRefHash: 'sha256:' + '2'.repeat(64),
		credentialRefConfigured: true,
		connectorConfigured: true,
		url: 'https://audit.example.test/hook?token=raw-url-secret',
		tokenRef: 'kms://tenant-a/raw-ref-should-not-leak',
		authorization: 'Bearer should-not-leak',
	};
	dbm.saveWebuiAuditOutbox(db, {
		auditId: 1,
		at: '2030-01-01T00:00:00.000Z',
		tenantId: 'tenant_a',
		jobId: 'job-a',
		sinkMode: 'webhook',
		sinkId: 'webhook:success',
		status: 'pending',
		payloadHash: 'sha256:' + 'a'.repeat(64),
		payloadBytes: 42,
		target,
	});
	const connectorCalls = [];
	let delivery = await runner.deliverAuditOutboxBatch(db, {
		now: '2030-01-01T00:01:00.000Z',
		connector: {
			deliverAuditOutbox: async (envelope, context) => {
				connectorCalls.push({ envelope, context });
				return { ok: true, connectorId: 'fake' };
			},
		},
	});
	assert(delivery.ok && delivery.delivered === 1 && connectorCalls.length === 1, 'outbox worker delivers through connector interface');
	assert(connectorCalls[0].context.auditId === 1 && connectorCalls[0].context.tenantId === 'tenant_a', 'connector receives delivery context metadata');
	assert(connectorCalls[0].envelope.payload.hash === 'sha256:' + 'a'.repeat(64) && connectorCalls[0].envelope.payload.body === null, 'connector receives hash-only redacted payload');
	assert(connectorCalls[0].envelope.sink.target.host === 'audit.example.test' && connectorCalls[0].envelope.sink.target.origin === 'https://audit.example.test', 'connector receives safe webhook target metadata');
	assert(!JSON.stringify(connectorCalls).includes(tokenRef), 'connector envelope does not include runner token ref');
	for (const raw of ['raw-url-secret', 'raw-ref-should-not-leak', 'should-not-leak']) {
		assert(!JSON.stringify(connectorCalls).includes(raw), `connector envelope does not expose ${raw}`);
	}
	assert(dbm.listWebuiAuditOutbox(db, { auditId: 1 })[0].status === 'delivered', 'delivered outbox row is marked delivered');

	dbm.saveWebuiAuditOutbox(db, {
		auditId: 2,
		at: '2030-01-01T00:00:00.000Z',
		tenantId: 'tenant_a',
		jobId: 'job-a',
		sinkMode: 'webhook',
		sinkId: 'webhook:retry',
		status: 'pending',
		payloadHash: 'sha256:' + 'b'.repeat(64),
		payloadBytes: 24,
		target,
	});
	delivery = await runner.deliverAuditOutboxBatch(db, {
		now: '2030-01-01T00:02:00.000Z',
		baseDelayMs: 180000,
		maxAttempts: 3,
		connector: {
			deliverAuditOutbox: async () => {
				const err = new Error('upstream 503 token=raw-secret');
				err.statusCode = 503;
				throw err;
			},
		},
	});
	const retryRow = dbm.listWebuiAuditOutbox(db, { auditId: 2 })[0];
	assert(delivery.failed === 1 && retryRow.status === 'failed' && retryRow.lastErrorClass === 'server', 'retryable connector failure is classified as server failure');
	assert(retryRow.nextAttemptAt === '2030-01-01T00:05:00.000Z', 'retryable failure schedules deterministic backoff');
	assert(!String(retryRow.lastError).includes('raw-secret'), 'outbox failure error is redacted');

	dbm.saveWebuiAuditOutbox(db, {
		auditId: 3,
		at: '2030-01-01T00:00:00.000Z',
		tenantId: 'tenant_a',
		jobId: 'job-a',
		sinkMode: 'webhook',
		sinkId: 'webhook:auth',
		status: 'pending',
		payloadHash: 'sha256:' + 'c'.repeat(64),
		payloadBytes: 12,
		target,
	});
	delivery = await runner.deliverAuditOutboxBatch(db, {
		now: '2030-01-01T00:03:00.000Z',
		connector: {
			deliverAuditOutbox: async () => ({ ok: false, statusCode: 401, error: 'unauthorized' }),
		},
	});
	const authRow = dbm.listWebuiAuditOutbox(db, { auditId: 3 })[0];
	assert(!delivery.ok && delivery.deadLettered === 1 && authRow.status === 'dead-letter', 'non-retryable auth failure goes dead-letter');
	assert(authRow.lastErrorClass === 'auth' && authRow.deadLetterAt === '2030-01-01T00:03:00.000Z', 'dead-letter records failure classification and time');

	dbm.saveWebuiAuditOutbox(db, {
		auditId: 4,
		at: '2030-01-01T00:00:00.000Z',
		tenantId: 'tenant_a',
		jobId: 'job-a',
		sinkMode: 'webhook',
		sinkId: 'webhook:max-attempts',
		status: 'failed',
		attempts: 2,
		payloadHash: 'sha256:' + 'd'.repeat(64),
		payloadBytes: 10,
		target,
	});
	delivery = await runner.deliverAuditOutboxBatch(db, {
		now: '2030-01-01T00:04:00.000Z',
		maxAttempts: 3,
		connector: {
			deliverAuditOutbox: async () => {
				const err = new Error('still down');
				err.statusCode = 503;
				throw err;
			},
		},
	});
	const maxRow = dbm.listWebuiAuditOutbox(db, { auditId: 4 })[0];
	assert(!delivery.ok && maxRow.status === 'dead-letter' && maxRow.lastErrorClass === 'server', 'retryable failures dead-letter at max attempts');

	dbm.saveWebuiAuditOutbox(db, {
		auditId: 5,
		at: '2030-01-01T00:00:00.000Z',
		tenantId: 'tenant_a',
		jobId: 'job-a',
		sinkMode: 'webhook',
		sinkId: 'webhook:config-refusal',
		status: 'pending',
		payloadHash: 'sha256:' + 'e'.repeat(64),
		payloadBytes: 10,
		target,
	});
	const beforeRefusal = dbm.listWebuiAuditOutbox(db, { auditId: 5 })[0];
	await assertRejects(
		() => runner.deliverAuditOutboxBatch(db, {
			env: { WEBUI_AUDIT_OUTBOX_TOKEN: 'plain-worker-token' },
			now: '2030-01-01T00:05:00.000Z',
			connector: { deliverAuditOutbox: async () => ({ ok: true }) },
		}),
		/plaintext secret env/,
		'runner delivery path refuses plaintext audit outbox env before connector delivery',
	);
	const afterRefusal = dbm.listWebuiAuditOutbox(db, { auditId: 5 })[0];
	assert(afterRefusal.status === beforeRefusal.status && afterRefusal.attempts === beforeRefusal.attempts, 'runner delivery config refusal does not mutate outbox rows');

	const contract = runner.buildRunnerContract({ runner: identity });
	assert(contract.auditOutbox.statuses.includes('dead-letter'), 'public contract exposes dead-letter outbox status');
	assert(contract.auditOutbox.worker.failClosedWithoutConnector === true, 'public contract exposes fail-closed connector requirement');
	assert(contract.auditOutbox.worker.credentialRef === 'tenant-scoped-secret-ref' && contract.auditOutbox.worker.plaintextCredentialEnvAccepted === false, 'public contract exposes tenant-scoped audit webhook credential requirement');
	assert(contract.auditSinkDeployment.productionReady === false && contract.auditSinkDeployment.releaseBlockers.length >= 1, 'public contract keeps production audit delivery release-blocked by default');
} finally {
	dbm.closeDb(db);
}

console.log('  runner-contract-unit: all checks passed');
})().catch((e) => {
	console.error('  runner-contract-unit: ' + ((e && e.stack) || e));
	process.exit(1);
});
NODE
)
