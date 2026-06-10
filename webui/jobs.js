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

let seq = 0;
let tail = Promise.resolve(); // the serial chain
let runningId = null; // id of the job whose child is currently alive, or null
const pending = []; // FIFO of queued (not-yet-running) job ids
const jobs = new Map(); // id -> job record

function publicJob(job) {
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
		durationMs: job.startedAt && job.endedAt ? job.endedAt - job.startedAt : null,
		pid: job.pid,
		runId: job.runId, // for kind:'run', filled from the [run] RUN_ID= line
		result: job.result,
		error: job.error,
	};
}

function writeSse(res, event, data) {
	if (res.writableEnded || res.destroyed) return;
	// One frame per write, flushed immediately (no implicit buffering) so lines arrive live.
	res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function pushLine(job, line) {
	job.log.push(line);
	if (job.log.length > MAX_LOG) job.log.splice(0, job.log.length - MAX_LOG);
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
			pushLine(job, buf.slice(0, nl).replace(/\r$/, ''));
			buf = buf.slice(nl + 1);
		}
	});
	stream.on('end', () => {
		if (buf.length) pushLine(job, buf.replace(/\r$/, ''));
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

async function runJob(job) {
	const i = pending.indexOf(job.id);
	if (i >= 0) pending.splice(i, 1);
	// Cancelled while still queued: never spawn a child.
	if (job.cancelled) {
		job.status = 'cancelled';
		job.endedAt = Date.now();
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
				pushLine(job, `[webui] job exceeded ${Math.round(JOB_TIMEOUT_MS / 1000)}s timeout — killing process tree`);
				killTree(job.pid);
				killGraceTimer = setTimeout(() => {
					pushLine(job, `[webui] process did not report close after ${Math.round(JOB_KILL_GRACE_MS / 1000)}s — freeing queue slot`);
					resolveOnce(-1);
				}, JOB_KILL_GRACE_MS);
			}, JOB_TIMEOUT_MS);
			child.on('error', (e) => {
				pushLine(job, `[webui] spawn error: ${e.message}`);
				resolveOnce(-1);
			});
			// Resolve ONLY on 'close' (stdio fully drained + process exited) -> serialization.
			child.on('close', (c) => resolveOnce(c));
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
		child: null,
		cancelled: false,
		timedOut: false,
		error: null,
		result: null,
		stopFile: stopFile || null,
		onFinish: typeof onFinish === 'function' ? onFinish : null,
		spawnFn,
		log: [],
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
		result: job.result,
		error: job.error,
		meta: job.meta || {},
		startedAt: job.startedAt,
		endedAt: job.endedAt,
		durationMs: job.startedAt && job.endedAt ? job.endedAt - job.startedAt : null,
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

function safeFailureReason(job) {
	if (!job) return null;
	if (job.timedOut) return 'timeout';
	if (job.exitCode != null && job.exitCode !== 0) return `exit code ${job.exitCode}`;
	if (job.error) {
		const text = String(job.error).toLowerCase();
		if (text.includes('malformed structured job result')) return 'malformed structured job result';
		return 'job error';
	}
	return job.status === 'failed' ? 'failed' : null;
}

function queueMetrics(recent) {
	const all = [...jobs.values()];
	const terminalWithDuration = all.filter((j) => j.startedAt && j.endedAt);
	const totalDuration = terminalWithDuration.reduce((sum, j) => sum + (j.endedAt - j.startedAt), 0);
	const lastFailed = [...all].reverse().find((j) => j.status === 'failed');
	return {
		queued: pending.length,
		running: runningId ? 1 : 0,
		recent: recent.length,
		avgDurationMs: terminalWithDuration.length ? Math.round(totalDuration / terminalWithDuration.length) : null,
		lastFailureReason: safeFailureReason(lastFailed),
		timeoutCount: all.filter((j) => j.timedOut).length,
		cancelledCount: all.filter((j) => j.status === 'cancelled' || j.cancelled).length,
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
