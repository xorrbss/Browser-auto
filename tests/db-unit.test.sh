#!/usr/bin/env bash
# tests/db-unit.test.sh — browser-free unit test for lib/db.js (the generic RPA store + the 결재
# COALESCE upsert). Pins: systems CRUD, records merge-not-clobber INCLUDING null-preserve, key
# required + transaction rollback (no partial write), keyword/status query, count, delete-cascade,
# and approvals status-preserved-on-resync. Part of the run.sh gate. No browser, no network, no LLM.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# `node -e` resolves require() relative to CWD, so cd to the repo root and require ./lib/db.js
# (an absolute MSYS path like /c/... is not a valid Node module specifier on Windows).
( cd "$DIR" && AQA_DB_PATH="$TMP/t.db" node -e '
const d = require("./lib/db.js");
const assert = (c, m) => { if (!c) { console.error("  ✗ db-unit: " + m); process.exit(1); } };
const h = d.openDb();

// systems CRUD + recipe round-trips as an object
d.registerSystem(h, { name: "sys", label: "L", target_url: "u", recipe: { collection: { name: "t" }, key: "k", columns: { k: "K" } } });
assert(d.getSystem(h, "sys").recipe.key === "k", "recipe parsed back to object");
assert(d.listSystems(h).length === 1, "listSystems returns 1");

// records: merge accumulates; a null field in a later pass PRESERVES the prior value (no clobber)
d.upsertRecords(h, "sys", [{ key: "A", data: { title: "t1", amt: "100" } }]);
d.upsertRecords(h, "sys", [{ key: "A", data: { title: null, dept: "D" }, summary: "S" }]);
const a = d.queryRecords(h, "sys").find((x) => x.key === "A");
assert(a.data.title === "t1", "null-preserve: title kept");
assert(a.data.amt === "100", "untouched field kept");
assert(a.data.dept === "D", "new field merged");
assert(a.summary === "S", "summary set");

// a non-null field in a later pass DOES update
d.upsertRecords(h, "sys", [{ key: "A", data: { amt: "200" } }]);
assert(d.queryRecords(h, "sys").find((x) => x.key === "A").data.amt === "200", "non-null updates");

// query keyword + count
d.upsertRecords(h, "sys", [{ key: "B", data: { title: "findme" } }]);
assert(d.countRecords(h, "sys") === 2, "count 2");
assert(d.queryRecords(h, "sys", { keyword: "findme" }).length === 1, "keyword match");
assert(d.queryRecords(h, "sys", { keyword: "nope" }).length === 0, "keyword no-match");

// key required -> throws AND rolls back the whole batch (no partial write of C)
let threw = false;
try { d.upsertRecords(h, "sys", [{ key: "C", data: { x: 1 } }, { data: { y: 2 } }]); } catch { threw = true; }
assert(threw, "missing key throws");
assert(d.queryRecords(h, "sys").find((x) => x.key === "C") === undefined, "rollback: C not stored");

// delete cascades records
d.deleteSystem(h, "sys");
assert(d.getSystem(h, "sys") == null && d.countRecords(h, "sys") === 0, "delete cascades records");

// approvals COALESCE: a resync updates title but PRESERVES a workflow-set status
d.upsertApprovals(h, [{ doc_id: "X", title: "T1" }]);
h.prepare("UPDATE approvals SET status=? WHERE doc_id=?").run("approved", "X");
d.upsertApprovals(h, [{ doc_id: "X", title: "T2" }]);
const ap = d.getApproval(h, "X");
assert(ap.title === "T2" && ap.status === "approved", "approvals: title updates, status preserved");

d.closeDb(h);
console.log("  ✓ db-unit: all checks passed");
' )
