#!/usr/bin/env node
'use strict';

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redactObject, redactText } from '../webui/redact.js';

const PROBE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TRUE_RE = /^(1|true|yes|on)$/i;
const DEFAULT_API = 'http://127.0.0.1:4310/api/runner';
const DEFAULT_POLL_MS = 3000;
const DEFAULT_HEARTBEAT_MS = 5000;
const DEFAULT_LEASE_MS = 60000;
const DEFAULT_MAX_LOG_LINES = 500;

function usage() {
	return `Usage: node bin/runner-worker.mjs [options]

Options:
  --api <url>             Runner API prefix. Defaults to WEBUI_RUNNER_API_URL or ${DEFAULT_API}
  --once                  Poll once; if a job is claimed, run exactly that job then exit.
  --poll-ms <n>           Empty-poll delay. Defaults to ${DEFAULT_POLL_MS}.
  --heartbeat-ms <n>      Active job heartbeat interval. Defaults to ${DEFAULT_HEARTBEAT_MS}.
  --lease-ms <n>          Requested runner lease. Defaults to ${DEFAULT_LEASE_MS}.
  --kind <name>           Optional job kind filter; may be repeated.
  --max-log-lines <n>     Redacted log lines sent on completion. Defaults to ${DEFAULT_MAX_LOG_LINES}.
  --no-echo               Do not echo redacted child output to stderr.
  --help                  Show this message.

Required identity env:
  WEBUI_RUNNER_ID, WEBUI_RUNNER_TENANT_ID, WEBUI_RUNNER_DEPLOYMENT_ID, WEBUI_RUNNER_TOKEN_REF
Optional control-plane auth env:
  WEBUI_RUNNER_API_AUTH_TOKEN or AQA_RUNNER_API_AUTH_TOKEN sends a Bearer token for external-mode WebUI gates.

The worker is outbound-only: it polls the control plane, runs the claimed commandSpec locally, sends
heartbeats, observes cancel requests, and reports complete/fail/canceled through the runner API.`;
}

function positiveInt(value, fallback, label) {
	if (value == null || value === '') return fallback;
	const n = Number(value);
	if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a positive integer`);
	return Math.trunc(n);
}

function parseArgs(argv) {
	const opts = {
		api: process.env.WEBUI_RUNNER_API_URL || process.env.AQA_RUNNER_API_URL || DEFAULT_API,
		once: false,
		pollMs: positiveInt(process.env.WEBUI_RUNNER_POLL_MS, DEFAULT_POLL_MS, 'WEBUI_RUNNER_POLL_MS'),
		heartbeatMs: positiveInt(process.env.WEBUI_RUNNER_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS, 'WEBUI_RUNNER_HEARTBEAT_MS'),
		leaseMs: positiveInt(process.env.WEBUI_RUNNER_LEASE_MS, DEFAULT_LEASE_MS, 'WEBUI_RUNNER_LEASE_MS'),
		maxLogLines: positiveInt(process.env.WEBUI_RUNNER_MAX_LOG_LINES, DEFAULT_MAX_LOG_LINES, 'WEBUI_RUNNER_MAX_LOG_LINES'),
		kinds: [],
		echo: !TRUE_RE.test(String(process.env.WEBUI_RUNNER_NO_ECHO || '').trim()),
		apiAuthToken: String(process.env.WEBUI_RUNNER_API_AUTH_TOKEN || process.env.AQA_RUNNER_API_AUTH_TOKEN || '').trim(),
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = () => {
			i += 1;
			if (i >= argv.length) throw new Error(`${arg} requires a value`);
			return argv[i];
		};
		if (arg === '--help' || arg === '-h') opts.help = true;
		else if (arg === '--api') opts.api = next();
		else if (arg === '--once') opts.once = true;
		else if (arg === '--poll-ms') opts.pollMs = positiveInt(next(), opts.pollMs, '--poll-ms');
		else if (arg === '--heartbeat-ms') opts.heartbeatMs = positiveInt(next(), opts.heartbeatMs, '--heartbeat-ms');
		else if (arg === '--lease-ms') opts.leaseMs = positiveInt(next(), opts.leaseMs, '--lease-ms');
		else if (arg === '--kind') opts.kinds.push(next());
		else if (arg === '--max-log-lines') opts.maxLogLines = positiveInt(next(), opts.maxLogLines, '--max-log-lines');
		else if (arg === '--no-echo') opts.echo = false;
		else throw new Error(`unknown option: ${arg}`);
	}
	return opts;
}

function runnerIdentity(env = process.env) {
	const identity = {
		runnerId: String(env.WEBUI_RUNNER_ID || env.AQA_RUNNER_ID || env.WEBUI_WORKER_ID || '').trim(),
		tenantId: String(env.WEBUI_RUNNER_TENANT_ID || env.AQA_RUNNER_TENANT_ID || env.WEBUI_TENANT_ID || env.AQA_TENANT_ID || '').trim(),
		deploymentId: String(env.WEBUI_RUNNER_DEPLOYMENT_ID || env.AQA_RUNNER_DEPLOYMENT_ID || '').trim(),
		tokenRef: String(env.WEBUI_RUNNER_TOKEN_REF || env.AQA_RUNNER_TOKEN_REF || '').trim(),
		mode: String(env.WEBUI_RUNNER_MODE || env.AQA_RUNNER_MODE || 'production').trim() || 'production',
	};
	for (const [key, value] of Object.entries(identity)) {
		if (key !== 'mode' && !value) throw new Error(`runner worker requires ${key}`);
	}
	return identity;
}

function normalizeApiPrefix(raw) {
	const text = String(raw || DEFAULT_API).trim().replace(/\/+$/, '');
	if (!/^https?:\/\//i.test(text)) throw new Error('runner API URL must be http(s)');
	return text.endsWith('/api/runner') ? text : `${text}/api/runner`;
}

function safeJson(value) {
	return redactObject(value, 1200);
}

function runnerApiHeaders(options = {}) {
	const headers = { 'Content-Type': 'application/json; charset=utf-8' };
	const token = String(options.apiAuthToken || '').trim();
	if (token) headers.Authorization = /^Bearer\s+/i.test(token) ? token : `Bearer ${token}`;
	return headers;
}

function apiErrorText(status, body) {
	const msg = body?.error || body?.message || body?.code || `HTTP ${status}`;
	return redactText(msg, `runner API HTTP ${status}`, 500);
}

async function postRunnerApi(op, payload, options) {
	const api = normalizeApiPrefix(options.api);
	const identity = options.identity;
	const body = {
		op,
		runnerMode: identity.mode,
		runnerId: identity.runnerId,
		tenantId: identity.tenantId,
		deploymentId: identity.deploymentId,
		tokenRef: identity.tokenRef,
		leaseMs: options.leaseMs,
		...payload,
	};
	const res = await fetch(`${api}/${op}`, {
		method: 'POST',
		headers: runnerApiHeaders(options),
		body: JSON.stringify(body),
	});
	let parsed = null;
	try { parsed = await res.json(); } catch {}
	if (!res.ok || !parsed?.ok) {
		const err = new Error(apiErrorText(res.status, parsed));
		err.status = res.status;
		err.body = safeJson(parsed || {});
		throw err;
	}
	return parsed;
}

function safeRelativeScript(script) {
	const normalized = String(script || '').trim().replace(/\\/g, '/');
	if (!normalized || normalized.includes('\0') || normalized.includes('..') || path.isAbsolute(normalized)) {
		throw new Error('commandSpec script must be a safe repo-relative path');
	}
	return normalized;
}

function gitBashPath(env = process.env) {
	return env.AQA_GIT_BASH || env.GIT_BASH || (process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : 'bash');
}

export function commandForSpec(spec, env = process.env) {
	if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('claimed job has no commandSpec');
	const runner = String(spec.runner || '').trim();
	const args = Array.isArray(spec.args) ? spec.args.map((arg) => String(arg)) : [];
	if (runner === 'gitBash') {
		return { file: gitBashPath(env), args: [safeRelativeScript(spec.script), ...args], cwd: PROBE_ROOT, runner };
	}
	if (runner === 'nodeLeaf') {
		return { file: process.execPath, args: [safeRelativeScript(spec.script), ...args], cwd: PROBE_ROOT, runner };
	}
	if (runner === 'testDouble' && TRUE_RE.test(String(env.AQA_RUNNER_ALLOW_TEST_DOUBLE || '').trim())) {
		return { file: process.execPath, args: ['-e', String(spec.script || '')], cwd: PROBE_ROOT, runner };
	}
	throw new Error(`unsupported commandSpec runner "${runner || '(empty)'}"`);
}

function commandSummary(spec) {
	return {
		runner: String(spec?.runner || ''),
		script: redactText(spec?.script || '', '', 300),
		args: Array.isArray(spec?.args) ? spec.args.map((arg) => redactText(arg, '', 300)) : [],
	};
}

function pushRedactedLog(logs, stream, line, options) {
	const safeLine = redactText(line, '', 2000);
	if (!safeLine) return;
	logs.push({ at: new Date().toISOString(), stream, line: safeLine });
	if (logs.length > options.maxLogLines) logs.splice(0, logs.length - options.maxLogLines);
	if (options.echo) console.error(`[runner-worker:${stream}] ${safeLine}`);
}

function wireStream(stream, name, logs, options, state) {
	let buffer = '';
	stream.setEncoding('utf8');
	stream.on('data', (chunk) => {
		buffer += chunk;
		let nl;
		while ((nl = buffer.indexOf('\n')) >= 0) {
			const raw = buffer.slice(0, nl).replace(/\r$/, '');
			captureStructuredResult(raw, state);
			pushRedactedLog(logs, name, raw, options);
			buffer = buffer.slice(nl + 1);
		}
	});
	stream.on('end', () => {
		if (!buffer) return;
		const raw = buffer.replace(/\r$/, '');
		captureStructuredResult(raw, state);
		pushRedactedLog(logs, name, raw, options);
		buffer = '';
	});
}

function captureStructuredResult(line, state) {
	const text = String(line || '').trim();
	if (!text.startsWith('AQA_JOB_RESULT=')) return;
	try {
		state.driverResult = redactObject(JSON.parse(text.slice('AQA_JOB_RESULT='.length)), 1200);
	} catch {
		state.driverResult = { status: 'failed', error: 'malformed structured job result' };
	}
}

function waitForClose(child) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (code, signal) => {
			if (settled) return;
			settled = true;
			resolve({ code: code == null ? -1 : code, signal: signal || null });
		};
		child.on('error', (e) => done(-1, `error:${redactText((e && e.message) || e, 'spawn error', 120)}`));
		child.on('close', done);
	});
}

function stopChild(child) {
	if (!child || child.killed) return;
	try { child.kill(); } catch {}
}

async function heartbeatUntilClosed(job, child, options, state) {
	const heartbeat = async () => {
		const out = await postRunnerApi('heartbeat', {
			jobId: job.id,
			status: 'running',
			pid: child.pid,
			runId: state.runId || null,
		}, options);
		if (out.cancelRequested || out.job?.cancelRequested || out.job?.status === 'canceling') {
			state.cancelRequested = true;
			stopChild(child);
		}
	};
	try {
		await heartbeat();
	} catch (e) {
		state.heartbeatError = redactText((e && e.message) || e, 'heartbeat failed', 500);
		stopChild(child);
	}
	const timer = setInterval(() => {
		heartbeat().catch((e) => {
			state.heartbeatError = redactText((e && e.message) || e, 'heartbeat failed', 500);
			stopChild(child);
		});
	}, options.heartbeatMs);
	return () => clearInterval(timer);
}

function terminalStatus(closeResult, state) {
	if (state.cancelRequested) return 'canceled';
	if (state.heartbeatError) return 'failed';
	return closeResult.code === 0 ? 'succeeded' : 'failed';
}

async function completeJob(job, status, closeResult, spec, logs, state, options) {
	const error = state.heartbeatError || (status === 'failed' ? `exit code ${closeResult.code}` : null);
	const result = {
		status,
		command: commandSummary(spec),
		logLines: logs.length,
		...(state.driverResult ? { driverResult: state.driverResult } : {}),
		...(state.cancelRequested ? { cancelRequested: true } : {}),
	};
	await postRunnerApi('complete', {
		jobId: job.id,
		status,
		exitCode: closeResult.code,
		exitSignal: closeResult.signal,
		error,
		failureReason: error,
		result,
		log: logs,
	}, options);
}

async function completeCanceledBeforeSpawn(job, spec, logs, state, options) {
	state.cancelRequested = true;
	await completeJob(job, 'canceled', { code: -1, signal: 'cancel-before-spawn' }, spec, logs, state, options);
	console.error(`[runner-worker] completed ${job.id} status=canceled before spawn`);
	return { ok: true, status: 'canceled', jobId: job.id };
}

async function observeCancelBeforeSpawn(job, spec, logs, state, options) {
	if (job.cancelRequested || job.cancelled || job.status === 'canceling') {
		return completeCanceledBeforeSpawn(job, spec, logs, state, options);
	}
	try {
		const out = await postRunnerApi('heartbeat', {
			jobId: job.id,
			status: 'claimed',
			runId: state.runId || null,
		}, options);
		if (out.cancelRequested || out.job?.cancelRequested || out.job?.status === 'canceling' || out.job?.status === 'canceled') {
			return completeCanceledBeforeSpawn(job, spec, logs, state, options);
		}
		return null;
	} catch (e) {
		state.heartbeatError = redactText((e && e.message) || e, 'heartbeat failed before spawn', 500);
		await completeJob(job, 'failed', { code: -1, signal: 'heartbeat-before-spawn-error' }, spec, logs, state, options);
		return { ok: false, status: 'failed', jobId: job.id };
	}
}

export async function runClaimedJob(job, options) {
	const spec = job.commandSpec || job.command || job.meta?.commandSpec;
	const logs = [];
	const state = { cancelRequested: false, heartbeatError: '', driverResult: null, runId: null };
	let command = null;
	try {
		command = commandForSpec(spec);
	} catch (e) {
		const error = redactText((e && e.message) || e, 'commandSpec refused', 500);
		await postRunnerApi('complete', {
			jobId: job.id,
			status: 'failed',
			exitCode: -1,
			error,
			failureReason: error,
			result: { status: 'failed', error, command: commandSummary(spec) },
			log: [{ at: new Date().toISOString(), stream: 'worker', line: error }],
		}, options);
		return { ok: false, status: 'failed', jobId: job.id };
	}
	const preSpawnResult = await observeCancelBeforeSpawn(job, spec, logs, state, options);
	if (preSpawnResult) return preSpawnResult;
	console.error(`[runner-worker] claimed ${job.id} runner=${command.runner} script=${command.args[0]}`);
	const child = spawn(command.file, command.args, {
		cwd: command.cwd,
		env: {
			...process.env,
			AQA_TENANT_ID: options.identity.tenantId,
			WEBUI_TENANT_ID: options.identity.tenantId,
			AQA_RUNNER_ID: options.identity.runnerId,
			WEBUI_RUNNER_ID: options.identity.runnerId,
		},
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (child.stdout) wireStream(child.stdout, 'stdout', logs, options, state);
	if (child.stderr) wireStream(child.stderr, 'stderr', logs, options, state);
	const stopHeartbeat = await heartbeatUntilClosed(job, child, options, state);
	const closeResult = await waitForClose(child);
	stopHeartbeat();
	const status = terminalStatus(closeResult, state);
	await completeJob(job, status, closeResult, spec, logs, state, options);
	console.error(`[runner-worker] completed ${job.id} status=${status} exitCode=${closeResult.code}`);
	return { ok: status !== 'failed', status, jobId: job.id };
}

async function pollOnce(options) {
	const pull = await postRunnerApi('pull', {
		...(options.kinds.length ? { kinds: options.kinds } : {}),
	}, options);
	if (pull.empty || !pull.job) return { worked: false };
	let job = pull.job;
	if (job.status === 'queued') {
		const claimed = await postRunnerApi('claim', { jobId: job.id }, options);
		job = claimed.job;
	}
	return { worked: true, result: await runClaimedJob(job, options) };
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runWorker(rawOptions = {}) {
	const options = {
		...rawOptions,
		api: normalizeApiPrefix(rawOptions.api || DEFAULT_API),
		identity: rawOptions.identity || runnerIdentity(),
		kinds: Array.isArray(rawOptions.kinds) ? rawOptions.kinds : [],
	};
	let stopping = false;
	const stop = () => { stopping = true; };
	process.once('SIGINT', stop);
	process.once('SIGTERM', stop);
	do {
		try {
			const out = await pollOnce(options);
			if (options.once) return out;
			if (!out.worked) await sleep(options.pollMs);
		} catch (e) {
			console.error(`[runner-worker] ${redactText((e && e.message) || e, 'worker error', 800)}`);
			if (options.once) throw e;
			await sleep(options.pollMs);
		}
	} while (!stopping);
	return { worked: false, stopped: true };
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	if (opts.help) {
		console.log(usage());
		return;
	}
	await runWorker({
		...opts,
		api: normalizeApiPrefix(opts.api),
		identity: runnerIdentity(),
	});
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	main().catch((e) => {
		console.error(`[runner-worker] ${redactText((e && e.message) || e, 'worker failed', 800)}`);
		process.exit(1);
	});
}
