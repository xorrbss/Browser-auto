#!/usr/bin/env bash
# Browser-free route checks for WebUI blocked-flow static metadata.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
PORT=$((6100 + RANDOM % 1000))
SRV=""
DEV_FLOW_NAME="_webui_dev_readonly_$$"
DEV_FLOW="$DIR/flows/$DEV_FLOW_NAME.flow.json"
DEV_TEST="$DIR/tests/$DEV_FLOW_NAME.test.sh"

fail(){ echo "  webui-blocked-flow-route-unit: $1" >&2; exit 1; }

cleanup() {
	if [ -n "$SRV" ]; then
		kill "$SRV" 2>/dev/null || true
		wait "$SRV" 2>/dev/null || true
	fi
	rm -f "$DEV_FLOW" "$DEV_TEST"
	rm -rf "$TMP"
}
trap cleanup EXIT

cat > "$DEV_FLOW" <<JSON
{
  "name": "$DEV_FLOW_NAME",
  "engine": "playwright",
  "environment": "live-readonly",
  "riskClass": "read",
  "startUrl": "https://example.com",
  "steps": [
    { "kind": "find", "by": "text", "value": "Example Domain", "action": "hover" }
  ],
  "asserts": []
}
JSON
node --check "$DIR/webui/blocked-flows.js" || fail "blocked-flows syntax failed"
node --check "$DIR/webui/flows.js" || fail "flows syntax failed"
node --check "$DIR/webui/readiness.js" || fail "readiness syntax failed"
node --check "$DIR/webui/server.js" || fail "server syntax failed"
node --check "$DIR/webui/jobs.js" || fail "jobs syntax failed"
node --check "$DIR/webui/public/app.js" || fail "app syntax failed"
node --check "$DIR/webui/public/ops-dashboard.js" || fail "ops-dashboard syntax failed"

( cd "$DIR" && node --input-type=module - <<'NODE' ) || fail "module contract failed"
import assert from 'node:assert/strict';
import { getWebuiBlockedFlowReportSafe } from './webui/blocked-flows.js';
import { listFlows, getFlow } from './webui/flows.js';
import { getP0Readiness } from './webui/readiness.js';

const report = await getWebuiBlockedFlowReportSafe();
assert.equal(report.generator, 'blocked-flow-report/v1');
assert.equal(report.metadataOnly, true, 'route report declares metadata-only');
assert.equal(report.staticAnalysisOnly, true, 'route report declares static analysis only');
assert.equal(report.liveReplay, false, 'route report declares no live replay');
assert.equal(report.spawnsProcess, false, 'route report declares no process spawn');
assert.equal(report.reads.valuesSidecars, false, 'route report does not read values sidecars');
assert.equal(report.reads.authState, false, 'route report does not read auth state contents');
assert.equal(report.reads.authStateContents, false, 'route report does not expose auth state contents');
assert.equal(report.flowsDir, 'flows', 'route report uses repo-relative flowsDir');
assert(!JSON.stringify(report).includes('C:\\'), 'route report does not expose absolute Windows paths');

const byName = Object.fromEntries(report.flows.map((flow) => [flow.name, flow]));
assert.equal(byName.hiworks01.status, 'blocked', 'hiworks01 is surfaced as blocked');
assert(byName.hiworks01.blockers.some((b) => b.code === 'needs_review'), 'hiworks01 includes needs_review blockers');
assert.equal(byName.guest_samsungdisplay_com_argos_main_do.status, 'blocked', 'Samsung Argos flow is surfaced as blocked');
assert(byName.guest_samsungdisplay_com_argos_main_do.blockers.some((b) => b.code === 'missing_irreversible_gate'), 'Samsung Argos flow includes irreversible gate blocker');

const flows = await listFlows();
const hiworksList = flows.find((flow) => flow.name === 'hiworks01');
assert.equal(hiworksList?.blockedFlow?.status, 'blocked', '/api/flows summaries include blockedFlow metadata');
assert.equal(hiworksList?.scenarioStatus?.staticAnalysis?.status, 'blocked', 'scenarioStatus carries static analysis metadata');
const hiworksDetail = await getFlow('hiworks01');
assert.equal(hiworksDetail.blockedFlow.status, 'blocked', '/api/flows/:name includes blockedFlow metadata');

const readiness = await getP0Readiness();
assert.equal(readiness.blockedFlows.staticAnalysisOnly, true, 'readiness exposes static flow analysis');
assert.equal(readiness.blockedFlows.liveReplay, false, 'readiness flow analysis is no-replay');
assert(readiness.releaseChecklist.blockedFlows.blocked.includes('hiworks01'), 'release checklist lists blocked flow names');
assert(readiness.releaseChecklist.blockedFlows.blocked.includes('guest_samsungdisplay_com_argos_main_do'), 'release checklist lists Samsung blocked flow');
assert(!JSON.stringify(readiness).includes('C:\\'), 'readiness does not expose absolute Windows paths');
NODE

( cd "$DIR" && exec env AQA_DB_PATH="$TMP/t.db" WEBUI_PORT="$PORT" WEBUI_KEEP_RUNS=999999 node webui/server.js >"$TMP/server.log" 2>&1 ) &
SRV=$!

PORT="$PORT" DEV_FLOW_NAME="$DEV_FLOW_NAME" node --input-type=module - <<'NODE' || fail "server route contract failed"
import assert from 'node:assert/strict';

const base = `http://127.0.0.1:${process.env.PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
for (let i = 0; i < 80; i += 1) {
	try {
		const r = await fetch(`${base}/api/runs`);
		if (r.status === 200) break;
	} catch {}
	await sleep(100);
	if (i === 79) throw new Error('server did not become ready');
}

let r = await fetch(`${base}/api/flows/blocked-report`);
assert.equal(r.status, 200, 'blocked-flow report route returns 200');
let body = await r.json();
assert.equal(body.generator, 'blocked-flow-report/v1', 'route is not swallowed by /api/flows/:name');
assert.equal(body.staticAnalysisOnly, true, 'route response is static analysis only');
assert.equal(body.liveReplay, false, 'route response declares no live replay');
assert(body.flows.some((flow) => flow.name === 'hiworks01' && flow.status === 'blocked'), 'route includes hiworks01 blocked metadata');
assert(!JSON.stringify(body).includes('C:\\'), 'route body does not expose absolute Windows paths');

r = await fetch(`${base}/api/readiness`);
assert.equal(r.status, 200, 'readiness route returns 200');
body = await r.json();
assert.equal(body.blockedFlows.staticAnalysisOnly, true, 'readiness route includes static blocked-flow report');
assert(body.releaseChecklist.blockedFlows.blocked.includes('guest_samsungdisplay_com_argos_main_do'), 'readiness route includes blocked flow names');

r = await fetch(`${base}/api/auth`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({
		app: 'bad app',
		loginUrl: 'https://example.com/login',
		successUrl: 'https://example.com/dashboard',
		engine: 'playwright',
	}),
});
assert.equal(r.status, 400, 'auth setup route is handled before static secret-path fallback');
body = await r.json();
assert.match(body.error || '', /invalid app name/, 'auth setup route returns validation errors, not static not found');

r = await fetch(`${base}/api/flows`);
assert.equal(r.status, 200, 'flows route returns 200');
body = await r.json();
const hiworks = body.flows.find((flow) => flow.name === 'hiworks01');
assert.equal(hiworks?.blockedFlow?.status, 'blocked', 'flows route includes structured blockedFlow metadata');

const resolverEvidence = JSON.stringify({
	'example.com': {
		addresses: ['93.184.216.34'],
		connectionIps: ['93.184.216.34'],
		resolvedAtMs: Date.now(),
	},
});
r = await fetch(`${base}/api/dev-integration-readonly`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({
		name: process.env.DEV_FLOW_NAME,
		validateOnly: true,
		allowlist: 'https://example.com',
		resolverEvidence,
	}),
});
assert.equal(r.status, 202, 'development read-only route enqueues');
body = await r.json();
assert.equal(body.mode, 'development-integration-readonly', 'route reports development integration mode');
assert.equal(body.approvalRequired, false, 'route does not require owner approval for dev read-only');
assert.equal(body.evidencePackRequired, false, 'route does not require evidence pack for dev read-only');
assert.equal(body.allowlist, 'https://example.com', 'route returns exact allowlist');
assert.equal(body.job?.meta?.workflow, 'development-integration', 'job metadata marks development integration');
assert.equal(body.job?.meta?.productionOpenApprovalRequired, false, 'job metadata keeps production approval separate');
assert.match(body.job?.label || '', /dev-readonly validate/, 'validate-only dev route uses the development validate lane');
const jobId = body.job.id;
let job = null;
for (let i = 0; i < 80; i += 1) {
	const jr = await fetch(`${base}/api/jobs/${jobId}`);
	assert.equal(jr.status, 200, 'job status route returns 200');
	job = await jr.json();
	if (['done', 'failed', 'cancelled'].includes(job.status)) break;
	await sleep(100);
}
assert.equal(job.status, 'done', `development read-only validate job should finish, got ${job.status}: ${job.failureReason || job.error || ''}`);

r = await fetch(`${base}/api/dev-integration-readonly`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({ name: process.env.DEV_FLOW_NAME, allowlist: 'https://example.com/path' }),
});
assert.equal(r.status, 400, 'development read-only route rejects path allowlist entries');

r = await fetch(`${base}/api/dev-integration-readonly`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({
		name: process.env.DEV_FLOW_NAME,
		allowlist: 'https://example.com',
		resolverEvidence,
	}),
});
assert.equal(r.status, 409, 'development read-only replay still requires compiled test wrapper');
body = await r.json();
assert.match(body.error || '', /compiled test is missing or older than the flow/, 'replay compile blocker is explicit');

r = await fetch(`${base}/api/compile`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({ name: process.env.DEV_FLOW_NAME }),
});
assert.equal(r.status, 200, 'compile route returns 200 for development read-only flow');
body = await r.json();
assert.equal(body.ok, true, `development read-only compile should pass, got ${body.output || body.code}`);
assert.equal(body.mode, 'development-integration-readonly', 'compile route reports development read-only mode');
assert.equal(body.allowlist, 'https://example.com', 'compile route derives exact startUrl allowlist');

r = await fetch(`${base}/api/dev-integration-readonly`, {
	method: 'POST',
	headers: { 'Content-Type': 'application/json' },
	body: JSON.stringify({ name: 'hiworks01', allowlist: 'https://example.com' }),
});
assert.equal(r.status, 409, 'development read-only route refuses non-read/live-action flow');

r = await fetch(`${base}/api/queue`);
assert.equal(r.status, 200, 'queue route returns 200');
body = await r.json();
assert(body.running === null || body.running.label.startsWith('dev-readonly'), 'only the requested development job may run');
assert.equal(Array.isArray(body.pending) ? body.pending.length : 0, 0, 'static metadata reads do not enqueue jobs');
NODE

echo "  webui-blocked-flow-route-unit: static blocked-flow route/readiness checks passed"
