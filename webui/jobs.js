// webui/jobs.js - single-slot serial job queue for browser-driving Playwright jobs.
//
// Headed browser jobs share the operator desktop and persisted auth/profile files, so WebUI
// runs at most one browser-driving job (run / record / verify / auth) at a time. This module
// chains them on a single promise tail: a job's child must reach 'close' before the next job's
// child is spawned. Read-only HTTP endpoints do not go through here and run concurrently.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { gitBash, killTree, nodeLeaf } from './spawn.js';
import { redactObject, redactText } from './redact.js';
import { isSecretBearingPath } from './secrets.js';

const require = createRequire(import.meta.url);
const dbm = require('../lib/db.js');
const auditSink = require('../lib/audit-sink.js');
const runnerContracts = require('../lib/runner-contract.js');

const MAX_LOG = 2000; // per-job log ring-buffer cap
const MAX_JOBS = 50; // most-recent job records kept in memory
// Watchdog: a child that never reaches 'close' would otherwise stall the single slot forever.
// Cap each job; on timeout we tree-kill it so its 'close' fires and the chain advances.
// Generous default (the full suite is ~5 min); override with WEBUI_JOB_TIMEOUT_MS.
const JOB_TIMEOUT_MS = Number(process.env.WEBUI_JOB_TIMEOUT_MS) || 20 * 60 * 1000;
const JOB_KILL_GRACE_MS = Number(process.env.WEBUI_JOB_KILL_GRACE_MS) || 15000;
const JOB_HEARTBEAT_STALE_MS = Number(process.env.WEBUI_JOB_HEARTBEAT_STALE_MS) || 60 * 1000;
const JOB_LEASE_MS = Number(process.env.WEBUI_JOB_LEASE_MS) || Math.max(JOB_HEARTBEAT_STALE_MS * 2, 30000);
const JOB_HEARTBEAT_INTERVAL_MS = Number(process.env.WEBUI_JOB_HEARTBEAT_INTERVAL_MS) || Math.max(250, Math.min(5000, Math.floor(JOB_LEASE_MS / 3)));
const JOB_SLOW_MS = Number(process.env.WEBUI_JOB_SLOW_MS) || 5 * 60 * 1000;
const PROBE_ROOT = path.resolve(import.meta.dirname, '..');
const JOB_JOURNAL = process.env.WEBUI_JOB_JOURNAL || path.join(PROBE_ROOT, 'data', 'webui-jobs.jsonl');
const TERMINAL_STATUSES = new Set(['done', 'failed', 'cancelled', 'interrupted']);
const NAME_RE = /^[A-Za-z0-9_-]+$/;
const TEST_GLOB_RE = /^[A-Za-z0-9_*?-]+$/;
const READONLY_RUN_MODES = new Set(['staging', 'live-readonly']);
const COMMAND_ENV_KEYS = new Set(['AQA_DEV_INTEGRATION_READONLY', 'AQA_RUN_MODE', 'AQA_TARGET_ALLOWLIST', 'AQA_EGRESS_RESOLVER_EVIDENCE', 'AQA_EGRESS_CONNECTION_IPS']);
const RUN_ARTIFACTS = [
	{ rel: 'report.json', kind: 'report', redaction: 'text-redacted-on-read' },
	{ rel: 'report.junit.xml', kind: 'junit', redaction: 'text-redacted-on-read' },
	{ rel: 'results.tsv', kind: 'results', redaction: 'text-redacted-on-read' },
];
const TRUE_RE = /^(1|true|yes|on)$/i;
const SERVICE_MODE_RE = /^(external|service|prod|production)$/i;

export const validateRunnerDeployment = runnerContracts.validateRunnerDeployment;

const RUNNER = validateRunnerDeployment();
const WORKER_ID = RUNNER.runnerId;

function runnerBindingForJob(job) {
	return {
		runnerTenantId: RUNNER.tenantBindingRequired ? RUNNER.tenantId : job?.tenantId,
		runnerDeploymentId: RUNNER.deploymentId,
	};
}

let seq = 0;
let tail = Promise.resolve(); // the serial chain
let runningId = null; // id of the job whose child is currently alive, or null
const pending = []; // FIFO of queued (not-yet-running) job ids
const jobs = new Map(); // id -> job record

function envFlag(...names) {
	return names.some((name) => TRUE_RE.test(String(process.env[name] || '').trim()));
}

function strictDurableJobsRequired() {
	if (envFlag('WEBUI_REQUIRE_DURABLE_JOBS', 'WEBUI_EXTERNAL_MODE', 'AQA_EXTERNAL_MODE', 'WEBUI_SERVICE_MODE', 'AQA_SERVICE_MODE')) return true;
	return SERVICE_MODE_RE.test(String(process.env.WEBUI_MODE || process.env.AQA_MODE || process.env.WEBUI_DEPLOYMENT_MODE || '').trim());
}

function failClosedDurableError(action, e) {
	const reason = sanitizeDiagnosticText((e && e.message) || e, 'durable job storage error');
	return new Error(`durable job ${action} failed (fail-closed): ${reason}`);
}

function durationMs(job, now = Date.now()) {
	if (!job?.startedAt) return null;
	return (job.endedAt || now) - job.startedAt;
}

function formatDurationMs(ms) {
	return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

function sanitizeDiagnosticText(value, fallback = '') {
	return redactText(value, fallback, 320);
}

function jobArtifactLinks(job) {
	if (!job?.runId) return null;
	return {
		runId: job.runId,
		runUrl: `/api/runs/${job.runId}`,
		reportUrl: `/artifacts/${job.runId}/report.json`,
		junitUrl: `/artifacts/${job.runId}/report.junit.xml`,
		resultsUrl: `/artifacts/${job.runId}/results.tsv`,
	};
}

function sha256File(filePath) {
	return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`;
}

function recordJobArtifacts(job) {
	if (!job?.runId || job.kind !== 'run') return;
	try {
		dbCall((db) => {
			for (const item of RUN_ARTIFACTS) {
				const relPath = `artifacts/${job.runId}/${item.rel}`;
				if (isSecretBearingPath(relPath)) continue;
				const full = path.join(PROBE_ROOT, relPath);
				let st;
				try { st = fs.statSync(full); } catch { continue; }
				if (!st.isFile()) continue;
				dbm.saveWebuiArtifact(db, {
					tenantId: job.tenantId,
					actorId: job.actorId,
					jobId: job.id,
					runId: job.runId,
					path: relPath,
					kind: item.kind,
					sha256: sha256File(full),
					bytes: st.size,
					redaction: item.redaction,
					retention: job.retention || 'ephemeral-debug',
					deleteAfter: job.deleteAfter ? new Date(job.deleteAfter).toISOString() : null,
					meta: { source: 'webui-job', durableStatus: durableStatusFromJob(job), jobRetention: job.retention || 'ephemeral-debug' },
				});
			}
		});
	} catch (e) {
		appendJobJournal(job, 'artifact_metadata_error', { error: (e && e.message) || e });
	}
}

function resultFailureReason(result) {
	if (!result || typeof result !== 'object') return '';
	const direct = result.error || result.reason || result.message || result.refused;
	const status = String(result.status || '').toLowerCase();
	if (direct && ['failed', 'fail', 'error', 'refused'].includes(status)) return direct;
	if (Array.isArray(result.results)) {
		const failed = result.results.find((r) => r && ['failed', 'fail', 'error'].includes(String(r.status || '').toLowerCase()));
		if (failed) {
			const prefix = failed.doc_id || failed.id || failed.key;
			const reason = failed.error || failed.reason || failed.message || 'failed result';
			return prefix ? `${prefix}: ${reason}` : reason;
		}
	}
	return '';
}

function safeFailureReason(job) {
	if (!job) return null;
	if (job.durableStatus === 'interrupted' || job.status === 'interrupted') {
		return sanitizeDiagnosticText(job.failureReason || job.error || 'interrupted during server restart', 'interrupted during server restart');
	}
	let structured = resultFailureReason(job.result);
	if (!structured && job.status === 'failed' && job.result && typeof job.result === 'object') {
		structured = job.result.error || job.result.reason || job.result.message || job.result.refused || '';
	}
	const resultStatus = String(job.result?.status || '').toLowerCase();
	if (structured && (job.status === 'failed' || ['failed', 'fail', 'error', 'refused'].includes(resultStatus))) {
		return sanitizeDiagnosticText(structured, 'structured job failure');
	}
	if (job.timedOut) return `timeout after ${formatDurationMs(JOB_TIMEOUT_MS)}`;
	if (job.exitCode != null && job.exitCode !== 0) return `exit code ${job.exitCode}`;
	if (job.error) {
		const text = String(job.error).toLowerCase();
		if (text.includes('malformed structured job result')) return 'malformed structured job result';
		return sanitizeDiagnosticText(job.error, 'job error');
	}
	return job.status === 'failed' ? 'failed' : null;
}

function heartbeatState(job, now = Date.now()) {
	if (!job?.startedAt) return job?.status === 'queued' ? 'queued' : 'idle';
	if (job.status !== 'running') return 'terminal';
	const basis = job.lastOutputAt || job.startedAt;
	return now - basis > JOB_HEARTBEAT_STALE_MS ? 'stale' : 'active';
}

function jobDiagnostics(job, now = Date.now()) {
	const dur = durationMs(job, now);
	const heartbeatAgeMs = job.startedAt ? now - (job.lastOutputAt || job.startedAt) : null;
	const state = heartbeatState(job, now);
	const slow = dur != null && dur > JOB_SLOW_MS;
	const signals = [];
	if (job.timedOut) signals.push('timeout');
	if (job.cancelled || job.status === 'cancelled') signals.push('cancelled');
	if (job.durableStatus === 'interrupted' || job.status === 'interrupted') signals.push('interrupted');
	if (job.exitSignal) signals.push(`signal:${job.exitSignal}`);
	if (state === 'stale') signals.push('stale-heartbeat');
	if (slow) signals.push('slow');
	if (job.error) signals.push(job.error === 'malformed structured job result' ? 'malformed-result' : 'job-error');
	return {
		failureReason: job.failureReason || safeFailureReason(job),
		timeoutMs: JOB_TIMEOUT_MS,
		killGraceMs: JOB_KILL_GRACE_MS,
		heartbeatStaleMs: JOB_HEARTBEAT_STALE_MS,
		slowMs: JOB_SLOW_MS,
		lastLogAt: job.lastLogAt,
		lastHeartbeatAt: job.lastOutputAt,
		heartbeatAgeMs,
		heartbeatState: state,
		slow,
		unstable: signals.length > 0,
		signals,
		artifacts: jobArtifactLinks(job),
	};
}

function currentTenantId() {
	return String(process.env.WEBUI_TENANT_ID || process.env.AQA_TENANT_ID || 'local').trim() || 'local';
}

function currentActorId() {
	return String(process.env.WEBUI_ACTOR_ID || process.env.AQA_WEBUI_ACTOR || process.env.AQA_ACTOR_ID || 'local').trim() || 'local';
}

function currentActorRole() {
	return String(process.env.WEBUI_ACTOR_ROLE || process.env.AQA_WEBUI_ROLE || process.env.AQA_ACTOR_ROLE || 'operator').trim() || 'operator';
}

function contextTenantId(context) {
	if (!context || typeof context !== 'object') return '';
	return String(context.tenantId || context.tenant?.id || context.actor?.tenantId || '').trim();
}

function contextActorId(context) {
	if (!context || typeof context !== 'object') return '';
	return String(context.actorId || context.actor?.id || '').trim();
}

function contextActorRole(context) {
	if (!context || typeof context !== 'object') return '';
	return String(context.actorRole || context.role || context.actor?.role || '').trim();
}

function contextSessionId(context) {
	if (!context || typeof context !== 'object') return '';
	return String(context.sessionId || context.session?.id || context.auth?.sessionId || context.auth?.sid || '').trim();
}

function contextRoute(context) {
	if (!context || typeof context !== 'object') return '';
	return String(context.route || context.path || context.url || context.request?.route || context.request?.path || '').trim();
}

function jobIdentity(context = null, explicit = {}) {
	return {
		tenantId: String(explicit.tenantId || contextTenantId(context) || currentTenantId()).trim() || 'local',
		actorId: String(explicit.actorId || contextActorId(context) || currentActorId()).trim() || 'local',
		actorRole: String(explicit.actorRole || contextActorRole(context) || currentActorRole()).trim() || 'operator',
		sessionId: String(explicit.sessionId || contextSessionId(context) || '').trim() || null,
		route: String(explicit.route || contextRoute(context) || '').trim() || null,
	};
}

function canAccessJob(job, context = null) {
	if (!job) return false;
	const tenantId = contextTenantId(context);
	return !tenantId || job.tenantId === tenantId;
}

function normalizeExactTargetAllowlist(value) {
	const parts = String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
	if (!parts.length) throw new Error('AQA_TARGET_ALLOWLIST is required');
	const origins = [];
	for (const part of parts) {
		if (part.includes('*')) throw new Error('AQA_TARGET_ALLOWLIST must use exact origins, not wildcards');
		let url;
		try {
			url = new URL(part);
		} catch {
			throw new Error('AQA_TARGET_ALLOWLIST entries must be http(s) origins');
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('AQA_TARGET_ALLOWLIST entries must be http(s)');
		if (url.username || url.password) throw new Error('AQA_TARGET_ALLOWLIST entries must not contain credentials');
		if (url.pathname !== '/' || url.search || url.hash) throw new Error('AQA_TARGET_ALLOWLIST entries must be origins only');
		origins.push(url.origin);
	}
	return [...new Set(origins)].join(',');
}

function normalizeJsonEnv(value, label) {
	const text = String(value || '').trim();
	if (!text) return '';
	if (text.length > 65536) throw new Error(`${label} is too large`);
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`${label} must be JSON`);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
	return JSON.stringify(parsed);
}

function devReadonlyFlowArg(args, allowlist) {
	if (!allowlist) return '';
	if (args.length === 1 && NAME_RE.test(args[0])) return args[0];
	if (args.length === 2 && args[0] === '--validate-only' && NAME_RE.test(args[1])) return args[1];
	if (args.length === 3 && args[0] === '--allowlist' && normalizeExactTargetAllowlist(args[1]) === allowlist && NAME_RE.test(args[2])) return args[2];
	if (args.length === 4 && args[0] === '--validate-only' && args[1] === '--allowlist' && normalizeExactTargetAllowlist(args[2]) === allowlist && NAME_RE.test(args[3])) return args[3];
	return '';
}

function normalizeCommandEnv(value) {
	if (value == null) return {};
	if (typeof value !== 'object' || Array.isArray(value)) throw new Error('commandSpec.env must be an object');
	const out = {};
	for (const [key, raw] of Object.entries(value)) {
		if (raw == null || raw === '') continue;
		if (!COMMAND_ENV_KEYS.has(key)) throw new Error(`commandSpec.env key "${key}" is not WebUI-safe`);
		if (key === 'AQA_DEV_INTEGRATION_READONLY') {
			if (String(raw).trim() !== '1') throw new Error('AQA_DEV_INTEGRATION_READONLY must be 1');
			out.AQA_DEV_INTEGRATION_READONLY = '1';
		}
		if (key === 'AQA_RUN_MODE') {
			const mode = String(raw).trim();
			if (!READONLY_RUN_MODES.has(mode)) throw new Error('AQA_RUN_MODE must be staging or live-readonly');
			out.AQA_RUN_MODE = mode;
		}
		if (key === 'AQA_TARGET_ALLOWLIST') {
			out.AQA_TARGET_ALLOWLIST = normalizeExactTargetAllowlist(raw);
		}
		if (key === 'AQA_EGRESS_RESOLVER_EVIDENCE') {
			out.AQA_EGRESS_RESOLVER_EVIDENCE = normalizeJsonEnv(raw, key);
		}
		if (key === 'AQA_EGRESS_CONNECTION_IPS') {
			out.AQA_EGRESS_CONNECTION_IPS = normalizeJsonEnv(raw, key);
		}
	}
	return out;
}

function validateCommandSpec(spec) {
	if (!spec) return null;
	if (typeof spec !== 'object' || Array.isArray(spec)) throw new Error('commandSpec must be an object');
	const runner = String(spec.runner || '').trim();
	const script = String(spec.script || '').trim().replace(/\\/g, '/');
	const args = Array.isArray(spec.args) ? spec.args.map((a) => String(a)) : [];
	const env = normalizeCommandEnv(spec.env);
	const hasEnv = Object.keys(env).length > 0;
	const out = { schemaVersion: 1, runner, script, args, ...(hasEnv ? { env } : {}) };
	if (runner === 'gitBash' && script === 'run.sh') {
		if (!hasEnv && args.length <= 1 && args.every((a) => TEST_GLOB_RE.test(a))) return out;
	}
	if (runner === 'gitBash' && script === 'bin/operator-staging-readonly.sh') {
		const flowArg = args.length === 1 ? args[0] : args.length === 2 && args[0] === '--validate-only' ? args[1] : '';
		if (flowArg && NAME_RE.test(flowArg) && READONLY_RUN_MODES.has(env.AQA_RUN_MODE) && env.AQA_TARGET_ALLOWLIST) return out;
	}
	if (runner === 'gitBash' && script === 'bin/dev-integration-readonly.sh') {
		const flowArg = devReadonlyFlowArg(args, env.AQA_TARGET_ALLOWLIST);
		if (flowArg && NAME_RE.test(flowArg) && env.AQA_TARGET_ALLOWLIST) return out;
	}
	if (runner === 'gitBash' && (script === 'bin/sync-system.sh' || script === 'bin/enrich-system.sh')) {
		if (!hasEnv && args.length === 2 && args[0] === '--system' && NAME_RE.test(args[1])) return out;
	}
	if (runner === 'nodeLeaf' && script === 'bin/play-flow.mjs') {
		const m = args.length === 3 && args[0] === '--flow' && args[2] === '--verify'
			? /^flows\/([A-Za-z0-9_-]+)\.flow\.json$/.exec(args[1])
			: null;
		if (!hasEnv && m) return out;
		if (m && env.AQA_DEV_INTEGRATION_READONLY === '1' && READONLY_RUN_MODES.has(env.AQA_RUN_MODE) && env.AQA_TARGET_ALLOWLIST) return out;
	}
	if (runner === 'nodeLeaf' && script === 'bin/pw-rpa.mjs') {
		if (!hasEnv && args.length === 3 && ['analyze', 'sync', 'enrich'].includes(args[0]) && args[1] === '--system' && NAME_RE.test(args[2])) return out;
	}
	throw new Error('commandSpec is not WebUI-safe for durable resume');
}

function spawnEnv(identity = {}, extraEnv = {}) {
	const env = { ...(extraEnv || {}) };
	if (identity.tenantId) {
		env.AQA_TENANT_ID = identity.tenantId;
		env.WEBUI_TENANT_ID = identity.tenantId;
	}
	if (identity.actorId) {
		env.AQA_ACTOR_ID = identity.actorId;
		env.WEBUI_ACTOR_ID = identity.actorId;
	}
	return Object.keys(env).length ? env : null;
}

function spawnFromCommandSpec(spec, identity = {}) {
	const safe = validateCommandSpec(spec);
	if (!safe) return null;
	return () => safe.runner === 'gitBash' ? gitBash(safe.script, safe.args, spawnEnv(identity, safe.env)) : nodeLeaf(safe.script, safe.args, spawnEnv(identity, safe.env));
}

function defaultNonResumableReason(kind) {
	return `${kind || 'job'} has no persisted WebUI-safe command spec`;
}

function retryMaxAttempts(meta = {}) {
	const raw = meta.maxAttempts ?? meta.max_attempts ?? meta.retryMaxAttempts ?? meta.retry_max_attempts ?? meta.retry?.maxAttempts;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.min(10, Math.trunc(n)) : 1;
}

function dbCall(fn) {
	const db = dbm.openDb();
	try { return fn(db); }
	finally { dbm.closeDb(db); }
}

function durableStatusFromJob(job) {
	if (job?.durableStatus) return job.durableStatus;
	if (job?.timedOut) return 'expired';
	if (job?.status === 'done') return 'succeeded';
	if (job?.status === 'cancelled') return 'canceled';
	if (job?.status === 'failed') return 'failed';
	if (job?.status === 'interrupted') return 'interrupted';
	if (job?.status === 'running') return job.cancelled ? 'canceling' : 'running';
	return 'queued';
}

function publicStatusFromDurable(status) {
	switch (status) {
		case 'succeeded': return 'done';
		case 'canceled': return 'cancelled';
		case 'expired': return 'failed';
		case 'interrupted': return 'failed';
		case 'claimed': return 'queued';
		case 'canceling': return 'running';
		default: return status || 'queued';
	}
}

function isTerminal(job) {
	return TERMINAL_STATUSES.has(job?.status);
}

function terminalAuditEvent(job) {
	const durable = durableStatusFromJob(job);
	return durable === 'failed' || durable === 'expired' || durable === 'interrupted' ? 'fail' : 'finish';
}

function hashObject(value) {
	if (value == null) return null;
	return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function jobTargetSystem(job) {
	return job?.meta?.system || job?.meta?.app || job?.meta?.targetSystem || null;
}

function durableJobRecord(job) {
	return {
		id: job.id,
		tenantId: job.tenantId,
		actorId: job.actorId,
		actorRole: job.actorRole,
		sessionId: job.sessionId,
		kind: job.kind,
		label: redactText(job.label, '', 240),
		meta: redactObject(job.meta || {}),
		route: job.route,
		status: durableStatusFromJob(job),
		exitCode: job.exitCode,
		cancelled: job.cancelled,
		cancelRequestedAt: job.cancelRequestedAt,
		timedOut: job.timedOut,
		enqueuedAt: job.enqueuedAt,
		claimedAt: job.claimedAt,
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		pid: job.pid,
		workerId: job.workerId,
		workerTenantId: job.workerTenantId,
		workerDeploymentId: job.workerDeploymentId,
		lastHeartbeatAt: job.lastHeartbeatAt,
		claimExpiresAt: job.claimExpiresAt,
		attempts: job.attempts,
		maxAttempts: job.maxAttempts,
		runId: job.runId,
		exitSignal: job.exitSignal,
		error: job.error ? redactText(job.error, '', 320) : null,
		failureReason: job.failureReason || safeFailureReason(job),
		result: redactObject(job.result),
		log: (job.log || []).slice(-MAX_LOG).map((line) => redactText(line, '', 2000)),
		command: job.command || null,
		resumable: !!job.command,
		nonResumableReason: job.command ? null : (job.nonResumableReason || defaultNonResumableReason(job.kind)),
		retention: job.retention || 'ephemeral-debug',
		deleteAfter: job.deleteAfter,
	};
}

function persistJob(job, opts = {}) {
	const required = opts.required ?? strictDurableJobsRequired();
	try {
		dbCall((db) => dbm.saveWebuiJob(db, durableJobRecord(job)));
		return true;
	} catch (e) {
		appendJobJournal(job, 'persist_error', { error: (e && e.message) || e });
		if (required) throw failClosedDurableError('persist', e);
		return false;
	}
}

function syncJobFromDurable(job, row) {
	if (!job || !row) return job;
	job.tenantId = row.tenantId || job.tenantId;
	job.actorId = row.actorId || job.actorId;
	job.actorRole = row.actorRole || job.actorRole;
	job.sessionId = row.sessionId || job.sessionId;
	job.route = row.route || job.route;
	job.durableStatus = row.status || job.durableStatus;
	job.status = publicStatusFromDurable(row.status);
	job.exitCode = row.exitCode;
	job.cancelled = !!row.cancelled;
	job.cancelRequestedAt = row.cancelRequestedAt;
	job.timedOut = !!row.timedOut;
	job.enqueuedAt = row.enqueuedAt || job.enqueuedAt;
	job.claimedAt = row.claimedAt;
	job.startedAt = row.startedAt;
	job.endedAt = row.endedAt;
	job.pid = row.pid;
	job.workerId = row.workerId;
	job.workerTenantId = row.workerTenantId;
	job.workerDeploymentId = row.workerDeploymentId;
	job.lastHeartbeatAt = row.lastHeartbeatAt;
	job.claimExpiresAt = row.claimExpiresAt;
	job.attempts = row.attempts || 0;
	job.maxAttempts = row.maxAttempts || 1;
	job.runId = row.runId;
	job.exitSignal = row.exitSignal;
	job.error = row.error;
	job.failureReason = row.failureReason;
	job.result = row.result;
	job.retention = row.retention || job.retention;
	job.deleteAfter = row.deleteAfter || job.deleteAfter;
	return job;
}

function claimDurableJob(job) {
	const binding = runnerBindingForJob(job);
	const row = dbCall((db) => dbm.claimWebuiJob(db, job.id, {
		runnerId: WORKER_ID,
		tenantId: job.tenantId,
		runnerTenantId: binding.runnerTenantId,
		runnerDeploymentId: binding.runnerDeploymentId,
		now: Date.now(),
		leaseMs: JOB_LEASE_MS,
		requireResumable: false,
	}));
	return syncJobFromDurable(job, row);
}

function heartbeatDurableJob(job, status = 'running') {
	if (!job || isTerminal(job)) return null;
	try {
		const binding = runnerBindingForJob(job);
		const row = dbCall((db) => dbm.heartbeatWebuiJob(db, job.id, {
			runnerId: WORKER_ID,
			runnerTenantId: job.workerTenantId || binding.runnerTenantId,
			runnerDeploymentId: job.workerDeploymentId || binding.runnerDeploymentId,
			now: Date.now(),
			leaseMs: JOB_LEASE_MS,
			status,
			pid: job.pid,
			runId: job.runId,
		}));
		if (!row) return null;
		const cancelRequested = row.cancelRequested && !job.cancelled;
		syncJobFromDurable(job, row);
		if (cancelRequested) {
			pushLine(job, '[webui] durable cancel observed - killing process tree');
			if (runningId === job.id && job.pid) killTree(job.pid);
		}
		return row;
	} catch (e) {
		appendJobJournal(job, 'heartbeat_error', { error: (e && e.message) || e });
		return null;
	}
}

function appendJobAudit(job, event, extra = {}, identity = null, opts = {}) {
	const required = opts.required ?? strictDurableJobsRequired();
	const auditActorId = identity?.actorId || job.actorId;
	const auditActorRole = identity?.actorRole || job.actorRole;
	const auditSessionId = identity?.sessionId || job.sessionId;
	const auditRoute = identity?.route || job.route;
	const commandHash = hashObject(job.command);
	const system = jobTargetSystem(job);
	try {
		dbCall((db) => dbm.appendWebuiJobAudit(db, {
			tenantId: job.tenantId,
			actorId: auditActorId,
			actorRole: auditActorRole,
			sessionId: auditSessionId,
			jobId: job.id,
			kind: job.kind,
			event,
			status: durableStatusFromJob(job),
			route: auditRoute,
			command: job.command,
			system,
			redaction: 'applied',
			result: redactObject(job.result),
			data: redactObject({
				label: redactText(job.label, '', 240),
				exitCode: job.exitCode,
				cancelled: job.cancelled,
				timedOut: job.timedOut,
				runId: job.runId,
				workerId: job.workerId,
				workerTenantId: job.workerTenantId,
				workerDeploymentId: job.workerDeploymentId,
				commandHash,
				system,
				action: job.meta?.action || null,
				riskClass: job.meta?.riskClass || null,
				retention: job.retention || 'ephemeral-debug',
				failureReason: job.failureReason || safeFailureReason(job),
				...extra,
			}, 240),
		}));
		return true;
	} catch (e) {
		appendJobJournal(job, 'audit_error', { error: (e && e.message) || e });
		if (required) throw failClosedDurableError('audit append', e);
		return false;
	}
}

function durableRowForAudit(row) {
	if (!row) return null;
	return {
		id: row.id,
		tenantId: row.tenantId,
		actorId: row.actorId,
		actorRole: row.actorRole,
		sessionId: row.sessionId,
		kind: row.kind,
		label: row.label,
		meta: row.meta || {},
		route: row.route,
		status: publicStatusFromDurable(row.status),
		durableStatus: row.status,
		exitCode: row.exitCode,
		cancelled: row.cancelled,
		cancelRequestedAt: row.cancelRequestedAt,
		timedOut: row.timedOut,
		runId: row.runId,
		workerId: row.workerId,
		workerTenantId: row.workerTenantId,
		workerDeploymentId: row.workerDeploymentId,
		command: row.command,
		result: row.result,
		retention: row.retention,
		failureReason: row.failureReason,
	};
}

function requestDurableCancel(id, context = null, job = null) {
	const tenantId = job?.tenantId || contextTenantId(context) || null;
	const identity = jobIdentity(context, { tenantId: tenantId || undefined });
	const req = dbCall((db) => dbm.requestWebuiJobCancel(db, id, {
		tenantId: tenantId || undefined,
		now: Date.now(),
		reason: 'cancelled before start',
	}));
	if (req.ok && req.changed) appendJobAudit(job || durableRowForAudit(req.job), 'cancel', {}, identity);
	return req;
}

function appendJobJournal(job, event, extra = {}) {
	try {
		fs.mkdirSync(path.dirname(JOB_JOURNAL), { recursive: true });
		const rec = {
			at: new Date().toISOString(),
			event,
			id: job.id,
			tenantId: job.tenantId,
			actorId: job.actorId,
			kind: job.kind,
			status: job.status,
			label: redactText(job.label, '', 240),
			exitCode: job.exitCode,
			cancelled: job.cancelled,
			timedOut: job.timedOut,
			runId: job.runId,
			failureReason: job.failureReason || safeFailureReason(job),
			...redactObject(extra, 240),
		};
		fs.appendFileSync(JOB_JOURNAL, JSON.stringify(rec) + '\n', { mode: 0o600 });
	} catch {
		/* best-effort local journal */
	}
}

function publicJob(job) {
	const dur = durationMs(job);
	const failureReason = job.failureReason || safeFailureReason(job);
	const artifacts = jobArtifactLinks(job);
	return {
		id: job.id,
		tenantId: job.tenantId,
		actorId: job.actorId,
		kind: job.kind,
		label: redactText(job.label, '', 240),
		meta: redactObject(job.meta || {}),
		status: job.status, // queued | running | done | failed | cancelled
		durableStatus: durableStatusFromJob(job),
		exitCode: job.exitCode,
		cancelled: job.cancelled,
		timedOut: job.timedOut,
		enqueuedAt: job.enqueuedAt,
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		durationMs: dur,
		pid: job.pid,
		workerId: job.workerId,
		workerTenantId: job.workerTenantId,
		workerDeploymentId: job.workerDeploymentId,
		lastHeartbeatAt: job.lastHeartbeatAt,
		claimExpiresAt: job.claimExpiresAt,
		attempts: job.attempts || 0,
		maxAttempts: job.maxAttempts || 1,
		runId: job.runId, // for kind:'run', filled from the [run] RUN_ID= line
		artifacts,
		result: redactObject(job.result),
		error: job.error ? redactText(job.error) : job.error,
		failureReason,
		diagnostics: jobDiagnostics(job),
		restored: !!job.restored,
		resumable: job.spawnFn ? true : false,
		nonResumableReason: job.spawnFn ? null : (job.nonResumableReason || defaultNonResumableReason(job.kind)),
		retention: job.retention || 'ephemeral-debug',
		deleteAfter: job.deleteAfter,
	};
}

function writeSse(res, event, data) {
	if (res.writableEnded || res.destroyed) return;
	// One frame per write, flushed immediately (no implicit buffering) so lines arrive live.
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function pushLine(job, line, opts = {}) {
	const now = Date.now();
	const rawLine = String(line == null ? '' : line);
	const capturedResult = captureStructuredResult(job, rawLine);
	const safeLine = redactText(rawLine, '', 2000);
	job.log.push(safeLine);
	if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
	job.lastLogAt = now;
	if (opts.childOutput) job.lastOutputAt = now;
	// Opportunistically capture the RUN_ID run.sh prints, so the UI can deep-link the new run.
	let capturedRunId = false;
	if (job.kind === 'run' && !job.runId) {
		const m = /RUN_ID=(\d{8}-\d{6}-\d+)/.exec(rawLine);
		if (m) { job.runId = m[1]; capturedRunId = true; }
	}
	// Opportunistic mid-stream persist: best-effort only. This runs inside the child stream
	// 'data' handler, so a fail-closed throw here would escape as an uncaughtException and crash
	// the server. Durability is enforced authoritatively at terminal persist (runJob finally).
	if (capturedResult || capturedRunId) { try { persistJob(job, { required: false }); } catch {} }
	for (const res of job.subscribers) writeSse(res, 'line', { line: safeLine });
}

// Capture a driver's structured result. The AQA_JOB_RESULT= sentinel is AUTHORITATIVE: once a sentinel
// line is seen, the loose `{…"results"…}` heuristic is disabled so a later stray results-bearing log line
// can't clobber the real result that feeds the dry-run/approve gate. The loose branch remains only as a
// fallback for drivers that don't emit the sentinel. A malformed result is flagged ONLY for the explicit
// sentinel — a malformed loose line is just a normal log line, not a job error.
function captureStructuredResult(job, line) {
	const t = String(line || '').trim();
	let raw = '';
	let sentinel = false;
	if (t.startsWith('AQA_JOB_RESULT=')) { raw = t.slice('AQA_JOB_RESULT='.length); sentinel = true; }
	else if (!job._resultSentinel && t.startsWith('{') && t.includes('"results"')) raw = t;
	if (!raw) return false;
	try {
		const obj = JSON.parse(raw);
		if (obj && typeof obj === 'object') { job.result = obj; if (sentinel) job._resultSentinel = true; return true; }
	} catch {
		if (sentinel) job.error = job.error || 'malformed structured job result';
	}
	return false;
}

// Split a child stream into lines, feeding pushLine (buffering a partial trailing line).
function wireStream(job, stream) {
	let buf = '';
	stream.setEncoding('utf8');
	stream.on('data', (chunk) => {
		buf += chunk;
		let nl;
		while ((nl = buf.indexOf('\n')) >= 0) {
			pushLine(job, buf.slice(0, nl).replace(/\r$/, ''), { childOutput: true });
			buf = buf.slice(nl + 1);
		}
	});
	stream.on('end', () => {
		if (buf.length) pushLine(job, buf.replace(/\r$/, ''), { childOutput: true });
		buf = '';
	});
}

function prune() {
	if (jobs.size <= MAX_JOBS) return;
	for (const id of [...jobs.keys()].slice(0, jobs.size - MAX_JOBS)) {
		if (id !== runningId && !pending.includes(id)) jobs.delete(id);
	}
}

// Emit terminal 'end' to a job's SSE subscribers, close their streams, prune old records.
function finishJob(job) {
	if (job.finishedNotified) return;
	for (const res of job.subscribers) {
		writeSse(res, 'end', publicJob(job));
		if (!res.writableEnded) res.end();
	}
	job.subscribers.clear();
	job.finishedNotified = true;
	prune();
}

function pushTerminalDiagnostics(job) {
	const d = jobDiagnostics(job);
	if (job.status !== 'failed' && job.status !== 'cancelled' && !d.slow && !d.unstable) return;
	const fields = [
		`status=${job.status}`,
		`durationMs=${durationMs(job) ?? 0}`,
		`reason=${JSON.stringify(d.failureReason || job.status)}`,
		`heartbeat=${d.heartbeatState}`,
		`heartbeatAgeMs=${d.heartbeatAgeMs ?? 0}`,
	];
	if (job.exitCode != null) fields.push(`exitCode=${job.exitCode}`);
	if (job.exitSignal) fields.push(`signal=${job.exitSignal}`);
	if (job.runId) fields.push(`runId=${job.runId}`, `report=${d.artifacts.reportUrl}`);
	if (d.signals.length) fields.push(`signals=${d.signals.join(',')}`);
	pushLine(job, `[webui] diagnostic: ${fields.join(' ')}`);
}

function failJobBeforeSpawn(job, reason, error = null) {
	job.status = 'failed';
	job.durableStatus = 'interrupted';
	job.endedAt = Date.now();
	job.error = sanitizeDiagnosticText((error && error.message) || error || reason, reason);
	job.failureReason = safeFailureReason(job);
	pushTerminalDiagnostics(job);
	try { persistJob(job, { required: false }); } catch {}
	appendJobJournal(job, 'interrupted', { reason, error: job.error });
	finishJob(job);
}

async function runJob(job) {
	if (isTerminal(job) || (job.restored && !job.spawnFn)) return;
	const i = pending.indexOf(job.id);
	if (i >= 0) pending.splice(i, 1);
	// Cancelled while still queued: never spawn a child.
	if (job.cancelled) {
		job.status = 'cancelled';
		job.durableStatus = 'canceled';
		job.endedAt = Date.now();
		job.failureReason = safeFailureReason(job);
		pushTerminalDiagnostics(job);
		persistJob(job);
		appendJobAudit(job, 'finish', { reason: 'cancelled before start' });
		appendJobJournal(job, 'terminal');
		finishJob(job);
		return;
	}
	const claimed = claimDurableJob(job);
	if (!claimed) {
		const durable = dbCall((db) => dbm.getWebuiJob(db, job.id, { tenantId: job.tenantId }));
		if (durable && durable.status === 'canceled') {
			syncJobFromDurable(job, durable);
			job.failureReason = safeFailureReason(job);
			pushTerminalDiagnostics(job);
			appendJobJournal(job, 'terminal');
			finishJob(job);
			return;
		}
		job.status = 'failed';
		job.durableStatus = 'interrupted';
		job.endedAt = Date.now();
		job.error = 'durable claim refused';
		job.failureReason = safeFailureReason(job);
		persistJob(job);
		appendJobAudit(job, 'fail', { reason: 'durable claim refused' });
		appendJobJournal(job, 'interrupted', { reason: 'durable claim refused' });
		finishJob(job);
		return;
	}
	try {
		appendJobAudit(job, 'claim', { workerId: WORKER_ID, workerTenantId: job.workerTenantId, workerDeploymentId: job.workerDeploymentId });
	} catch (e) {
		failJobBeforeSpawn(job, 'required claim audit failed', e);
		return;
	}
	job.status = 'running';
	job.durableStatus = 'running';
	job.startedAt = Date.now();
	runningId = job.id;
	pushLine(job, `[webui] starting ${job.id}: ${job.label}`);
	appendJobJournal(job, 'running');
	try {
		appendJobAudit(job, 'start', { pid: null });
	} catch (e) {
		runningId = null;
		failJobBeforeSpawn(job, 'required start audit failed', e);
		return;
	}
	let timer = null;
	let killGraceTimer = null;
	let heartbeatTimer = null;
	try {
		const child = job.spawnFn();
		job.child = child;
		job.pid = child.pid ?? null;
		heartbeatDurableJob(job, 'running');
		heartbeatTimer = setInterval(() => heartbeatDurableJob(job, 'running'), JOB_HEARTBEAT_INTERVAL_MS);
		if (child.stdout) wireStream(job, child.stdout);
		if (child.stderr) wireStream(job, child.stderr);
		const code = await new Promise((resolve) => {
			let settled = false;
			const resolveOnce = (c) => {
				if (settled) return;
				settled = true;
				resolve(c == null ? -1 : c);
			};
			// Watchdog: tree-kill a child that overruns. If Windows never reports the child's
			// close after taskkill, force-resolve so the single browser slot cannot stay wedged.
			timer = setTimeout(() => {
				job.timedOut = true;
				pushLine(job, `[webui] job exceeded ${formatDurationMs(JOB_TIMEOUT_MS)} timeout — killing process tree`);
				killTree(job.pid);
				killGraceTimer = setTimeout(() => {
					pushLine(job, `[webui] process did not report close after ${formatDurationMs(JOB_KILL_GRACE_MS)} — freeing queue slot`);
					resolveOnce(-1);
				}, JOB_KILL_GRACE_MS);
			}, JOB_TIMEOUT_MS);
			child.on('error', (e) => {
				pushLine(job, `[webui] spawn error: ${e.message}`);
				resolveOnce(-1);
			});
			// Resolve ONLY on 'close' (stdio fully drained + process exited) -> serialization.
			child.on('close', (c, signal) => {
				job.exitSignal = signal || null;
				resolveOnce(c);
			});
		});
		job.exitCode = code;
		job.status = job.cancelled ? 'cancelled' : job.timedOut ? 'failed' : code === 0 ? 'done' : 'failed';
		job.durableStatus = job.cancelled ? 'canceled' : job.timedOut ? 'expired' : code === 0 ? 'succeeded' : 'failed';
	} catch (e) {
		job.exitCode = -1;
		job.status = 'failed';
		job.durableStatus = 'failed';
		job.error = String((e && e.message) || e);
		pushLine(job, `[webui] job error: ${(e && e.message) || e}`);
	} finally {
		if (timer) clearTimeout(timer);
		if (killGraceTimer) clearTimeout(killGraceTimer);
		if (heartbeatTimer) clearInterval(heartbeatTimer);
		if (job.stopFile) { try { fs.rmSync(job.stopFile, { force: true }); } catch {} } // clear the stop signal
		job.child = null;
		job.endedAt = Date.now();
		job.failureReason = safeFailureReason(job);
		pushTerminalDiagnostics(job);
		try {
			persistJob(job);
		} catch (e) {
			job.status = 'failed';
			job.durableStatus = 'interrupted';
			job.error = sanitizeDiagnosticText((e && e.message) || e, 'required terminal persist failed');
			job.failureReason = safeFailureReason(job);
			try { persistJob(job, { required: false }); } catch {}
			appendJobJournal(job, 'terminal_persist_refused', { error: job.error });
		}
		recordJobArtifacts(job);
		try {
			appendJobAudit(job, terminalAuditEvent(job));
		} catch (e) {
			job.status = 'failed';
			job.durableStatus = 'interrupted';
			job.error = sanitizeDiagnosticText((e && e.message) || e, 'required terminal audit failed');
			job.failureReason = safeFailureReason(job);
			try { persistJob(job, { required: false }); } catch {}
			appendJobJournal(job, 'terminal_audit_refused', { error: job.error });
		}
		appendJobJournal(job, 'terminal');
		if (typeof job.onFinish === 'function') {
			try { job.onFinish(publicJob(job)); }
			catch (e) { pushLine(job, `[webui] onFinish error: ${(e && e.message) || e}`); }
		}
		runningId = null;
		finishJob(job);
	}
}

// enqueue({kind, label, spawnFn, meta?, onFinish?, context?, commandSpec?}) -> public job record.
// spawnFn() must return a ChildProcess.
export function enqueue({ kind, label, spawnFn, stopFile, meta, onFinish, context, tenantId, actorId, commandSpec, nonResumableReason }) {
	const id = `j${++seq}`;
	const identity = jobIdentity(context, { tenantId, actorId });
	const command = validateCommandSpec(commandSpec);
	const metaObj = meta && typeof meta === 'object' ? meta : {};
	const rawDeleteAfter = metaObj.deleteAfter ?? metaObj.delete_after;
	const numericDeleteAfter = Number(rawDeleteAfter);
	const parsedDeleteAfter = Number.isFinite(numericDeleteAfter) ? numericDeleteAfter : Date.parse(String(rawDeleteAfter || ''));
	const maxAttempts = retryMaxAttempts(metaObj);
	const job = {
		id,
		tenantId: identity.tenantId,
		actorId: identity.actorId,
		actorRole: identity.actorRole,
		sessionId: identity.sessionId,
		kind,
		label: label || kind,
		meta: metaObj,
		route: identity.route || metaObj.route || null,
		command,
		nonResumableReason: command ? null : (nonResumableReason || defaultNonResumableReason(kind)),
		status: 'queued',
		durableStatus: 'queued',
		exitCode: null,
		enqueuedAt: Date.now(),
		claimedAt: null,
		startedAt: null,
		endedAt: null,
		pid: null,
		workerId: null,
		workerTenantId: null,
		workerDeploymentId: null,
		lastHeartbeatAt: null,
		claimExpiresAt: null,
		attempts: 0,
		maxAttempts,
		runId: null,
		exitSignal: null,
		child: null,
		cancelled: false,
		cancelRequestedAt: null,
		timedOut: false,
		error: null,
		failureReason: null,
		result: null,
		stopFile: stopFile || null,
		onFinish: typeof onFinish === 'function' ? onFinish : null,
		spawnFn: spawnFn || spawnFromCommandSpec(command, identity),
		log: [],
		lastLogAt: null,
		lastOutputAt: null,
		subscribers: new Set(),
		retention: String(metaObj.retention || metaObj.retentionPolicy || 'ephemeral-debug'),
		deleteAfter: Number.isFinite(parsedDeleteAfter) ? Math.trunc(parsedDeleteAfter) : null,
	};
	pushLine(job, `[webui] queued ${id}: ${job.label}`);
	try {
		persistJob(job);
		appendJobAudit(job, 'enqueue');
	} catch (e) {
		job.status = 'failed';
		job.durableStatus = 'interrupted';
		job.endedAt = Date.now();
		job.error = sanitizeDiagnosticText((e && e.message) || e, 'durable enqueue refused');
		job.failureReason = safeFailureReason(job);
		try { persistJob(job, { required: false }); } catch {}
		appendJobJournal(job, 'enqueue_refused', { error: job.error });
		throw e;
	}
	jobs.set(id, job);
	pending.push(id);
	appendJobJournal(job, 'queued');
	// .catch keeps the chain alive on a thrown job; per-job status already records the failure.
	tail = tail.then(() => runJob(job)).catch(() => {});
	return publicJob(job);
}

export function jobStatus(id, context = null) {
	const job = jobs.get(id);
	return job && canAccessJob(job, context) ? publicJob(job) : null;
}

export function jobResult(id, context = null) {
	const job = jobs.get(id);
	if (!job || !canAccessJob(job, context)) return null;
	return {
		id: job.id,
		tenantId: job.tenantId,
		actorId: job.actorId,
		status: job.status,
		durableStatus: durableStatusFromJob(job),
		exitCode: job.exitCode,
		cancelled: job.cancelled,
		timedOut: job.timedOut,
		runId: job.runId,
		artifacts: jobArtifactLinks(job),
		result: redactObject(job.result),
		error: job.error ? redactText(job.error) : job.error,
		failureReason: job.failureReason || safeFailureReason(job),
		diagnostics: jobDiagnostics(job),
		meta: redactObject(job.meta || {}),
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		durationMs: durationMs(job),
		workerId: job.workerId,
		workerTenantId: job.workerTenantId,
		workerDeploymentId: job.workerDeploymentId,
		lastHeartbeatAt: job.lastHeartbeatAt,
		claimExpiresAt: job.claimExpiresAt,
		attempts: job.attempts || 0,
		maxAttempts: job.maxAttempts || 1,
		restored: !!job.restored,
		resumable: job.spawnFn ? true : false,
		nonResumableReason: job.spawnFn ? null : (job.nonResumableReason || defaultNonResumableReason(job.kind)),
		retention: job.retention || 'ephemeral-debug',
		deleteAfter: job.deleteAfter,
	};
}

// cancel(id): if running, tree-kill its child (the ensuing 'close' frees the slot and advances
// the queue); if still queued, mark it so runJob skips spawning. Returns true if the id exists.
export function cancel(id, context = null) {
	const job = jobs.get(id);
	if (!job) {
		const req = requestDurableCancel(id, context, null);
		return !!req.ok;
	}
	if (!canAccessJob(job, context)) return false;
	if (isTerminal(job)) return true;
	if (job.cancelled) return true;
	const req = requestDurableCancel(id, context, job);
	if (!req.ok) return false;
	job.cancelled = true;
	job.cancelRequestedAt = req.job?.cancelRequestedAt || Date.now();
	job.durableStatus = job.status === 'queued' ? 'canceled' : 'canceling';
	appendJobJournal(job, 'cancel_requested');
	if (id === runningId && job.pid) {
		pushLine(job, '[webui] cancel requested — killing process tree');
		persistJob(job);
		killTree(job.pid);
	} else if (job.status === 'queued') {
		const i = pending.indexOf(job.id);
		if (i >= 0) pending.splice(i, 1);
		job.status = 'cancelled';
		job.endedAt = Date.now();
		job.failureReason = safeFailureReason(job);
		pushTerminalDiagnostics(job);
		persistJob(job);
		appendJobAudit(job, 'finish', { reason: 'cancelled before start' });
		appendJobJournal(job, 'terminal');
		finishJob(job);
	} else {
		persistJob(job);
	}
	return true;
}

// stop(id): GRACEFUL early finish of a running recording — create its stop-file so capture()'s
// watch loop breaks into the SAME drain path as --seconds auto-stop (a COMPLETE flow), unlike
// cancel()'s tree-kill (a partial/degraded capture). No-op unless the job has a stopFile and is the
// one currently running. Returns true only when a stop signal was actually written.
export function stop(id, context = null) {
	const job = jobs.get(id);
	if (!job || !job.stopFile) return false;
	if (!canAccessJob(job, context)) return false;
	if (id !== runningId || job.status !== 'running') return false;
	try {
		fs.writeFileSync(job.stopFile, '');
	} catch (e) {
		pushLine(job, `[webui] stop signal write failed: ${(e && e.message) || e}`);
		return false;
	}
	pushLine(job, '[webui] stop requested - finishing the recording (complete capture)');
	return true;
}

// killRunning(): best-effort tree-kill of the in-flight child, for server shutdown so the
// browser-driver tree is not orphaned.
export function killRunning() {
	if (runningId) {
		const job = jobs.get(runningId);
		if (job && job.pid) {
			job.status = 'failed';
			job.durableStatus = 'interrupted';
			job.endedAt = Date.now();
			job.failureReason = safeFailureReason(job);
			persistJob(job);
			appendJobAudit(job, 'fail', { reason: 'server shutdown' });
			appendJobJournal(job, 'interrupted', { reason: 'server shutdown' });
			killTree(job.pid);
		}
	}
}

// Subscribe an SSE response to a job: replay the buffered log, then stream live lines, then
// 'end'. Replay+subscribe is synchronous (no await between) so no line is missed or doubled.
export function subscribe(id, res, context = null) {
	const job = jobs.get(id);
	if (!job || !canAccessJob(job, context)) return false;
	res.writeHead(200, {
		'Content-Type': 'text/event-stream',
		'Cache-Control': 'no-cache',
		Connection: 'keep-alive',
		'X-Accel-Buffering': 'no',
	});
	if (typeof res.flushHeaders === 'function') res.flushHeaders();
	for (const line of job.log) writeSse(res, 'line', { line });
	// All terminal states (incl. 'cancelled') must short-circuit — finishJob already fired the
	// one-and-only 'end' to the original subscribers, so a late subscriber (e.g. the Jobs view
	// opening a historical job) would otherwise wait forever and leak the connection.
	if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
		writeSse(res, 'end', publicJob(job));
		res.end();
		return true;
	}
	job.subscribers.add(res);
	res.on('close', () => job.subscribers.delete(res));
	return true;
}

export function runnerContract() {
	const contract = runnerContracts.buildRunnerContract({
		runner: RUNNER,
		workerId: WORKER_ID,
		leaseMs: JOB_LEASE_MS,
		heartbeatIntervalMs: JOB_HEARTBEAT_INTERVAL_MS,
		heartbeatStaleMs: JOB_HEARTBEAT_STALE_MS,
		auditSinkPublicConfig: auditSink.auditSinkPublicConfig,
		redactError: (e) => redactText((e && e.message) || e, '', 240),
	});
	return {
		...contract,
		runner: {
			id: contract.runner.runnerId,
			...contract.runner,
		},
	};
}

function restoredJob(row) {
	const status = publicStatusFromDurable(row.status);
	const terminal = TERMINAL_STATUSES.has(status);
	const log = Array.isArray(row.log) ? row.log.map((line) => redactText(line, '', 2000)).slice(-MAX_LOG) : [];
	let command = null;
	let restoredSpawn = null;
	let nonResumableReason = row.nonResumableReason || null;
	try {
		command = row.command ? validateCommandSpec(row.command) : null;
		restoredSpawn = command && row.resumable ? spawnFromCommandSpec(command, { tenantId: row.tenantId, actorId: row.actorId }) : null;
	} catch (e) {
		command = null;
		restoredSpawn = null;
		nonResumableReason = `persisted command spec refused: ${(e && e.message) || e}`;
	}
	if (!log.length) log.push(`[webui] restored ${row.status} job ${row.id} from durable queue`);
	if (row.status === 'queued' && !restoredSpawn) {
		log.push(`[webui] queued job was preserved across restart; ${nonResumableReason || defaultNonResumableReason(row.kind)}`);
	}
	return {
		id: row.id,
		tenantId: row.tenantId || 'local',
		actorId: row.actorId || 'local',
		actorRole: row.actorRole || 'operator',
		sessionId: row.sessionId || null,
		kind: row.kind || 'job',
		label: row.label || row.kind || 'job',
		meta: row.meta && typeof row.meta === 'object' ? row.meta : {},
		route: row.route || null,
		command,
		nonResumableReason: restoredSpawn ? null : (nonResumableReason || defaultNonResumableReason(row.kind)),
		status,
		durableStatus: row.status,
		exitCode: row.exitCode,
		enqueuedAt: row.enqueuedAt,
		claimedAt: row.claimedAt,
		startedAt: row.startedAt,
		endedAt: row.endedAt,
		pid: null,
		workerId: row.workerId || null,
		workerTenantId: row.workerTenantId || null,
		workerDeploymentId: row.workerDeploymentId || null,
		lastHeartbeatAt: row.lastHeartbeatAt || null,
		claimExpiresAt: row.claimExpiresAt || null,
		attempts: row.attempts || 0,
		maxAttempts: row.maxAttempts || 1,
		runId: row.runId,
		exitSignal: row.exitSignal,
		child: null,
		cancelled: row.cancelled || row.status === 'canceled',
		cancelRequestedAt: row.cancelRequestedAt,
		timedOut: row.timedOut || row.status === 'expired',
		error: row.error,
		failureReason: row.failureReason,
		result: row.result,
		stopFile: null,
		onFinish: null,
		spawnFn: restoredSpawn,
		log,
		lastLogAt: row.updatedAt || row.endedAt || row.startedAt || row.enqueuedAt || null,
		lastOutputAt: null,
		subscribers: new Set(),
		retention: row.retention || 'ephemeral-debug',
		deleteAfter: row.deleteAfter || null,
		restored: true,
		finishedNotified: terminal,
	};
}

function hydrateDurableJobs() {
	try {
		const rows = dbCall((db) => {
			const interrupted = dbm.reconcileWebuiJobs(db, { reason: 'interrupted during server restart' });
			for (const row of interrupted) {
				dbm.appendWebuiJobAudit(db, {
					tenantId: row.tenantId,
					actorId: row.actorId,
					actorRole: row.actorRole,
					sessionId: row.sessionId,
					jobId: row.id,
					kind: row.kind,
					event: 'fail',
					status: 'interrupted',
					route: row.route,
					command: row.command,
					system: row.meta?.system || row.meta?.app || row.meta?.targetSystem || null,
					redaction: 'applied',
					result: row.result,
					data: {
						label: row.label,
						reason: 'startup reconciliation',
						failureReason: row.failureReason || 'interrupted during server restart',
					},
				});
			}
			return dbm.listWebuiJobs(db, { limit: MAX_JOBS });
		});
		for (const row of rows) {
			const m = /^j(\d+)$/.exec(row.id || '');
			if (m) seq = Math.max(seq, Number(m[1]));
			const job = restoredJob(row);
			jobs.set(job.id, job);
			if (row.status === 'queued' && !pending.includes(job.id)) {
				pending.push(job.id);
				if (job.spawnFn) tail = tail.then(() => runJob(job)).catch(() => {});
			}
		}
	} catch (e) {
		if (strictDurableJobsRequired()) throw failClosedDurableError('startup readback', e);
		/* Durable queue readback is fail-soft for localhost startup; new jobs still persist later. */
	}
}

function queueMetrics(recent, scopedJobs = [...jobs.values()]) {
	const all = scopedJobs;
	const terminalWithDuration = all.filter((j) => j.startedAt && j.endedAt);
	const totalDuration = terminalWithDuration.reduce((sum, j) => sum + (j.endedAt - j.startedAt), 0);
	const lastFailed = [...all].reverse().find((j) => j.status === 'failed');
	const now = Date.now();
	const diagnostics = all.map((j) => jobDiagnostics(j, now));
	return {
		queued: all.filter((j) => j.status === 'queued').length,
		running: all.filter((j) => j.status === 'running').length,
		recent: recent.length,
		avgDurationMs: terminalWithDuration.length ? Math.round(totalDuration / terminalWithDuration.length) : null,
		lastFailureReason: safeFailureReason(lastFailed),
		timeoutCount: all.filter((j) => j.timedOut).length,
		cancelledCount: all.filter((j) => j.status === 'cancelled' || j.cancelled).length,
		heartbeatStaleCount: diagnostics.filter((d) => d.heartbeatState === 'stale').length,
		slowCount: diagnostics.filter((d) => d.slow).length,
		unstableCount: diagnostics.filter((d) => d.unstable).length,
	};
}

// queueState() -> snapshot for GET /api/queue (proves serialization: one running, N pending).
export function queueState(context = null) {
	const scopedJobs = [...jobs.values()].filter((job) => canAccessJob(job, context));
	const scopedPending = pending.filter((id) => {
		const job = jobs.get(id);
		return job && canAccessJob(job, context);
	});
	const recent = scopedJobs.slice(-10).reverse().map(publicJob);
	return {
		busy: runningId !== null && canAccessJob(jobs.get(runningId), context),
		running: runningId && canAccessJob(jobs.get(runningId), context) ? publicJob(jobs.get(runningId)) : null,
		pending: scopedPending.map((id) => publicJob(jobs.get(id))),
		recent,
		metrics: queueMetrics(recent, scopedJobs),
	};
}

hydrateDurableJobs();
