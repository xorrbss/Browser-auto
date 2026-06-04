#!/usr/bin/env bash
# tests/capture-input-enter.test.sh — regression: a typed value must be committed (and ordered before
# the key) when the user presses Enter to submit — NOT lost. The Enter keydown + the teardown handlers
# flush a pending input via flushAll() (commitPend THEN commitScroll). commitScroll() alone early-returns
# past its commitPend when no scroll is pending, which would silently DROP the fill on a
# type-then-Enter-submit (a regression introduced by, and fixed during, the #2 scroll work). Without the
# fix the buffer holds a `key` with no preceding `input`, compiling to an empty-form submit that a loose
# trailing assert can false-green. Mechanism mirrors the other capture tests (capture.js via
# --init-script into example.com — file:// sessionStorage is opaque). Headless; verdicts read JSON.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DIR/lib/env.sh"
source "$DIR/lib/cleanup.sh"
source "$DIR/lib/assert.sh"

fail(){ echo "  ✗ capture-input-enter: $1" >&2; exit 1; }
eq(){ [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }

CAPJS="$DIR/bin/capture.js"
[ -s "$CAPJS" ] || fail "missing $CAPJS"
AB open --init-script "$CAPJS" "https://example.com" >/dev/null

# Type into a field (a real `input` event sets capture.js's pending value) then press Enter (keydown).
# We deliberately do NOT blur — so NO focusout/change fires, and ONLY the Enter/teardown flush can
# commit the fill. The buggy version (commitScroll on the Enter path) would drop it.
AB_JSON eval "document.body.innerHTML='<input id=fld>';var f=document.getElementById('fld');f.focus();f.value='helloWorld';f.dispatchEvent(new Event('input',{bubbles:true}));f.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));1" >/dev/null

BUF="$(AB_JSON eval "JSON.parse(sessionStorage.getItem('__aqa_buf')||'[]')")"
ACTS="$(printf '%s' "$BUF" | jq -c '[.data.result[] | select(.action_type=="input" or .action_type=="key")]')"
# The fill must be present (value NOT lost) AND ordered BEFORE the Enter key.
eq "$(printf '%s' "$ACTS" | jq -rc 'map(.action_type)')" '["input","key"]' "type-then-Enter -> input committed BEFORE key (fill not lost)"
eq "$(printf '%s' "$ACTS" | jq -r '.[0].input_value')" 'helloWorld' "the typed value is captured (not dropped)"
eq "$(printf '%s' "$ACTS" | jq -r '.[1].input_value')" 'Enter' "the key action is Enter"

# And the full chain: build-flow -> a `fill` step (token, not the literal) then a `press Enter`.
WORK="$ARTDIR/iebuild"; mkdir -p "$WORK"
printf '%s' "$BUF" | jq -c '.data.result' > "$WORK/records.json"
node "$DIR/bin/build-flow.js" ieflow "https://example.com" "" "$WORK/records.json" "$WORK" 2>/dev/null \
	|| fail "build-flow.js exited non-zero"
FLOW="$WORK/ieflow.flow.json"
eq "$(jq -rc '[.steps[]|.kind]' "$FLOW")" '["find","press"]' "build-flow -> fill step then press Enter (not a lone press)"
eq "$(jq -r '.steps[0].action' "$FLOW")" 'fill' "the first step is a fill"

echo "  ✓ capture-input-enter.test.sh passed"
