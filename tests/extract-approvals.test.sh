#!/usr/bin/env bash
# tests/extract-approvals.test.sh — browser-free GOLDEN regression for bin/extract-approvals.js.
#
# Pins the recipe-driven aria-table extraction CONTRACT so a future parser refactor cannot silently
# corrupt the approvals audit trail: header-anchored field mapping, the title suffix strip, the
# doc_id-empty row skip, generality across a DIFFERENT groupware (daou) with ZERO code change, and
# the four fail-loud integrity guards (per-row cell-count divergence, missing/renamed mapped header,
# duplicate mapped header, recipe field outside the DB vocabulary). Deterministic; synthetic
# PII-free aria snapshots; no browser/daemon. Part of the run.sh gate.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EX="$DIR/bin/extract-approvals.js"
HW="$DIR/recipes/hiworks.json"      # committed recipe — also pins its column map here
DAOU="$DIR/recipes/daou.json"       # committed recipe — generality proof

fail(){ echo "  ✗ extract-approvals-unit: $1" >&2; exit 1; }
eq(){ [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

# snap <tree-file>: wrap a raw aria tree as the {snapshot:...} .data object (what fetch saves).
snap(){ jq -Rs '{snapshot: .}' "$1"; }
run(){ snap "$2" | node "$EX" "$1"; }   # -> items JSON (aborts test if the extractor errors)
expect_fail(){ if snap "$2" | node "$EX" "$1" >/dev/null 2>&1; then fail "$3: expected non-zero exit (guard did not fire)"; fi; }

# ---------- case 1: hiworks shape -> header mapping + title strip + empty-doc_id skip ----------
cat > "$TMP/c1" <<'TREE'
- table "대기 문서 리스트"
  - rowgroup
    - row
      - columnheader
      - columnheader "문서 번호"
      - columnheader
      - columnheader "제목"
      - columnheader "기안자"
      - columnheader "기안일"
      - columnheader "구분"
    - row [ref=e16]
      - cell
        - checkbox
      - cell "IB-001"
      - cell
      - cell "비품 구매 첨부 파일 표시"
      - cell "홍길동"
      - cell "2026-06-01"
      - cell "결재"
    - row [ref=e17]
      - cell
        - checkbox
      - cell "IB-002"
      - cell
      - cell "출장 정산"
      - cell "김철수"
      - cell "2026-06-02"
      - cell "결재"
    - row [ref=e18]
      - cell
        - checkbox
      - cell
      - cell
      - cell "빈 문서번호"
      - cell "이영희"
      - cell "2026-06-03"
      - cell "결재"
TREE
OUT="$(run "$HW" "$TMP/c1")"
eq "$(printf '%s' "$OUT" | jq 'length')" "2" "c1 count (empty doc_id row skipped)"
eq "$(printf '%s' "$OUT" | jq -r '.[0].doc_id')" "IB-001" "c1 doc_id"
eq "$(printf '%s' "$OUT" | jq -r '.[0].title')" "비품 구매" "c1 title suffix strip"
eq "$(printf '%s' "$OUT" | jq -r '.[0].drafter')" "홍길동" "c1 drafter"
eq "$(printf '%s' "$OUT" | jq -r '.[0].submitted_at')" "2026-06-01" "c1 submitted_at"
eq "$(printf '%s' "$OUT" | jq -r '.[1].doc_id')" "IB-002" "c1 row2"
echo "  ✓ c1 hiworks mapping + strip + skip"

# ---------- case 2: per-row cell-count != header-column-count -> fail loud ----------
cat > "$TMP/c2" <<'TREE'
- table "대기 문서 리스트"
  - rowgroup
    - row
      - columnheader
      - columnheader "문서 번호"
      - columnheader
      - columnheader "제목"
      - columnheader "기안자"
      - columnheader "기안일"
      - columnheader "구분"
    - row [ref=e16]
      - cell
        - checkbox
      - cell "IB-001"
      - cell "제목만"
      - cell "홍길동"
      - cell "2026-06-01"
      - cell "결재"
TREE
expect_fail "$HW" "$TMP/c2" "c2 cell-count divergence"
echo "  ✓ c2 cell-count guard"

# ---------- case 3: renamed/missing mapped header (문서ID, not 문서 번호) -> fail loud ----------
cat > "$TMP/c3" <<'TREE'
- table "대기 문서 리스트"
  - rowgroup
    - row
      - columnheader
      - columnheader "문서ID"
      - columnheader
      - columnheader "제목"
      - columnheader "기안자"
      - columnheader "기안일"
      - columnheader "구분"
    - row [ref=e16]
      - cell
        - checkbox
      - cell "IB-001"
      - cell
      - cell "제목"
      - cell "홍길동"
      - cell "2026-06-01"
      - cell "결재"
TREE
expect_fail "$HW" "$TMP/c3" "c3 renamed header"
echo "  ✓ c3 missing-header guard"

# ---------- case 4: duplicate mapped header (two 제목) -> fail loud ----------
cat > "$TMP/c4" <<'TREE'
- table "대기 문서 리스트"
  - rowgroup
    - row
      - columnheader
      - columnheader "문서 번호"
      - columnheader "제목"
      - columnheader "제목"
      - columnheader "기안자"
      - columnheader "기안일"
      - columnheader "구분"
    - row [ref=e16]
      - cell
        - checkbox
      - cell "IB-001"
      - cell "제목A"
      - cell "제목B"
      - cell "홍길동"
      - cell "2026-06-01"
      - cell "결재"
TREE
expect_fail "$HW" "$TMP/c4" "c4 duplicate header"
echo "  ✓ c4 duplicate-header guard"

# ---------- case 5: DIFFERENT groupware (daou recipe), ZERO code change -> amount captured ----------
cat > "$TMP/c5" <<'TREE'
- table "결재 대기함"
  - rowgroup
    - row
      - columnheader "문서번호"
      - columnheader "제목"
      - columnheader "기안자"
      - columnheader "기안일자"
      - columnheader "금액"
    - row [ref=e1]
      - cell "DA-100"
      - cell "사무용품 구매"
      - cell "박영수"
      - cell "2026-05-30"
      - cell "1,200,000원"
TREE
OUT="$(run "$DAOU" "$TMP/c5")"
eq "$(printf '%s' "$OUT" | jq 'length')" "1" "c5 count"
eq "$(printf '%s' "$OUT" | jq -r '.[0].doc_id')" "DA-100" "c5 doc_id"
eq "$(printf '%s' "$OUT" | jq -r '.[0].submitted_at')" "2026-05-30" "c5 daou date header (기안일자)"
eq "$(printf '%s' "$OUT" | jq -r '.[0].amount')" "1,200,000" "c5 amount strip 원"
echo "  ✓ c5 daou generality (amount captured, no code change)"

# ---------- case 6: recipe field outside the DB vocabulary -> fail loud ----------
if printf '%s' '{"snapshot":"- table \"x\""}' | node "$EX" '{"collection":{"name":"x"},"columns":{"doc_id":"문서번호","bogus":"x"}}' >/dev/null 2>&1; then
	fail "c6 vocab guard: expected non-zero exit on unknown db field"
fi
echo "  ✓ c6 field-vocabulary guard"

echo "  ✓ extract-approvals-unit: all 6 cases passed"
