#!/usr/bin/env bash
# tests/capture-iconbutton.test.sh — #3 icon-only (aria-label) reinforcement.
#
# An icon-only <button aria-label="X"> has exactly ONE captured candidate (role+name). Capture.js now
# accepts that aria-label-BUTTON role+name as a clean PRIMARY (roleAriaLabelButton gate) — sufficient
# by itself despite the <2-candidate backstop — and compile emits it with --exact, which 0.27.0
# resolves reliably (probe-verified: role --name is a SUBSTRING match without --exact, so --exact is
# what makes capture's exact count==1 agree with the engine). The gate is deliberately NARROW; the
# engine does NOT resolve `find role --name` for a native <a>/<input>/<heading> or an aria-LABELLEDBY
# name, and an AUTO-generated aria-label is fragile — all of those must STAY needs_review (a fragile
# lone guess is never auto-promoted = the no-false-green rule).
#
# Mechanism mirrors capture-longtext: inject capture.js via --init-script into a real http page
# (example.com — file:// sessionStorage is opaque), build the DOM, synthetic-click each target, drain
# __aqa_buf, assert the records, feed the buffer through build-flow.js, and finally confirm the engine
# actually resolves the captured aria-label-button locator with --exact. Headless; verdicts read JSON.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DIR/lib/env.sh"
source "$DIR/lib/cleanup.sh"
source "$DIR/lib/assert.sh"

fail(){ echo "  ✗ capture-iconbutton: $1" >&2; exit 1; }
eq(){ [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }

CAPJS="$DIR/bin/capture.js"
[ -s "$CAPJS" ] || fail "missing $CAPJS"
AB open --init-script "$CAPJS" "https://example.com" >/dev/null

# Build the DOM in ONE eval (fully observed before any click). Five click targets exercising each gate
# branch: ICON (icon-only aria-label button -> CLEAN primary); LBB (aria-labelledby AND aria-label set
# equal -> isolates the aria-labelledby guard: without it the aria-label==name check would pass);
# ICONLINK (icon aria-label LINK -> needs_review); ICONINPUT (<input type=button> aria-label -> isolates
# the native-button/explicit-role gate, roleOf()=='button' but excluded); AUTOBTN (auto-looking
# aria-label -> looksAuto bar). OTHER gives <body> a distinct button so ICON's role+name is unique.
AB_JSON eval "document.body.innerHTML='<button id=ICON><svg width=10 height=10></svg></button><button id=OTHER>OtherQ</button><span id=LB>LabelledQ</span><button id=LBB><svg width=10 height=10></svg></button><a id=ICONLINK href=#><svg width=10 height=10></svg></a><input id=ICONINPUT type=button><button id=AUTOBTN><svg width=10 height=10></svg></button>';document.getElementById('ICON').setAttribute('aria-label','CloseDialogQ');document.getElementById('LBB').setAttribute('aria-labelledby','LB');document.getElementById('LBB').setAttribute('aria-label','LabelledQ');document.getElementById('ICONLINK').setAttribute('aria-label','HomeQ');document.getElementById('ICONINPUT').setAttribute('aria-label','SaveQ');document.getElementById('AUTOBTN').setAttribute('aria-label','menu_a1b2c3');1" >/dev/null
AB_JSON eval "['ICON','LBB','ICONLINK','ICONINPUT','AUTOBTN'].forEach(function(i){document.getElementById(i).click();});1" >/dev/null

BUF="$(AB_JSON eval "JSON.parse(sessionStorage.getItem('__aqa_buf')||'[]')")"
CLICKS="$(printf '%s' "$BUF" | jq -c '[.data.result[] | select(.action_type=="click")]')"
n="$(printf '%s' "$CLICKS" | jq 'length')"
[ "$n" = 5 ] || fail "expected 5 click actions, got $n (capture.js did not install via --init-script?)"

# (1) ICON: a clean role+name BUTTON primary, NOT insufficient (no needs_review).
A0="$(printf '%s' "$CLICKS" | jq -c '.[0]')"
eq "$(printf '%s' "$A0" | jq -rc '.primary|[.by,.value,.name]')" '["role","button","CloseDialogQ"]' "icon button -> role+name primary"
eq "$(printf '%s' "$A0" | jq -r '.insufficient // false')" 'false' "icon button must NOT be insufficient"

# (2-5) every NEGATIVE must have NO primary and be insufficient (stays needs_review).
neg(){ local idx="$1" what="$2" a; a="$(printf '%s' "$CLICKS" | jq -c ".[$idx]")"
	eq "$(printf '%s' "$a" | jq -r '.primary')" 'null' "$what -> no primary"
	eq "$(printf '%s' "$a" | jq -r '.insufficient // false')" 'true' "$what -> insufficient"; }
neg 1 "aria-labelledby button (isolates the labelledby guard)"
neg 2 "icon link (role link unresolvable on 0.27.0)"
neg 3 "input[type=button] (native, not <button>/explicit role=button)"
neg 4 "auto-looking aria-label (looksAuto bar)"

# Full chain: captured buffer -> build-flow.js -> step0 CLEAN role find, steps 1..4 needs_review.
WORK="$ARTDIR/ibbuild"; mkdir -p "$WORK"
printf '%s' "$BUF" | jq -c '.data.result' > "$WORK/records.json"
node "$DIR/bin/build-flow.js" ibflow "https://example.com" "" "$WORK/records.json" "$WORK" 2>/dev/null \
	|| fail "build-flow.js exited non-zero on the icon-button capture"
FLOW="$WORK/ibflow.flow.json"
[ -s "$FLOW" ] || fail "build-flow produced no flow.json"
eq "$(jq -rc '.steps[0]|[.kind,.by,.value,.name,.action,(.needs_review//false)]' "$FLOW")" \
	'["find","role","button","CloseDialogQ","click",false]' "build-flow: icon button -> clean role step"
eq "$(jq -r '[.steps[1,2,3,4]|select(.needs_review==true)]|length' "$FLOW")" '4' "build-flow: all 4 negatives -> needs_review"

# Engine sanity: the captured role+name locator resolves WITH --exact. (That compile actually appends
# --exact for a role primary — the form below — is guarded separately, browser-free, in
# compile-fallback.test.sh; here we just confirm the resulting locator works on a live engine.)
res="$(AB_JSON find role button hover --name CloseDialogQ --exact 2>/dev/null </dev/null | jq -r '.success // false')"
eq "$res" 'true' "engine resolves the captured 'find role button --name CloseDialogQ --exact'"

echo "  ✓ capture-iconbutton.test.sh passed"
