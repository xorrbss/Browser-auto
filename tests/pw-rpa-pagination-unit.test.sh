#!/usr/bin/env bash
# Browser-free unit for bin/pw-rpa.mjs pagination settle handling.
# Pins the fail-closed contract: a later page that does not settle must throw, so sync/enrich jobs
# fail instead of storing/reporting partial pages as done — AND the waitListSettled change-then-
# stable rule itself (the half-render undercount fix mirroring approve-run settlePage).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module -e '
import { assertPageSettled, paginationSettleFailureMessage, sync, waitListSettled } from "./bin/pw-rpa.mjs";
const assert = (c, m) => { if (!c) { console.error("  x pw-rpa-pagination: " + m); process.exit(1); } };

const ok = { items: [{ key: "A" }], sig: "A" };
assert(assertPageSettled(ok, "sync pagination", 2, 3) === ok, "settled page passes through");

let threw = false;
try {
  assertPageSettled({ error: "no new rows" }, "sync pagination", 2, 3);
} catch (e) {
  threw = true;
  assert(e.message.includes("sync pagination page 2/3 did not settle"), "sync message names page and total");
  assert(e.message.includes("refusing to store partial pagination results"), "sync message refuses partial storage");
  assert(e.message.includes("fail-closed"), "sync message says fail-closed");
}
assert(threw, "sync settle failure throws");

const msg = paginationSettleFailureMessage("enrich pagination while locating DOC-7", 4, 5, "extract-list failed");
assert(msg.includes("enrich pagination while locating DOC-7 page 4/5 did not settle"), "enrich message names key page");
assert(msg.includes("extract-list failed"), "enrich message preserves cause");

// ---- waitListSettled: the change-then-stable rule (browser-free via injected getList) ----
const list = (...keys) => ({ items: keys.map((k) => ({ key: k })), sig: keys.sort().join(",") });
const seq = (reads) => { let i = 0; return () => { const r = reads[Math.min(i++, reads.length - 1)]; if (r instanceof Error) throw r; return r; }; };

// duplicate keys across settled paginated pages are ambiguous and must fail before storage
{
  const rawSensitiveKey = "PRIVATE-CUSTOMER-ALPHA-DO-NOT-LOG";
  const browser = { closed: false, async close() { this.closed = true; } };
  const page = { waitForTimeout: async () => {} };
  let currentPage = 1;
  let upsertCalls = 0;
  let dualWriteCalls = 0;
  let duplicateMessage = "";
  try {
    await sync({ name: "tickets", target_url: "https://example.test/tickets", recipe: { ready: { text: "ready" }, pagination: { mode: "combobox" } } }, "recipe.json", {
      newPage: async () => ({ browser, page }),
      gotoTarget: async () => {},
      waitText: async () => {},
      snapshotList: async () => currentPage === 1 ? list(rawSensitiveKey) : list(rawSensitiveKey, "NEXT-1"),
      pagerInfo: async () => ({ locator: {}, total: 2 }),
      selectPage: async (pager, p) => { currentPage = p; },
      settleWait: async () => {},
      settleTries: 8,
      upsert: () => { upsertCalls++; },
      approvalsDualWrite: () => { dualWriteCalls++; },
    });
  } catch (e) {
    duplicateMessage = e.message;
  }
  assert(duplicateMessage.includes("sync pagination/list aggregation produced a duplicate record key"), "duplicate message names safe scope");
  assert(duplicateMessage.includes("before save/upsert"), "duplicate message refuses before save/upsert");
  assert(duplicateMessage.includes("fail-closed"), "duplicate message says fail-closed");
  assert(duplicateMessage.includes("fingerprint=sha256:"), "duplicate message includes a non-raw fingerprint");
  assert(!duplicateMessage.includes(rawSensitiveKey), "duplicate message does not expose raw key");
  assert(!duplicateMessage.includes("DO-NOT-LOG"), "duplicate message does not expose sensitive key fragment");
  assert(upsertCalls === 0, "duplicate key fails before upsert");
  assert(dualWriteCalls === 0, "duplicate key fails before approvals dual-write");
  assert(browser.closed, "duplicate-key sync closes browser");
}

// half-render closed: first CHANGED read is a loading intermediate — must settle on the STABLE full page
let r = await waitListSettled(seq([list("P1a", "P1b"), list("X1"), list("X1", "X2", "X3"), list("X1", "X2", "X3")]), { prevSig: list("P1a", "P1b").sig, tries: 10 });
assert(!r.error && r.items.length === 3, "pages 2+: settles on the stable full read, not the first change (half-render undercount)");

// no change within budget => error (page never switched)
r = await waitListSettled(seq([list("P"), list("P"), list("P")]), { prevSig: list("P").sig, tries: 5 });
assert(r.error, "pages 2+: unchanged page never settles (fail-closed)");

// pages 2+: a BRIEF empty is "still loading" (clear-then-render transition) — never settles early...
r = await waitListSettled(seq([{ items: [], sig: "" }]), { prevSig: "P", tries: 5 });
assert(r.error, "pages 2+: brief empty (< EMPTY_STABLE_READS) does not settle");
// ...but a PERSISTENTLY empty page is real (a 대기 page whose docs were all approved) — settles empty.
r = await waitListSettled(seq([{ items: [], sig: "" }]), { prevSig: "P", tries: 10 });
assert(!r.error && r.items.length === 0, "pages 2+: persistently-empty page settles as a real empty page");
// clear-then-render: empty reads followed by stable rows settle on the rows, never the transient empty
r = await waitListSettled(seq([{ items: [], sig: "" }, { items: [], sig: "" }, { items: [], sig: "" }, list("N1", "N2"), list("N1", "N2")]), { prevSig: "P", tries: 12 });
assert(!r.error && r.items.length === 2, "pages 2+: clear-then-render settles on the rendered rows");

// page 1 (no prevSig): stability only — partial first read does not win
r = await waitListSettled(seq([list("A"), list("A", "B"), list("A", "B")]), { tries: 10 });
assert(!r.error && r.items.length === 2, "page 1: settles on the stable read");

// page 1: consistently-empty (no row ever seen) => accepted as a real empty list
r = await waitListSettled(seq([{ items: [], sig: "" }]), { tries: 10 });
assert(!r.error && r.items.length === 0, "page 1: consistently-empty list accepted as empty");

// page 1: empty reads followed by rows => rows win (never settles empty early)
r = await waitListSettled(seq([{ items: [], sig: "" }, { items: [], sig: "" }, list("A"), list("A")]), { tries: 10 });
assert(!r.error && r.items.length === 1, "page 1: late-rendering rows beat earlier empty reads");

// page 1: rows seen THEN persistently empty => suspicious, fail-closed (no empty settle)
r = await waitListSettled(seq([list("A"), { items: [], sig: "" }]), { tries: 12 });
assert(r.error, "page 1: rows-then-empty never settles empty (fail-closed)");

// extract failures tolerated as still-rendering, then settle; all-fail => error with cause
r = await waitListSettled(seq([new Error("table not found"), new Error("table not found"), list("A"), list("A")]), { tries: 10 });
assert(!r.error && r.items.length === 1, "extract failures tolerated until the list renders");
r = await waitListSettled(seq([new Error("table not found")]), { prevSig: "P", tries: 3 });
assert(r.error && r.error.includes("table not found"), "all-fail budget surfaces the extract cause");

// a failed read between two equal reads breaks the consecutive-equal chain (no stale settle)
r = await waitListSettled(seq([list("X"), new Error("blip"), list("X"), list("X")]), { prevSig: "P", tries: 10 });
assert(!r.error && r.items.length === 1, "chain re-established after a blip still settles");

console.log("  ok pw-rpa-pagination: settle failures fail closed + change-then-stable rule pinned");
' )
