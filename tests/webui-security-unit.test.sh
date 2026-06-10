#!/usr/bin/env bash
# Browser-free tests for WebUI external-mode fail-closed security gates.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
PORT=$((5200 + RANDOM % 1000))
TOKEN="0123456789abcdef"
SRV=""

cleanup() {
	if [ -n "$SRV" ]; then
		kill "$SRV" 2>/dev/null || true
		wait "$SRV" 2>/dev/null || true
	fi
	rm -rf "$TMP"
}
trap cleanup EXIT

(
	cd "$DIR"
	node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { authorizeHttpRequest, secretPathBlocked, securityModeSummary } from './webui/security.js';

const allowedHosts = new Set(['127.0.0.1:4310', 'localhost:4310']);
const req = (method, headers = {}) => ({ method, headers });
const externalEnv = {
	WEBUI_EXTERNAL_MODE: '1',
	WEBUI_AUTH_TOKEN: '0123456789abcdef',
	WEBUI_TENANT_ID: 'tenant_a',
	WEBUI_ACTOR_ID: 'alice',
	WEBUI_ACTOR_ROLE: 'viewer',
};

assert.equal(secretPathBlocked('/fixtures/auth/playwright/app.state.json'), true, 'auth state path is blocked');
assert.equal(secretPathBlocked('/flows/demo.values.json'), true, 'values sidecar path is blocked');
assert.equal(secretPathBlocked('/data/approvals.db'), true, 'local DB path is blocked');
assert.equal(secretPathBlocked('/artifacts/20990101-000000-1/report.json'), false, 'normal report path is allowed by path gate');

assert.equal(authorizeHttpRequest(req('GET'), '/api/runs', { allowedHosts }).ok, true, 'local mode allows existing localhost behavior');

let summary = securityModeSummary(externalEnv);
assert.equal(summary.mode, 'external', 'external mode is detected');
assert.equal(summary.configured, true, 'external mode is configured with token and tenant');
assert.equal(summary.tenantId, 'tenant_a', 'tenant id is exposed as metadata');

let decision = authorizeHttpRequest(req('POST', {}), '/api/run', { allowedHosts, env: externalEnv });
assert.equal(decision.code, 401, 'missing bearer token is unauthorized before mutation can run');

decision = authorizeHttpRequest(req('POST', { authorization: 'Bearer wrongwrongwrongwrong' }), '/api/run', { allowedHosts, env: externalEnv });
assert.equal(decision.code, 401, 'wrong bearer token is unauthorized');

decision = authorizeHttpRequest(req('POST', { authorization: `Bearer ${externalEnv.WEBUI_AUTH_TOKEN}` }), '/api/run', { allowedHosts, env: externalEnv });
assert.equal(decision.code, 403, 'external mutation without origin/referer is refused');

decision = authorizeHttpRequest(req('POST', { authorization: `Bearer ${externalEnv.WEBUI_AUTH_TOKEN}`, origin: 'http://evil.test' }), '/api/run', { allowedHosts, env: externalEnv });
assert.equal(decision.code, 403, 'wrong origin is refused');

decision = authorizeHttpRequest(req('POST', { authorization: `Bearer ${externalEnv.WEBUI_AUTH_TOKEN}`, origin: 'http://127.0.0.1:4310' }), '/api/run', { allowedHosts, env: externalEnv });
assert.equal(decision.ok, true, 'valid bearer token plus same-origin is accepted by the HTTP gate');
assert.equal(decision.tenantId, 'tenant_a', 'request context carries tenant id');

decision = authorizeHttpRequest(req('POST', { authorization: `Bearer ${externalEnv.WEBUI_AUTH_TOKEN}`, origin: 'http://127.0.0.1:4310' }), '/api/run', {
	allowedHosts,
	env: { ...externalEnv, WEBUI_CSRF_TOKEN: 'csrf-secret' },
});
assert.equal(decision.code, 403, 'configured CSRF token is required');

decision = authorizeHttpRequest(req('POST', { authorization: `Bearer ${externalEnv.WEBUI_AUTH_TOKEN}`, origin: 'http://127.0.0.1:4310', 'x-aqa-csrf': 'csrf-secret' }), '/api/run', {
	allowedHosts,
	env: { ...externalEnv, WEBUI_CSRF_TOKEN: 'csrf-secret' },
});
assert.equal(decision.ok, true, 'valid CSRF header is accepted');

console.log('  webui-security-unit: pure security gate checks passed');
NODE
)

( cd "$DIR" && exec env AQA_DB_PATH="$TMP/t.db" WEBUI_PORT="$PORT" WEBUI_KEEP_RUNS=999999 WEBUI_EXTERNAL_MODE=1 WEBUI_AUTH_TOKEN="$TOKEN" WEBUI_TENANT_ID=tenant_a AQA_WEBUI_ROLE=viewer node webui/server.js >"$TMP/server.log" 2>&1 ) &
SRV=$!

PORT="$PORT" TOKEN="$TOKEN" node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';

const port = process.env.PORT;
const token = process.env.TOKEN;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < 80; i++) {
	try {
		const r = await fetch(base + '/api/runs');
		if (r.status === 401) break;
	} catch {}
	await sleep(100);
	if (i === 79) throw new Error('server did not become ready');
}

async function post(headers = {}) {
	return fetch(base + '/api/run', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify({ glob: 'login' }),
	});
}

let r = await post();
assert.equal(r.status, 401, 'external-mode mutating route rejects unauthenticated request');

r = await post({ Authorization: `Bearer ${token}` });
assert.equal(r.status, 403, 'external-mode mutating route rejects missing origin/referer');

r = await post({ Authorization: `Bearer ${token}`, Origin: base });
assert.equal(r.status, 403, 'authenticated viewer still cannot enqueue a run');
const body = await r.json();
assert.match(body.reason || '', /lacks permission/, 'RBAC denial is reported');

r = await fetch(base + '/api/rbac', { headers: { Authorization: `Bearer ${token}` } });
assert.equal(r.status, 200, 'authenticated external read can inspect RBAC');
const rbac = await r.json();
assert.equal(rbac.tenantId, 'tenant_a', 'RBAC readback includes tenant metadata');

console.log('  webui-security-unit: external-mode server route checks passed');
NODE
