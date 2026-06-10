// webui/jobs.js - single-slot serial job queue for browser-driving Playwright jobs.
//
// Headed browser jobs share the operator desktop and persisted auth/profile files, so WebUI
// runs at most one browser-driving job (run / record / verify / auth) at a time. This module
// chains them on a single promise tail: a job's child must reach 'close' before the next job's
// child is spawned. Read-only HTTP endpoints do not go through here and run concurrently.

import fs from 'node:fs';
import { killTree } from './spawn.js';

const MAX_LOG = 2000; // per-job log ring-buffer cap
const MAX_JOBS = 50; // most-recent job records kept in memory
// Watchdog: a child that never reaches 'close' would otherwise stall the single slot forever.
// Cap each job; on timeout we tree-kill it so its 'close' fires and the chain advances.
// Generous default (the full suite is ~5 min); override with WEBUI_JOB_TIMEOUT_MS.
const JOB_TIMEOUT_MS = Number(process.env.WEBUI_JOB_TIMEOUT_MS) || 20 * 60 * 1000;
const JOB_KILL_GRACE_MS = Number(process.env.WEBUI_JOB_KILL_GRACE_MS) || 15000;
const JOB_HEARTBEAT_STALE_MS = Number(process.env.WEBUI_JOB_HEARTBEAT_STALE_MS) || 60 * 1000;
const JOB_SLOW_MS = Number(process.env.WEBUI_JOB_SLOW_MS) || 5 * 60 * 1000;

let seq = 0;
let tail = Promise.resolve(); // the serial chain
let runningId = null; // id of the job whose child is currently alive, or null
const pending = []; // FIFO of queued (not-yet-running) job ids
const jobs = new Map(); // id -> job record

function durationMs(job, now = Date.now()) {
	if (!job?.startedAt) return null;
	return (job.endedAt || now) - job.startedAt;
}

function formatDurationMs(ms) {
	return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

function compactDiagnosticText(value) {
	return String(value == null ? '' : value)
		.replace(/\x1b\[[0-9;]*m/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

function sanitizeDiagnosticText(value, fallback = '') {
	let s = compactDiagnosticText(value);
	if (!s) s = fallback;
	s = s
		.replace(/\b(authorization|cookie|set-cookie)\s*:\s*[^,;\s]+/ig, '$1: [redacted]')
		.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/ig, '$1 [redacted]')
		.replace(/\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|otp|code)\s*=\s*[^&\s]+/ig, '$1=[redacted]')
		.replace(/(https?:\/\/[^\s?#]+)\?[^)\]\s]+/ig, '$1?[redacted]');
	return s.length > 320 ? `${s.slice(0, 317)}...` : s;
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

function publicJob(job) {
	const dur = durationMs(job);
	const failureReason = job.failureReason || safeFailureReason(job);
	const artifacts = jobArtifactLinks(job);
	return {
		id: job.id,
		kind: job.kind,
		label: job.label,
		meta: job.meta || {},
		status: job.status, // queued | running | done | failed | cancelled
		exitCode: job.exitCode,
		cancelled: job.cancelled,
		timedOut: job.timedOut,
		enqueuedAt: job.enqueuedAt,
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		durationMs: dur,
		pid: job.pid,
		runId: job.runId, // for kind:'run', filled from the [run] RUN_ID= line
		artifacts,
		result: job.result,
		error: job.error,
		failureReason,
		diagnostics: jobDiagnostics(job),
	};
}

function writeSse(res, event, data) {
	if (res.writableEnded || res.destroyed) return;
	// One frame per write, flushed immediately (no implicit buffering) so lines arrive live.
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function pushLine(job, line, opts = {}) {
	const now = Date.now();
	job.log.push(line);
	if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
	job.lastLogAt = now;
	if (opts.childOutput) job.lastOutputAt = now;
	// Opportunistically capture the RUN_ID run.sh prints, so the UI can deep-link the new run.
	if (job.kind === 'run' && !job.runId) {
		const m = /RUN_ID=(\d{8}-\d{6}-\d+)/.exec(line);
		if (m) job.runId = m[1];
	}
	captureStructuredResult(job, line);
	for (const res of job.subscribers) writeSse(res, 'line', { line });
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
	if (!raw) return;
	try {
		const obj = JSON.parse(raw);
		if (obj && typeof obj === 'object') { job.result = obj; if (sentinel) job._resultSentinel = true; }
	} catch {
		if (sentinel) job.error = job.error || 'malformed structured job result';
	}
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
	for (const res of job.subscribers) {
		writeSse(res, 'end', publicJob(job));
		if (!res.writableEnded) res.end();
	}
	job.subscribers.clear();
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

async function runJob(job) {
	const i = pending.indexOf(job.id);
	if (i >= 0) pending.splice(i, 1);
	// Cancelled while still queued: never spawn a child.
	if (job.cancelled) {
		job.status = 'cancelled';
		job.endedAt = Date.now();
		job.failureReason = safeFailureReason(job);
		pushTerminalDiagnostics(job);
		finishJob(job);
		return;
	}
	job.status = 'running';
	job.startedAt = Date.now();
	runningId = job.id;
	pushLine(job, `[webui] starting ${job.id}: ${job.label}`);
	let timer = null;
	let killGraceTimer = null;
	try {
		const child = job.spawnFn();
		job.child = child;
		job.pid = child.pid ?? null;
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
	} catch (e) {
		job.exitCode = -1;
		job.status = 'failed';
		job.error = String((e && e.message) || e);
		pushLine(job, `[webui] job error: ${(e && e.message) || e}`);
	} finally {
		if (timer) clearTimeout(timer);
		if (killGraceTimer) clearTimeout(killGraceTimer);
		if (job.stopFile) { try { fs.rmSync(job.stopFile, { force: true }); } catch {} } // clear the stop signal
		job.child = null;
		job.endedAt = Date.now();
		job.failureReason = safeFailureReason(job);
		pushTerminalDiagnostics(job);
		if (typeof job.onFinish === 'function') {
			try { job.onFinish(publicJob(job)); }
			catch (e) { pushLine(job, `[webui] onFinish error: ${(e && e.message) || e}`); }
		}
		runningId = null;
		finishJob(job);
	}
}

// enqueue({kind, label, spawnFn, meta?, onFinish?}) -> public job record. spawnFn() must return a ChildProcess.
export function enqueue({ kind, label, spawnFn, stopFile, meta, onFinish }) {
	const id = `j${++seq}`;
	const job = {
		id,
		kind,
		label: label || kind,
		meta: meta && typeof meta === 'object' ? meta : {},
		status: 'queued',
		exitCode: null,
		enqueuedAt: Date.now(),
		startedAt: null,
		endedAt: null,
		pid: null,
		runId: null,
		exitSignal: null,
		child: null,
		cancelled: false,
		timedOut: false,
		error: null,
		failureReason: null,
		result: null,
		stopFile: stopFile || null,
		onFinish: typeof onFinish === 'function' ? onFinish : null,
		spawnFn,
		log: [],
		lastLogAt: null,
		lastOutputAt: null,
		subscribers: new Set(),
	};
	jobs.set(id, job);
	pending.push(id);
	pushLine(job, `[webui] queued ${id}: ${job.label}`);
	// .catch keeps the chain alive on a thrown job; per-job status already records the failure.
	tail = tail.then(() => runJob(job)).catch(() => {});
	return publicJob(job);
}

export function jobStatus(id) {
	const job = jobs.get(id);
	return job ? publicJob(job) : null;
}

export function jobResult(id) {
	const job = jobs.get(id);
	if (!job) return null;
	return {
		id: job.id,
		status: job.status,
		exitCode: job.exitCode,
		cancelled: job.cancelled,
		timedOut: job.timedOut,
		runId: job.runId,
		artifacts: jobArtifactLinks(job),
		result: job.result,
		error: job.error,
		failureReason: job.failureReason || safeFailureReason(job),
		diagnostics: jobDiagnostics(job),
		meta: job.meta || {},
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		durationMs: durationMs(job),
	};
}

// cancel(id): if running, tree-kill its child (the ensuing 'close' frees the slot and advances
// the queue); if still queued, mark it so runJob skips spawning. Returns true if the id exists.
export function cancel(id) {
	const job = jobs.get(id);
	if (!job) return false;
	if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') return true;
	job.cancelled = true;
	if (id === runningId && job.pid) {
		pushLine(job, '[webui] cancel requested — killing process tree');
		killTree(job.pid);
	}
	return true;
}

// stop(id): GRACEFUL early finish of a running recording — create its stop-file so capture()'s
// watch loop breaks into the SAME drain path as --seconds auto-stop (a COMPLETE flow), unlike
// cancel()'s tree-kill (a partial/degraded capture). No-op unless the job has a stopFile and is the
// one currently running. Returns true only when a stop signal was actually written.
export function stop(id) {
	const job = jobs.get(id);
	if (!job || !job.stopFile) return false;
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
		if (job && job.pid) killTree(job.pid);
	}
}

// Subscribe an SSE response to a job: replay the buffered log, then stream live lines, then
// 'end'. Replay+subscribe is synchronous (no await between) so no line is missed or doubled.
export function subscribe(id, res) {
	const job = jobs.get(id);
	if (!job) return false;
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

function queueMetrics(recent) {
	const all = [...jobs.values()];
	const terminalWithDuration = all.filter((j) => j.startedAt && j.endedAt);
	const totalDuration = terminalWithDuration.reduce((sum, j) => sum + (j.endedAt - j.startedAt), 0);
	const lastFailed = [...all].reverse().find((j) => j.status === 'failed');
	const now = Date.now();
	const diagnostics = all.map((j) => jobDiagnostics(j, now));
	return {
		queued: pending.length,
		running: runningId ? 1 : 0,
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
export function queueState() {
	const recent = [...jobs.values()].slice(-10).reverse().map(publicJob);
	return {
		busy: runningId !== null,
		running: runningId ? publicJob(jobs.get(runningId)) : null,
		pending: pending.map((id) => publicJob(jobs.get(id))),
		recent,
		metrics: queueMetrics(recent),
	};
}
