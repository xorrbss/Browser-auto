#!/usr/bin/env bash
# Browser-free unit tests for structured webui job results.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module - <<'NODE'
import { spawn } from 'node:child_process';
import { enqueue, jobStatus, jobResult, queueState } from './webui/jobs.js';

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
	label: 'bad-result',
	spawnFn: () => spawn(process.execPath, ['-e', 'console.log("AQA_JOB_RESULT={bad")']),
});
await waitDone(job.id);
jr = jobResult(job.id);
assert(jr.status === 'done' && jr.error === 'malformed structured job result', 'malformed result records an error without failing the process status');
assert(jobResult('missing') === null, 'missing job result returns null');

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
assert(Number.isInteger(q.metrics.timeoutCount) && Number.isInteger(q.metrics.cancelledCount), 'queue metrics expose timeout/cancel counts');

console.log('  jobs-result-unit: all checks passed');
NODE
)
