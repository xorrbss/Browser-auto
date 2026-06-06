#!/usr/bin/env bash
# tests/extract-detail-unit.test.sh — browser-free golden for bin/extract-detail.js (label→value detail
# extractor used by the enrich passes). Pins: the new --generic mode (arbitrary records.data field names,
# no DB-vocabulary restriction); the legacy 결재 mode still rejects an unknown column; the wrong-page
# guard (idLabel must equal the expected key, and a page lacking idLabel is refused — never store the
# list). Deterministic synthetic aria snapshots; no browser, no LLM, no network. In the run.sh gate.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ED="$DIR/bin/extract-detail.js"
fail(){ echo "  ✗ extract-detail-unit: $1" >&2; exit 1; }
eq(){ [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
snap(){ jq -Rs '{snapshot: .}' "$1"; }

# A document DETAIL page: heading + label→value rows + a body line.
cat > "$TMP/detail" <<'TREE'
- heading "전자결재 문서" [level=1]
- table
  - rowgroup
    - row
      - rowheader "문서 번호"
      - cell "DOC-7"
    - row
      - rowheader "기안 부서"
      - cell "관리팀"
    - row
      - rowheader "우선순위"
      - cell "높음"
- paragraph "출장 신청합니다. 금액 50000원."
TREE

# A LIST page (no 문서 번호 rowheader) — the wrong-page guard must refuse this.
cat > "$TMP/list" <<'TREE'
- heading "문서 목록" [level=1]
- table
  - rowgroup
    - row
      - cell "DOC-1"
      - cell "DOC-2"
TREE

GENERIC='{"detail":{"idLabel":"문서 번호","fields":{"dept":"기안 부서","priority":"우선순위"},"bodyFromHeadingLevel":1}}'

# ---------- c1: --generic extracts ARBITRARY fields (priority ∉ DB vocab) + raw_text body ----------
OUT="$(snap "$TMP/detail" | node "$ED" "$GENERIC" "DOC-7" --generic)"
eq "$(printf '%s' "$OUT" | jq -r '.dept')" "관리팀" "c1 dept"
eq "$(printf '%s' "$OUT" | jq -r '.priority')" "높음" "c1 arbitrary field priority"
[ "$(printf '%s' "$OUT" | jq -r '.raw_text')" != "null" ] || fail "c1 raw_text present"
printf '%s' "$OUT" | jq -e '.raw_text|contains("출장")' >/dev/null || fail "c1 raw_text contains body"
echo "  ✓ c1 --generic arbitrary fields + body blob"

# ---------- c2: wrong-page guard — expected key mismatch -> fail loud ----------
if snap "$TMP/detail" | node "$ED" "$GENERIC" "DOC-9" --generic >/dev/null 2>&1; then
	fail "c2 expected non-zero on wrong key (guard did not fire)"
fi
echo "  ✓ c2 wrong-key guard"

# ---------- c3: not-a-detail-page guard — idLabel absent (a list page) -> fail loud ----------
if snap "$TMP/list" | node "$ED" "$GENERIC" "DOC-7" --generic >/dev/null 2>&1; then
	fail "c3 expected non-zero on a list page (guard did not fire)"
fi
echo "  ✓ c3 not-a-detail-page guard"

# ---------- c4: legacy 결재 mode (no --generic) still REJECTS an unknown DB column ----------
BADVOCAB='{"detail":{"idLabel":"문서 번호","fields":{"priority":"우선순위"}}}'
if snap "$TMP/detail" | node "$ED" "$BADVOCAB" "DOC-7" >/dev/null 2>&1; then
	fail "c4 expected non-zero: 'priority' is not a DB column on the approvals path"
fi
echo "  ✓ c4 approvals-mode vocab guard intact"

# ---------- c5: legacy 결재 mode accepts a real DB column (dept) ----------
OKVOCAB='{"detail":{"idLabel":"문서 번호","fields":{"dept":"기안 부서"},"bodyFromHeadingLevel":1}}'
OUT="$(snap "$TMP/detail" | node "$ED" "$OKVOCAB" "DOC-7")"
eq "$(printf '%s' "$OUT" | jq -r '.dept')" "관리팀" "c5 approvals dept"
echo "  ✓ c5 approvals-mode happy path"

echo "  ✓ extract-detail-unit: all cases passed"
