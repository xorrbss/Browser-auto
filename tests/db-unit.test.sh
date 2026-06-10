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
const { spawnSync } = require('node:child_process');
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

// enrich retry/original preservation: a failed retry with null detail fields must not erase
// the previously captured body or summary.
d.upsertRecords(h, 'sys', [{ key: 'RTRY', data: { title: 'Original', raw_text: 'Original body', dept: 'Ops' }, summary: 'Original summary' }]);
d.upsertRecords(h, 'sys', [{ key: 'RTRY', data: { title: null, raw_text: null, dept: null }, summary: null }]);
rec = d.getRecord(h, 'sys', 'RTRY');
assert.equal(rec.data.title, 'Original', 'retry preserve: title kept');
assert.equal(rec.data.raw_text, 'Original body', 'retry preserve: raw_text kept');
assert.equal(rec.summary, 'Original summary', 'retry preserve: summary kept');

// a non-null field in a later pass updates
d.upsertRecords(h, 'sys', [{ key: 'A', data: { amt: '200' } }]);
rec = d.queryRecords(h, 'sys').find((x) => x.key === 'A');
assert.equal(rec.data.amt, '200', 'non-null updates');

// PII/secret scrub on generic records: values are stored redacted/masked, not raw.
d.upsertRecords(h, 'sys', [{
	key: 'PII',
	data: {
		contact: 'ada@example.com',
		phone: '010-1234-5678',
		password: 'hunter2',
		apiKey: 'sk-test-secret',
		cardNumber: '4111111111111111',
		note: 'card 4111 1111 1111 1111 ssn 123-45-6789 rrn 900101-1234567 token=abc123 amount 1,200',
	},
	summary: 'Bearer abc.def_123',
}]);
rec = d.getRecord(h, 'sys', 'PII');
assert.equal(rec.data.contact, '[REDACTED_EMAIL]', 'redact email value');
assert.equal(rec.data.phone, '[REDACTED_PHONE]', 'redact phone value');
assert.equal(rec.data.password, '[MASKED]', 'mask sensitive field by name');
assert.equal(rec.data.apiKey, '[MASKED]', 'mask camelCase apiKey field');
assert.equal(rec.data.cardNumber, '[MASKED]', 'mask camelCase cardNumber field');
assert.equal(rec.data.note.includes('4111'), false, 'redact card digits in text');
assert.equal(rec.data.note.includes('123-45-6789'), false, 'redact SSN in text');
assert.equal(rec.data.note.includes('900101-1234567'), false, 'redact resident id in text');
assert.equal(rec.data.note.includes('abc123'), false, 'mask token assignment in text');
assert.equal(rec.summary, 'Bearer [REDACTED_TOKEN]', 'redact bearer token in summary');

// query keyword + count
d.upsertRecords(h, 'sys', [{ key: 'B', data: { title: 'findme' } }]);
assert.equal(d.countRecords(h, 'sys'), 4, 'count includes merged, retry, PII, and keyword fixtures');
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

// duplicate key in one sync batch must fail closed before any write/merge can collapse rows.
assert.throws(
	() => d.upsertRecords(h, 'sys', [{ key: 'DUP', data: { title: 'one' } }, { key: ' DUP ', data: { title: 'two' } }]),
	/duplicate key/,
	'duplicate key throws',
);
assert.equal(d.getRecord(h, 'sys', 'DUP'), undefined, 'duplicate key batch wrote nothing');

// delete cascades records
d.deleteSystem(h, 'sys');
assert.equal(d.getSystem(h, 'sys'), undefined, 'system deleted');
assert.equal(d.countRecords(h, 'sys'), 0, 'delete cascades records');

// legacy engine normalization: a pre-migration row stored with engine='agent-browser' (written
// before the Playwright-only cutover) must not brick listSystems()/getSystem() — openDb's
// _migrateSystemsEngine normalizes it to NULL (=> DEFAULT_ENGINE) one time. A second openDb on
// the same file (WAL allows concurrent connections) plays the "upgraded deployment reopens" role.
d.registerSystem(h, { name: 'modern', label: 'M' });
h.prepare("INSERT INTO systems (name, engine, created_at) VALUES ('legacyab', 'agent-browser', '2026-01-01T00:00:00Z')").run();
const h2 = d.openDb(); // fresh open runs the migration over the legacy row
assert.equal(d.listSystems(h2).length, 2, 'listSystems works with a formerly-legacy row present');
assert.equal(d.getSystem(h2, 'legacyab').engine, 'playwright', 'legacy engine row normalized to the default engine');
d.closeDb(h2);
d.deleteSystem(h, 'modern');
d.deleteSystem(h, 'legacyab');

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

// approval enrich retry/original preservation: null detail retry keeps original body/summary.
d.upsertApprovals(h, [{ doc_id: 'A1', raw_text: null, summary: null, dept: null }], '2026-06-08T00:00:00Z');
let apRetry = d.getApproval(h, 'A1');
assert.equal(apRetry.raw_text, 'body', 'approval retry preserve: raw_text kept');
assert.equal(apRetry.summary, 'sum-rev2', 'approval retry preserve: summary kept');

// approval PII/secret scrub mirrors the generic store.
d.upsertApprovals(h, [{
	doc_id: 'PII-A',
	title: 'email ada@example.com card 4111 1111 1111 1111',
	drafter: '010-1234-5678',
	raw_text: 'password: hunter2 ssn 123-45-6789 rrn 900101-1234567',
	summary: 'Bearer abc.def_123',
}], '2026-06-08T00:00:00Z');
const apPii = d.getApproval(h, 'PII-A');
assert.equal(apPii.title.includes('ada@example.com'), false, 'approval redact email in title');
assert.equal(apPii.title.includes('4111'), false, 'approval redact card digits in title');
assert.equal(apPii.drafter, '[REDACTED_PHONE]', 'approval redact phone in drafter');
assert.equal(apPii.raw_text.includes('hunter2'), false, 'approval mask password assignment in raw_text');
assert.equal(apPii.raw_text.includes('123-45-6789'), false, 'approval redact SSN in raw_text');
assert.equal(apPii.summary, 'Bearer [REDACTED_TOKEN]', 'approval redact bearer token in summary');

// approvalsFromRecords: the registry→approvals dual-write mapper (GW_APP 결재 sync path).
// Picks only SCRAPED_COLS from data, falls back to the record-level summary, nulls the rest —
// so upsertApprovals' COALESCE keeps a list sync non-destructive over a prior enrich.
const mapped = d.approvalsFromRecords([
	{ key: 'D1', data: { title: 'T', drafter: 'Kim', submitted_at: '2026-06-09', extraneous: 'dropme' } },
	{ key: 'D2', data: { dept: '관리팀', raw_text: 'body' }, summary: 'S2' },
]);
assert.equal(mapped[0].doc_id, 'D1', 'mapper: key -> doc_id');
assert.equal(mapped[0].title, 'T', 'mapper: data field picked');
assert.equal(mapped[0].dept, null, 'mapper: absent field nulled (COALESCE keeps stored value)');
assert.equal('extraneous' in mapped[0], false, 'mapper: non-approval field dropped');
assert.equal(mapped[1].summary, 'S2', 'mapper: record-level summary falls back in');
d.upsertApprovals(h, mapped, '2026-06-09T00:00:00Z');
assert.equal(d.getApproval(h, 'D2').dept, '관리팀', 'mapper rows upsert cleanly');
assert.throws(() => d.approvalsFromRecords('nope'), /array/, 'mapper: non-array rejected');

// approvals input validation
assert.throws(() => d.upsertApprovals(h, [{ title: 'no id' }]), /doc_id/, 'empty doc_id rejected');
assert.throws(() => d.upsertApprovals(h, 'nope'), /array/, 'non-array rejected');

assert.throws(
	() => d.upsertApprovals(h, [{ doc_id: 'ADUP', title: 'one' }, { doc_id: ' ADUP ', title: 'two' }]),
	/duplicate doc_id/,
	'duplicate doc_id throws',
);
assert.equal(d.getApproval(h, 'ADUP'), undefined, 'duplicate doc_id batch wrote nothing');

// approvals transaction rollback
const before = d.listApprovals(h).length;
assert.throws(() => d.upsertApprovals(h, [{ doc_id: 'GOOD', title: 'ok' }, { title: 'BAD-no-id' }]));
assert.equal(d.listApprovals(h).length, before, 'approval rollback: failed batch wrote nothing');
assert.equal(d.getApproval(h, 'GOOD'), undefined, 'approval rollback: GOOD not inserted');

d.closeDb(h);

// CLI store helpers: use the same temp DB, fail closed on duplicates, and avoid printing runtime DB paths.
const cliEnv = { ...process.env, NODE_NO_WARNINGS: '1' };
let cli = spawnSync(process.execPath, ['bin/store-records.js', '--system', 'sys'], {
	cwd: process.cwd(),
	env: cliEnv,
	input: JSON.stringify([{ key: 'CLI-DUP', data: { title: 'one' } }, { key: 'CLI-DUP', data: { title: 'two' } }]),
	encoding: 'utf8',
});
assert.notEqual(cli.status, 0, 'store-records duplicate exits non-zero');
assert.equal((cli.stderr || '').includes('CLI-DUP'), false, 'store-records duplicate error does not echo the key value');
let h3 = d.openDb();
assert.equal(d.getRecord(h3, 'sys', 'CLI-DUP'), undefined, 'store-records duplicate wrote nothing');
d.closeDb(h3);

cli = spawnSync(process.execPath, ['bin/store-approvals.js'], {
	cwd: process.cwd(),
	env: cliEnv,
	input: JSON.stringify([{ doc_id: 'CLI-A', title: 'ok' }]),
	encoding: 'utf8',
});
assert.equal(cli.status, 0, 'store-approvals happy path exits zero');
assert.equal((cli.stdout || '').includes(process.env.AQA_DB_PATH), false, 'store-approvals stdout does not expose DB path');
h3 = d.openDb();
assert.equal(d.getApproval(h3, 'CLI-A').title, 'ok', 'store-approvals wrote the row');
d.closeDb(h3);

console.log('  db-unit: all checks passed');
NODE
)
