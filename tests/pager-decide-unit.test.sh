#!/usr/bin/env bash
# tests/pager-decide-unit.test.sh — browser-free unit for bin/pager-decide.js (shared page-combobox
# decision). Pins the fail-closed rule it shares with the Playwright engine (guards.pagerDecision):
# trust ONLY a single clean 1..N <select>; a rows-per-page select, a non-1..N set, or ≥2 comboboxes ⇒
# uncertain (caller scans page 1 only) — never the old "drive the first combobox" guess. Part of run.sh.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JS="$DIR/bin/pager-decide.js"
fail=0
check(){ # check <name> <expected-line> <stdin-json> [mode]
	local name="$1" want="$2" data="$3" mode="${4:-combobox}"
	local got; got="$(printf '%s' "$data" | node "$JS" "$mode")"
	if [ "$got" != "$want" ]; then echo "  ✗ pager-decide: $name — want [$want] got [$got]" >&2; fail=1
	else echo "  ✓ pager-decide: $name"; fi
}

# A single clean 1..3 page <select> ⇒ trustworthy pager driving that combobox's ref.
check "single 1..N combobox ⇒ pager" "pager 3 e5" \
	'{"refs":{"e5":{"role":"combobox","name":"page"},"e6":{"role":"option","name":"1"},"e7":{"role":"option","name":"2"},"e8":{"role":"option","name":"3"},"e9":{"role":"button","name":"검색"}}}'

# A page 1..2 select PLUS a rows-per-page select ⇒ TWO comboboxes ⇒ can't identify the pager ⇒ uncertain.
check "two comboboxes (rows-per-page present) ⇒ uncertain" "uncertain 1 " \
	'{"refs":{"e5":{"role":"combobox","name":"page"},"e6":{"role":"option","name":"1"},"e7":{"role":"option","name":"2"},"e10":{"role":"combobox","name":"perpage"},"e11":{"role":"option","name":"10"},"e12":{"role":"option","name":"20"},"e13":{"role":"option","name":"50"}}}'

# One combobox but options are NOT contiguous 1..N (1,2,4) ⇒ uncertain (fail-closed).
check "single non-1..N combobox ⇒ uncertain" "uncertain 1 " \
	'{"refs":{"e5":{"role":"combobox","name":"page"},"e6":{"role":"option","name":"1"},"e7":{"role":"option","name":"2"},"e8":{"role":"option","name":"4"}}}'

# No combobox at all ⇒ single page.
check "no combobox ⇒ none" "none 1 " \
	'{"refs":{"e1":{"role":"table","name":"x"},"e2":{"role":"button","name":"검색"}}}'

# mode not combobox ⇒ none (recipe declares no combobox pagination).
check "mode!=combobox ⇒ none" "none 1 " \
	'{"refs":{"e5":{"role":"combobox","name":"page"},"e6":{"role":"option","name":"1"},"e7":{"role":"option","name":"2"}}}' "link"

# Garbage stdin ⇒ none (no refs) — never crashes the caller.
check "unparseable stdin ⇒ none" "none 1 " 'not json'

[ "$fail" -eq 0 ] && echo "  ✓ pager-decide: all decisions fail-closed as expected" || exit 1
