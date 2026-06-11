#!/usr/bin/env bash
# Browser-free tests for WebUI artifact/static secret boundaries.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
PORT=$((5400 + RANDOM % 1000))
RUN_ID="20990102-010101-$((100000 + $$))"
RUN_B="20990103-010101-$((100000 + $$))"
ART="$DIR/artifacts/$RUN_ID"
ART_B="$DIR/artifacts/$RUN_B"
PUB_ENV="$DIR/webui/public/.env"
SRV=""

cleanup() {
	if [ -n "$SRV" ]; then
		kill "$SRV" 2>/dev/null || true
		wait "$SRV" 2>/dev/null || true
	fi
	rm -rf "$ART" "$ART_B" "$TMP"
	rm -f "$PUB_ENV"
}
trap cleanup EXIT

mkdir -p "$ART/nested"
mkdir -p "$ART_B"
cat > "$ART/report.json" <<JSON
[
  {
    "name": "secret-boundary",
    "status": "fail",
    "durationMs": 12,
    "reason": "password=hunter2 token=report_token_secret OTP 123456",
    "url": "https://example.test/path?token=query_secret",
    "authorization": "Bearer report_bearer_secret",
    "cookie": "sid=report_cookie_secret",
    "artifacts": "$ART/flow.values.json"
  }
]
JSON
printf 'RAW_VALUE_SECRET\n' > "$ART/flow.values.json"
printf 'RAW_STATE_SECRET\n' > "$ART/app.state.json"
printf 'RAW_DB_SECRET\n' > "$ART/local.sqlite"
printf '{"token":"job_jsonl_secret"}\n' > "$ART/webui-jobs.jsonl"
printf 'PNG_BYTES' > "$ART/screenshot.png"
printf '[{"name":"tenant-b","status":"pass","durationMs":1}]\n' > "$ART_B/report.json"
printf 'PUBLIC_ENV_SECRET\n' > "$PUB_ENV"

( cd "$DIR" && AQA_DB_PATH="$TMP/t.db" node --input-type=module - <<NODE
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const dbm = require('./lib/db.js');
const db = dbm.openDb();
try {
	dbm.saveWebuiArtifact(db, {
		tenantId: 'tenant_a',
		actorId: 'tester_a',
		runId: '$RUN_ID',
		path: 'artifacts/$RUN_ID/report.json',
		kind: 'report',
		sha256: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
		redaction: 'text-redacted-on-read',
		redactionStatus: 'redacted',
		scanStatus: 'clean',
		retention: 'ephemeral-debug',
		policyApproval: { status: 'approved', approvedBy: 'owner_a', approvedAt: '2099-01-01T00:00:00.000Z' },
	});
	dbm.saveWebuiArtifact(db, {
		tenantId: 'tenant_a',
		actorId: 'tester_a',
		runId: '$RUN_ID',
		path: 'artifacts/$RUN_ID/screenshot.png',
		kind: 'screenshot',
		sha256: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
		redaction: 'not-required',
		redactionStatus: 'not-required',
		scanStatus: 'clean',
		retention: 'ephemeral-debug',
		policyApproval: { status: 'approved', approvedBy: 'owner_a', approvedAt: '2099-01-01T00:00:00.000Z' },
	});
	dbm.saveWebuiArtifact(db, {
		tenantId: 'tenant_b',
		actorId: 'tester_b',
		runId: '$RUN_B',
		path: 'artifacts/$RUN_B/report.json',
		kind: 'report',
		sha256: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
		redaction: 'text-redacted-on-read',
		redactionStatus: 'redacted',
		scanStatus: 'clean',
		retention: 'ephemeral-debug',
		policyApproval: { status: 'approved', approvedBy: 'owner_b', approvedAt: '2099-01-01T00:00:00.000Z' },
	});
} finally {
	dbm.closeDb(db);
}
NODE
)

( cd "$DIR" && exec env AQA_DB_PATH="$TMP/t.db" WEBUI_TENANT_ID=tenant_a WEBUI_PORT="$PORT" WEBUI_KEEP_RUNS=999999 node webui/server.js >"$TMP/server.log" 2>&1 ) &
SRV=$!

PORT="$PORT" RUN_ID="$RUN_ID" RUN_B="$RUN_B" node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { createSecretStore, classifySecretPath, isSecretBearingPath, makeSecretRef, parseSecretRef, staticFilePolicy } from './webui/secrets.js';

const port = process.env.PORT;
const runId = process.env.RUN_ID;
const runB = process.env.RUN_B;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

assert.equal(isSecretBearingPath('/fixtures/auth/playwright/app.state.json'), true, 'auth state path is secret-bearing');
assert.equal(isSecretBearingPath('/flows/demo.values.json'), true, 'values sidecar path is secret-bearing');
assert.equal(isSecretBearingPath('/artifacts/20990101-000000-1/report.json'), false, 'normal report path is not denied by name');
assert.equal(classifySecretPath('/artifacts/run/local.sqlite').reason, 'secret-file', 'local DB artifact is denied by name');
assert.equal(staticFilePolicy('/tmp/report.json', { artifact: true }).redact, true, 'text artifacts are redacted');

const ref = makeSecretRef({ tenantId: 'tenant_a', kind: 'flow-values', name: 'demo' });
assert.deepEqual(parseSecretRef(ref), { tenantId: 'tenant_a', kind: 'flow-values', name: 'demo', ref }, 'secret refs round-trip without local paths');
const store = createSecretStore({ tenantId: 'tenant_a' });
const meta = store.describeLocalFile({ kind: 'auth-state', name: 'app', filePath: '/not/read/app.state.json', stat: { size: 42, mtimeMs: 99 } });
assert.equal(meta.ref, 'aqa-secret://tenant_a/auth-state/app', 'secret metadata exposes an opaque ref');
assert.equal(meta.pathExposed, false, 'secret metadata does not expose raw paths');
assert.equal(meta.encrypted, false, 'local pilot metadata is explicit about plaintext storage');
await assert.rejects(() => store.getBytes(ref), /not exposed/, 'secret bytes are not readable through interface');

for (let i = 0; i < 80; i++) {
	try {
		const r = await fetch(base + '/');
		if (r.status === 200) break;
	} catch {}
	await sleep(100);
	if (i === 79) throw new Error('server did not become ready');
}

let r = await fetch(`${base}/artifacts/${runId}/report.json`);
assert.equal(r.status, 200, 'report artifact remains viewable');
assert.equal(r.headers.get('x-aqa-redaction'), 'applied', 'text artifact is served through redactor');
let text = await r.text();
for (const raw of ['hunter2', 'report_token_secret', '123456', 'query_secret', 'report_bearer_secret', 'report_cookie_secret', 'flow.values.json']) {
	assert(!text.includes(raw), `redacted report must not expose ${raw}`);
}
assert.match(text, /\[redacted\]|\[REDACTED_SECRET_PATH\]/, 'redacted report includes redaction markers');

for (const name of ['flow.values.json', 'app.state.json', 'local.sqlite', 'webui-jobs.jsonl', 'nested/../app.state.json']) {
	r = await fetch(`${base}/artifacts/${runId}/${name}`);
	assert.equal(r.status, 404, `${name} is not statically served`);
}

r = await fetch(`${base}/artifacts/${runB}/report.json`);
assert.equal(r.status, 404, 'tenant A cannot reuse a tenant B artifact URL');

r = await fetch(`${base}/artifacts/${runId}/nested/%2e%2e/app.state.json`);
assert.equal(r.status, 404, 'encoded traversal toward a denied artifact stays blocked');

r = await fetch(`${base}/artifacts/${runId}/screenshot.png`);
assert.equal(r.status, 200, 'non-secret binary artifact still streams');
assert.equal(r.headers.get('x-aqa-redaction'), null, 'binary artifact is not text-redacted');

r = await fetch(`${base}/.env`);
assert.equal(r.status, 404, 'public static .env is denied');

r = await fetch(`${base}/api/runs/${runId}`);
assert.equal(r.status, 200, 'run API still reads the report');
const body = await r.json();
const serialized = JSON.stringify(body);
for (const raw of ['hunter2', 'report_token_secret', 'query_secret', 'report_bearer_secret', 'report_cookie_secret', 'flow.values.json']) {
	assert(!serialized.includes(raw), `run API must not expose ${raw}`);
}
assert.equal(body.tests[0].artifactUrl, null, 'run API does not advertise denied artifact link');

console.log('  webui-artifact-boundary-unit: all checks passed');
NODE
