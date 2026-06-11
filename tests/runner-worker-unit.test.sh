#!/usr/bin/env bash
# Browser-free unit test for the outbound-only runner worker.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

(
	cd "$DIR"
	NODE_NO_WARNINGS=1 node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';

function readBody(req) {
	return new Promise((resolve, reject) => {
		let raw = '';
		req.setEncoding('utf8');
		req.on('data', (chunk) => { raw += chunk; });
		req.on('end', () => {
			try { resolve(raw ? JSON.parse(raw) : {}); }
			catch (e) { reject(e); }
		});
		req.on('error', reject);
	});
}

function send(res, code, body) {
	const text = JSON.stringify(body);
	res.writeHead(code, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(text),
	});
	res.end(text);
}

function assertIdentity(req, body) {
	assert.equal(req.headers.authorization, 'Bearer operator00000001', 'worker sends control-plane bearer token when configured');
	assert.equal(body.runnerId, 'runner-a', 'worker sends runner identity');
	assert.equal(body.tenantId, 'tenant-a', 'worker sends tenant identity');
	assert.equal(body.deploymentId, 'deploy-a', 'worker sends deployment identity');
	assert.equal(body.tokenRef, 'kms://tenant-a/runner', 'worker sends token reference, not plaintext token');
}

function makeJob(id, script) {
	return {
		id,
		tenantId: 'tenant-a',
		status: 'claimed',
		workerId: 'runner-a',
		workerTenantId: 'tenant-a',
		workerDeploymentId: 'deploy-a',
		commandSpec: {
			runner: 'testDouble',
			script,
			args: [],
		},
	};
}

async function runWorkerScenario(handler) {
	const bodies = [];
	const server = http.createServer(async (req, res) => {
		try {
			const body = await readBody(req);
			bodies.push({ url: req.url, body });
			assertIdentity(req, body);
			return await handler(req, res, body);
		} catch (e) {
			return send(res, 500, { ok: false, error: (e && e.message) || String(e) });
		}
	});
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address();
	const stderr = [];
	const child = spawn(process.execPath, [
		'bin/runner-worker.mjs',
		'--api', `http://127.0.0.1:${port}/api/runner`,
		'--once',
		'--poll-ms', '25',
		'--heartbeat-ms', '50',
		'--lease-ms', '500',
	], {
		cwd: process.cwd(),
		env: {
			...process.env,
			WEBUI_RUNNER_ID: 'runner-a',
			WEBUI_RUNNER_TENANT_ID: 'tenant-a',
			WEBUI_RUNNER_DEPLOYMENT_ID: 'deploy-a',
			WEBUI_RUNNER_TOKEN_REF: 'kms://tenant-a/runner',
			WEBUI_RUNNER_API_AUTH_TOKEN: 'operator00000001',
			AQA_RUNNER_ALLOW_TEST_DOUBLE: '1',
			NODE_NO_WARNINGS: '1',
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	child.stderr.setEncoding('utf8');
	child.stderr.on('data', (chunk) => stderr.push(chunk));
	child.stdout.resume();
	const timer = setTimeout(() => child.kill(), 8000);
	const code = await new Promise((resolve) => child.on('close', resolve));
	clearTimeout(timer);
	await new Promise((resolve) => server.close(resolve));
	return { code, stderr: stderr.join(''), bodies };
}

{
	const job = makeJob('job-cancel-before-spawn', 'console.log("SPAWNED_BEFORE_CANCEL"); process.exit(0);');
	let heartbeatCount = 0;
	let completeBody = null;
	const out = await runWorkerScenario(async (req, res, body) => {
		if (req.url === '/api/runner/pull') {
			return send(res, 200, { ok: true, op: 'pull', empty: false, job, leaseMs: 500 });
		}
		if (req.url === '/api/runner/heartbeat') {
			heartbeatCount += 1;
			return send(res, 200, {
				ok: true,
				op: 'heartbeat',
				cancelRequested: true,
				job: { ...job, status: 'canceling', cancelRequested: true },
				leaseMs: 500,
			});
		}
		if (req.url === '/api/runner/complete') {
			completeBody = body;
			return send(res, 200, { ok: true, op: 'complete', job: { ...job, status: body.status }, leaseMs: 500 });
		}
		return send(res, 404, { ok: false, error: 'not found' });
	});
	assert.equal(out.code, 0, `cancel-before-spawn worker exits cleanly: ${out.stderr}`);
	assert.equal(heartbeatCount, 1, 'worker checks heartbeat before spawning a claimed job');
	assert.equal(completeBody?.status, 'canceled', 'pre-spawn cancel completes as canceled');
	assert.notEqual(completeBody?.status, 'succeeded', 'pre-spawn cancel is never reported as succeeded');
	assert.equal(JSON.stringify(completeBody?.log || []).includes('SPAWNED_BEFORE_CANCEL'), false, 'pre-spawn cancel does not capture child output');
	assert.equal(completeBody?.result?.logLines, 0, 'pre-spawn cancel does not run the child command');
	assert.equal(out.stderr.includes('SPAWNED_BEFORE_CANCEL'), false, 'pre-spawn cancel does not echo child output');
	assert.deepEqual(out.bodies.map((b) => b.url), ['/api/runner/pull', '/api/runner/heartbeat', '/api/runner/complete'], 'pre-spawn cancel uses pull, heartbeat, complete');
}

{
	const job = makeJob('job-cancel-running', 'console.log("password=hunter2 token=abc123"); setInterval(() => {}, 1000);');
	let heartbeatCount = 0;
	let completeBody = null;
	const out = await runWorkerScenario(async (req, res, body) => {
		if (req.url === '/api/runner/pull') {
			return send(res, 200, { ok: true, op: 'pull', empty: false, job, leaseMs: 500 });
		}
		if (req.url === '/api/runner/heartbeat') {
			heartbeatCount += 1;
			const cancelRequested = heartbeatCount >= 3;
			return send(res, 200, {
				ok: true,
				op: 'heartbeat',
				cancelRequested,
				job: { ...job, status: cancelRequested ? 'canceling' : 'running', cancelRequested },
				leaseMs: 500,
			});
		}
		if (req.url === '/api/runner/complete') {
			completeBody = body;
			return send(res, 200, { ok: true, op: 'complete', job: { ...job, status: body.status }, leaseMs: 500 });
		}
		return send(res, 404, { ok: false, error: 'not found' });
	});
	assert.equal(out.code, 0, `running-cancel worker exits cleanly: ${out.stderr}`);
	assert.equal(heartbeatCount >= 3, true, 'worker keeps heartbeating until a running cancel request appears');
	assert.equal(completeBody?.status, 'canceled', 'running cancel reports canceled durable terminal state');
	assert.notEqual(completeBody?.status, 'succeeded', 'running cancel is never reported as succeeded');
	const completeJson = JSON.stringify(completeBody);
	assert.equal(/hunter2|abc123/.test(completeJson), false, 'complete payload redacts stdout secrets');
	assert.match(completeJson, /\[redacted\]/, 'complete payload includes redaction marker');
	assert.equal(/hunter2|abc123/.test(out.stderr), false, 'worker stderr echoes only redacted child output');
}

{
	const job = makeJob('job-failed-child', 'console.error("worker child intentional failure"); process.exit(7);');
	let completeBody = null;
	const out = await runWorkerScenario(async (req, res, body) => {
		if (req.url === '/api/runner/pull') {
			return send(res, 200, { ok: true, op: 'pull', empty: false, job, leaseMs: 500 });
		}
		if (req.url === '/api/runner/heartbeat') {
			return send(res, 200, {
				ok: true,
				op: 'heartbeat',
				cancelRequested: false,
				job: { ...job, status: 'running', cancelRequested: false },
				leaseMs: 500,
			});
		}
		if (req.url === '/api/runner/complete') {
			completeBody = body;
			return send(res, 200, { ok: true, op: 'complete', job: { ...job, status: body.status }, leaseMs: 500 });
		}
		return send(res, 404, { ok: false, error: 'not found' });
	});
	assert.equal(out.code, 0, `failed-child worker reports terminal failure cleanly: ${out.stderr}`);
	assert.equal(completeBody?.status, 'failed', 'failed child process reports failed terminal state');
	assert.equal(completeBody?.exitCode, 7, 'failed child exit code is reported');
	assert.notEqual(completeBody?.status, 'succeeded', 'failed child is never reported as succeeded');
}

console.log('  runner-worker-unit: all checks passed');
NODE
)
