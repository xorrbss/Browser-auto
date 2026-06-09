#!/usr/bin/env bash
# Browser-free unit tests for the durable CommandPlan route contract.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; rm -f "$DIR/recipes/planunit.json" "$DIR/approve/planunit.pw-state.json"' EXIT

( cd "$DIR" && AQA_DB_PATH="$TMP/t.db" node --input-type=module - <<'NODE'
import fs from 'node:fs';
import { createRequire } from 'node:module';

process.env.AQA_DB_PATH = process.env.AQA_DB_PATH;
const require = createRequire(import.meta.url);
const dbm = require('./lib/db.js');

fs.mkdirSync('recipes', { recursive: true });
fs.mkdirSync('approve', { recursive: true });
fs.writeFileSync('recipes/planunit.json', JSON.stringify({
	collection: { name: 'Rows' },
	key: 'doc_id',
	columns: { doc_id: 'ID', title: 'Title' },
	actions: {
		approve: {
			button: { role: 'button', name: 'Approve', exact: true },
			decision: { role: 'radio', name: 'Yes' },
			confirm: { role: 'button', name: 'OK', exact: true },
			success: 'leftInbox',
			titleField: 'title'
		},
		reject: { enabled: false }
	}
}));
fs.writeFileSync('approve/planunit.pw-state.json', '{}');

const db = dbm.openDb();
dbm.registerSystem(db, {
	name: 'planunit',
	target_url: 'https://example.test/list',
	recipe: { collection: { name: 'Rows' }, key: 'doc_id', columns: { doc_id: 'ID', title: 'Title' } }
});
dbm.upsertRecords(db, 'planunit', [
	{ key: 'DOC-1', data: { title: 'Expense one' }, summary: 'ready' },
	{ key: 'DOC-2', data: { title: 'Expense two' }, summary: 'ready' },
]);
dbm.closeDb(db);

const { commandPlanPost, commandPlanGet } = await import('./webui/routes-command-plan.js');

const assert = (cond, msg) => { if (!cond) { console.error('  agent-plan-unit: ' + msg); process.exit(1); } };
const res = () => ({ code: 0, body: null });
const sendJson = (r, code, obj) => { r.code = code; r.body = obj; };
let enqueued = [];
const deps = {
	sendJson,
	enqueue(spec) {
		const job = { id: 'j' + (enqueued.length + 1), kind: spec.kind, label: spec.label, status: 'queued', meta: spec.meta || {} };
		enqueued.push({ spec, job });
		return job;
	},
	nodeLeaf(script, args) { return { script, args }; },
	gitBash(script, args) { return { script, args }; }
};

async function post(path, body) {
	const r = res();
	const handled = await commandPlanPost(path, body || {}, r, deps);
	assert(handled, 'route not handled: ' + path);
	return r;
}
function get(path) {
	const r = res();
	const handled = commandPlanGet(path, new URL('http://x' + path), r, { sendJson });
	assert(handled, 'GET route not handled: ' + path);
	return r;
}

let r = await post('/api/agent/plan', { text: 'approve it', system: 'planunit', action: 'approve' });
assert(r.code === 200, 'plan create returns 200');
const plan = r.body.plan;
assert(plan.id && plan.hash.startsWith('sha256:'), 'plan id/hash present');
assert(plan.status === 'planned' && plan.riskClass === 'irreversible', 'irreversible plan is planned');

r = await post('/api/agent/plan', { text: 'reject it', system: 'planunit', action: 'reject' });
assert(r.code === 200 && r.body.plan.status === 'refused' && r.body.refusal.reason === 'action_unavailable', 'disabled action creates a refused plan');

r = await post(`/api/agent/plan/${plan.id}/dry-run`, { planHash: 'sha256:wrong', targetKeys: ['DOC-1'] });
assert(r.code === 409 && r.body.reason === 'hash_mismatch', 'dry-run rejects plan hash mismatch');

r = await post(`/api/agent/plan/${plan.id}/dry-run`, { targetKeys: ['DOC-1'] });
assert(r.code === 409 && r.body.reason === 'missing_plan_hash', 'dry-run requires plan hash');

r = await post(`/api/agent/plan/${plan.id}/dry-run`, { planHash: plan.hash });
assert(r.code === 409 && r.body.reason === 'target_review_required', 'dry-run requires reviewed targets');

r = await post(`/api/agent/plan/${plan.id}/dry-run`, { planHash: plan.hash, targetKeys: ['DOC-1'] });
assert(r.code === 202 && r.body.job.meta.commandId === plan.id && r.body.job.meta.dryRun === true, 'dry-run queues command-scoped dry job: ' + JSON.stringify(r.body));
assert(r.body.plan.targetSetHash && r.body.plan.targetCount === 1, 'dry-run stores target-set hash');
const targetSetHash = r.body.plan.targetSetHash;

r = await post(`/api/agent/plan/${plan.id}/confirm`, { planHash: plan.hash, targetSetHash, confirm: true });
assert(r.code === 409 && r.body.reason === 'dry_run_missing', 'confirm rejects before dry-run result is persisted');

enqueued[0].spec.onFinish({ id: enqueued[0].job.id, status: 'done', exitCode: 0, result: { results: [{ doc_id: 'DOC-1', status: 'dry-ok' }] } });

r = await post(`/api/agent/plan/${plan.id}/confirm`, { planHash: plan.hash, targetSetHash });
assert(r.code === 409 && r.body.reason === 'missing_human_confirmation', 'confirm requires explicit human confirmation');

r = await post(`/api/agent/plan/${plan.id}/confirm`, { targetSetHash, dryRunHash: enqueued[0].job.id, confirm: true });
assert(r.code === 409 && r.body.reason === 'missing_plan_hash', 'confirm requires plan hash');

r = await post(`/api/agent/plan/${plan.id}/confirm`, { planHash: plan.hash, dryRunHash: enqueued[0].job.id, confirm: true });
assert(r.code === 409 && r.body.reason === 'missing_target_set_hash', 'confirm requires target-set hash');

r = await post(`/api/agent/plan/${plan.id}/confirm`, { planHash: plan.hash, targetSetHash: 'sha256:bad', dryRunHash: 'sha256:dry', confirm: true });
assert(r.code === 409 && r.body.reason === 'target_review_mismatch', 'confirm rejects target-set hash mismatch');

r = await post(`/api/agent/plan/${plan.id}/confirm`, { planHash: plan.hash, targetSetHash, confirm: true });
assert(r.code === 409 && r.body.reason === 'missing_dry_run_hash', 'confirm requires dry-run hash');

r = await post(`/api/agent/plan/${plan.id}/confirm`, { planHash: plan.hash, targetSetHash, dryRunHash: 'sha256:bad', confirm: true });
assert(r.code === 409 && r.body.reason === 'dry_run_mismatch', 'confirm rejects dry-run hash mismatch');

let planAfterDry = get(`/api/agent/plan/${plan.id}`).body.plan;
r = await post(`/api/agent/plan/${plan.id}/confirm`, { planHash: plan.hash, targetSetHash, dryRunHash: planAfterDry.dryRun.hash, confirm: true });
assert(r.code === 202 && r.body.job.meta.dryRun === false && r.body.confirmation.status === 'confirmed', 'confirm queues live job after gates pass');

enqueued[1].spec.onFinish({ id: enqueued[1].job.id, status: 'done', exitCode: 0, result: { results: [{ doc_id: 'DOC-1', status: 'approved' }] } });

r = await post(`/api/agent/plan/${plan.id}/confirm`, { planHash: plan.hash, targetSetHash, dryRunHash: planAfterDry.dryRun.hash, confirm: true });
assert(r.code === 409 && r.body.reason === 'already_confirmed', 'confirm cannot enqueue a second live job');

r = get(`/api/agent/plan/${plan.id}/events`);
const refusedReasons = new Set(r.body.events.filter((e) => e.type === 'gate_refused').map((e) => e.reason));
for (const reason of ['hash_mismatch', 'missing_plan_hash', 'target_review_required', 'dry_run_missing', 'missing_human_confirmation', 'missing_target_set_hash', 'target_review_mismatch', 'missing_dry_run_hash', 'dry_run_mismatch', 'already_confirmed']) {
	assert(refusedReasons.has(reason), 'gate refusal event persisted for ' + reason);
}
assert(r.code === 200 && r.body.events.some((e) => e.type === 'targets_reviewed') && r.body.events.some((e) => e.type === 'dry_run_completed') && r.body.events.some((e) => e.type === 'confirmed') && r.body.events.some((e) => e.type === 'live_completed'), 'events are durable');

r = await post('/api/agent/plan', { text: 'approve target mutation', system: 'planunit', action: 'approve' });
const plan2 = r.body.plan;
r = await post(`/api/agent/plan/${plan2.id}/dry-run`, { planHash: plan2.hash, targetKeys: ['DOC-1'] });
assert(r.code === 202, 'second dry-run queues');
const oldTargetSetHash = r.body.plan.targetSetHash;
let h = dbm.openDb();
dbm.updateCommandPlan(h, plan2.id, {
	status: 'awaiting_confirmation',
	dry_run_json: { status: 'passed', hash: 'sha256:dry2', planHash: plan2.hash, targetSetHash: oldTargetSetHash, result: { results: [{ doc_id: 'DOC-1', status: 'dry-ok' }] } }
});
dbm.closeDb(h);
r = await post(`/api/agent/plan/${plan2.id}/targets`, { planHash: plan2.hash, targetKeys: ['DOC-2'] });
assert(r.code === 200 && r.body.targetSetHash !== oldTargetSetHash, 'reviewed target change stores a new target-set hash');
r = await post(`/api/agent/plan/${plan2.id}/confirm`, { planHash: plan2.hash, targetSetHash: r.body.targetSetHash, dryRunHash: 'sha256:dry2', confirm: true });
assert(r.code === 409 && r.body.reason === 'dry_run_missing', 'target changes invalidate the prior dry-run');

console.log('  agent-plan-unit: all checks passed');
NODE
)
