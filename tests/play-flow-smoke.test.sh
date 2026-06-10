#!/usr/bin/env bash
# Minimal local HTML smoke for bin/play-flow.mjs (Playwright engine replay).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
NAME="_pw_smoke_$$"
NAME2="_pw_smoke_verifyneg_$$"
NAME3="_pw_smoke_verifyirr_$$"
NAME4="_pw_smoke_playneg_$$"
cleanup(){ rm -rf "$TMP"; rm -f "$DIR/flows/$NAME.flow.json" "$DIR/flows/$NAME.values.json" "$DIR/tests/$NAME.test.sh" "$DIR/flows/$NAME2.flow.json" "$DIR/flows/$NAME2.values.json" "$DIR/flows/$NAME3.flow.json" "$DIR/flows/$NAME3.values.json" "$DIR/flows/$NAME4.flow.json" "$DIR/flows/$NAME4.values.json"; }
trap cleanup EXIT

HTML="$TMP/smoke.html"
cat > "$HTML" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<label>Name <input id="name"></label>
<button type="button" onclick="document.querySelector('#status').textContent='Saved '+document.querySelector('#name').value">Save</button>
<div id="status">Idle</div>
HTML
URL="$(node -e "const {pathToFileURL}=require('node:url'); console.log(pathToFileURL(process.argv[1]).href)" "$HTML")"

cat > "$DIR/flows/$NAME.flow.json" <<JSON
{
  "name": "$NAME",
  "engine": "playwright",
  "startUrl": "$URL",
  "steps": [
    { "kind": "find", "by": "label", "value": "Name", "action": "fill", "text": "{{input_1}}" },
    { "kind": "find", "by": "role", "value": "button", "name": "Save", "action": "click" },
    { "kind": "wait", "until": "text", "value": "Saved {{input_1}}" }
  ],
  "asserts": [
    { "kind": "text", "value": "Saved Ada" },
    { "kind": "value", "selector": "#name", "text": "Ada" }
  ]
}
JSON
printf '%s\n' '{"input_1":"Ada"}' > "$DIR/flows/$NAME.values.json"

set +e
OUT="$(node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$NAME.flow.json" 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
	case "$OUT" in
		*"Executable doesn't exist"*|*"Chromium distribution"*|*"not found at"*)
			echo "  play-flow-smoke: skipped (Playwright Chrome channel unavailable)"
			exit 0
			;;
	esac
	printf '%s\n' "$OUT" | sed 's/^/    /' >&2
	echo "  play-flow-smoke: failed" >&2
	exit "$RC"
fi
case "$OUT" in *AQA_JOB_RESULT*'"status":"ok"'*) ;; *) printf '%s\n' "$OUT" >&2; echo "  play-flow-smoke: missing ok result" >&2; exit 1 ;; esac
echo "  play-flow-smoke: passed"

# Live replay failures should identify the exact failed step, not just bubble up a browser error.
cat > "$DIR/flows/$NAME4.flow.json" <<JSON
{
  "name": "$NAME4",
  "engine": "playwright",
  "startUrl": "$URL",
  "steps": [
    { "kind": "find", "by": "label", "value": "Name", "action": "fill", "text": "{{input_1}}" },
    { "kind": "press", "value": "ThisKeyDoesNotExist" }
  ],
  "asserts": []
}
JSON
printf '%s\n' '{"input_1":"Ada"}' > "$DIR/flows/$NAME4.values.json"

set +e
OUT4="$(node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$NAME4.flow.json" 2>&1)"
RC4=$?
set -e
if [ "$RC4" -eq 0 ]; then printf '%s\n' "$OUT4" >&2; echo "  play-flow-smoke play-negative: replay WRONGLY reported success" >&2; exit 1; fi
case "$OUT4" in *'"status":"failed"'*) ;; *) printf '%s\n' "$OUT4" >&2; echo "  play-flow-smoke play-negative: expected a failed status" >&2; exit 1 ;; esac
case "$OUT4" in *'step 1 (press ThisKeyDoesNotExist) failed'*) ;; *) printf '%s\n' "$OUT4" >&2; echo "  play-flow-smoke play-negative: missing step-index diagnostic" >&2; exit 1 ;; esac
echo "  play-flow-smoke play-negative: passed"

# --verify must FAIL LOUD when a NON-find step diverges at replay (regression for the verifyFlow
# silent-OK bug: a failing wait/press/scroll used to break the loop with promoted=0 ⇒ status:'ok').
# The bad `press` key throws at replay; verify must report failed + exit non-zero.
cat > "$DIR/flows/$NAME2.flow.json" <<JSON
{
  "name": "$NAME2",
  "engine": "playwright",
  "startUrl": "$URL",
  "steps": [
    { "kind": "find", "by": "label", "value": "Name", "action": "fill", "text": "{{input_1}}" },
    { "kind": "press", "value": "ThisKeyDoesNotExist" }
  ],
  "asserts": []
}
JSON
printf '%s\n' '{"input_1":"Ada"}' > "$DIR/flows/$NAME2.values.json"

set +e
OUT2="$(node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$NAME2.flow.json" --verify 2>&1)"
RC2=$?
set -e
case "$OUT2" in
	*"Executable doesn't exist"*|*"Chromium distribution"*|*"not found at"*)
		echo "  play-flow-smoke verify-negative: skipped (Playwright Chrome channel unavailable)"
		exit 0
		;;
esac
if [ "$RC2" -eq 0 ]; then printf '%s\n' "$OUT2" >&2; echo "  play-flow-smoke verify-negative: verify WRONGLY reported success on a diverged journey" >&2; exit 1; fi
case "$OUT2" in *'"status":"failed"'*) ;; *) printf '%s\n' "$OUT2" >&2; echo "  play-flow-smoke verify-negative: expected a failed status" >&2; exit 1 ;; esac
echo "  play-flow-smoke verify-negative: passed"

# --verify must STOP BEFORE a flow-declared irreversibleAt (side-door regression: verify used to re-drive
# every step with a blanket reversible:true, executing a declared point-of-no-return un-audited/un-capped).
# Here step 1 (the Save click) is the point-of-no-return: verify must verify only step 0, report
# stoppedBeforeIrreversible, and exit 0 WITHOUT clicking Save.
cat > "$DIR/flows/$NAME3.flow.json" <<JSON
{
  "name": "$NAME3",
  "engine": "playwright",
  "startUrl": "$URL",
  "irreversibleAt": 1,
  "steps": [
    { "kind": "find", "by": "label", "value": "Name", "action": "fill", "text": "{{input_1}}" },
    { "kind": "find", "by": "role", "value": "button", "name": "Save", "action": "click" }
  ],
  "asserts": []
}
JSON
printf '%s\n' '{"input_1":"Ada"}' > "$DIR/flows/$NAME3.values.json"

set +e
OUT3="$(node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$NAME3.flow.json" --verify 2>&1)"
RC3=$?
set -e
if [ "$RC3" -ne 0 ]; then printf '%s\n' "$OUT3" | sed 's/^/    /' >&2; echo "  play-flow-smoke verify-irreversible: verify failed (expected gated ok)" >&2; exit 1; fi
case "$OUT3" in *'"stoppedBeforeIrreversible":true'*) ;; *) printf '%s\n' "$OUT3" >&2; echo "  play-flow-smoke verify-irreversible: missing stoppedBeforeIrreversible (side door open?)" >&2; exit 1 ;; esac
case "$OUT3" in *'"verified":1'*) ;; *) printf '%s\n' "$OUT3" >&2; echo "  play-flow-smoke verify-irreversible: expected exactly 1 verified pre-commit step" >&2; exit 1 ;; esac
echo "  play-flow-smoke verify-irreversible: passed"
