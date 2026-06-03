#!/usr/bin/env bash
# tests/capture-domswap.test.sh — C2 regression: a click that swaps a large DOM subtree WITHOUT
# changing the URL (a pure client-side SPA router) must emit a `dom_settle` marker so build-flow
# can insert an explicit settle wait at replay. pushState/replaceState/hashchange/full-doc navs
# already emit a `navigate` gate (they change the URL); the gap C2 closes is the no-URL-change case.
#
# capture.js (injected via --init-script) runs a MutationObserver that accumulates added/removed
# element subtree sizes; after each click it checks, once the settle window elapses, whether the URL
# stayed the same AND a significant DOM swap occurred. We assert:
#   (NEG) a trivial click (no DOM change) emits NO dom_settle (no false positives), and
#   (POS) a big no-URL-change swap emits exactly one dom_settle, recorded AFTER the click.
# Headless; verdicts read JSON fields, never exit codes. Mirrors bin/capture.js DOM_SWAP_* — keep in sync.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DIR/lib/env.sh"
source "$DIR/lib/cleanup.sh"
source "$DIR/lib/assert.sh"

CAPJS="$DIR/bin/capture.js"
[ -s "$CAPJS" ] || { echo "  ✗ missing $CAPJS" >&2; exit 1; }

AB open --init-script "$CAPJS" "https://example.com" >/dev/null

# Count of recorded dom_settle markers in the in-page buffer.
dscount() {
	AB_JSON eval "(JSON.parse(sessionStorage.getItem('__aqa_buf')||'[]')).filter(function(a){return a.action_type==='dom_settle';}).length" \
		| jq -r '.data.result // 0'
}

# Build the page: a no-op button, a nav button whose click swaps a large subtree into #view with NO
# URL change (no pushState/hash), and the initial view. Done in its OWN eval so the build mutation
# is fully observed BEFORE any click (cannot be attributed to a click).
AB_JSON eval "document.body.innerHTML='<button id=TRIV>noop</button><button id=NAV>Go</button><div id=view><p>old</p></div>';document.getElementById('NAV').addEventListener('click',function(){var s='';for(var i=0;i<40;i++){s+='<p>row '+i+'</p>';}document.getElementById('view').innerHTML=s;});1" >/dev/null

# (NEG) trivial click -> no DOM mutation -> must NOT emit a dom_settle.
AB_JSON eval "document.getElementById('TRIV').click();1" >/dev/null
sleep 1   # exceed the settle window so a (wrong) dom_settle would have landed
neg="$(dscount)"
[ "${neg:-0}" -eq 0 ] || { echo "  ✗ C2: trivial click wrongly emitted a dom_settle (count=$neg)" >&2; exit 1; }

# (POS) big no-URL-change swap -> exactly one dom_settle, after the settle window.
AB_JSON eval "document.getElementById('NAV').click();1" >/dev/null
pos=0
for _ in $(seq 1 20); do
	pos="$(dscount)"
	[ "${pos:-0}" -ge 1 ] && break
	sleep 0.3
done
[ "${pos:-0}" -eq 1 ] || { echo "  ✗ C2: expected exactly one dom_settle after the DOM-swap click, got $pos" >&2; exit 1; }

# The dom_settle must come AFTER the click (last buffer entry) and carry no URL change.
BUF="$(AB_JSON eval "JSON.parse(sessionStorage.getItem('__aqa_buf')||'[]')")"
last="$(printf '%s' "$BUF" | jq -r '.data.result[-1].action_type')"
[ "$last" = "dom_settle" ] || { echo "  ✗ C2: dom_settle is not the last recorded action (got '$last')" >&2; exit 1; }
dsurl="$(printf '%s' "$BUF" | jq -r '[.data.result[] | select(.action_type=="dom_settle")][0].url_at_capture')"
case "$dsurl" in *example.com*) : ;; *) echo "  ✗ C2: dom_settle url_at_capture unexpected: $dsurl" >&2; exit 1 ;; esac

echo "  ✓ capture-domswap.test.sh passed"
