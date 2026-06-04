#!/usr/bin/env bash
# tests/capture-checkable.test.sh — checkbox/radio false-green fix. A bare `click` on a checkbox/radio
# TOGGLES, so if the page's initial state differs at replay the final state is wrong yet the run passes
# green. capture.js now records the ABSOLUTE desired state: a native <input type=checkbox|radio> that
# ends CHECKED emits `check` (compiles to `find ... check`, an absolute set). Unchecking stays a `click`
# because agent-browser 0.27.0 `uncheck` is broken (probe-verified). The label/ancestor-click case
# (control toggles AFTER the recorded click) is handled by the raw!==el pre-toggle flip.
#
# Mechanism mirrors the other capture tests: inject capture.js via --init-script into example.com
# (file:// sessionStorage is opaque), build the DOM, synthetic-click, drain __aqa_buf, assert the
# records + build-flow, and PROVE `check` is absolute (stays checked when the initial state differs).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DIR/lib/env.sh"
source "$DIR/lib/cleanup.sh"
source "$DIR/lib/assert.sh"

fail(){ echo "  ✗ capture-checkable: $1" >&2; exit 1; }
eq(){ [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }

CAPJS="$DIR/bin/capture.js"
[ -s "$CAPJS" ] || fail "missing $CAPJS"
AB open --init-script "$CAPJS" "https://example.com" >/dev/null

# DOM: cb1 (click direct -> check), cb2 (click via LABEL -> check, post-toggle flip), r1 (radio ->
# check), cb3 (PRE-checked, click -> uncheck -> stays a click). All attrs unquoted (no escaping).
AB_JSON eval "document.body.innerHTML='<input type=checkbox id=cb1><label for=cb1>Subscribe</label><input type=checkbox id=cb2><label for=cb2>Terms</label><input type=radio name=g id=r1><label for=r1>Red</label><input type=checkbox id=cb3 checked><label for=cb3>News</label>';1" >/dev/null
AB_JSON eval "document.getElementById('cb1').click();document.querySelector('label[for=cb2]').click();document.getElementById('r1').click();document.getElementById('cb3').click();1" >/dev/null

BUF="$(AB_JSON eval "JSON.parse(sessionStorage.getItem('__aqa_buf')||'[]')")"
ACTS="$(printf '%s' "$BUF" | jq -c '[.data.result[] | select(.action_type=="click" or .action_type=="check") | {a:.action_type, by:.primary.by, v:.primary.value}]')"
eq "$(printf '%s' "$ACTS" | jq 'length')" '4' "exactly 4 actions recorded (label-click control dup suppressed)"
eq "$(printf '%s' "$ACTS" | jq -rc '.[0]')" '{"a":"check","by":"label","v":"Subscribe"}' "cb1 direct -> check Subscribe"
eq "$(printf '%s' "$ACTS" | jq -rc '.[1]')" '{"a":"check","by":"label","v":"Terms"}'     "cb2 via LABEL -> check Terms (post-toggle flip)"
eq "$(printf '%s' "$ACTS" | jq -rc '.[2]')" '{"a":"check","by":"label","v":"Red"}'       "r1 radio -> check Red"
eq "$(printf '%s' "$ACTS" | jq -rc '.[3]')" '{"a":"click","by":"label","v":"News"}'      "cb3 pre-checked uncheck -> stays a click (uncheck broken)"

# build-flow: check records -> find ... check steps; the uncheck -> find ... click.
WORK="$ARTDIR/ckbuild"; mkdir -p "$WORK"
printf '%s' "$BUF" | jq -c '.data.result' > "$WORK/records.json"
node "$DIR/bin/build-flow.js" ckflow "https://example.com" "" "$WORK/records.json" "$WORK" 2>/dev/null \
	|| fail "build-flow.js exited non-zero"
FLOW="$WORK/ckflow.flow.json"
eq "$(jq -rc '[.steps[]|[.by,.value,.action]]' "$FLOW")" \
	'[["label","Subscribe","check"],["label","Terms","check"],["label","Red","check"],["label","News","click"]]' \
	"build-flow -> three check steps + one click"

# THE FALSE-GREEN FIX: `check` is ABSOLUTE. Pre-CHECK cb1 (the differing-initial-state scenario capture
# saw unchecked); `find label Subscribe check` must leave it CHECKED — a bare click would toggle it OFF.
AB_JSON eval "document.getElementById('cb1').checked=true;1" >/dev/null
AB find label Subscribe check --exact >/dev/null 2>&1 </dev/null || true
eq "$(AB_JSON eval "document.getElementById('cb1').checked" 2>/dev/null </dev/null | jq -r '.data.result')" 'true' \
	"check is ABSOLUTE: stays checked when initial state differs (a click would have toggled it OFF = false-green)"

echo "  ✓ capture-checkable.test.sh passed"
