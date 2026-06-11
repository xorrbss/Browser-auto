#!/usr/bin/env bash
# Browser-free durable queue/audit tests for webui/jobs.js.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

(
	cd "$DIR"
	AQA_DB_PATH="$TMP/jobs.db" WEBUI_JOB_JOURNAL="$TMP/jobs.jsonl" NODE_NO_WARNINGS=1 node --input-type=module - <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

process.env.WEBUI_JOB_TIMEOUT_MS = '2500';
process.env.WEBUI_JOB_KILL_GRACE_MS = '100';
process.env.WEBUI_JOB_HEARTBEAT_STALE_MS = '1000';
process.env.WEBUI_JOB_LEASE_MS = '1200';
process.env.WEBUI_JOB_HEARTBEAT_INTERVAL_MS = '100';
process.env.WEBUI_JOB_SLOW_MS = '2000';
process.env.WEBUI_REQUIRE_DURABLE_JOBS = '1';
process.env.WEBUI_AUDIT_SINK = 'jsonl';
process.env.WEBUI_AUDIT_SINK_PATH = path.join(path.dirname(process.env.AQA_DB_PATH), 'audit-sink.jsonl');

const require = createRequire(import.meta.url);
const dbm = require('./lib/db.js');
const auditSink = require('./lib/audit-sink.js');
const { enqueue, cancel, stop, jobStatus, jobResult, queueState, runnerContract, validateRunnerDeployment } = await import('./webui/jobs.js');

const assert = (cond, msg) => { if (!cond) { console.error('  jobs-durable-unit: ' + msg); process.exit(1); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function longChild(ms = 3000) {
	return spawn(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`], {
		detached: process.platform !== 'win32',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

async function waitUntil(id, pred, label) {
	for (let i = 0; i < 100; i++) {
		const s = jobStatus(id);
		if (s && pred(s)) return s;
		await sleep(30);
	}
	throw new Error(`timeout waiting for ${id} ${label}`);
}

async function waitDone(id) {
	return waitUntil(id, (s) => ['done', 'failed', 'cancelled'].includes(s.status), 'terminal');
}

function dbRead(fn) {
	const db = dbm.openDb();
	try { return fn(db); }
	finally { dbm.closeDb(db); }
}

const dbJob = (id) => dbRead((db) => dbm.getWebuiJob(db, id));
const auditFor = (id) => dbRead((db) => dbm.listWebuiJobAudit(db, { jobId: id, limit: 50 }));
const auditChain = () => dbRead((db) => dbm.verifyWebuiJobAuditChain(db));
const outboxFor = (opts) => dbRead((db) => dbm.listWebuiAuditOutbox(db, opts));
const artifactsFor = (opts) => dbRead((db) => dbm.listWebuiArtifacts(db, opts));
const sha256 = (filePath) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
const assertThrows = (fn, pattern, label) => {
	try { fn(); }
	catch (e) {
		assert(pattern.test((e && e.message) || String(e)), label);
		return;
	}
	assert(false, label);
};
assert(auditSink.validateAuditSinkConfig().mode === 'jsonl', 'audit sink jsonl config validates');
assert(auditSink.auditSinkPublicConfig().pathConfigured === true, 'audit sink public config hides raw path');
assertThrows(
	() => auditSink.validateAuditSinkConfig({ WEBUI_AUDIT_SINK: 'webhook', WEBUI_AUDIT_SINK_URL: 'http://audit.example.test/hook', WEBUI_AUDIT_SINK_TOKEN_REF: 'ref' }),
	/https/,
	'audit webhook sink requires https',
);
assertThrows(
	() => auditSink.validateAuditSinkConfig({ WEBUI_AUDIT_SINK: 'webhook', WEBUI_AUDIT_SINK_URL: 'https://audit.example.test/hook', WEBUI_AUDIT_SINK_TOKEN: 'plain-secret' }),
	/TOKEN_REF|plaintext/,
	'audit webhook sink refuses plaintext token env',
);
assertThrows(
	() => auditSink.writeAuditSinkEvent({ event: 'fixture' }, { WEBUI_AUDIT_SINK: 'webhook', WEBUI_AUDIT_SINK_URL: 'https://audit.example.test/hook', WEBUI_AUDIT_SINK_TOKEN_REF: 'kms://tenant-a/audit' }),
	/production connector/,
	'audit webhook sink stays fail-closed without connector',
);
assertThrows(
	() => validateRunnerDeployment({ WEBUI_RUNNER_ID: 'runner-a', WEBUI_RUNNER_TOKEN: 'plain-runner-token' }),
	/plaintext/,
	'runner preflight refuses plaintext runner token env',
);
assertThrows(
	() => validateRunnerDeployment({ WEBUI_RUNNER_MODE: 'production', WEBUI_RUNNER_ID: 'runner-a', WEBUI_RUNNER_TENANT_ID: 'tenant_a', WEBUI_RUNNER_DEPLOYMENT_ID: 'prod-a' }),
	/TOKEN_REF/,
	'production runner preflight requires token ref',
);
const productionRunner = validateRunnerDeployment({
	WEBUI_RUNNER_MODE: 'production',
	WEBUI_RUNNER_ID: 'runner-a',
	WEBUI_RUNNER_TENANT_ID: 'tenant_a',
	WEBUI_RUNNER_DEPLOYMENT_ID: 'prod-a',
	WEBUI_RUNNER_TOKEN_REF: 'kms://tenant-a/runner',
});
assert(productionRunner.mode === 'production' && productionRunner.tenantId === 'tenant_a' && productionRunner.deploymentId === 'prod-a', 'production runner preflight validates identity binding');
assert(productionRunner.tokenRefConfigured === true && !JSON.stringify(productionRunner).includes('kms://tenant-a/runner'), 'runner preflight reports token ref presence without echoing ref');
const contract = runnerContract();
assert(contract.claim.pull === 'claimNextWebuiJob' && contract.cancel.idempotent === true, 'runner contract exposes pull/cancel semantics');
assert(contract.auditSink.mode === 'jsonl' && contract.auditSink.pathConfigured === true, 'runner contract reports redacted audit sink status');
assert(contract.runner.tenantBound === true && contract.runner.deploymentBound === true && contract.preflight.failClosed === true, 'runner contract exposes identity preflight');
assert(contract.auditOutbox.table === 'webui_audit_outbox' && contract.auditOutbox.payload === 'hash-only', 'runner contract exposes audit outbox contract');

const originalAuditEnv = {
	WEBUI_AUDIT_SINK: process.env.WEBUI_AUDIT_SINK,
	WEBUI_AUDIT_SINK_PATH: process.env.WEBUI_AUDIT_SINK_PATH,
	WEBUI_AUDIT_SINK_URL: process.env.WEBUI_AUDIT_SINK_URL,
	WEBUI_AUDIT_SINK_TOKEN_REF: process.env.WEBUI_AUDIT_SINK_TOKEN_REF,
	WEBUI_AUDIT_SINK_TOKEN: process.env.WEBUI_AUDIT_SINK_TOKEN,
	WEBUI_AUDIT_SINK_CONNECTOR: process.env.WEBUI_AUDIT_SINK_CONNECTOR,
	WEBUI_AUDIT_SINK_TENANT_ID: process.env.WEBUI_AUDIT_SINK_TENANT_ID,
};
process.env.WEBUI_AUDIT_SINK = 'webhook';
delete process.env.WEBUI_AUDIT_SINK_PATH;
process.env.WEBUI_AUDIT_SINK_TENANT_ID = 'tenant-a';
process.env.WEBUI_AUDIT_SINK_URL = 'https://audit.example.test/hook';
process.env.WEBUI_AUDIT_SINK_TOKEN_REF = 'kms://tenant-a/audit';
delete process.env.WEBUI_AUDIT_SINK_TOKEN;
delete process.env.WEBUI_AUDIT_SINK_CONNECTOR;
assertThrows(
	() => dbRead((db) => dbm.appendWebuiJobAudit(db, {
		tenantId: 'tenant_a',
		actorId: 'actor-a',
		jobId: 'webhook-outbox-fixture',
		kind: 'unit',
		event: 'enqueue',
		status: 'queued',
		data: { secret: 'should-redact', token: 'raw-token-value' },
	})),
	/production connector/,
	'webhook audit append refuses delivery without connector',
);
const pendingOutbox = outboxFor({ tenantId: 'tenant_a', jobId: 'webhook-outbox-fixture', status: 'pending' });
assert(pendingOutbox.length === 1, 'webhook audit append persists pending outbox metadata');
assert(pendingOutbox[0].target.host === 'audit.example.test' && pendingOutbox[0].target.credentialRefConfigured === true, 'outbox stores redacted webhook target metadata');
assert(/^sha256:[0-9a-f]{64}$/.test(pendingOutbox[0].payloadHash) && pendingOutbox[0].payloadBytes > 0, 'outbox stores deterministic payload hash/size');
assert(!JSON.stringify(pendingOutbox).includes('kms://tenant-a/audit') && !JSON.stringify(pendingOutbox).includes('raw-token-value'), 'outbox does not store plaintext token refs or secrets');
for (const [key, value] of Object.entries(originalAuditEnv)) {
	if (value == null) delete process.env[key];
	else process.env[key] = value;
}

let strictSpawned = false;
process.env.WEBUI_AUDIT_SINK = 'webhook';
delete process.env.WEBUI_AUDIT_SINK_PATH;
process.env.WEBUI_AUDIT_SINK_TENANT_ID = 'tenant-a';
process.env.WEBUI_AUDIT_SINK_URL = 'https://audit.example.test/hook';
process.env.WEBUI_AUDIT_SINK_TOKEN_REF = 'kms://tenant-a/audit';
delete process.env.WEBUI_AUDIT_SINK_TOKEN;
delete process.env.WEBUI_AUDIT_SINK_CONNECTOR;
assertThrows(
	() => enqueue({
		kind: 'unit',
		label: 'strict audit refused',
		spawnFn: () => {
			strictSpawned = true;
			return longChild();
		},
	}),
	/durable job audit append failed.*fail-closed/,
	'strict durable mode rejects enqueue when required audit append fails',
);
assert(strictSpawned === false, 'strict audit failure does not spawn a child');
const refusedRows = dbRead((db) => dbm.listWebuiJobs(db, { limit: 20 })).filter((j) => j.label === 'strict audit refused');
assert(refusedRows.length === 1 && refusedRows[0].status === 'interrupted', 'strict audit enqueue failure stores a safe interrupted state');
assert(!queueState().pending.some((j) => j.label === 'strict audit refused'), 'strict audit enqueue failure is not left pending in memory');
for (const [key, value] of Object.entries(originalAuditEnv)) {
	if (value == null) delete process.env[key];
	else process.env[key] = value;
}

const badDbPath = path.join(path.dirname(process.env.AQA_DB_PATH), 'db-dir');
fs.mkdirSync(badDbPath, { recursive: true });
const badDbProbe = spawnSync(process.execPath, ['--input-type=module', '-e', `await import('./webui/jobs.js')`], {
	cwd: process.cwd(),
	env: { ...process.env, AQA_DB_PATH: badDbPath, WEBUI_REQUIRE_DURABLE_JOBS: '1', NODE_NO_WARNINGS: '1' },
	encoding: 'utf8',
});
assert(badDbProbe.status !== 0, 'strict durable mode refuses startup when the DB cannot open');
assert(/durable job startup readback failed/.test(badDbProbe.stderr), 'strict durable startup failure is explicit');

const cleanupArtifactDirs = [];
process.on('exit', () => {
	for (const dir of cleanupArtifactDirs) {
		try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
	}
});
const tenantACtx = {
	tenantId: 'tenant_a',
	tenant: { id: 'tenant_a' },
	actor: { id: 'creator_a', role: 'operator', tenantId: 'tenant_a' },
	sessionId: 'sess-a',
	route: '/api/systems/sys1/sync',
};
const tenantBCtx = { tenantId: 'tenant_b', tenant: { id: 'tenant_b' }, actor: { id: 'creator_b', role: 'operator', tenantId: 'tenant_b' } };
const cancelACtx = { tenantId: 'tenant_a', tenant: { id: 'tenant_a' }, actor: { id: 'canceller_a', role: 'operator', tenantId: 'tenant_a' }, sessionId: 'sess-cancel' };

let running = enqueue({
	kind: 'unit',
	label: 'durable-running',
	spawnFn: () => longChild(),
});
let queued = enqueue({
	kind: 'unit',
	label: 'durable-queued',
	spawnFn: () => spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['ignore', 'pipe', 'pipe'] }),
});
await waitUntil(running.id, (s) => s.status === 'running' && s.pid, 'running');
assert(dbJob(running.id).status === 'running', 'running job state persisted');
assert(/^worker-/.test(dbJob(running.id).workerId || ''), 'running job records claiming worker id');
assert(auditFor(running.id).some((e) => e.event === 'claim' && e.status === 'claimed' && /^worker-/.test(e.data?.workerId || '')), 'claim audit records worker id');
assert(dbJob(queued.id).status === 'queued', 'queued job state persisted');
assert(queueState().pending.some((j) => j.id === queued.id), 'queued job remains visible in queue state');

assert(cancel(queued.id), 'queued cancel succeeds');
assert(cancel(queued.id), 'duplicate queued cancel is idempotent');
await waitDone(queued.id);
assert(dbJob(queued.id).status === 'canceled', 'queued cancel persisted as canceled');
assert(auditFor(queued.id).filter((e) => e.event === 'cancel').length === 1, 'duplicate queued cancel writes one audit event');

assert(cancel(running.id), 'running cancel succeeds');
assert(cancel(running.id), 'duplicate running cancel is idempotent');
await waitDone(running.id);
assert(jobResult(running.id).status === 'cancelled', 'running cancel surfaces cancelled');
assert(dbJob(running.id).status === 'canceled', 'running cancel persisted as canceled');
assert(auditFor(running.id).filter((e) => e.event === 'cancel').length === 1, 'duplicate running cancel writes one audit event');

const failed = enqueue({
	kind: 'unit',
	label: 'durable-fail',
	spawnFn: () => spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: ['ignore', 'pipe', 'pipe'] }),
});
await waitDone(failed.id);
assert(jobResult(failed.id).status === 'failed', 'failed child process surfaces failed');
assert(dbJob(failed.id).status === 'failed' && dbJob(failed.id).exitCode === 7, 'failed child process persists failure');
assert(auditFor(failed.id).some((e) => e.event === 'fail' && e.status === 'failed'), 'failed child process writes fail audit');
const failedAuditCount = auditFor(failed.id).length;
assert(cancel(failed.id), 'cancel after failed terminal job is idempotent');
assert(dbJob(failed.id).status === 'failed' && dbJob(failed.id).exitCode === 7, 'terminal cancel does not rewrite failed status');
assert(auditFor(failed.id).length === failedAuditCount, 'terminal cancel does not append duplicate audit');

const redacted = enqueue({
	kind: 'unit',
	label: 'redact password=hunter2 token=tok_123',
	spawnFn: () => spawn(process.execPath, ['-e', 'console.log("AQA_JOB_RESULT=" + JSON.stringify({status:"failed", error:"password=hunter2 token=abc123", nested:{apiKey:"secret-value"}})); process.exit(9)'], { stdio: ['ignore', 'pipe', 'pipe'] }),
});
await waitDone(redacted.id);
const redactedRowText = JSON.stringify(dbJob(redacted.id));
const redactedAuditText = JSON.stringify(auditFor(redacted.id));
assert(!/hunter2|abc123|secret-value|tok_123/.test(redactedRowText), 'durable job result/label is redacted');
assert(!/hunter2|abc123|secret-value|tok_123/.test(redactedAuditText), 'audit result/label is redacted');
assert(auditFor(redacted.id).some((e) => e.event === 'fail' && e.result?.error === 'password=[redacted] token=[redacted]'), 'redacted fail audit stores sanitized result');

const artifactRunId = `20991231-235959-${Date.now()}`;
const artifactDir = path.join(process.cwd(), 'artifacts', artifactRunId);
cleanupArtifactDirs.push(artifactDir);
fs.mkdirSync(artifactDir, { recursive: true });
const reportPath = path.join(artifactDir, 'report.json');
const junitPath = path.join(artifactDir, 'report.junit.xml');
const resultsPath = path.join(artifactDir, 'results.tsv');
fs.writeFileSync(reportPath, JSON.stringify({ status: 'ok', runId: artifactRunId }) + '\n');
fs.writeFileSync(junitPath, `<testsuite name="fixture" tests="1"></testsuite>\n`);
fs.writeFileSync(resultsPath, `name\tstatus\nfixture\tok\n`);
const artifactJob = enqueue({
	kind: 'run',
	label: 'artifact hash fixture',
	context: tenantACtx,
	meta: { system: 'sys1', retention: 'short-lived', deleteAfter: Date.now() + 3600000 },
	spawnFn: () => spawn(process.execPath, ['-e', `console.log("[run] RUN_ID=${artifactRunId} tests=1")`], { stdio: ['ignore', 'pipe', 'pipe'] }),
});
await waitDone(artifactJob.id);
assert(dbJob(artifactJob.id).retention === 'short-lived' && dbJob(artifactJob.id).deleteAfter, 'run job retention/delete metadata is persisted');
const artifacts = artifactsFor({ jobId: artifactJob.id, runId: artifactRunId });
assert(artifacts.length === 3, 'run job records report/junit/results artifact metadata');
const reportArtifact = artifacts.find((a) => a.path === `artifacts/${artifactRunId}/report.json`);
assert(reportArtifact?.sha256 === sha256(reportPath), 'artifact metadata records report sha256');
assert(reportArtifact.retention === 'short-lived' && reportArtifact.deleteAfter, 'artifact metadata inherits retention/delete policy');

const scoped = enqueue({
	kind: 'unit',
	label: 'tenant scoped command job',
	context: tenantACtx,
	meta: { system: 'sys1', action: 'sync', riskClass: 'read', retention: 'tenant-debug' },
	commandSpec: { runner: 'gitBash', script: 'run.sh', args: ['tenant_unit'] },
	spawnFn: () => spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: ['ignore', 'pipe', 'pipe'] }),
});
await waitDone(scoped.id);
const scopedRow = dbJob(scoped.id);
assert(scopedRow.tenantId === 'tenant_a' && scopedRow.actorId === 'creator_a', 'enqueue persists request tenant/actor');
assert(scopedRow.actorRole === 'operator' && scopedRow.sessionId === 'sess-a' && scopedRow.route === '/api/systems/sys1/sync', 'job record persists role/session/route metadata');
assert(scopedRow.resumable === true && scopedRow.command?.runner === 'gitBash', 'safe command spec is persisted as resumable');
assert(scopedRow.retention === 'tenant-debug', 'job retention metadata is persisted');
const scopedAudit = auditFor(scoped.id).find((e) => e.event === 'enqueue');
assert(scopedAudit?.actorRole === 'operator' && scopedAudit.sessionId === 'sess-a' && scopedAudit.route === '/api/systems/sys1/sync', 'audit persists actor role/session/route metadata');
assert(scopedAudit?.command?.runner === 'gitBash' && scopedAudit.system === 'sys1' && scopedAudit.redaction === 'applied', 'audit persists command/system/redaction metadata');
assert(/^sha256:[0-9a-f]{64}$/.test(scopedAudit?.data?.commandHash || ''), 'audit records a command hash');
assert(jobStatus(scoped.id, tenantBCtx) === null, 'tenant B cannot read tenant A job status');
assert(jobResult(scoped.id, tenantBCtx) === null, 'tenant B cannot read tenant A job result');
assert(queueState(tenantBCtx).recent.every((j) => j.tenantId !== 'tenant_a'), 'tenant B queue state excludes tenant A jobs');

const scopedRunning = enqueue({
	kind: 'unit',
	label: 'tenant scoped cancel job',
	context: tenantACtx,
	spawnFn: () => longChild(),
});
await waitUntil(scopedRunning.id, (s) => s.status === 'running' && s.pid, 'tenant scoped running');
assert(cancel(scopedRunning.id, tenantBCtx) === false, 'tenant B cannot cancel tenant A job');
assert(cancel(scopedRunning.id, cancelACtx), 'tenant A canceller can cancel tenant A job');
await waitDone(scopedRunning.id);
const scopedCancelAudit = auditFor(scopedRunning.id).filter((e) => e.event === 'cancel');
assert(scopedCancelAudit.length === 1 && scopedCancelAudit[0].actorId === 'canceller_a', 'cancel audit records requesting actor');

// stop() (graceful recording finish) must enforce the same tenant access control as cancel().
const stopFilePath = path.join(path.dirname(process.env.AQA_DB_PATH), 'stop-signal');
const stoppable = enqueue({
	kind: 'record',
	label: 'tenant scoped stoppable job',
	context: tenantACtx,
	stopFile: stopFilePath,
	spawnFn: () => longChild(),
});
await waitUntil(stoppable.id, (s) => s.status === 'running' && s.pid, 'stoppable running');
assert(stop(stoppable.id, tenantBCtx) === false, 'tenant B cannot stop tenant A recording');
assert(!fs.existsSync(stopFilePath), 'cross-tenant stop does not write the stop-file');
assert(stop(stoppable.id, cancelACtx) === true, 'tenant A actor can stop tenant A recording');
assert(fs.existsSync(stopFilePath), 'authorized stop writes the stop-file');
assert(cancel(stoppable.id, cancelACtx), 'free the running slot after the stop test');
await waitDone(stoppable.id);

const durableCanceled = enqueue({
	kind: 'unit',
	label: 'durable cross-runner cancel',
	context: tenantACtx,
	spawnFn: () => longChild(),
});
await waitUntil(durableCanceled.id, (s) => s.status === 'running' && s.pid && s.lastHeartbeatAt, 'durable heartbeat before cancel');
const durableCancelReq = dbRead((db) => dbm.requestWebuiJobCancel(db, durableCanceled.id, { tenantId: 'tenant_a', now: Date.now() }));
assert(durableCancelReq.ok && durableCancelReq.changed && durableCancelReq.job.status === 'canceling', 'durable cancel moves running job to canceling for any runner');
await waitDone(durableCanceled.id);
assert(jobResult(durableCanceled.id).status === 'cancelled', 'local worker observes durable cancel heartbeat and cancels child');
assert(dbJob(durableCanceled.id).status === 'canceled', 'durable heartbeat cancel persists terminal canceled');

const pullNow = Date.now() + 5000;
const safeCommand = { runner: 'gitBash', script: 'run.sh', args: ['tenant_unit'] };
dbRead((db) => {
	dbm.saveWebuiJob(db, {
		id: 'j800',
		tenantId: 'tenant_a',
		actorId: 'actor-a',
		kind: 'unit',
		label: 'pull claim heartbeat',
		status: 'queued',
		enqueuedAt: pullNow,
		command: safeCommand,
		resumable: true,
		maxAttempts: 2,
	});
	dbm.saveWebuiJob(db, {
		id: 'j801',
		tenantId: 'tenant_b',
		actorId: 'actor-b',
		kind: 'unit',
		label: 'other tenant queued',
		status: 'queued',
		enqueuedAt: pullNow - 1,
		command: safeCommand,
		resumable: true,
		maxAttempts: 2,
	});
});
const claimed = dbRead((db) => dbm.claimNextWebuiJob(db, { tenantId: 'tenant_a', runnerId: 'runner-a', now: pullNow + 10, leaseMs: 500 }));
assert(claimed?.id === 'j800' && claimed.status === 'claimed' && claimed.workerId === 'runner-a', 'runner pulls and claims oldest queued job for its tenant');
assert(claimed.attempts === 1 && claimed.claimExpiresAt === pullNow + 510, 'claim increments attempts and records lease expiry');
assert(dbRead((db) => dbm.claimNextWebuiJob(db, { tenantId: 'tenant_a', runnerId: 'runner-b', now: pullNow + 20, leaseMs: 500 })) === null, 'second runner cannot double-claim claimed job');
assert(dbRead((db) => dbm.heartbeatWebuiJob(db, 'j800', { runnerId: 'runner-b', now: pullNow + 30, leaseMs: 500 })) === null, 'heartbeat from non-owning runner is rejected');
const hb = dbRead((db) => dbm.heartbeatWebuiJob(db, 'j800', { runnerId: 'runner-a', now: pullNow + 40, leaseMs: 500, status: 'running', pid: 4242 }));
assert(hb?.status === 'running' && hb.pid === 4242 && hb.cancelRequested === false, 'owning runner heartbeat moves claim to running');
const pulledCancel = dbRead((db) => dbm.requestWebuiJobCancel(db, 'j800', { tenantId: 'tenant_a', now: pullNow + 50 }));
assert(pulledCancel.ok && pulledCancel.changed && pulledCancel.job.status === 'canceling', 'cross-runner cancel marks claimed/running job canceling');
const cancelHb = dbRead((db) => dbm.heartbeatWebuiJob(db, 'j800', { runnerId: 'runner-a', now: pullNow + 60, leaseMs: 500, status: 'running' }));
assert(cancelHb?.cancelRequested === true && cancelHb.status === 'canceling', 'owning runner heartbeat sees durable cancel request');
const completedCancel = dbRead((db) => dbm.completeWebuiJob(db, 'j800', { runnerId: 'runner-a', status: 'canceled', now: pullNow + 70, exitCode: -1, failureReason: 'cancelled by operator' }));
assert(completedCancel?.status === 'canceled' && completedCancel.cancelled === true, 'owning runner completes canceled job terminally');

dbRead((db) => {
	dbm.saveWebuiJob(db, {
		id: 'j805',
		tenantId: 'tenant_a',
		actorId: 'actor-a',
		kind: 'unit',
		label: 'production runner binding',
		status: 'queued',
		enqueuedAt: pullNow + 80,
		command: safeCommand,
		resumable: true,
		maxAttempts: 2,
	});
});
assert(dbRead((db) => dbm.claimWebuiJob(db, 'j805', {
	tenantId: 'tenant_a',
	runnerId: 'runner-prod-a',
	runnerTenantId: 'tenant_b',
	runnerDeploymentId: 'deploy-a',
	now: pullNow + 81,
	leaseMs: 500,
})) === null, 'runner tenant binding refuses mismatched tenant claim');
const prodClaim = dbRead((db) => dbm.claimWebuiJob(db, 'j805', {
	tenantId: 'tenant_a',
	runnerId: 'runner-prod-a',
	runnerTenantId: 'tenant_a',
	runnerDeploymentId: 'deploy-a',
	now: pullNow + 82,
	leaseMs: 500,
}));
assert(prodClaim?.workerId === 'runner-prod-a' && prodClaim.workerTenantId === 'tenant_a' && prodClaim.workerDeploymentId === 'deploy-a', 'runner claim persists tenant/deployment binding');
assert(dbRead((db) => dbm.heartbeatWebuiJob(db, 'j805', {
	runnerId: 'runner-prod-a',
	runnerTenantId: 'tenant_b',
	runnerDeploymentId: 'deploy-a',
	now: pullNow + 83,
	leaseMs: 500,
})) === null, 'heartbeat with wrong runner tenant is refused');
assert(dbRead((db) => dbm.heartbeatWebuiJob(db, 'j805', {
	runnerId: 'runner-prod-a',
	runnerTenantId: 'tenant_a',
	runnerDeploymentId: 'deploy-b',
	now: pullNow + 84,
	leaseMs: 500,
})) === null, 'heartbeat with wrong runner deployment is refused');
assert(dbRead((db) => dbm.completeWebuiJob(db, 'j805', {
	runnerId: 'runner-prod-a',
	runnerTenantId: 'tenant_a',
	runnerDeploymentId: 'deploy-b',
	status: 'succeeded',
	now: pullNow + 85,
	exitCode: 0,
})) === null, 'completion with wrong runner deployment is refused');
const prodHeartbeat = dbRead((db) => dbm.heartbeatWebuiJob(db, 'j805', {
	runnerId: 'runner-prod-a',
	runnerTenantId: 'tenant_a',
	runnerDeploymentId: 'deploy-a',
	now: pullNow + 86,
	leaseMs: 500,
	status: 'running',
}));
assert(prodHeartbeat?.status === 'running', 'heartbeat with matching runner binding succeeds');
const prodComplete = dbRead((db) => dbm.completeWebuiJob(db, 'j805', {
	runnerId: 'runner-prod-a',
	runnerTenantId: 'tenant_a',
	runnerDeploymentId: 'deploy-a',
	status: 'succeeded',
	now: pullNow + 87,
	exitCode: 0,
	result: { status: 'ok' },
}));
assert(prodComplete?.status === 'succeeded' && prodComplete.workerDeploymentId === 'deploy-a', 'completion with matching runner binding succeeds');

dbRead((db) => {
	dbm.saveWebuiJob(db, {
		id: 'j810',
		tenantId: 'tenant_a',
		actorId: 'actor-a',
		kind: 'unit',
		label: 'retry stale runner',
		status: 'queued',
		enqueuedAt: pullNow + 100,
		command: safeCommand,
		resumable: true,
		maxAttempts: 2,
	});
});
assert(dbRead((db) => dbm.claimWebuiJob(db, 'j810', { tenantId: 'tenant_a', runnerId: 'runner-stale-1', runnerTenantId: 'tenant_a', runnerDeploymentId: 'deploy-stale-1', now: pullNow + 110, leaseMs: 50 }))?.attempts === 1, 'first stale retry fixture claim succeeds');
const retried = dbRead((db) => dbm.reconcileWebuiJobs(db, { tenantId: 'tenant_a', now: pullNow + 500, staleMs: 1, retryStale: true, reason: 'stale runner heartbeat' }));
assert(retried.some((j) => j.id === 'j810' && j.reconcileAction === 'retry-queued'), 'stale resumable job is requeued while attempts remain');
assert(dbJob('j810').status === 'queued' && dbJob('j810').attempts === 1 && !dbJob('j810').workerId && !dbJob('j810').workerTenantId && !dbJob('j810').workerDeploymentId, 'retry reconcile clears stale claim ownership');
assert(dbRead((db) => dbm.claimWebuiJob(db, 'j810', { tenantId: 'tenant_a', runnerId: 'runner-stale-2', runnerTenantId: 'tenant_a', runnerDeploymentId: 'deploy-stale-2', now: pullNow + 510, leaseMs: 50 }))?.attempts === 2, 'second retry claim consumes final attempt');
const exhausted = dbRead((db) => dbm.reconcileWebuiJobs(db, { tenantId: 'tenant_a', now: pullNow + 900, staleMs: 1, retryStale: true, reason: 'stale runner heartbeat exhausted' }));
assert(exhausted.some((j) => j.id === 'j810' && j.reconcileAction === 'interrupted'), 'stale job is interrupted after retry budget is exhausted');
assert(dbJob('j810').status === 'interrupted', 'exhausted retry reconcile persists interrupted');
assert(dbRead((db) => dbm.requestWebuiJobCancel(db, 'j801', { tenantId: 'tenant_b', now: pullNow + 950 })).job.status === 'canceled', 'unused pull fixture is canceled before restart hydration');

const now = Date.now();
dbRead((db) => {
	dbm.saveWebuiJob(db, {
		id: 'j900',
		tenantId: 'tenant-a',
		actorId: 'actor-a',
		kind: 'unit',
		label: 'manual queued',
		status: 'queued',
		enqueuedAt: now + 900,
		resumable: false,
		nonResumableReason: 'manual fixture has no WebUI-safe command spec',
	});
	dbm.saveWebuiJob(db, {
		id: 'j901',
		tenantId: 'tenant-a',
		actorId: 'actor-a',
		kind: 'unit',
		label: 'manual running',
		status: 'running',
		enqueuedAt: now + 901,
		startedAt: now + 901,
		pid: 123456,
	});
	dbm.saveWebuiJob(db, {
		id: 'j902',
		tenantId: 'tenant-a',
		actorId: 'actor-a',
		kind: 'unit',
		label: 'manual claimed',
		status: 'claimed',
		enqueuedAt: now + 902,
		claimedAt: now + 902,
		workerId: 'stale-worker',
	});
	dbm.saveWebuiJob(db, {
		id: 'j903',
		tenantId: 'tenant-a',
		actorId: 'actor-a',
		kind: 'unit',
		label: 'manual canceling',
		status: 'canceling',
		enqueuedAt: now + 903,
		startedAt: now + 903,
		cancelled: true,
		cancelRequestedAt: now + 904,
		pid: 123457,
	});
});

const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
	const { queueState, jobResult } = await import('./webui/jobs.js');
	const q = queueState();
	console.log(JSON.stringify({
		queued: q.pending.find((j) => j.id === 'j900') || null,
		running: jobResult('j901'),
		claimed: jobResult('j902'),
		canceling: jobResult('j903'),
	}));
`], {
	cwd: process.cwd(),
	env: { ...process.env, AQA_DB_PATH: process.env.AQA_DB_PATH, WEBUI_JOB_JOURNAL: process.env.WEBUI_JOB_JOURNAL, NODE_NO_WARNINGS: '1' },
	encoding: 'utf8',
});
assert(child.status === 0, 'restart probe exits cleanly: ' + child.stderr);
const restartView = JSON.parse(child.stdout.trim());
assert(restartView.queued?.status === 'queued' && restartView.queued.restored === true && restartView.queued.resumable === false, 'startup preserves queued job record');
assert(/WebUI-safe command spec/.test(restartView.queued.nonResumableReason || ''), 'restored non-resumable job keeps persisted reason');
assert(restartView.running?.status === 'failed' && restartView.running.durableStatus === 'interrupted', 'startup reconciles running job to interrupted, not succeeded');
assert(restartView.claimed?.status === 'failed' && restartView.claimed.durableStatus === 'interrupted', 'startup reconciles claimed job to interrupted');
assert(restartView.canceling?.status === 'failed' && restartView.canceling.durableStatus === 'interrupted', 'startup reconciles canceling job to interrupted');
assert(dbJob('j901').status === 'interrupted', 'reconciled running job persisted as interrupted');
assert(dbJob('j902').status === 'interrupted' && dbJob('j903').status === 'interrupted', 'reconciled claimed/canceling jobs persisted as interrupted');
assert(auditFor('j901').some((e) => e.event === 'fail' && e.status === 'interrupted'), 'reconciliation writes fail audit');

const chainOk = auditChain();
assert(chainOk.ok && chainOk.checked > 0 && /^sha256:|^[0-9a-f]{64}$/.test(chainOk.headHash || ''), 'audit hash chain verifies before tamper');
const sinkText = fs.readFileSync(process.env.WEBUI_AUDIT_SINK_PATH, 'utf8');
assert(sinkText.includes('"schemaVersion":1') && sinkText.includes('"hash"'), 'external audit jsonl sink receives audit rows');
assert(!/hunter2|abc123|secret-value|tok_123/.test(sinkText), 'external audit sink receives redacted data only');
const tamperedId = dbRead((db) => db.prepare('SELECT id FROM webui_job_audit ORDER BY id ASC LIMIT 1').get().id);
dbRead((db) => db.prepare('UPDATE webui_job_audit SET data_json = ? WHERE id = ?').run('{"tampered":true}', tamperedId));
const chainBad = auditChain();
assert(chainBad.ok === false && chainBad.brokenAt === tamperedId && chainBad.reason === 'hash mismatch', 'audit hash chain detects tampered row');

console.log('  jobs-durable-unit: all checks passed');
NODE
)
