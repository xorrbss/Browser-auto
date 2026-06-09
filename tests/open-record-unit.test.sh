#!/usr/bin/env bash
# Browser-free contract test for lib/flow-steps.sh open_record.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PROBE_ROOT="$DIR"

fail(){ echo "  x open-record-unit: $1" >&2; exit 1; }
TMP="$(mktemp -d)"; RECIPE="$DIR/recipes/_open_record_unit.json"
trap 'rm -rf "$TMP"; rm -f "$RECIPE"' EXIT

cat > "$RECIPE" <<'JSON'
{
  "collection": { "name": "Tickets" },
  "key": "id",
  "columns": { "id": "id", "subject": "subject", "owner": "owner" }
}
JSON

cat > "$TMP/snapshot.txt" <<'TREE'
- table "Tickets"
  - rowgroup
    - row
      - columnheader "id"
      - columnheader "subject"
      - columnheader "owner"
    - row
      - cell "T-1"
      - cell "Login bug"
      - cell "Alice"
    - row
      - cell "T-2"
      - cell "Slow page"
      - cell "Bob"
TREE

ABX() {
	[ "$1" = "snapshot" ] || fail "unexpected ABX: $*"
	jq -n --rawfile snap "$TMP/snapshot.txt" '{success:true,data:{snapshot:$snap}}'
}

MODE=""
AB_JSON() {
	printf '%s\n' "$*" >> "$TMP/clicks"
	case "$MODE:$*" in
		key-title:"find title T-1 click --exact")
			printf '{"success":true}'
			;;
		second-key-title:"find title T-2 click --exact")
			printf '{"success":true}'
			;;
		subject-contains:"find text Login bug click")
			printf '{"success":true}'
			;;
		*)
			printf '{"success":false,"error":"not mocked"}'
			;;
	esac
}

source "$DIR/lib/flow-steps.sh"

: > "$TMP/clicks"
MODE=key-title
aqa_open_record first _open_record_unit
grep -F "find title T-1 click --exact" "$TMP/clicks" >/dev/null || fail "default key did not click first row key"
if grep -F "T-2" "$TMP/clicks" >/dev/null; then fail "clicked second row"; fi

: > "$TMP/clicks"
MODE=second-key-title
aqa_open_record row_index _open_record_unit "" 1
grep -F "find title T-2 click --exact" "$TMP/clicks" >/dev/null || fail "row_index did not click second row key"
if grep -F "T-1" "$TMP/clicks" >/dev/null; then fail "row_index clicked first row"; fi

: > "$TMP/clicks"
MODE=subject-contains
aqa_open_record first _open_record_unit subject
grep -F "find text Login bug click" "$TMP/clicks" >/dev/null || fail "field fallback did not click first row subject"
if grep -F "Slow page" "$TMP/clicks" >/dev/null; then fail "clicked second row subject"; fi

if AQA_OPEN_RECORD_ATTEMPTS=1 aqa_open_record row_index _open_record_unit "" 9 2>"$TMP/out_of_range"; then
	fail "out-of-range rowIndex passed"
fi
grep -F "rowIndex 9 is out of range" "$TMP/out_of_range" >/dev/null || fail "out-of-range error was not clear"

echo "  ok open-record-unit: row_index dynamic open is recipe-driven"
