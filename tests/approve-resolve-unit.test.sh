#!/usr/bin/env bash
# tests/approve-resolve-unit.test.sh — browser-free unit for the P2 REGISTRY-DRIVEN approve resolvers in
# webui/routes-approve.js (listUrlFor + titlesFor). Generic systems resolve their pending-list URL from the
# registry (systems.target_url) and their content-binding TITLE from their records (data[titleField]); both
# FAIL CLOSED when absent. The legacy 결재 (config GW_APP) path stays exact. Validated against a SEEDED test
# system + record (not a live browser), so the resolution logic is pinned without assuming any site. run.sh gate.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

( cd "$DIR" && AQA_DB_PATH="$TMP/t.db" node --input-type=module -e '
import { listUrlFor, titlesFor } from "./webui/routes-approve.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const d = require("./lib/db.js");
const assert = (c, m) => { if (!c) { console.error("  ✗ approve-resolve: " + m); process.exit(1); } };

// seed a registered system with an approve recipe + a record carrying a title
const h = d.openDb();
d.registerSystem(h, { name: "testsys", target_url: "https://erp.example.com/pending", recipe: { collection: { name: "T" }, key: "k", columns: { k: "K" }, approve: { titleField: "subject", button: { role: "button", name: "승인" } } } });
d.upsertRecords(h, "testsys", [{ key: "IB-TEST-1", data: { subject: "Hello World", amount: "100" } }]);
d.closeDb(h);

// registry-driven list URL (the systems.target_url)
assert(listUrlFor("testsys") === "https://erp.example.com/pending", "listUrlFor reads the registry target_url");
// content-binding title from the record via the recipe titleField
const t = titlesFor("testsys", ["IB-TEST-1", "IB-NOPE"], "subject");
assert(t["IB-TEST-1"] === "Hello World", "titlesFor binds the records title (titleField)");
assert(t["IB-NOPE"] === null, "a missing record ⇒ null title ⇒ fail-closed (refused)");
// a record present but with an EMPTY title field ⇒ still refused
d.upsertRecords(d.openDb(), "testsys", [{ key: "IB-EMPTY", data: { subject: "   " } }]);
assert(titlesFor("testsys", ["IB-EMPTY"], "subject")["IB-EMPTY"] === null, "empty title ⇒ refused");
// fail-closed: an unregistered system has no list URL
assert(listUrlFor("nope-sys") === "", "unregistered system ⇒ no list URL (fail-closed)");

console.log("  ✓ approve-resolve: registry-driven listUrl + records title resolution (all fail-closed)");
' )
