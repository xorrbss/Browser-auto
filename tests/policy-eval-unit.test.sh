#!/usr/bin/env bash
# tests/policy-eval-unit.test.sh — browser-free unit for the unattended SHADOW evaluator
# (lib/policy.js + bin/shadow-eval.js; UNATTENDED-CRITERIA.md phase P-a). No browser, no LLM, no approval.
# Pins:
#   • evaluatePolicy — DETERMINISTIC, fail-closed eligibility: a matching doc ⇒ would-approve; any declared
#     criterion failing ⇒ would-skip; a LIVE-only criterion (formType / Gate-B amount) ⇒ requires-live; a
#     heuristic amount ceiling (no Gate-B) ⇒ would-skip (never trusted for unattended).
#   • shadow-eval CLI — seeds eval over the synced DB, cap PREVIEW, audits to a file, NEVER approves; and
#     REFUSES a non-shadow phase (exit 3).
# Part of the run.sh gate.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- 1) pure evaluator (fixed 'now' ⇒ date-stable) ---
( cd "$DIR" && node -e '
const { evaluatePolicy, validatePolicy } = require("./lib/policy.js");
const assert = (c, m) => { if (!c) { console.error("  ✗ policy-eval: " + m); process.exit(1); } };
const now = "2026-06-08";
const doc = { doc_id: "IB-품의-20260605-0001", drafter: "재무팀 김", dept: "재무팀", submitted_at: "2026-06-05", title: "정기 급여 지급 품의", status: "fetched" };
const pol = { id: "p1", app: "hiworks", phase: "shadow", eligibility: { docIdGlobs: ["IB-품의-*"], deptPattern: "재무", maxDocAgeDays: 30, requireContentMarkers: ["정기", "급여"] } };
assert(evaluatePolicy(doc, pol, now).stage === "would-approve", "all criteria pass ⇒ would-approve");
assert(evaluatePolicy({ ...doc, dept: "영업팀" }, pol, now).stage === "would-skip", "dept mismatch ⇒ would-skip");
assert(evaluatePolicy({ ...doc, submitted_at: "2026-01-01" }, pol, now).stage === "would-skip", "too old ⇒ would-skip");
assert(evaluatePolicy({ ...doc, submitted_at: "garbage" }, pol, now).stage === "would-skip", "unparseable date ⇒ would-skip (fail-closed)");
assert(evaluatePolicy({ ...doc, doc_id: "IB-지출-1" }, pol, now).stage === "would-skip", "docId glob mismatch ⇒ would-skip");
assert(evaluatePolicy({ ...doc, title: "일반 급여 지급" }, pol, now).stage === "would-skip", "missing marker 정기 ⇒ would-skip");
// requireContentMarkers is matched against DETERMINISTIC scraped text only — a marker present ONLY in the
// LLM summary must NOT flip a doc to would-approve (no LLM on the eligibility path; fail-closed).
assert(evaluatePolicy({ ...doc, title: "일반 지급 품의", summary: "정기 급여 자동 분류됨" }, pol, now).stage === "would-skip", "marker only in LLM summary ⇒ would-skip (summary excluded from haystack)");
assert(evaluatePolicy({ ...doc, title: "일반 지급", raw_text: "정기 급여 명세" }, pol, now).stage === "would-approve", "marker in raw_text (deterministic scraped) ⇒ would-approve");
assert(evaluatePolicy({ ...doc, status: "approved" }, pol, now).stage === "would-skip", "already-decided ⇒ would-skip");
assert(evaluatePolicy(doc, { ...pol, eligibility: { ...pol.eligibility, formTypeAllow: ["품의"] } }, now).stage === "requires-live", "formType (live-only) ⇒ requires-live");
assert(evaluatePolicy(doc, { ...pol, amount: { maxAmount: 1000000, gateBCaptured: false } }, now).stage === "would-skip", "heuristic amount (no Gate-B) ⇒ would-skip (fail-closed)");
assert(evaluatePolicy(doc, { ...pol, amount: { maxAmount: 1000000, gateBCaptured: true } }, now).stage === "requires-live", "Gate-B amount ⇒ requires-live");
assert(validatePolicy({ id: "x", app: "y", eligibility: { docIdGlobs: ["IB-*"] } }).ok === true, "valid policy (has a positive selector)");
assert(validatePolicy({ id: "x", app: "y" }).ok === false, "no positive selector ⇒ invalid (match-everything refused)");
assert(validatePolicy({ id: "x", app: "y", eligibility: { maxDocAgeDays: 7 } }).ok === false, "only a recency filter (no positive selector) ⇒ invalid");
assert(validatePolicy({ app: "y", eligibility: { drafterPattern: "x" } }).ok === false, "missing id ⇒ invalid");
assert(validatePolicy({ id: "x", app: "y", phase: "bogus", eligibility: { deptPattern: "재무" } }).ok === false, "bad phase ⇒ invalid");
console.log("  ✓ policy-eval: deterministic fail-closed eligibility OK");
' )

# --- 2) shadow-eval CLI: seed a tmp DB + a policy ⇒ would-* counts + cap preview, NEVER approves ---
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
( cd "$DIR" && node -e '
const { openDb, closeDb, upsertApprovals } = require("./lib/db.js");
const db = openDb(process.argv[1]);
upsertApprovals(db, [
  { doc_id: "IB-품의-20260607-0001", title: "정기 급여 품의", drafter: "김", dept: "재무팀", submitted_at: "2026-06-07" },
  { doc_id: "IB-지출(거래처)-20260607-0002", title: "정기 거래처 지출", drafter: "이", dept: "경영지원", submitted_at: "2026-06-07" },
  { doc_id: "IB-기타-20260607-0003", title: "기타 문서", drafter: "박", dept: "영업", submitted_at: "2026-06-07" },
], new Date().toISOString());
closeDb(db);
' "$TMP/t.db" )
cat > "$TMP/pol.json" <<'JSON'
{ "id": "itest", "app": "hiworks", "phase": "shadow", "eligibility": { "docIdGlobs": ["IB-품의-*", "IB-지출(거래처)-*"], "deptPattern": "재무|경영", "requireContentMarkers": ["정기"] }, "caps": { "maxPerTick": 1 } }
JSON
OUT="$( cd "$DIR" && node bin/shadow-eval.js --policy "$TMP/pol.json" --db "$TMP/t.db" --audit "$TMP/shadow.jsonl" 2>/dev/null )"
node -e '
const o = JSON.parse(process.argv[1]);
const assert = (c, m) => { if (!c) { console.error("  ✗ shadow-cli: " + m + " — " + JSON.stringify(o)); process.exit(1); } };
assert(o.evaluated === 3, "evaluated all 3 fetched docs");
assert(o.counts["would-approve"] === 1, "1 would-approve (maxPerTick:1 caps the 2nd match)");
assert(o.counts["would-skip"] === 2, "2 would-skip (1 docId mismatch + 1 cap)");
assert(o.skipReasons.cap === 1, "cap preview flagged the over-cap match");
assert(o.skipReasons.docIdGlobs === 1, "the non-matching docId was skipped");
console.log("  ✓ shadow-cli: seeded eval + cap preview OK (no approval)");
' "$OUT"
# audit file written, append-only, with a tick-summary
[ -s "$TMP/shadow.jsonl" ] || { echo "  ✗ shadow-cli: audit file not written"; exit 1; }
grep -q '"stage":"tick-summary"' "$TMP/shadow.jsonl" || { echo "  ✗ shadow-cli: no tick-summary in audit"; exit 1; }

# --- 3) phase gate: a non-shadow (or missing) phase is REFUSED (exit 3) — policies carry a positive selector
#        so they pass validatePolicy and reach the phase check ---
printf '{ "id":"x", "app":"hiworks", "phase":"unattended", "eligibility": { "docIdGlobs": ["IB-*"] } }\n' > "$TMP/live.json"
printf '{ "id":"x", "app":"hiworks", "eligibility": { "docIdGlobs": ["IB-*"] } }\n' > "$TMP/nophase.json"
for f in live nophase; do
  set +e
  ( cd "$DIR" && node bin/shadow-eval.js --policy "$TMP/$f.json" --db "$TMP/t.db" --audit "$TMP/s2.jsonl" >/dev/null 2>&1 )
  RC=$?
  set -e
  [ "$RC" = "3" ] || { echo "  ✗ shadow-cli: $f phase must be refused (exit 3, got $RC)"; exit 1; }
done
echo "  ✓ shadow-cli: non-shadow AND missing phase both refused (exit 3, fail-closed)"
# a match-everything policy (no positive selector) is refused at validation (exit 2)
printf '{ "id":"x", "app":"hiworks", "phase":"shadow", "eligibility": {} }\n' > "$TMP/empty.json"
set +e
( cd "$DIR" && node bin/shadow-eval.js --policy "$TMP/empty.json" --db "$TMP/t.db" --audit "$TMP/s3.jsonl" >/dev/null 2>&1 )
RC2=$?
set -e
[ "$RC2" = "2" ] || { echo "  ✗ shadow-cli: a no-positive-selector policy must be refused (exit 2, got $RC2)"; exit 1; }
echo "  ✓ shadow-cli: match-everything policy refused (exit 2, positive-match required)"
