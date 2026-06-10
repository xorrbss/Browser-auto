#!/usr/bin/env bash
# Browser-free unit tests for structured webui job results.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module - <<'NODE'
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

process.env.WEBUI_JOB_TIMEOUT_MS = '600';
process.env.WEBUI_JOB_KILL_GRACE_MS = '80';
process.env.WEBUI_JOB_HEARTBEAT_STALE_MS = '25';
process.env.WEBUI_JOB_SLOW_MS = '40';
const { enqueue, jobStatus, jobResult, queueState, cancel, subscribe } = await import('./webui/jobs.js');

const assert = (cond, msg) => { if (!cond) { console.error('  jobs-result-unit: ' + msg); process.exit(1); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitDone(id) {
	for (let i = 0; i < 80; i++) {
		const s = jobStatus(id);
		if (s && ['done', 'failed', 'cancelled'].includes(s.status)) return s;
		await sleep(50);
	}
	throw new Error('timeout waiting for ' + id);
}
async function waitUntil(id, pred, label) {
	for (let i = 0; i < 80; i++) {
		const s = jobStatus(id);
		if (s && pred(s)) return s;
		await sleep(25);
	}
	throw new Error('timeout waiting for ' + id + ' ' + label);
}
function longChild(ms = 1000) {
	return spawn(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`], {
		detached: process.platform !== 'win32',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}
function replayStream(id) {
	const chunks = [];
	const res = new EventEmitter();
	res.writableEnded = false;
	res.destroyed = false;
	res.writeHead = () => {};
	res.flushHeaders = () => {};
	res.write = (s) => { chunks.push(String(s)); };
	res.end = () => { res.writableEnded = true; };
	assert(subscribe(id, res), 'late SSE subscribe succeeds');
	return chunks.join('');
}

let job = enqueue({
	kind: 'unit',
	label: 'structured',
	meta: { commandId: 'cmd_test' },
	spawnFn: () => spawn(process.execPath, ['-e', 'console.log(JSON.stringify({results:[{status:"dry-ok"}]}))']),
});
await waitDone(job.id);
let jr = jobResult(job.id);
assert(jr.status === 'done', 'structured job finished');
assert(jr.meta.commandId === 'cmd_test', 'job meta is public');
assert(jr.result.results[0].status === 'dry-ok', 'final JSON summary captured as result');

job = enqueue({
	kind: 'unit',
	label: 'sentinel',
	spawnFn: () => spawn(process.execPath, ['-e', 'console.log("AQA_JOB_RESULT=" + JSON.stringify({status:"ok", value:3}))']),
});
await waitDone(job.id);
jr = jobResult(job.id);
assert(jr.result.status === 'ok' && jr.result.value === 3, 'AQA_JOB_RESULT sentinel captured');

job = enqueue({
	kind: 'unit',
	label: 'structured-failed',
	spawnFn: () => spawn(process.execPath, ['-e', 'console.log("AQA_JOB_RESULT=" + JSON.stringify({status:"failed", error:"locator timeout password=hunter2 token=abc123"})); process.exit(9)']),
});
await waitDone(job.id);
jr = jobResult(job.id);
assert(jr.status === 'failed', 'structured failed job fails');
assert(jr.failureReason === 'locator timeout password=[redacted] token=[redacted]', 'structured failure reason is sanitized');
assert(jr.diagnostics.failureReason === jr.failureReason, 'diagnostics expose sanitized failure reason');

job = enqueue({
	kind: 'unit',
	label: 'heartbeat-slow',
	spawnFn: () => spawn(process.execPath, ['-e', 'console.log("beat"); setTimeout(()=>process.exit(0), 400)']),
});
await waitUntil(job.id, (s) => s.status === 'running' && s.diagnostics?.lastHeartbeatAt, 'heartbeat');
await sleep(70);
let running = jobStatus(job.id);
assert(running.diagnostics.heartbeatState === 'stale', 'running job exposes stale heartbeat');
assert(running.diagnostics.slow === true, 'running job exposes slow diagnostic');
assert(queueState().metrics.heartbeatStaleCount >= 1, 'queue metrics count stale heartbeats');
await waitDone(job.id);
jr = jobResult(job.id);
assert(jr.diagnostics.slow === true && jr.diagnostics.signals.includes('slow'), 'terminal job keeps slow signal');

job = enqueue({
	kind: 'run',
	label: 'run-links',
	spawnFn: () => spawn(process.execPath, ['-e', 'console.log("[run] RUN_ID=20990101-010101-123 tests=1")']),
});
await waitDone(job.id);
jr = jobResult(job.id);
assert(jr.runId === '20990101-010101-123', 'run job captures RUN_ID');
assert(jr.artifacts.reportUrl === '/artifacts/20990101-010101-123/report.json', 'run job exposes report deep-link');
assert(jr.diagnostics.artifacts.resultsUrl === '/artifacts/20990101-010101-123/results.tsv', 'diagnostics expose artifact links');

job = enqueue({
	kind: 'unit',
	label: 'bad-result',
	spawnFn: () => spawn(process.execPath, ['-e', 'console.log("AQA_JOB_RESULT={bad")']),
});
await waitDone(job.id);
jr = jobResult(job.id);
assert(jr.status === 'done' && jr.error === 'malformed structured job result', 'malformed result records an error without failing the process status');
assert(jobResult('missing') === null, 'missing job result returns null');

job = enqueue({
	kind: 'unit',
	label: 'timeout',
	spawnFn: () => longChild(),
});
await waitDone(job.id);
jr = jobResult(job.id);
assert(jr.status === 'failed' && jr.timedOut === true, 'timeout marks job failed');
assert(jr.failureReason === 'timeout after 600ms', 'timeout failure reason includes timeout budget');
assert(replayStream(job.id).includes('[webui] diagnostic: status=failed'), 'terminal diagnostic is present in replayed SSE log');

job = enqueue({
	kind: 'unit',
	label: 'cancel',
	spawnFn: () => longChild(),
});
await waitUntil(job.id, (s) => s.status === 'running' && s.pid, 'running before cancel');
assert(cancel(job.id), 'cancel returns true for running job');
await waitDone(job.id);
jr = jobResult(job.id);
assert(jr.status === 'cancelled' && jr.cancelled === true, 'cancelled job is surfaced');

job = enqueue({
	kind: 'unit',
	label: 'failed',
	spawnFn: () => spawn(process.execPath, ['-e', 'process.exit(7)']),
});
await waitDone(job.id);
const q = queueState();
assert(q.metrics && q.metrics.queued === 0 && q.metrics.running === 0, 'queue metrics expose queued/running counts');
assert(q.metrics.recent === q.recent.length, 'queue metrics recent count matches recent list');
assert(Number.isFinite(q.metrics.avgDurationMs), 'queue metrics expose avg duration');
assert(q.metrics.lastFailureReason === 'exit code 7', 'queue metrics expose sanitized last failure reason');
assert(q.metrics.timeoutCount >= 1 && q.metrics.cancelledCount >= 1, 'queue metrics expose timeout/cancel counts');
assert(q.metrics.slowCount >= 1 && q.metrics.unstableCount >= 1, 'queue metrics expose slow/unstable counts');

console.log('  jobs-result-unit: all checks passed');
NODE
)
