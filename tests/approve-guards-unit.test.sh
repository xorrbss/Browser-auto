#!/usr/bin/env bash
# tests/approve-guards-unit.test.sh — browser-free unit test for approve/guards.mjs, the PURE deterministic
# guards that are the SOLE safety of the auto-approve leaf (after the owner removed the human gate). Pins:
#   • pagerDecision — the page-count oracle MUST fail-closed (uncertain) on a windowed/ambiguous/non-1..N
#     pager (a wrong count under-scans completion ⇒ a doc reads ABSENT ⇒ false "approved"); single page = none.
#   • parseKRW — the amount-ceiling figure (over-read ⇒ over-skip ⇒ fail-safe).
#   • matchesFormType — the form-type pin (empty/no-match ⇒ false ⇒ caller fail-closes).
# Part of the run.sh gate. No browser, no network, no LLM.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module -e '
import { parseKRW, pagerDecision, matchesFormType } from "./approve/guards.mjs";
const assert = (c, m) => { if (!c) { console.error("  ✗ approve-guards: " + m); process.exit(1); } };
const eq = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), m + " (got " + JSON.stringify(a) + ")");

// --- pagerDecision: TRUST a pager only when reliable; else fail-closed ---
eq(pagerDecision(undefined, []), { kind: "none" }, "no pagination declared ⇒ single page");
eq(pagerDecision("combobox", []), { kind: "none" }, "combobox declared but no select rendered ⇒ single page");
const p12 = Array.from({ length: 12 }, (_, i) => String(i + 1));
eq(pagerDecision("combobox", [p12]), { kind: "pager", index: 0, total: 12 }, "1..12 combobox ⇒ 12-page pager");
eq(pagerDecision("combobox", [["1", "2", "3", "전체"]]), { kind: "pager", index: 0, total: 3 }, "non-numeric option ignored, 1..3 ⇒ 3 pages");
// rows-per-page select ([10,20,50]) is numeric but NOT 1..N ⇒ uncertain (fail-closed), never mistaken for pages
eq(pagerDecision("combobox", [["10", "20", "50"]]), { kind: "uncertain" }, "rows-per-page select ⇒ uncertain");
// a windowed pager (does not start at 1, or sparse like a "1 2 3 … 10" link bar) ⇒ uncertain
eq(pagerDecision("combobox", [["5", "6", "7", "8"]]), { kind: "uncertain" }, "1-window not from 1 ⇒ uncertain");
eq(pagerDecision("combobox", [["1", "2", "3", "10"]]), { kind: "uncertain" }, "sparse 1,2,3,10 ⇒ uncertain");
// two valid pagers ⇒ ambiguous ⇒ uncertain
eq(pagerDecision("combobox", [["1", "2"], ["1", "2", "3"]]), { kind: "uncertain" }, "two 1..N candidates ⇒ uncertain");
// a real pager alongside a rows-per-page select ⇒ pick the unique 1..N pager
eq(pagerDecision("combobox", [["10", "20", "50"], ["1", "2", "3", "4", "5"]]), { kind: "pager", index: 1, total: 5 }, "pager beside a rows-per-page select");
// an unsupported pagination mode is NOT reliably scannable ⇒ uncertain
eq(pagerDecision("link", [p12]), { kind: "uncertain" }, "non-combobox mode ⇒ uncertain");

// --- parseKRW: largest figure (over-read = fail-safe for a ceiling) ---
eq(parseKRW("총 금액 100,000,000"), 1e8, "comma won");
eq(parseKRW("₩50,000,000 수수료 500원"), 5e7, "takes the max, not the line item");
eq(parseKRW("5억원"), 5e8, "억");
eq(parseKRW("5억 3000만"), 530000000, "억+만");
eq(parseKRW("300만"), 3e6, "만");
eq(parseKRW("1,234,567원"), 1234567, "won with 원");
eq(parseKRW("결재선에 금액 없음"), -1, "no figure ⇒ -1");

// --- matchesFormType: empty/no-match ⇒ false (fail-closed) ---
assert(matchesFormType("지출결의서(거래처) 요약", "지출결의서(거래처)") === true, "substring match");
assert(matchesFormType("지출결의서(거래처)", ["품의", "지출결의서(거래처)"]) === true, "array member match");
assert(matchesFormType("품의서", ["지출결의서"]) === false, "wrong form ⇒ false");
assert(matchesFormType("", "지출결의서") === false, "empty live form ⇒ false");

console.log("  ✓ approve-guards: all checks passed");
' )
