#!/usr/bin/env bash
# tests/capture-scroll.test.sh — #2 explicit page-scroll capture (the only principle-clean action of
# the drag/upload/scroll backlog — drag/upload need a CSS selector or stale @ref, both forbidden).
#
# capture.js debounces window scroll into ONE coalesced record per gesture: the net delta from the
# last committed scroll position becomes a `scroll <dir> <px>` action. Successive gestures compose
# (deltas), and the record is flushed before the next action so seq order matches the journey.
#
# Mechanism mirrors capture-longtext/iconbutton: inject capture.js via --init-script into a real http
# page (example.com — file:// sessionStorage is opaque), make it tall, programmatic scrollTo, wait the
# settle window, drain __aqa_buf, assert two coalesced scroll records; build-flow -> scroll steps; and
# the engine `scroll` primitive (which replay uses) actually scrolls. Headless; verdicts read JSON.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DIR/lib/env.sh"
source "$DIR/lib/cleanup.sh"
source "$DIR/lib/assert.sh"

fail(){ echo "  ✗ capture-scroll: $1" >&2; exit 1; }
eq(){ [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }

CAPJS="$DIR/bin/capture.js"
[ -s "$CAPJS" ] || fail "missing $CAPJS"
AB open --init-script "$CAPJS" "https://example.com" >/dev/null

# Make the page tall (scrollable) at y=0. No scroll event yet (height change doesn't scroll; we are
# already at 0), so capture.js's scrollBase stays 0.
AB_JSON eval "document.documentElement.style.minHeight='4000px';document.body.style.minHeight='4000px';window.scrollTo(0,0);1" >/dev/null

# Gesture 1: scroll to y=700 -> after the settle window, a coalesced `scroll down 700` record.
AB_JSON eval "window.scrollTo(0,700);1" >/dev/null
sleep 0.6
# Gesture 2: scroll to y=1100 -> delta from 700 -> `scroll down 400` (deltas compose).
AB_JSON eval "window.scrollTo(0,1100);1" >/dev/null
sleep 0.6
# Gesture 3 (COALESCING): three scroll events fired inside ONE settle window must collapse to a SINGLE
# record of their NET delta (3x scrollBy 120 from y=1100 -> y=1460 -> one `scroll down 360`), NOT three.
AB_JSON eval "window.scrollBy(0,120);window.scrollBy(0,120);window.scrollBy(0,120);1" >/dev/null
sleep 0.6

BUF="$(AB_JSON eval "JSON.parse(sessionStorage.getItem('__aqa_buf')||'[]')")"
SCROLLS="$(printf '%s' "$BUF" | jq -c '[.data.result[] | select(.action_type=="scroll")]')"
n="$(printf '%s' "$SCROLLS" | jq 'length')"
[ "$n" = 3 ] || fail "expected 3 scroll records (3rd gesture's 3 events must COALESCE to one), got $n"
eq "$(printf '%s' "$SCROLLS" | jq -rc '.[0]|[.dir,.px]')" '["down",700]' "gesture 1 -> coalesced scroll down 700"
eq "$(printf '%s' "$SCROLLS" | jq -rc '.[1]|[.dir,.px]')" '["down",400]' "gesture 2 -> delta scroll down 400 (composes)"
eq "$(printf '%s' "$SCROLLS" | jq -rc '.[2]|[.dir,.px]')" '["down",360]' "gesture 3 -> THREE events coalesced into ONE down 360"

# build-flow: scroll records -> {kind:scroll,dir,px} steps.
WORK="$ARTDIR/scbuild"; mkdir -p "$WORK"
printf '%s' "$BUF" | jq -c '.data.result' > "$WORK/records.json"
node "$DIR/bin/build-flow.js" scflow "https://example.com" "" "$WORK/records.json" "$WORK" 2>/dev/null \
	|| fail "build-flow.js exited non-zero on the scroll capture"
FLOW="$WORK/scflow.flow.json"
[ -s "$FLOW" ] || fail "build-flow produced no flow.json"
eq "$(jq -rc '[.steps[]|select(.kind=="scroll")|[.dir,.px]]' "$FLOW")" '[["down",700],["down",400],["down",360]]' "build-flow -> three scroll steps"

# Replay primitive: the engine `scroll` command (what a compiled `AB scroll <dir> <px>` runs) scrolls.
AB_JSON eval "window.scrollTo(0,0);1" >/dev/null
AB scroll down 500 >/dev/null 2>&1 </dev/null || true
y="$(AB_JSON eval "Math.round(window.scrollY)" 2>/dev/null </dev/null | jq -r '.data.result')"
[ "${y:-0}" -ge 400 ] 2>/dev/null || fail "engine 'scroll down 500' did not scroll the page (scrollY=$y)"

echo "  ✓ capture-scroll.test.sh passed"
