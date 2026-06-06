#!/usr/bin/env bash
# tests/db-unit.test.sh — fast, browser-free unit test for lib/db.js (the 결재 approvals store).
#
# Exercises the node:sqlite-backed store through the AQA_DB_PATH temp-file hook (built for exactly
# this) so it never touches data/. Pins the load-bearing behaviours the audit flagged as untested:
#   - schema creation + insert/return-count
#   - amount stored losslessly as TEXT (commas/currency preserved)
#   - STATUS-PRESERVATION on re-sync: an upsert refreshes scraped columns but must NEVER clobber a
#     workflow-owned status (a P1 'approved' decision) back to 'fetched' — the reason `status` is
#     excluded from SCRAPED_COLS
#   - all-or-nothing transaction: a batch containing a bad item rolls back, writing nothing
#   - list ordering (newest-first), status filter, limit
#   - input validation (empty doc_id / non-array rejected)
# Deterministic, no daemon, no browser — runs in the suite or standalone.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
export AQA_DB_PATH="$TMP/approvals.db"
export ROOT="$DIR"

NODE_NO_WARNINGS=1 node <<'NODE'
const assert = require('node:assert');
const { openDb, closeDb, upsertApprovals, listApprovals, getApproval } =
	require(process.env.ROOT + '/lib/db.js');

const db = openDb(); // honours AQA_DB_PATH

// --- insert ---
const n = upsertApprovals(db, [
	{ doc_id: 'A1', title: 'Buy laptops', drafter: 'Kim', dept: 'IT', submitted_at: '2026-06-01', amount: '1,200,000', raw_text: 'body', summary: 'sum' },
	{ doc_id: 'A2', title: 'Trip', drafter: 'Lee', dept: 'Sales', submitted_at: '2026-06-03', amount: '50,000', raw_text: 'b2', summary: 's2' },
], '2026-06-06T00:00:00Z');
assert.strictEqual(n, 2, 'insert returns count');
assert.strictEqual(getApproval(db, 'A1').status, 'fetched', 'default status is fetched');
assert.strictEqual(getApproval(db, 'A1').amount, '1,200,000', 'amount stored losslessly as TEXT');

// --- ordering: newest submitted_at first (A2 2026-06-03 before A1 2026-06-01) ---
let all = listApprovals(db);
assert.strictEqual(all.length, 2, 'two rows');
assert.strictEqual(all[0].doc_id, 'A2', 'newest submitted_at sorts first');
assert.strictEqual(listApprovals(db, { limit: 1 }).length, 1, 'limit honoured');

// --- STATUS PRESERVATION (the key invariant) ---
db.prepare("UPDATE approvals SET status='approved' WHERE doc_id='A1'").run(); // simulate a P1 decision
upsertApprovals(db, [
	{ doc_id: 'A1', title: 'Buy laptops (rev2)', drafter: 'Kim', dept: 'IT', submitted_at: '2026-06-01', amount: '1,200,000', raw_text: 'body', summary: 'sum-rev2' },
], '2026-06-07T00:00:00Z');
const a1 = getApproval(db, 'A1');
assert.strictEqual(a1.status, 'approved', 'status PRESERVED across re-sync (not clobbered to fetched)');
assert.strictEqual(a1.title, 'Buy laptops (rev2)', 'scraped column refreshed on re-sync');
assert.strictEqual(a1.summary, 'sum-rev2', 'summary refreshed on re-sync');
assert.strictEqual(listApprovals(db, { status: 'approved' }).length, 1, 'status filter works');

// --- input validation ---
assert.throws(() => upsertApprovals(db, [{ title: 'no id' }]), /doc_id/, 'empty doc_id rejected');
assert.throws(() => upsertApprovals(db, 'nope'), /array/, 'non-array rejected');

// --- all-or-nothing transaction: a bad item rolls the whole batch back ---
const before = listApprovals(db).length;
assert.throws(() => upsertApprovals(db, [{ doc_id: 'GOOD', title: 'ok' }, { title: 'BAD-no-id' }]));
assert.strictEqual(listApprovals(db).length, before, 'rollback: failed batch wrote nothing');
assert.strictEqual(getApproval(db, 'GOOD'), undefined, 'rollback: GOOD not inserted');

closeDb(db);
console.log('  ✓ db-unit: all assertions passed');
NODE
