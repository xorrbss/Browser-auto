#!/usr/bin/env bash
# tests/db-unit.test.sh - browser-free unit test for lib/db.js.
#
# Covers both stores backed by node:sqlite:
#   - generic systems/records registry used by the RPA product layer
#   - approvals store used by the Hiworks reference path
#
# The test uses AQA_DB_PATH so it never touches data/. It is deterministic:
# no daemon, no browser, no network, no LLM.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# `node -e` and heredocs resolve require() relative to CWD, so cd to the repo
# root and require ./lib/db.js. An absolute MSYS path like /c/... is not a
# valid Node module specifier on Windows.
(
	cd "$DIR"
	AQA_DB_PATH="$TMP/t.db" NODE_NO_WARNINGS=1 node <<'NODE'
const assert = require('node:assert/strict');
const d = require('./lib/db.js');
const h = d.openDb();

// systems CRUD + recipe round-trips as an object
d.registerSystem(h, {
	name: 'sys',
	label: 'L',
	target_url: 'u',
	recipe: { collection: { name: 't' }, key: 'k', columns: { k: 'K' } },
});
assert.equal(d.getSystem(h, 'sys').recipe.key, 'k', 'recipe parsed back to object');
assert.equal(d.listSystems(h).length, 1, 'listSystems returns 1');

// records: merge accumulates; null in a later pass preserves prior value
d.upsertRecords(h, 'sys', [{ key: 'A', data: { title: 't1', amt: '100' } }]);
d.upsertRecords(h, 'sys', [{ key: 'A', data: { title: null, dept: 'D' }, summary: 'S' }]);
let rec = d.queryRecords(h, 'sys').find((x) => x.key === 'A');
assert.equal(rec.data.title, 't1', 'null-preserve: title kept');
assert.equal(rec.data.amt, '100', 'untouched field kept');
assert.equal(rec.data.dept, 'D', 'new field merged');
assert.equal(rec.summary, 'S', 'summary set');

// a non-null field in a later pass updates
d.upsertRecords(h, 'sys', [{ key: 'A', data: { amt: '200' } }]);
rec = d.queryRecords(h, 'sys').find((x) => x.key === 'A');
assert.equal(rec.data.amt, '200', 'non-null updates');

// query keyword + count
d.upsertRecords(h, 'sys', [{ key: 'B', data: { title: 'findme' } }]);
assert.equal(d.countRecords(h, 'sys'), 2, 'count 2');
assert.equal(d.queryRecords(h, 'sys', { keyword: 'findme' }).length, 1, 'keyword match');
assert.equal(d.queryRecords(h, 'sys', { keyword: 'nope' }).length, 0, 'keyword no-match');

// key required -> throws and rolls back the whole batch
assert.throws(
	() => d.upsertRecords(h, 'sys', [{ key: 'C', data: { x: 1 } }, { data: { y: 2 } }]),
	/key/,
	'missing key throws',
);
assert.equal(
	d.queryRecords(h, 'sys').find((x) => x.key === 'C'),
	undefined,
	'rollback: C not stored',
);

// delete cascades records
d.deleteSystem(h, 'sys');
assert.equal(d.getSystem(h, 'sys'), undefined, 'system deleted');
assert.equal(d.countRecords(h, 'sys'), 0, 'delete cascades records');

// approvals: insert/count/default status/lossless amount text
const inserted = d.upsertApprovals(h, [
	{
		doc_id: 'A1',
		title: 'Buy laptops',
		drafter: 'Kim',
		dept: 'IT',
		submitted_at: '2026-06-01',
		amount: '1,200,000',
		raw_text: 'body',
		summary: 'sum',
	},
	{
		doc_id: 'A2',
		title: 'Trip',
		drafter: 'Lee',
		dept: 'Sales',
		submitted_at: '2026-06-03',
		amount: '50,000',
		raw_text: 'b2',
		summary: 's2',
	},
], '2026-06-06T00:00:00Z');
assert.equal(inserted, 2, 'approvals insert returns count');
assert.equal(d.getApproval(h, 'A1').status, 'fetched', 'default status is fetched');
assert.equal(d.getApproval(h, 'A1').amount, '1,200,000', 'amount stored losslessly as TEXT');

// approvals ordering/filter/limit
let approvals = d.listApprovals(h);
assert.equal(approvals.length, 2, 'two approval rows');
assert.equal(approvals[0].doc_id, 'A2', 'newest submitted_at sorts first');
assert.equal(d.listApprovals(h, { limit: 1 }).length, 1, 'approval limit honoured');

// approvals COALESCE: resync updates scraped columns but preserves workflow status
h.prepare("UPDATE approvals SET status='approved' WHERE doc_id='A1'").run();
d.upsertApprovals(h, [{
	doc_id: 'A1',
	title: 'Buy laptops (rev2)',
	drafter: 'Kim',
	dept: 'IT',
	submitted_at: '2026-06-01',
	amount: '1,200,000',
	raw_text: 'body',
	summary: 'sum-rev2',
}], '2026-06-07T00:00:00Z');
const ap = d.getApproval(h, 'A1');
assert.equal(ap.status, 'approved', 'approval status preserved across re-sync');
assert.equal(ap.title, 'Buy laptops (rev2)', 'approval title refreshed');
assert.equal(ap.summary, 'sum-rev2', 'approval summary refreshed');
assert.equal(d.listApprovals(h, { status: 'approved' }).length, 1, 'approval status filter works');

// approvals input validation
assert.throws(() => d.upsertApprovals(h, [{ title: 'no id' }]), /doc_id/, 'empty doc_id rejected');
assert.throws(() => d.upsertApprovals(h, 'nope'), /array/, 'non-array rejected');

// approvals transaction rollback
const before = d.listApprovals(h).length;
assert.throws(() => d.upsertApprovals(h, [{ doc_id: 'GOOD', title: 'ok' }, { title: 'BAD-no-id' }]));
assert.equal(d.listApprovals(h).length, before, 'approval rollback: failed batch wrote nothing');
assert.equal(d.getApproval(h, 'GOOD'), undefined, 'approval rollback: GOOD not inserted');

d.closeDb(h);
console.log('  db-unit: all checks passed');
NODE
)
