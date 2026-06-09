#!/usr/bin/env bash
# Browser-free server smoke for CommandPlan confirm's strict session/origin gate.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
PORT=$((4800 + RANDOM % 1000))
SRV=""

cleanup() {
	if [ -n "$SRV" ]; then
		kill "$SRV" 2>/dev/null || true
		wait "$SRV" 2>/dev/null || true
	fi
	rm -rf "$TMP"
}
trap cleanup EXIT

( cd "$DIR" && exec env AQA_DB_PATH="$TMP/t.db" WEBUI_PORT="$PORT" WEBUI_KEEP_RUNS=999999 node webui/server.js >"$TMP/server.log" 2>&1 ) &
SRV=$!

if ! PORT="$PORT" node --input-type=module - <<'NODE'
const port = process.env.PORT;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (cond, msg) => {
	if (!cond) {
		console.error('  command-confirm-session-route-unit: ' + msg);
		process.exit(1);
	}
};

for (let i = 0; i < 80; i++) {
	try {
		const r = await fetch(base + '/');
		if (r.status === 200) break;
	} catch {}
	await sleep(100);
	if (i === 79) throw new Error('server did not become ready');
}

async function post(path, body, headers = {}) {
	return fetch(base + path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(body || {}),
	});
}

let r = await post('/api/agent/plan', { text: 'query records', system: 'hiworks', action: 'query' });
assert(r.status === 200, 'plan create failed with status ' + r.status);
const created = await r.json();
const plan = created.plan;
assert(plan && plan.id && plan.hash, 'created plan has id/hash');

r = await post(`/api/agent/plan/${plan.id}/confirm`, { planHash: plan.hash, confirm: true });
assert(r.status === 403, 'confirm without Origin/Referer must be 403, got ' + r.status);

r = await post(`/api/agent/plan/${plan.id}/confirm`, { planHash: plan.hash, confirm: true }, { Origin: base });
assert(r.status === 401, 'confirm with same-origin but no session must be 401, got ' + r.status);

r = await fetch(`${base}/api/agent/plan/${plan.id}/events`);
assert(r.status === 200, 'events fetch failed');
const events = (await r.json()).events || [];
const reasons = new Set(events.filter((e) => e.type === 'gate_refused').map((e) => e.reason));
assert(reasons.has('origin_or_referer_required'), 'origin/referer refusal was not persisted');
assert(reasons.has('session_missing'), 'session refusal was not persisted');

console.log('  command-confirm-session-route-unit: all checks passed');
NODE
then
	cat "$TMP/server.log" >&2
	exit 1
fi
