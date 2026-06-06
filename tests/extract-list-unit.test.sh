#!/usr/bin/env bash
# tests/extract-list-unit.test.sh — browser-free golden for the GENERIC extractor bin/extract-list.js.
# Pins the field-agnostic {key,data} contract + every fail-loud guard for the "register any system"
# path: header-anchored mapping, empty-key row skip, per-row cell-count divergence, missing mapped
# header, and the NON-UNIQUE key guard (the data-loss bug the design review surfaced). In the run.sh
# gate. Deterministic; synthetic ASCII aria snapshots; no browser/network.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EX="$DIR/bin/extract-list.js"
fail(){ echo "  ✗ extract-list-unit: $1" >&2; exit 1; }
eq(){ [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
snap(){ jq -Rs '{snapshot: .}' "$1"; }
RECIPE='{"collection":{"name":"Tickets"},"key":"id","columns":{"id":"id","subject":"subject","owner":"owner"}}'
expect_fail(){ if snap "$2" | node "$EX" "$1" >/dev/null 2>&1; then fail "$3: expected non-zero (guard did not fire)"; fi; }

# ---------- case 1: generic mapping {key,data} + empty-key row skip ----------
cat > "$TMP/c1" <<'TREE'
- table "Tickets"
  - rowgroup
    - row
      - columnheader "id"
      - columnheader "subject"
      - columnheader "owner"
    - row [ref=e1]
      - cell "T-1"
      - cell "Login bug"
      - cell "Alice"
    - row [ref=e2]
      - cell "T-2"
      - cell "Slow page"
      - cell "Bob"
    - row [ref=e3]
      - cell
      - cell "no id row"
      - cell "Carol"
TREE
OUT="$(snap "$TMP/c1" | node "$EX" "$RECIPE")"
eq "$(printf '%s' "$OUT" | jq 'length')" "2" "c1 count (empty-key row skipped)"
eq "$(printf '%s' "$OUT" | jq -r '.[0].key')" "T-1" "c1 key"
eq "$(printf '%s' "$OUT" | jq -rc '.[0].data')" '{"id":"T-1","subject":"Login bug","owner":"Alice"}' "c1 data"
echo "  ✓ c1 generic {key,data} mapping + empty-key skip"

# ---------- case 2: NON-UNIQUE key -> fail loud (the data-loss guard) ----------
cat > "$TMP/c2" <<'TREE'
- table "Tickets"
  - rowgroup
    - row
      - columnheader "id"
      - columnheader "subject"
      - columnheader "owner"
    - row [ref=e1]
      - cell "DUP"
      - cell "a"
      - cell "Alice"
    - row [ref=e2]
      - cell "DUP"
      - cell "b"
      - cell "Bob"
TREE
expect_fail "$RECIPE" "$TMP/c2" "c2 non-unique key"
echo "  ✓ c2 non-unique-key guard"

# ---------- case 3: per-row cell-count divergence -> fail loud ----------
cat > "$TMP/c3" <<'TREE'
- table "Tickets"
  - rowgroup
    - row
      - columnheader "id"
      - columnheader "subject"
      - columnheader "owner"
    - row [ref=e1]
      - cell "T-1"
      - cell "only two cells"
TREE
expect_fail "$RECIPE" "$TMP/c3" "c3 cell-count divergence"
echo "  ✓ c3 cell-count guard"

# ---------- case 4: missing mapped header -> fail loud ----------
cat > "$TMP/c4" <<'TREE'
- table "Tickets"
  - rowgroup
    - row
      - columnheader "ticket_id"
      - columnheader "subject"
      - columnheader "owner"
    - row [ref=e1]
      - cell "T-1"
      - cell "x"
      - cell "Alice"
TREE
expect_fail "$RECIPE" "$TMP/c4" "c4 missing header (id)"
echo "  ✓ c4 missing-header guard"

echo "  ✓ extract-list-unit: all cases passed"
