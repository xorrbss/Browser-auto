#!/usr/bin/env bash
# tests/capture-select-multiple.test.sh — <select multiple> -> needs_review (#6). el.value / el.selectedIndex
# expose only the FIRST selected option, so capturing a multi-select as a single-value `select` step would
# silently drop the rest at replay (a false-green: only option#1 is reached). capture.js now flags a
# <select multiple> change with insufficient:true so build-flow routes it to needs_review (compile then
# refuses it); build-flow's select branch also skips tokenizing the partial value. A normal single
# <select> is unaffected (control — no over-flagging).
#
# Mechanism mirrors the other capture tests: inject capture.js via --init-script into example.com (file://
# sessionStorage is opaque), build a single select AND a multiple select that BOTH have a testid+aria-label
# (so each has >=2 candidates and WOULD be a clean step), select option(s) + dispatch change, drain
# __aqa_buf, assert the records + build-flow. The multiple one carries a PRIMARY yet is needs_review,
# proving the flag is the `multiple` attribute — not a missing locator.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DIR/lib/env.sh"
source "$DIR/lib/cleanup.sh"
source "$DIR/lib/assert.sh"

fail(){ echo "  ✗ capture-select-multiple: $1" >&2; exit 1; }
eq(){ [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }

CAPJS="$DIR/bin/capture.js"
[ -s "$CAPJS" ] || fail "missing $CAPJS"
AB open --init-script "$CAPJS" "https://example.com" >/dev/null

# Two selects, each testid + aria-label (>=2 candidates => clean but for the `multiple` flag). The single
# select picks 'm'; the multiple select picks 'a' + 'c' (two options) then both dispatch change.
AB_JSON eval "document.body.innerHTML='<select data-testid=size aria-label=Size><option value=s>Small</option><option value=m>Medium</option></select><select multiple data-testid=toppings aria-label=Toppings><option value=a>Anchovy</option><option value=b>Basil</option><option value=c>Cheese</option></select>';var s=document.querySelector('[data-testid=size]');s.value='m';s.dispatchEvent(new Event('change',{bubbles:true}));var t=document.querySelector('[data-testid=toppings]');t.options[0].selected=true;t.options[2].selected=true;t.dispatchEvent(new Event('change',{bubbles:true}));1" >/dev/null

BUF="$(AB_JSON eval "JSON.parse(sessionStorage.getItem('__aqa_buf')||'[]')")"
SEL="$(printf '%s' "$BUF" | jq -c '[.data.result[] | select(.action_type=="select")]')"
eq "$(printf '%s' "$SEL" | jq 'length')" '2' "exactly two select records"
single="$(printf '%s' "$SEL" | jq -c 'map(select(.primary.value=="size"))|.[0]')"
multi="$(printf '%s' "$SEL"  | jq -c 'map(select(.primary.value=="toppings"))|.[0]')"
[ -n "$single" ] && [ "$single" != "null" ] || fail "single select record not found"
[ -n "$multi" ]  && [ "$multi"  != "null" ] || fail "multiple select record not found"

# single select: a CLEAN step (not needs_review), value captured.
eq "$(printf '%s' "$single" | jq -r '.insufficient // false')" 'false'  "single <select> is a clean step"
eq "$(printf '%s' "$single" | jq -r '.input_value')"           'm'      "single select value captured"
eq "$(printf '%s' "$single" | jq -r '.primary.by')"            'testid' "single select resolves to testid primary"
# multiple select: HAS a primary (locator present) yet is needs_review BECAUSE it is `multiple`.
eq "$(printf '%s' "$multi" | jq -r '.primary.by')"             'testid' "multiple select DID resolve a locator (testid)"
eq "$(printf '%s' "$multi" | jq -r '.insufficient // false')"  'true'   "multiple select is needs_review (the multi-value false-green guard)"

# build-flow: single -> clean select step with a token; multiple -> needs_review (action:select, NO value
# token written for the partial option#1).
WORK="$ARTDIR/smbuild"; mkdir -p "$WORK"
printf '%s' "$BUF" | jq -c '.data.result' > "$WORK/records.json"
node "$DIR/bin/build-flow.js" smflow "https://example.com" "" "$WORK/records.json" "$WORK" 2>/dev/null \
	|| fail "build-flow.js exited non-zero"
FLOW="$WORK/smflow.flow.json"
eq "$(jq -rc '.steps[0]|[.by,.value,.action,.val]' "$FLOW")" '["testid","size","select","{{input_1}}"]' \
	"single -> clean select step with token"
eq "$(jq -rc '.steps[1]|[.needs_review,.action,(.by//"none"),(.val//"none")]' "$FLOW")" '[true,"select","none","none"]' \
	"multiple -> needs_review select step, no locator, no value token"
# only the single select's value is in the sidecar (the multi-select's partial option#1 is NOT written).
eq "$(jq -rc 'keys' "$WORK/smflow.values.json")" '["input_1"]' "only the single select value tokenized (no misleading partial)"
eq "$(jq -r '.input_1' "$WORK/smflow.values.json")" 'm' "the single select value is the one tokenized"

echo "  ✓ capture-select-multiple.test.sh passed"
