#!/usr/bin/env bash
# Browser-free unit tests for the runner HTTP API contract.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

(
	cd "$DIR"
	node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
	createRunnerApiHandler,
	handleRunnerApiRequest,
	runnerApiContract,
} from './webui/runner-api.js';

const require = createRequire(import.meta.url);
const runner = require('./lib/runner-contract.js');

const TOKEN_A = 'aqa-secret://tenant-a/runner-a';
const TOKEN_B = 'aqa-secret://tenant-a/runner-b';
const identityA = runner.validateRunnerIdentity({
	WEBUI_RUNNER_MODE: 'production',
	WEBUI_RUNNER_ID: 'runner-a',
	WEBUI_RUNNER_TENANT_ID: 'tenant-a',
	WEBUI_RUNNER_DEPLOYMENT_ID: 'deploy-a',
	WEBUI_RUNNER_TOKEN_REF: TOKEN_A,
});
const identityB = runner.validateRunnerIdentity({
	WEBUI_RUNNER_MODE: 'production',
	WEBUI_RUNNER_ID: 'runner-b',
	WEBUI_RUNNER_TENANT_ID: 'tenant-a',
	WEBUI_RUNNER_DEPLOYMENT_ID: 'deploy-b',
	WEBUI_RUNNER_TOKEN_REF: TOKEN_B,
});

let now = 1000;
const makeBody = (overrides = {}) => ({
	runnerMode: 'production',
	runnerId: 'runner-a',
	tenantId: 'tenant-a',
	deploymentId: 'deploy-a',
	tokenRef: TOKEN_A,
	...overrides,
});
const registry = new Map([
	['runner-a|tenant-a|deploy-a', identityA],
	['runner-b|tenant-a|deploy-b', identityB],
]);
const resolveRunnerIdentity = (req) => registry.get(`${req.runnerId}|${req.tenantId}|${req.deploymentId}`) || null;

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function createFakeStore(seed = []) {
	const jobs = new Map(seed.map((job) => [job.id, {
		status: 'queued',
		attempts: 0,
		maxAttempts: 2,
		resumable: true,
		command: { schemaVersion: 1, runner: 'gitBash', script: 'run.sh', args: ['unit'] },
		...clone(job),
	}]));
	const findScoped = (jobId, ctx) => {
		const job = jobs.get(jobId);
		if (!job || job.tenantId !== ctx.tenantId) return null;
		return job;
	};
	const ownActive = (job, ctx) => (
		job
		&& job.workerId === ctx.runnerId
		&& job.workerTenantId === ctx.runnerTenantId
		&& job.workerDeploymentId === ctx.runnerDeploymentId
	);
	const claimJob = (job, ctx) => {
		if (!job || job.tenantId !== ctx.tenantId || job.status !== 'queued' || job.attempts >= job.maxAttempts || !job.resumable) return null;
		job.status = 'claimed';
		job.workerId = ctx.runnerId;
		job.workerTenantId = ctx.runnerTenantId;
		job.workerDeploymentId = ctx.runnerDeploymentId;
		job.claimedAt = ctx.now;
		job.lastHeartbeatAt = ctx.now;
		job.claimExpiresAt = ctx.now + ctx.leaseMs;
		job.attempts += 1;
		return clone(job);
	};
	return {
		jobs,
		pull(ctx) {
			const next = [...jobs.values()]
				.filter((job) => job.status === 'queued' && job.tenantId === ctx.tenantId)
				.sort((a, b) => (a.enqueuedAt || 0) - (b.enqueuedAt || 0) || a.id.localeCompare(b.id))[0];
			const job = claimJob(next, ctx);
			return job ? { ok: true, job } : { ok: true, empty: true, job: null };
		},
		claim(jobId, ctx) {
			const job = claimJob(findScoped(jobId, ctx), ctx);
			return job ? { ok: true, job } : { ok: false, code: 'not-found', message: 'job not found' };
		},
		heartbeat(jobId, ctx) {
			const job = findScoped(jobId, ctx);
			if (!job) return { ok: false, code: 'not-found', message: 'job not found' };
			if (!ownActive(job, ctx)) return { ok: false, code: 'foreign-runner', message: 'runner does not own job' };
			if (job.claimExpiresAt <= ctx.now) return { ok: false, code: 'stale-heartbeat', message: 'heartbeat lease expired' };
			if (!['claimed', 'running', 'canceling'].includes(job.status)) return { ok: false, code: 'not-active', message: 'job is not active' };
			if (job.status !== 'canceling') job.status = 'running';
			job.pid = ctx.pid ?? job.pid ?? null;
			job.runId = ctx.runId ?? job.runId ?? null;
			job.lastHeartbeatAt = ctx.now;
			job.claimExpiresAt = ctx.now + ctx.leaseMs;
			return { ok: true, job: clone({ ...job, cancelRequested: job.status === 'canceling' }) };
		},
		complete(jobId, ctx) {
			const job = findScoped(jobId, ctx);
			if (!job) return { ok: false, code: 'not-found', message: 'job not found' };
			if (!ownActive(job, ctx)) return { ok: false, code: 'foreign-runner', message: 'runner does not own job' };
			if (!['claimed', 'running', 'canceling'].includes(job.status)) return { ok: false, code: 'already-terminal', message: 'job is terminal' };
			job.status = ctx.status;
			job.exitCode = ctx.exitCode ?? null;
			job.result = ctx.result ?? null;
			job.endedAt = ctx.now;
			return { ok: true, job: clone(job) };
		},
		cancel(jobId, ctx) {
			const job = findScoped(jobId, ctx);
			if (!job) return { ok: false, code: 'not-found', message: 'job not found' };
			if (!ownActive(job, ctx)) return { ok: false, code: 'foreign-runner-cancel', message: 'runner does not own job token=sk-cancel-secret' };
			if (['canceled', 'succeeded', 'failed', 'interrupted', 'expired'].includes(job.status)) {
				return { ok: true, job: clone(job), changed: false };
			}
			job.status = 'canceling';
			job.cancelled = true;
			job.cancelRequestedAt = ctx.now;
			return { ok: true, job: clone(job), changed: true };
		},
	};
}

const api = (store) => ({
	store,
	now: () => now,
	leaseMs: 100,
	resolveRunnerIdentity,
});

const seeded = createFakeStore([
	{ id: 'job-other-tenant', tenantId: 'tenant-b', enqueuedAt: 1, label: 'other tenant' },
	{ id: 'job-a', tenantId: 'tenant-a', enqueuedAt: 2, label: 'tenant job', meta: { tokenRef: TOKEN_A } },
	{ id: 'job-stale', tenantId: 'tenant-a', enqueuedAt: 3, label: 'stale heartbeat' },
]);

let out = await handleRunnerApiRequest({
	method: 'POST',
	path: '/api/runner/pull',
	body: makeBody({ op: 'pull' }),
}, api(seeded));
assert.equal(out.status, 200, 'pull succeeds');
assert.equal(out.body.ok, true, 'pull response is ok');
assert.equal(out.body.job.id, 'job-a', 'pull skips jobs outside runner tenant');
assert.equal(out.body.job.tenantId, 'tenant-a', 'pull preserves scoped tenant');
assert.equal(out.body.runner.runnerId, 'runner-a', 'runner identity is returned');
assert.match(out.body.runner.tokenRefHash, /^sha256:[0-9a-f]{64}$/, 'runner response exposes only token-ref hash');
assert.equal(JSON.stringify(out.body).includes(TOKEN_A), false, 'pull response does not echo raw token ref');
assert.equal(out.body.job.meta.tokenRef, '[redacted]', 'job metadata is redacted on readback');

out = await handleRunnerApiRequest({
	method: 'POST',
	path: '/api/runner/claim',
	body: makeBody({ op: 'claim', jobId: 'job-other-tenant' }),
}, api(seeded));
assert.equal(out.status, 404, 'claim outside tenant scope is not claimable');
assert.equal(out.body.failClosed, true, 'tenant scope failure is fail closed');

out = await handleRunnerApiRequest({
	method: 'POST',
	path: '/api/runner/heartbeat',
	body: makeBody({ op: 'heartbeat', jobId: 'job-a', pid: 1234, runId: 'run-a' }),
}, api(seeded));
assert.equal(out.status, 200, 'owning runner heartbeat succeeds');
assert.equal(out.body.job.status, 'running', 'heartbeat advances the job to running');
assert.equal(out.body.job.pid, 1234, 'heartbeat records runner pid');

out = await handleRunnerApiRequest({
	method: 'POST',
	path: '/api/runner/cancel',
	body: makeBody({
		op: 'cancel',
		jobId: 'job-a',
		runnerId: 'runner-b',
		deploymentId: 'deploy-b',
		tokenRef: TOKEN_B,
	}),
}, api(seeded));
assert.equal(out.status, 403, 'foreign runner cancel is refused');
assert.equal(out.body.code, 'foreign-runner-cancel', 'foreign cancel returns a scoped refusal code');
assert.equal(JSON.stringify(out.body).includes('sk-cancel-secret'), false, 'foreign cancel error is sanitized');
assert.equal(seeded.jobs.get('job-a').status, 'running', 'foreign cancel does not mutate the job');

out = await handleRunnerApiRequest({
	method: 'POST',
	path: '/api/runner/complete',
	body: makeBody({ op: 'complete', jobId: 'job-a', status: 'succeeded', exitCode: 0, result: { status: 'ok', password: 'hunter2' } }),
}, api(seeded));
assert.equal(out.status, 200, 'owning runner complete succeeds');
assert.equal(out.body.job.status, 'succeeded', 'complete writes terminal status');
assert.equal(out.body.job.result.password, '[redacted]', 'complete result is redacted on response');

now = 2000;
out = await handleRunnerApiRequest({
	method: 'POST',
	path: '/api/runner/claim',
	body: makeBody({ op: 'claim', jobId: 'job-stale', leaseMs: 10 }),
}, api(seeded));
assert.equal(out.status, 200, 'claim fixture for stale heartbeat succeeds');
now = 3000;
out = await handleRunnerApiRequest({
	method: 'POST',
	path: '/api/runner/heartbeat',
	body: makeBody({ op: 'heartbeat', jobId: 'job-stale' }),
}, api(seeded));
assert.equal(out.status, 409, 'stale heartbeat is refused');
assert.equal(out.body.code, 'stale-heartbeat', 'stale heartbeat returns a deterministic code');

out = await handleRunnerApiRequest({
	method: 'POST',
	path: '/api/runner/pull',
	body: makeBody({ op: 'pull', token: 'sk-plaintext-secret' }),
}, api(seeded));
assert.equal(out.status, 400, 'plaintext runner token is rejected');
assert.equal(out.body.code, 'plaintext_runner_token_refused', 'plaintext token refusal is explicit');
assert.equal(JSON.stringify(out.body).includes('sk-plaintext-secret'), false, 'plaintext token is not echoed');

out = await handleRunnerApiRequest({
	method: 'POST',
	path: '/api/runner/pull',
	headers: { authorization: 'Bearer raw-secret-token' },
	body: makeBody({ op: 'pull' }),
}, api(seeded));
assert.equal(out.status, 400, 'direct runner API rejects plaintext Authorization tokens');
assert.equal(out.body.code, 'plaintext_runner_token_refused', 'plaintext Authorization refusal is explicit');
assert.equal(JSON.stringify(out.body).includes('raw-secret-token'), false, 'plaintext Authorization is not echoed');

out = await handleRunnerApiRequest({
	method: 'POST',
	path: '/api/runner/pull',
	body: makeBody({ op: 'pull', tokenRef: 'aqa-secret://tenant-a/wrong-runner' }),
}, api(seeded));
assert.equal(out.status, 401, 'wrong token-ref is rejected');
assert.equal(JSON.stringify(out.body).includes('wrong-runner'), false, 'wrong token-ref is not echoed');

out = await handleRunnerApiRequest({
	method: 'POST',
	path: '/api/runner/pull',
	body: makeBody({ op: 'pull', tenantId: 'tenant-b' }),
}, api(seeded));
assert.equal(out.status, 401, 'unknown tenant-bound runner identity is rejected');

const throwingStore = {
	pull() {
		throw new Error('boom password=hunter2 Authorization: Bearer raw-secret-token C:\\project\\Browser-auto\\flows\\demo.values.json token=sk-store-secret');
	},
};
out = await handleRunnerApiRequest({
	method: 'POST',
	path: '/api/runner/pull',
	body: makeBody({ op: 'pull' }),
}, api(throwingStore));
assert.equal(out.status, 500, 'store exceptions become sanitized JSON errors');
const errJson = JSON.stringify(out.body);
for (const raw of ['hunter2', 'raw-secret-token', 'demo.values.json', 'sk-store-secret']) {
	assert.equal(errJson.includes(raw), false, `sanitized error must not expose ${raw}`);
}
assert.equal(out.body.failClosed, true, 'sanitized store exception is fail closed');

const handlerStore = createFakeStore([{ id: 'job-handler', tenantId: 'tenant-a', enqueuedAt: 1 }]);
const handler = createRunnerApiHandler(api(handlerStore));
const req = {
	method: 'POST',
	path: '/runner/pull',
	headers: {},
	params: {},
	body: makeBody({ op: 'pull' }),
};
const res = {
	statusCode: 0,
	payload: null,
	status(code) {
		this.statusCode = code;
		return this;
	},
	json(payload) {
		this.payload = payload;
		return this;
	},
};
await handler(req, res);
assert.equal(res.statusCode, 200, 'Express-style handler writes status');
assert.equal(res.payload.job.id, 'job-handler', 'Express-style handler writes JSON payload');

const contract = runnerApiContract();
assert.deepEqual(contract.operations, ['pull', 'claim', 'heartbeat', 'complete', 'cancel'], 'contract lists runner operations');
assert.equal(contract.identity.plaintextTokenAccepted, false, 'contract declares plaintext token rejection');
assert.equal(contract.scope.cancelRequiresOwningRunner, true, 'contract declares owning-runner cancel scope');

console.log('  runner-api-unit: all checks passed');
NODE
)
