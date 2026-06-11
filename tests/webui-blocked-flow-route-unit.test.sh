#!/usr/bin/env bash
# Browser-free route checks for WebUI blocked-flow static metadata.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
PORT=$((6100 + RANDOM % 1000))
SRV=""

fail(){ echo "  webui-blocked-flow-route-unit: $1" >&2; exit 1; }

cleanup() {
	if [ -n "$SRV" ]; then
		kill "$SRV" 2>/dev/null || true
		wait "$SRV" 2>/dev/null || true
	fi
	rm -rf "$TMP"
}
trap cleanup EXIT

node --check "$DIR/webui/blocked-flows.js" || fail "blocked-flows syntax failed"
node --check "$DIR/webui/flows.js" || fail "flows syntax failed"
node --check "$DIR/webui/readiness.js" || fail "readiness syntax failed"
node --check "$DIR/webui/server.js" || fail "server syntax failed"
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

PORT="$PORT" node --input-type=module - <<'NODE' || fail "server route contract failed"
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

r = await fetch(`${base}/api/flows`);
assert.equal(r.status, 200, 'flows route returns 200');
body = await r.json();
const hiworks = body.flows.find((flow) => flow.name === 'hiworks01');
assert.equal(hiworks?.blockedFlow?.status, 'blocked', 'flows route includes structured blockedFlow metadata');

r = await fetch(`${base}/api/queue`);
assert.equal(r.status, 200, 'queue route returns 200');
body = await r.json();
assert.equal(body.running, null, 'static metadata reads do not start a running job');
assert.equal(Array.isArray(body.pending) ? body.pending.length : 0, 0, 'static metadata reads do not enqueue jobs');
NODE

echo "  webui-blocked-flow-route-unit: static blocked-flow route/readiness checks passed"
