#!/usr/bin/env bash
# Browser-free regression guard: operational drivers must use the shared
# hardening helpers for checked actions and polling waits.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

fail(){ echo "  driver-migration-unit: $*" >&2; exit 1; }

drivers=(
	bin/analyze-system.sh
	bin/sync-system.sh
	bin/fetch-approvals.sh
	bin/enrich-system.sh
	bin/enrich-approvals.sh
)

for rel in "${drivers[@]}"; do
	path="$DIR/$rel"
	[ -s "$path" ] || fail "missing driver: $rel"
	if grep -nE '^[[:space:]]*(AB_JSON[[:space:]]+(navigate|snapshot|wait[[:space:]]+--text)|AB[[:space:]]+select[[:space:]])' "$path" >"$TMP" 2>/dev/null; then
		cat "$TMP" >&2
		fail "$rel still uses raw/unchecked browser actions"
	fi
done

expect(){ grep -qE "$2" "$DIR/$1" || fail "$1 missing expected helper: $2"; }

expect bin/analyze-system.sh 'ABX[[:space:]]+navigate'
expect bin/analyze-system.sh 'ABX[[:space:]]+snapshot'
expect bin/sync-system.sh 'ABX[[:space:]]+select'
expect bin/sync-system.sh 'wait_text'
expect bin/fetch-approvals.sh 'ABX[[:space:]]+select'
expect bin/fetch-approvals.sh 'wait_text'
expect bin/enrich-system.sh 'ABX[[:space:]]+find[[:space:]]+text'
expect bin/enrich-system.sh 'wait_text'
expect bin/enrich-approvals.sh 'ABX[[:space:]]+find[[:space:]]+text'
expect bin/enrich-approvals.sh 'wait_text'

echo "  driver-migration-unit: all checks passed"
