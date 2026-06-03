#!/usr/bin/env bash
# tests/capture-longtext.test.sh — C1 regression: a long (>80-char) accessible name must still
# yield a NON-EMPTY needs_review candidate ladder (the ianatour #5 pain) while NEVER being
# auto-promoted to a step's primary locator (long exact text is too fragile to trust unattended).
#
# Root cause fixed in bin/capture.js: pushCand() used to `if (value.length > 80) return;`,
# dropping long values and leaving an empty ladder. Now long values stay in the ladder but
# overLong() bars them from auto-primary selection, so the step stays needs_review with a
# reviewable option.
#
# Mechanism: capture.js is injected via --init-script (the same way capture() does it), installing
# document-level listeners on a real loaded page (example.com — the proven init-script target the
# other capture tests use). We replace the body with a button whose visible text is 109 chars,
# synthetically click it (a synthetic .click() fires the capture-phase listener exactly like a real
# click), then drain __aqa_buf and assert the recorded click action. Finally we feed the captured
# buffer through build-flow.js and assert the produced step is needs_review with a non-empty ladder
# (the full capture->build chain). Headless; every verdict reads JSON fields, never exit codes.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DIR/lib/env.sh"
source "$DIR/lib/cleanup.sh"
source "$DIR/lib/assert.sh"

CAPJS="$DIR/bin/capture.js"
[ -s "$CAPJS" ] || { echo "  ✗ missing $CAPJS" >&2; exit 1; }

# Inject capture.js and open a real page; the init-script installs the recorder's listeners.
AB open --init-script "$CAPJS" "https://example.com" >/dev/null

# A 109-char visible label (>80). All-'a' keeps Shannon entropy ~0 so the dynamic-id filter does
# not flag it — this isolates the length policy under test.
LONG="$(printf 'a%.0s' $(seq 1 109))"

# Build the DOM in ONE eval (its mutation is fully observed BEFORE the click, so the DOM-swap
# detector cannot attribute it to the click), then click in a SECOND eval. The sibling <span>
# gives <body> different text than the button so the button is a clean unique exact-text match.
AB_JSON eval "document.body.innerHTML='<button id=L></button><span>x</span>';document.getElementById('L').textContent='$LONG';1" >/dev/null
AB_JSON eval "document.getElementById('L').click();1" >/dev/null

# Drain the buffer and isolate the recorded click action.
BUF="$(AB_JSON eval "JSON.parse(sessionStorage.getItem('__aqa_buf')||'[]')")"
CLICK="$(printf '%s' "$BUF" | jq -c '[.data.result[] | select(.action_type=="click")] | last')"
[ -n "$CLICK" ] && [ "$CLICK" != "null" ] || { echo "  ✗ no click action recorded (capture.js did not install via --init-script?)" >&2; exit 1; }

# (a) candidate ladder is NON-EMPTY and contains the long value (as a text value or a role name).
nc="$(printf '%s' "$CLICK" | jq -r '.candidates | length')"
[ "${nc:-0}" -ge 1 ] || { echo "  ✗ C1: needs_review candidate ladder is EMPTY for long text (the bug)" >&2; exit 1; }
haslong="$(printf '%s' "$CLICK" | jq -r --arg L "$LONG" 'any(.candidates[]?; .value==$L or .name==$L)')"
[ "$haslong" = "true" ] || { echo "  ✗ C1: long (>80) value missing from the candidate ladder" >&2; exit 1; }

# (b) the long text must NOT be auto-promoted to a primary locator (the step stays needs_review).
prim="$(printf '%s' "$CLICK" | jq -r '.primary')"
[ "$prim" = "null" ] || { echo "  ✗ C1: long text was auto-promoted to primary (must stay needs_review): $prim" >&2; exit 1; }

# Full chain: captured buffer -> build-flow.js -> needs_review step with a NON-EMPTY ladder.
WORK="$ARTDIR/ltbuild"; mkdir -p "$WORK"
printf '%s' "$BUF" | jq -c '.data.result' > "$WORK/records.json"
node "$DIR/bin/build-flow.js" ltflow "https://example.com" "" "$WORK/records.json" "$WORK" 2>/dev/null \
	|| { echo "  ✗ build-flow.js exited non-zero on the long-text capture" >&2; exit 1; }
FLOW="$WORK/ltflow.flow.json"
[ -s "$FLOW" ] || { echo "  ✗ build-flow produced no flow.json" >&2; exit 1; }
nr="$(jq -r '[.steps[] | select(.needs_review==true)] | length' "$FLOW")"
[ "${nr:-0}" -ge 1 ] || { echo "  ✗ C1: build-flow produced no needs_review step for the long-text click" >&2; exit 1; }
empties="$(jq -r '[.steps[] | select(.needs_review==true) | select((.candidates|length)==0)] | length' "$FLOW")"
[ "$empties" = "0" ] || { echo "  ✗ C1: a needs_review step has an EMPTY candidate ladder (must never happen)" >&2; exit 1; }

echo "  ✓ capture-longtext.test.sh passed"
