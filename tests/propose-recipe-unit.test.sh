#!/usr/bin/env bash
# tests/propose-recipe-unit.test.sh — browser-free golden for bin/propose-recipe.js's UNTRUSTED-model
# validator. Pins validateProposal()'s contract for the "register any system" analyze path: it accepts a
# clean proposal, RECOVERS from the two model mistakes that otherwise drop a good proposal (inverted
# {header:field} columns; a mismatched/abbreviated collection.name when headers still pin one table),
# never INVENTS a header, and gives up (→ deterministic fallback) on a genuinely ambiguous pick. No LLM,
# no browser — the model reply is supplied synthetically. In the run.sh gate.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PR="$DIR/bin/propose-recipe.js"
fail(){ echo "  ✗ propose-recipe-unit: $1" >&2; exit 1; }
eq(){ [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }

# pr OBJ TABLES -> validateProposal(obj, tables) as JSON ("null" if rejected).
pr(){ node -e 'const m=require(process.argv[1]);process.stdout.write(JSON.stringify(m.validateProposal(JSON.parse(process.argv[2]),JSON.parse(process.argv[3]))));' "$PR" "$1" "$2"; }
# det TABLES -> deterministicRecipe(tables) as JSON.
det(){ node -e 'const m=require(process.argv[1]);process.stdout.write(JSON.stringify(m.deterministicRecipe(JSON.parse(process.argv[2]))));' "$PR" "$1"; }

HIWORKS='[{"name":"대기 문서 리스트","headers":["문서 번호","제목","기안자","기안일","구분"],"rowCount":15}]'

# ---------- c1: clean proposal, exact name, normal orientation ----------
OBJ='{"collection":{"name":"대기 문서 리스트"},"key":"doc_id","columns":{"doc_id":"문서 번호","title":"제목","drafter":"기안자","date":"기안일","status":"구분"}}'
OUT="$(pr "$OBJ" "$HIWORKS")"
eq "$(printf '%s' "$OUT" | jq -r '.collection.name')" "대기 문서 리스트" "c1 collection"
eq "$(printf '%s' "$OUT" | jq -r '.key')" "doc_id" "c1 key"
eq "$(printf '%s' "$OUT" | jq -r '.columns.doc_id')" "문서 번호" "c1 doc_id->header"
eq "$(printf '%s' "$OUT" | jq -r '.columns.status')" "구분" "c1 status->header"
eq "$(printf '%s' "$OUT" | jq -r '.columns|keys|length')" "5" "c1 all 5 columns"
echo "  ✓ c1 clean proposal accepted"

# ---------- c2: INVERTED columns {header:field} -> recovered to {field:header} ----------
OBJ='{"collection":{"name":"대기 문서 리스트"},"key":"doc_id","columns":{"문서 번호":"doc_id","제목":"title","기안자":"drafter"}}'
OUT="$(pr "$OBJ" "$HIWORKS")"
eq "$(printf '%s' "$OUT" | jq -r '.columns.doc_id')" "문서 번호" "c2 inverted doc_id->header"
eq "$(printf '%s' "$OUT" | jq -r '.columns.title')" "제목" "c2 inverted title->header"
eq "$(printf '%s' "$OUT" | jq -r '.key')" "doc_id" "c2 inverted key"
eq "$(printf '%s' "$OUT" | jq -r '.columns|keys|length')" "3" "c2 columns count"
echo "  ✓ c2 inverted columns recovered"

# ---------- c3: multi-table, collection.name mismatch, headers pin the right table ----------
MULTI='[{"name":"네비게이션","headers":["메뉴","링크"],"rowCount":4},{"name":"문서함","headers":["문서 번호","제목","기안자","기안일","구분"],"rowCount":20}]'
OBJ='{"collection":{"name":"엉뚱한 이름"},"key":"doc_id","columns":{"doc_id":"문서 번호","title":"제목","drafter":"기안자"}}'
OUT="$(pr "$OBJ" "$MULTI")"
eq "$(printf '%s' "$OUT" | jq -r '.collection.name')" "문서함" "c3 header-anchored table pick"
eq "$(printf '%s' "$OUT" | jq -r '.columns.doc_id')" "문서 번호" "c3 doc_id mapped"
echo "  ✓ c3 name-mismatch recovered by header anchoring"

# ---------- c4: ambiguous (two identical-header tables, name mismatch) -> null (give up) ----------
AMBIG='[{"name":"A","headers":["문서 번호","제목","기안자"],"rowCount":3},{"name":"B","headers":["문서 번호","제목","기안자"],"rowCount":3}]'
OBJ='{"collection":{"name":"Z"},"key":"doc_id","columns":{"doc_id":"문서 번호","title":"제목"}}'
eq "$(pr "$OBJ" "$AMBIG")" "null" "c4 ambiguous -> null"
echo "  ✓ c4 ambiguous pick rejected (→ fallback)"

# ---------- c5: INVENTED headers dropped; all-invented -> null ----------
OBJ='{"collection":{"name":"대기 문서 리스트"},"key":"doc_id","columns":{"doc_id":"문서 번호","ghost":"없는헤더","phantom":"가짜"}}'
OUT="$(pr "$OBJ" "$HIWORKS")"
eq "$(printf '%s' "$OUT" | jq -r '.columns|keys|length')" "1" "c5 only real header kept"
eq "$(printf '%s' "$OUT" | jq -r '.columns.doc_id')" "문서 번호" "c5 real column"
OBJ2='{"collection":{"name":"대기 문서 리스트"},"key":"x","columns":{"x":"없는1","y":"없는2"}}'
eq "$(pr "$OBJ2" "$HIWORKS")" "null" "c5 all-invented -> null"
echo "  ✓ c5 invented headers never accepted"

# ---------- c6: single table + garbage/empty name -> single-table shortcut ----------
OBJ='{"collection":{"name":"무관한 이름"},"key":"doc_id","columns":{"doc_id":"문서 번호","title":"제목"}}'
eq "$(pr "$OBJ" "$HIWORKS" | jq -r '.collection.name')" "대기 문서 리스트" "c6 single-table shortcut"
echo "  ✓ c6 single-table shortcut"

# ---------- c7: key not in columns -> falls back to first field ----------
OBJ='{"collection":{"name":"대기 문서 리스트"},"key":"nonexistent","columns":{"doc_id":"문서 번호","title":"제목"}}'
eq "$(pr "$OBJ" "$HIWORKS" | jq -r '.key')" "doc_id" "c7 key fallback to first field"
echo "  ✓ c7 bad key falls back to first field"

# ---------- c8: deterministic fallback picks the largest table, slugged ----------
OUT="$(det "$MULTI")"
eq "$(printf '%s' "$OUT" | jq -r '.collection.name')" "문서함" "c8 fallback largest table"
eq "$(printf '%s' "$OUT" | jq -r '.columns|keys|length')" "5" "c8 fallback all headers slugged"
echo "  ✓ c8 deterministic fallback"

echo "  ✓ propose-recipe-unit: all cases passed"
