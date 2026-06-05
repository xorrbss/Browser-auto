#!/usr/bin/env bash
# tests/capture-keys.test.sh — non-Enter key allowlist (#8). capture.js records Enter + a navigation
# allowlist (Escape/Tab/ArrowUp/Down/Left/Right) as `press` actions. Bare printable keys are NOT captured
# (they are text -> the input listener); SPACE is excluded (text in a field / synthetic click on a button,
# both already captured). A ctrl/meta/alt shortcut is captured as a combo press but FLAGGED `modifier` so
# build-flow WARNS; Shift alone is normal navigation (not flagged). agent-browser `press` is best-effort
# (returns success for any key name — probe-verified), so a no-op press cannot false-green.
#
# Mechanism mirrors the other capture tests: capture.js via --init-script into example.com (file://
# sessionStorage is opaque); dispatch real keydown events; drain __aqa_buf; assert records + build-flow.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DIR/lib/env.sh"
source "$DIR/lib/cleanup.sh"
source "$DIR/lib/assert.sh"

fail(){ echo "  ✗ capture-keys: $1" >&2; exit 1; }
eq(){ [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }

CAPJS="$DIR/bin/capture.js"
[ -s "$CAPJS" ] || fail "missing $CAPJS"
AB open --init-script "$CAPJS" "https://example.com" >/dev/null

# Phase 1 — standalone keys (no pending input). Dispatch the allowlist + two shortcuts + two that MUST
# be ignored (bare printable 'a', Space). Distinct keys so order/values are unambiguous.
AB_JSON eval "document.body.innerHTML='<input id=f>';var f=document.getElementById('f');f.focus();function kd(k,o){o=o||{};o.key=k;o.bubbles=true;f.dispatchEvent(new KeyboardEvent('keydown',o));}kd('Escape');kd('Tab');kd('ArrowDown');kd('Tab',{shiftKey:true});kd('ArrowDown',{ctrlKey:true});kd('s',{ctrlKey:true});kd('a');kd(' ');1" >/dev/null

BUF="$(AB_JSON eval "JSON.parse(sessionStorage.getItem('__aqa_buf')||'[]')")"
KEYS="$(printf '%s' "$BUF" | jq -c '[.data.result[] | select(.action_type=="key") | {v:.input_value, m:(.modifier//false)}]')"
eq "$(printf '%s' "$KEYS" | jq 'length')" '6' "exactly 6 key records (bare 'a' and Space NOT captured)"
eq "$(printf '%s' "$KEYS" | jq -rc '.[0]')" '{"v":"Escape","m":false}'             "Escape -> press, no modifier flag"
eq "$(printf '%s' "$KEYS" | jq -rc '.[1]')" '{"v":"Tab","m":false}'                "Tab -> press"
eq "$(printf '%s' "$KEYS" | jq -rc '.[2]')" '{"v":"ArrowDown","m":false}'          "ArrowDown -> press"
eq "$(printf '%s' "$KEYS" | jq -rc '.[3]')" '{"v":"Shift+Tab","m":false}'          "Shift+Tab -> press, NOT flagged (Shift is normal nav)"
eq "$(printf '%s' "$KEYS" | jq -rc '.[4]')" '{"v":"Control+ArrowDown","m":true}'   "Ctrl+ArrowDown -> combo press, flagged modifier"
eq "$(printf '%s' "$KEYS" | jq -rc '.[5]')" '{"v":"Control+s","m":true}'           "Ctrl+s (printable shortcut) -> combo press, flagged modifier"
# Hard exclusions: neither the bare letter nor Space produced a key record.
eq "$(printf '%s' "$KEYS" | jq '[.[]|select(.v=="a" or .v==" " or .v=="Space")]|length')" '0' "bare printable 'a' and Space are NOT captured as press"

# build-flow: each key record -> a `press` step; the two modifier shortcuts each emit a WARNING.
WORK="$ARTDIR/kbuild"; mkdir -p "$WORK"
printf '%s' "$BUF" | jq -c '.data.result' > "$WORK/records.json"
BFERR="$(node "$DIR/bin/build-flow.js" kflow "https://example.com" "" "$WORK/records.json" "$WORK" 2>&1 >/dev/null)" \
	|| fail "build-flow.js exited non-zero"
FLOW="$WORK/kflow.flow.json"
eq "$(jq -rc '[.steps[]|{k:.kind,v:.value}]' "$FLOW")" \
	'[{"k":"press","v":"Escape"},{"k":"press","v":"Tab"},{"k":"press","v":"ArrowDown"},{"k":"press","v":"Shift+Tab"},{"k":"press","v":"Control+ArrowDown"},{"k":"press","v":"Control+s"}]' \
	"build-flow -> six press steps in order"
case "$BFERR" in *"modifier shortcut 'Control+ArrowDown'"*) : ;; *) fail "build-flow did not warn on Control+ArrowDown" ;; esac
case "$BFERR" in *"modifier shortcut 'Control+s'"*)         : ;; *) fail "build-flow did not warn on Control+s" ;; esac
case "$BFERR" in *"modifier shortcut 'Escape'"*|*"modifier shortcut 'Shift+Tab'"*) fail "build-flow wrongly warned on a non-shortcut key" ;; *) : ;; esac

# Phase 2 — ordering: a typed value is committed BEFORE the key (fill not lost / not reordered), the same
# flush guarantee Enter has. Reset the buffer, type then Tab (no blur), assert [input, key] order.
AB_JSON eval "sessionStorage.removeItem('__aqa_buf');sessionStorage.removeItem('__aqa_seq');document.body.innerHTML='<input id=g>';var g=document.getElementById('g');g.focus();g.value='draftZ';g.dispatchEvent(new Event('input',{bubbles:true}));g.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true}));1" >/dev/null
BUF2="$(AB_JSON eval "JSON.parse(sessionStorage.getItem('__aqa_buf')||'[]')")"
ORD="$(printf '%s' "$BUF2" | jq -c '[.data.result[] | select(.action_type=="input" or .action_type=="key")]')"
eq "$(printf '%s' "$ORD" | jq -rc 'map(.action_type)')" '["input","key"]' "type-then-Tab -> input committed BEFORE the key (fill not lost/reordered)"
eq "$(printf '%s' "$ORD" | jq -r '.[0].input_value')" 'draftZ' "the typed value is captured (not dropped by the key flush)"
eq "$(printf '%s' "$ORD" | jq -r '.[1].input_value')" 'Tab'    "the key action is Tab"

echo "  ✓ capture-keys.test.sh passed"
