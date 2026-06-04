#!/usr/bin/env bash
# tests/capture-contenteditable.test.sh — contenteditable value-capture fix (#5). A <div contenteditable>
# has no .value, so capture's valueOf() used to return null. build-flow then took the `input_value == null`
# branch — the MASKED path — emitting a {{input_N}} fill warned as "(sensitive)": the typed text was LOST
# (never recorded) and a benign rich-text field was MISLABELLED sensitive, forcing the human to re-enter a
# value capture should have kept. capture.js now reads el.textContent for a contenteditable, so the value
# is captured faithfully and replays via `find <loc> fill <text>` (probe-verified to work on 0.27.0).
#
# Mechanism mirrors the other capture tests: inject capture.js via --init-script into example.com (file://
# sessionStorage is opaque), build a realistic rich-text contenteditable (role=textbox + aria-label + a
# testid, so it resolves to a clean step, not needs_review-for-lack-of-candidates), type into it (real
# input event), commit via focusout, drain __aqa_buf, assert the records + build-flow, and PROVE the
# captured value replays into a contenteditable (observable work, .success — never the exit code).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DIR/lib/env.sh"
source "$DIR/lib/cleanup.sh"
source "$DIR/lib/assert.sh"

fail(){ echo "  ✗ capture-contenteditable: $1" >&2; exit 1; }
eq(){ [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }

CAPJS="$DIR/bin/capture.js"
[ -s "$CAPJS" ] || fail "missing $CAPJS"
AB open --init-script "$CAPJS" "https://example.com" >/dev/null

# A realistic rich-text editor: contenteditable with role=textbox + aria-label (so it has a role+name
# candidate alongside the testid -> >=2 candidates -> a clean step, not the lone-candidate backstop).
# Type text (real input event), commit via focusout. Distinctive UPPERCASE value so assertions/leak
# checks can't coincidentally match JSON noise.
# Typed text carries extra leading/trailing/internal whitespace — capture must NORMALIZE it (NFC +
# collapse whitespace + trim), the same contract as select_text/labels, so the replayed fill matches a
# stable single-line string (textContent of rich/block markup would otherwise concatenate with no
# separators and keep structural indentation).
AB_JSON eval "document.body.innerHTML='<div contenteditable role=textbox aria-label=Comment data-testid=note></div>';var d=document.querySelector('[data-testid=note]');d.focus();d.textContent='  Meeting   NotesZ  ';d.dispatchEvent(new Event('input',{bubbles:true}));d.dispatchEvent(new Event('focusout',{bubbles:true}));1" >/dev/null

BUF="$(AB_JSON eval "JSON.parse(sessionStorage.getItem('__aqa_buf')||'[]')")"
INP="$(printf '%s' "$BUF" | jq -c '[.data.result[] | select(.action_type=="input")]')"
eq "$(printf '%s' "$INP" | jq 'length')" '1' "exactly one input record (the contenteditable)"
R="$(printf '%s' "$INP" | jq -c '.[0]')"
# THE FIX: the typed text is captured from textContent (was null) AND normalized, and the field is NOT
# masked (a benign contenteditable was previously reported masked:sensitive — the mislabel this removes).
eq "$(printf '%s' "$R" | jq -r '.input_value')"    'Meeting NotesZ' "contenteditable value captured from textContent, normalized (was null = text lost)"
eq "$(printf '%s' "$R" | jq -r '.masked // false')" 'false'        "benign contenteditable is NOT masked (no longer mislabelled sensitive)"
eq "$(printf '%s' "$R" | jq -r '.primary.by')"      'testid'       "resolves to the testid primary"
eq "$(printf '%s' "$R" | jq -r '.insufficient // false')" 'false'  "with >=2 candidates it is a clean step, not needs_review"

# build-flow: the input record -> a `find testid note fill {{input_1}}` step with the value in the sidecar
# (NOT the masked path that warns "(sensitive)" and leaves the value for a human).
WORK="$ARTDIR/cebuild"; mkdir -p "$WORK"
printf '%s' "$BUF" | jq -c '.data.result' > "$WORK/records.json"
node "$DIR/bin/build-flow.js" ceflow "https://example.com" "" "$WORK/records.json" "$WORK" 2>/dev/null \
	|| fail "build-flow.js exited non-zero"
FLOW="$WORK/ceflow.flow.json"
eq "$(jq -rc '[.steps[]|[.by,.value,.action,.text]]' "$FLOW")" \
	'[["testid","note","fill","{{input_1}}"]]' "build-flow -> a fill step with a token (value carried, not lost)"
eq "$(jq -r '.input_1' "$WORK/ceflow.values.json")" 'Meeting NotesZ' "the real (normalized) value is written to the gitignored values sidecar"

# Proven by OBSERVABLE WORK: the captured value actually replays INTO a contenteditable. Clear the field,
# fill it via the captured locator+value, assert the text landed. Reads .success (never the exit code:
# env.sh — 0.27.0 exits 0 even on failure).
VAL="$(jq -r '.input_1' "$WORK/ceflow.values.json")"
AB_JSON eval "document.querySelector('[data-testid=note]').textContent='';1" >/dev/null
[ "$(AB_JSON find testid note fill "$VAL" 2>/dev/null </dev/null | jq -r '.success // false')" = "true" ] \
	|| fail "find testid note fill did not succeed (contenteditable not fillable?)"
ceText(){ AB_JSON eval "document.querySelector('[data-testid=note]').textContent" 2>/dev/null </dev/null | jq -r '.data.result'; }
eq "$(ceText)" 'Meeting NotesZ' "the captured value replays into the contenteditable (fill does observable work — not a no-op)"

echo "  ✓ capture-contenteditable.test.sh passed"
