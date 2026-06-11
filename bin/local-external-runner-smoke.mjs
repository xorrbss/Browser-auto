#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const PROBE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OPERATOR_TOKEN = 'operator00000001';
const RUNNER_TOKEN_REF = 'aqa-secret:tenant_a/runner-local';
const JOB_ID = `j${Date.now()}`;
const TIMEOUT_MS = Number(process.env.AQA_LOCAL_EXTERNAL_SMOKE_TIMEOUT_MS || 45000);

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const port = server.address().port;
			server.close(() => resolve(port));
		});
	});
}

function collect(child, label, max = 12000) {
	const chunks = [];
	const push = (chunk) => {
		chunks.push(String(chunk || ''));
		while (chunks.join('').length > max) chunks.shift();
	};
	child.stdout?.setEncoding('utf8');
	child.stderr?.setEncoding('utf8');
	child.stdout?.on('data', push);
	child.stderr?.on('data', push);
	return () => chunks.join('').trim() || `${label} produced no output`;
}

function killProcess(child) {
	if (!child || child.killed || child.exitCode != null) return;
	try { child.kill('SIGTERM'); } catch {}
}

async function waitForExit(child, timeoutMs, label) {
	if (!child || child.exitCode != null || child.signalCode != null) {
		return { code: child?.exitCode ?? -1, signal: child?.signalCode || null };
	}
	return await new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			killProcess(child);
			reject(new Error(`${label} timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.once('exit', (code, signal) => {
			clearTimeout(timer);
			resolve({ code: code == null ? -1 : code, signal: signal || null });
		});
		child.once('error', (e) => {
			clearTimeout(timer);
			reject(e);
		});
	});
}

async function stopChild(child, label) {
	if (!child || child.exitCode != null || child.signalCode != null) return;
	killProcess(child);
	try {
		await waitForExit(child, 5000, label);
	} catch {
		try { child.kill('SIGKILL'); } catch {}
	}
}

async function waitForServer(base, token, logText) {
	const started = Date.now();
	let last = '';
	while (Date.now() - started < TIMEOUT_MS) {
		try {
			const unauth = await fetch(`${base}/api/rbac`);
			if (unauth.status === 401) {
				const auth = await fetch(`${base}/api/rbac`, {
					headers: { Authorization: `Bearer ${token}` },
				});
				last = `unauth=${unauth.status} auth=${auth.status}`;
				if (auth.status === 200) return;
			} else {
				last = `unauth=${unauth.status}`;
			}
		} catch (e) {
			last = (e && e.message) || String(e);
		}
		await sleep(100);
	}
	throw new Error(`server did not become ready (${last})\n${logText()}`);
}

function smokeEnv({ port, dataRoot }) {
	return {
		...process.env,
		NODE_NO_WARNINGS: '1',
		WEBUI_LOCAL_EXTERNAL_REHEARSAL: '1',
		WEBUI_EXTERNAL_MODE: '1',
		AQA_EXTERNAL_MODE: '1',
		WEBUI_SERVICE_MODE: '1',
		WEBUI_REQUIRE_DURABLE_JOBS: '1',
		WEBUI_HOST: '127.0.0.1',
		WEBUI_PORT: String(port),
		WEBUI_PUBLIC_URL: 'https://console.local.test',
		WEBUI_ALLOWED_HOSTS: `127.0.0.1:${port},localhost:${port},127.0.0.1,localhost`,
		WEBUI_ALLOWED_ORIGINS: `http://127.0.0.1:${port},http://localhost:${port}`,
		WEBUI_AUTH_PROVIDER: 'static',
		WEBUI_TENANT_ID: 'tenant_a',
		WEBUI_AUTH_USERS: JSON.stringify([
			{ token: 'viewer0000000001', id: 'viewer1', role: 'viewer', tenantId: 'tenant_a' },
			{ token: OPERATOR_TOKEN, id: 'operator1', role: 'operator', tenantId: 'tenant_a' },
			{ token: 'owner00000000001', id: 'owner1', role: 'owner', tenantId: 'tenant_a' },
			{ token: 'admin00000000001', id: 'admin1', role: 'admin', tenantId: 'tenant_a' },
		]),
		WEBUI_SECRET_STORE_BACKEND: 'encrypted-local',
		WEBUI_SECRET_STORE_KEY: 'local-external-runner-smoke-dev-key-material',
		WEBUI_SECRET_STORE_KEY_ID: 'local-external-runner-smoke-key',
		WEBUI_SECRET_STORE_DIR: path.join(dataRoot, 'secrets'),
		NOVNC_DISABLE: '1',
		WEBUI_NOVNC_BROWSER_ROOT: path.join(dataRoot, 'browser-sessions'),
		WEBUI_AUDIT_SINK: 'jsonl',
		WEBUI_AUDIT_SINK_PATH: path.join(dataRoot, 'audit', 'audit.jsonl'),
		AQA_DB_PATH: path.join(dataRoot, 'webui.sqlite'),
		WEBUI_KEEP_RUNS: '1000',
		WEBUI_JOB_TIMEOUT_MS: '30000',
		WEBUI_RUNNER_MODE: 'production',
		WEBUI_RUNNER_ID: 'runner-local',
		WEBUI_RUNNER_TENANT_ID: 'tenant_a',
		WEBUI_RUNNER_DEPLOYMENT_ID: 'local-external',
		WEBUI_RUNNER_TOKEN_REF: RUNNER_TOKEN_REF,
		WEBUI_RUNNER_API_AUTH_TOKEN: OPERATOR_TOKEN,
	};
}

function insertSmokeJob(env) {
	process.env.AQA_DB_PATH = env.AQA_DB_PATH;
	process.env.WEBUI_TENANT_ID = env.WEBUI_TENANT_ID;
	process.env.WEBUI_AUDIT_SINK = env.WEBUI_AUDIT_SINK;
	process.env.WEBUI_AUDIT_SINK_PATH = env.WEBUI_AUDIT_SINK_PATH;
	const dbm = require('../lib/db.js');
	const db = dbm.openDb();
	try {
		const command = { schemaVersion: 1, runner: 'gitBash', script: 'run.sh', args: ['local-external-smoke-fixture'] };
		const job = dbm.saveWebuiJob(db, {
			id: JOB_ID,
			tenantId: 'tenant_a',
			actorId: 'operator1',
			actorRole: 'operator',
			kind: 'run',
			label: 'local external runner smoke',
			status: 'queued',
			enqueuedAt: Date.now(),
			route: '/api/run',
			meta: { source: 'local-external-runner-smoke' },
			command,
			resumable: true,
			maxAttempts: 1,
		});
		dbm.appendWebuiJobAudit(db, {
			tenantId: 'tenant_a',
			actorId: 'operator1',
			actorRole: 'operator',
			jobId: JOB_ID,
			kind: 'run',
			event: 'enqueue',
			status: 'queued',
			route: '/api/run',
			command,
			redaction: 'applied',
			data: { label: 'local external runner smoke', source: 'local-external-runner-smoke' },
		});
		return job;
	} finally {
		dbm.closeDb(db);
	}
}

function readSmokeJob(env) {
	process.env.AQA_DB_PATH = env.AQA_DB_PATH;
	const dbm = require('../lib/db.js');
	const db = dbm.openDb();
	try {
		return dbm.getWebuiJob(db, JOB_ID, { tenantId: 'tenant_a' });
	} finally {
		dbm.closeDb(db);
	}
}

async function readSmokeJobEventually(env) {
	const started = Date.now();
	let lastError = null;
	while (Date.now() - started < 10000) {
		try {
			return readSmokeJob(env);
		} catch (e) {
			lastError = e;
			if (!/locked|busy/i.test(String((e && e.message) || e))) throw e;
			await sleep(100);
		}
	}
	throw lastError || new Error('timed out reading smoke job');
}

async function main() {
	const port = await freePort();
	const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aqa-local-external-runner-smoke-'));
	fs.mkdirSync(path.join(dataRoot, 'audit'), { recursive: true });
	fs.mkdirSync(path.join(dataRoot, 'secrets'), { recursive: true });
	const env = smokeEnv({ port, dataRoot });
	const base = `http://127.0.0.1:${port}`;
	let server = null;
	let worker = null;
	try {
		server = spawn(process.execPath, ['webui/server.js'], {
			cwd: PROBE_ROOT,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const serverLog = collect(server, 'webui server');
		await waitForServer(base, OPERATOR_TOKEN, serverLog);

		const unauthRunner = await fetch(`${base}/api/runner/pull`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({}),
		});
		if (unauthRunner.status !== 401) throw new Error(`unauthenticated runner API returned ${unauthRunner.status}`);

		insertSmokeJob(env);

		worker = spawn(process.execPath, [
			'bin/runner-worker.mjs',
			'--api', `${base}/api/runner`,
			'--once',
			'--poll-ms', '50',
			'--heartbeat-ms', '100',
			'--lease-ms', '5000',
			'--no-echo',
		], {
			cwd: PROBE_ROOT,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const workerLog = collect(worker, 'runner worker');
		const exit = await waitForExit(worker, TIMEOUT_MS, 'runner worker');
		if (exit.code !== 0) {
			throw new Error(`runner worker exited ${exit.code} signal=${exit.signal}\n${workerLog()}`);
		}
		await stopChild(server, 'webui server');

		const job = await readSmokeJobEventually(env);
		if (!job) throw new Error('smoke job was not found after worker exit');
		if (job.status !== 'succeeded') throw new Error(`smoke job status ${job.status}; expected succeeded\n${workerLog()}\n${serverLog()}`);
		if (job.workerId !== 'runner-local') throw new Error(`smoke job workerId ${job.workerId}; expected runner-local`);
		if (job.workerTenantId !== 'tenant_a') throw new Error(`smoke job workerTenantId ${job.workerTenantId}; expected tenant_a`);
		if (job.workerDeploymentId !== 'local-external') throw new Error(`smoke job workerDeploymentId ${job.workerDeploymentId}; expected local-external`);
		if (job.attempts !== 1) throw new Error(`smoke job attempts ${job.attempts}; expected 1`);
		const driverStatus = job.result?.driverResult?.status || job.result?.status;
		if (driverStatus !== 'ok') throw new Error(`smoke job driver result ${driverStatus || '(missing)'}; expected ok`);

		const auditText = fs.existsSync(env.WEBUI_AUDIT_SINK_PATH)
			? fs.readFileSync(env.WEBUI_AUDIT_SINK_PATH, 'utf8')
			: '';
		if (!auditText.trim()) throw new Error('audit jsonl sink was not written');
		if (/operator00000001|aqa-secret:tenant_a\/runner-local/.test(auditText)) {
			throw new Error('audit sink exposed raw auth or runner token reference');
		}

		console.log(JSON.stringify({
			ok: true,
			jobId: JOB_ID,
			port,
			status: job.status,
			workerId: job.workerId,
			auditSinkWritten: true,
		}));
	} finally {
		await stopChild(worker, 'runner worker');
		await stopChild(server, 'webui server');
		await sleep(100);
		try { fs.rmSync(dataRoot, { recursive: true, force: true }); } catch {}
	}
}

main().catch((e) => {
	console.error((e && e.stack) || e);
	process.exit(1);
});
