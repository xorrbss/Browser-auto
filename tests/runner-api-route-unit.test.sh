#!/usr/bin/env bash
# Browser-free unit tests for the /api/runner/* route adapter.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

(
	cd "$DIR"
	AQA_DB_PATH="$TMP/runner-api-route.db" NODE_NO_WARNINGS=1 node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
	createDurableRunnerApiStore,
	createEnvRunnerIdentityResolver,
	parseRunnerApiRoute,
	runnerApiPost,
} from './webui/runner-routes.js';

const require = createRequire(import.meta.url);
const dbm = require('./lib/db.js');
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
const identities = new Map([
	['runner-a|tenant-a|deploy-a', identityA],
	['runner-b|tenant-a|deploy-b', identityB],
]);
const resolveRunnerIdentity = (req) => identities.get(`${req.runnerId}|${req.tenantId}|${req.deploymentId}`) || null;

const headersA = {
	'x-aqa-runner-mode': 'production',
	'x-aqa-runner-id': 'runner-a',
	'x-aqa-tenant-id': 'tenant-a',
	'x-aqa-runner-deployment-id': 'deploy-a',
	'x-aqa-runner-token-ref': TOKEN_A,
};
const headersB = {
	'x-aqa-runner-mode': 'production',
	'x-aqa-runner-id': 'runner-b',
	'x-aqa-tenant-id': 'tenant-a',
	'x-aqa-runner-deployment-id': 'deploy-b',
	'x-aqa-runner-token-ref': TOKEN_B,
};

let now = 1000;

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function createFakeStore(seed = []) {
	const jobs = new Map(seed.map((job) => [job.id, {
		status: 'queued',
		attempts: 0,
		maxAttempts: 2,
		command: { schemaVersion: 1, runner: 'gitBash', script: 'run.sh', args: ['unit'] },
		...clone(job),
	}]));
	const tenantJob = (jobId, ctx) => {
		const job = jobs.get(jobId);
		return job && job.tenantId === ctx.tenantId ? job : null;
	};
	const claim = (job, ctx) => {
		if (!job || job.status !== 'queued') return null;
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
	const owns = (job, ctx) => (
		job
		&& job.workerId === ctx.runnerId
		&& job.workerTenantId === ctx.runnerTenantId
		&& job.workerDeploymentId === ctx.runnerDeploymentId
	);
	return {
		jobs,
		pull(ctx) {
			const next = [...jobs.values()]
				.find((job) => job.tenantId === ctx.tenantId && job.status === 'queued');
			const job = claim(next, ctx);
			return job ? { ok: true, job } : { ok: true, empty: true, job: null };
		},
		claim(jobId, ctx) {
			const job = claim(tenantJob(jobId, ctx), ctx);
			return job ? { ok: true, job } : { ok: false, code: 'not-found', message: 'job not found' };
		},
		heartbeat(jobId, ctx) {
			const job = tenantJob(jobId, ctx);
			if (!job) return { ok: false, code: 'not-found', message: 'job not found' };
			if (!owns(job, ctx)) return { ok: false, code: 'foreign-runner', message: 'runner does not own job' };
			job.status = job.status === 'canceling' ? 'canceling' : 'running';
			job.pid = ctx.pid ?? job.pid ?? null;
			job.lastHeartbeatAt = ctx.now;
			job.claimExpiresAt = ctx.now + ctx.leaseMs;
			return { ok: true, job: clone(job), cancelRequested: job.status === 'canceling' };
		},
		complete(jobId, ctx) {
			const job = tenantJob(jobId, ctx);
			if (!job) return { ok: false, code: 'not-found', message: 'job not found' };
			if (!owns(job, ctx)) return { ok: false, code: 'foreign-runner', message: 'runner does not own job' };
			job.status = ctx.status;
			job.exitCode = ctx.exitCode;
			job.result = ctx.result;
			return { ok: true, job: clone(job) };
		},
		cancel(jobId, ctx) {
			const job = tenantJob(jobId, ctx);
			if (!job) return { ok: false, code: 'not-found', message: 'job not found' };
			if (['claimed', 'running', 'canceling'].includes(job.status) && !owns(job, ctx)) {
				return { ok: false, code: 'foreign-runner-cancel', message: 'runner does not own job token=sk-cancel-secret' };
			}
			if (['canceled', 'succeeded', 'failed', 'interrupted', 'expired'].includes(job.status)) {
				return { ok: true, job: clone(job), changed: false };
			}
			job.status = job.status === 'queued' ? 'canceled' : 'canceling';
			job.cancelled = true;
			return { ok: true, job: clone(job), changed: true };
		},
	};
}

function response() {
	return {
		statusCode: null,
		payload: null,
	};
}

function sendJson(res, code, obj) {
	res.statusCode = code;
	res.payload = obj;
	return res;
}

async function dispatch(path, body = {}, opts = {}) {
	const res = response();
	const handled = await runnerApiPost(path, body, res, {
		req: { method: opts.method || 'POST', headers: opts.headers || headersA, url: path },
		sendJson,
		runnerApi: {
			store: opts.store,
			now: () => now,
			leaseMs: 100,
			resolveRunnerIdentity,
			...(opts.runnerApi || {}),
		},
	});
	return { handled, status: res.statusCode, body: res.payload };
}

assert.equal(parseRunnerApiRoute('/api/not-runner').matched, false, 'non-runner paths do not match');
assert.deepEqual(
	parseRunnerApiRoute('/api/runner/jobs/job-1/heartbeat').params,
	{ op: 'heartbeat', jobId: 'job-1' },
	'jobs route parses op and job id',
);
assert.equal(parseRunnerApiRoute('/api/runner/reset').code, 'unsupported_runner_route', 'unsupported runner routes fail closed');

const fake = createFakeStore([
	{ id: 'job-other-tenant', tenantId: 'tenant-b', label: 'other tenant' },
	{ id: 'job-pull', tenantId: 'tenant-a', label: 'pull target', meta: { tokenRef: TOKEN_A } },
	{ id: 'job-claim', tenantId: 'tenant-a', label: 'claim target' },
	{ id: 'job-owned', tenantId: 'tenant-a', status: 'running', workerId: 'runner-a', workerTenantId: 'tenant-a', workerDeploymentId: 'deploy-a' },
]);

let out = await dispatch('/api/not-runner', {}, { store: fake });
assert.equal(out.handled, false, 'adapter ignores routes outside /api/runner');

out = await dispatch('/api/runner/pull', {}, { store: fake });
assert.equal(out.handled, true, 'pull route is handled');
assert.equal(out.status, 200, 'pull route succeeds');
assert.equal(out.body.job.id, 'job-pull', 'pull route dispatches by path op');
assert.equal(out.body.job.meta.tokenRef, '[redacted]', 'route response redacts token-ref fields');
assert.equal(JSON.stringify(out.body).includes(TOKEN_A), false, 'route response does not echo token ref');

out = await dispatch('/api/runner/jobs/job-claim/claim', {}, { store: fake });
assert.equal(out.status, 200, 'jobs/:id/claim route succeeds');
assert.equal(out.body.job.id, 'job-claim', 'claim route uses path job id');

out = await dispatch('/api/runner/jobs/job-claim/heartbeat', { pid: 4242 }, { store: fake });
assert.equal(out.status, 200, 'jobs/:id/heartbeat route succeeds');
assert.equal(out.body.job.pid, 4242, 'heartbeat route passes body fields to API');

out = await dispatch('/api/runner/complete/job-claim', { status: 'succeeded', exitCode: 0, result: { password: 'hunter2' } }, { store: fake });
assert.equal(out.status, 200, 'op/:id complete route succeeds');
assert.equal(out.body.job.status, 'succeeded', 'complete route writes terminal status');
assert.equal(out.body.job.result.password, '[redacted]', 'complete response redacts result values');

out = await dispatch('/api/runner/claim', { jobId: 'job-other-tenant' }, { store: fake });
assert.equal(out.status, 404, 'claim outside runner tenant is not claimable');
assert.equal(out.body.failClosed, true, 'cross-tenant route failure is fail closed');

out = await dispatch('/api/runner/jobs/job-owned/cancel', {}, { store: fake, headers: headersB });
assert.equal(out.status, 403, 'foreign runner cancel is refused');
assert.equal(out.body.code, 'foreign-runner-cancel', 'foreign cancel code is preserved');
assert.equal(fake.jobs.get('job-owned').status, 'running', 'foreign cancel does not mutate fake store');
assert.equal(JSON.stringify(out.body).includes('sk-cancel-secret'), false, 'foreign cancel error is sanitized');

out = await dispatch('/api/runner/pull', { op: 'claim', jobId: 'job-owned' }, { store: fake });
assert.equal(out.status, 400, 'body/path operation mismatch is refused');
assert.equal(out.body.code, 'ambiguous_runner_op', 'operation mismatch reports deterministic code');

out = await dispatch('/api/runner/pull', {}, { store: fake, method: 'GET' });
assert.equal(out.status, 405, 'runner route keeps POST-only API semantics');

out = await dispatch('/api/runner/reset', {}, { store: fake });
assert.equal(out.handled, true, 'unsupported runner prefix is consumed');
assert.equal(out.status, 404, 'unsupported runner prefix returns 404');
assert.equal(out.body.code, 'unsupported_runner_route', 'unsupported runner route code is explicit');

out = await dispatch('/api/runner/pull', {}, {
	store: fake,
	headers: { ...headersA, authorization: 'Bearer raw-secret-token' },
});
assert.equal(out.status, 200, 'route adapter strips WebUI Authorization before runner token validation');
assert.equal(out.body.empty, true, 'stripped WebUI Authorization leaves runner pull semantics intact');
assert.equal(JSON.stringify(out.body).includes('raw-secret-token'), false, 'plaintext token is not echoed');

out = await dispatch('/api/runner/pull', {}, {
	store: fake,
	headers: { ...headersA, 'x-aqa-runner-token-ref': 'aqa-secret://tenant-a/wrong-runner' },
});
assert.equal(out.status, 401, 'wrong token-ref is rejected');
assert.equal(JSON.stringify(out.body).includes('wrong-runner'), false, 'wrong token-ref is sanitized');

out = await dispatch('/api/runner/pull', {}, {
	store: {
		pull() {
			throw new Error('boom password=hunter2 Authorization: Bearer raw-token C:\\project\\Browser-auto\\flows\\demo.values.json token=sk-store-secret');
		},
	},
});
assert.equal(out.status, 500, 'store exceptions become route JSON errors');
for (const raw of ['hunter2', 'raw-token', 'demo.values.json', 'sk-store-secret']) {
	assert.equal(JSON.stringify(out.body).includes(raw), false, `route error does not expose ${raw}`);
}

const envResolver = createEnvRunnerIdentityResolver({
	WEBUI_RUNNER_MODE: 'production',
	WEBUI_RUNNER_ID: 'runner-a',
	WEBUI_RUNNER_TENANT_ID: 'tenant-a',
	WEBUI_RUNNER_DEPLOYMENT_ID: 'deploy-a',
	WEBUI_RUNNER_TOKEN_REF: TOKEN_A,
});
out = await dispatch('/api/runner/pull', {}, {
	store: createFakeStore([{ id: 'job-env', tenantId: 'tenant-a' }]),
	runnerApi: { resolveRunnerIdentity: envResolver },
});
assert.equal(out.status, 200, 'environment resolver authorizes matching configured runner identity');
assert.equal(out.body.job.id, 'job-env', 'environment resolver route can dispatch pull');

const db = dbm.openDb();
try {
	dbm.saveWebuiJob(db, {
		id: 'job-db',
		tenantId: 'tenant-a',
		actorId: 'actor-a',
		kind: 'unit',
		label: 'durable route job',
		status: 'queued',
		enqueuedAt: 1,
		command: { schemaVersion: 1, runner: 'gitBash', script: 'run.sh', args: ['unit'] },
		resumable: true,
		maxAttempts: 2,
	});
} finally {
	dbm.closeDb(db);
}
const durableStore = createDurableRunnerApiStore();
out = await dispatch('/api/runner/jobs/job-db/claim', {}, { store: durableStore });
assert.equal(out.status, 200, 'durable store route claim succeeds');
assert.equal(out.body.job.workerId, 'runner-a', 'durable route claim persists runner owner');
out = await dispatch('/api/runner/jobs/job-db/cancel', {}, { store: durableStore, headers: headersB });
assert.equal(out.status, 403, 'durable store foreign cancel is refused');
const afterDbCancel = (() => {
	const h = dbm.openDb();
	try { return dbm.getWebuiJob(h, 'job-db', { tenantId: 'tenant-a' }); }
	finally { dbm.closeDb(h); }
})();
assert.equal(afterDbCancel.status, 'claimed', 'durable store foreign cancel does not mutate job status');
assert.equal(afterDbCancel.workerId, 'runner-a', 'durable store keeps original owner after foreign cancel');

function saveDurableJob(rec) {
	const h = dbm.openDb();
	try {
		return dbm.saveWebuiJob(h, {
			tenantId: 'tenant-a',
			actorId: 'actor-a',
			kind: 'unit',
			status: 'queued',
			enqueuedAt: 10,
			command: { schemaVersion: 1, runner: 'gitBash', script: 'run.sh', args: ['unit'] },
			resumable: true,
			maxAttempts: 2,
			...rec,
		});
	} finally {
		dbm.closeDb(h);
	}
}

function durableJob(id) {
	const h = dbm.openDb();
	try { return dbm.getWebuiJob(h, id, { tenantId: 'tenant-a' }); }
	finally { dbm.closeDb(h); }
}

saveDurableJob({ id: 'job-db-queued-cancel', label: 'durable queued cancel' });
out = await dispatch('/api/runner/jobs/job-db-queued-cancel/cancel', {}, { store: durableStore });
assert.equal(out.status, 200, 'durable queued cancel before spawn succeeds');
assert.equal(out.body.job.status, 'canceled', 'durable queued cancel is terminal canceled');
out = await dispatch('/api/runner/jobs/job-db-queued-cancel/cancel', {}, { store: durableStore });
assert.equal(out.status, 200, 'duplicate durable queued cancel is idempotent');
assert.equal(out.body.job.status, 'canceled', 'duplicate queued cancel keeps canceled state');
assert.notEqual(durableJob('job-db-queued-cancel').status, 'succeeded', 'queued cancel is never persisted as succeeded');

saveDurableJob({ id: 'job-db-cancel-success-guard', label: 'durable cancel terminal guard' });
out = await dispatch('/api/runner/jobs/job-db-cancel-success-guard/claim', {}, { store: durableStore });
assert.equal(out.status, 200, 'durable cancel guard claim succeeds');
out = await dispatch('/api/runner/jobs/job-db-cancel-success-guard/cancel', {}, { store: durableStore });
assert.equal(out.status, 200, 'durable claimed cancel succeeds');
assert.equal(out.body.job.status, 'canceling', 'durable claimed cancel moves to canceling');
out = await dispatch('/api/runner/jobs/job-db-cancel-success-guard/complete', { status: 'succeeded', exitCode: 0, result: { status: 'ok' } }, { store: durableStore });
assert.equal(out.status, 200, 'durable completion after cancel is accepted');
assert.equal(out.body.job.status, 'canceled', 'durable completion after cancel is coerced to canceled');
assert.notEqual(durableJob('job-db-cancel-success-guard').status, 'succeeded', 'cancel-requested durable job is never persisted as succeeded');

console.log('  runner-api-route-unit: all checks passed');
NODE
)
