#!/usr/bin/env bash
# tests/pw-fallback-locator-e2e.test.sh — local-HTML e2e for the css/xpath LAST-RESORT fallback locators
# (approve/flow-runner.mjs buildLocator; dev/active/pw-fallback-locator/DESIGN.md).
#
# Reproduces the jWork jGrid blocker DETERMINISTICALLY without login: the fixture renders a grid the way
# jwork-ui-jgrid does — rows/cells are generic <div>s (.grid-row-rendered/.grid-cell/.grid-type-cell-label/
# .underline-cell) with NO role/name/label/testid, clickable via onclick. Such a cell yields ZERO semantic
# locator candidates (the real-site blocker). This pins that a `by:css` and a `by:xpath` step REPLAY and
# click the exact grid row. Skips if the Playwright Chrome channel is unavailable (mirrors play-flow-smoke).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
XP="_pwfb_xpath_$$"
CSS="_pwfb_css_$$"
cleanup(){ rm -rf "$TMP"; rm -f "$DIR/flows/$XP.flow.json" "$DIR/flows/$XP.values.json" "$DIR/flows/$CSS.flow.json" "$DIR/flows/$CSS.values.json"; }
trap cleanup EXIT

# jWork jGrid-shaped fixture: pure <div> grid (no roles/testid/labels), clickable .underline-cell via onclick.
HTML="$TMP/jgrid.html"
cat > "$HTML" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<title>jGrid fixture</title>
<div class="grid-theme-argos"><div class="grid-main"><div class="grid-table">
  <div class="grid-row grid-row-rendered">
    <div class="grid-cell"><div class="grid-cell-inner-cell"><div class="grid-type-cell-label">1</div></div></div>
    <div class="grid-cell"><div class="grid-cell-inner-cell"><div class="grid-type-cell-label underline-cell" onclick="openRow('A')">신청서 A</div></div></div>
  </div>
  <div class="grid-row grid-row-rendered">
    <div class="grid-cell"><div class="grid-cell-inner-cell"><div class="grid-type-cell-label">2</div></div></div>
    <div class="grid-cell"><div class="grid-cell-inner-cell"><div class="grid-type-cell-label underline-cell" onclick="openRow('B')">신청서 B</div></div></div>
  </div>
</div></div></div>
<div id="status">Idle</div>
<script>function openRow(t){document.getElementById('status').textContent='opened:'+t;}</script>
HTML
URL="$(node -e "const {pathToFileURL}=require('node:url'); console.log(pathToFileURL(process.argv[1]).href)" "$HTML")"

run_flow(){ # run_flow <name> ; echoes play-flow output, sets global RC
	set +e
	OUT="$(node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$1.flow.json" 2>&1)"
	RC=$?
	set -e
}

# --- by:xpath — text-anchored locator clicks row B (the underline cell whose text is "신청서 B") ---
cat > "$DIR/flows/$XP.flow.json" <<JSON
{
  "name": "$XP",
  "engine": "playwright",
  "startUrl": "$URL",
  "steps": [
    { "kind": "find", "by": "xpath", "value": "//div[contains(@class,'underline-cell') and normalize-space(.)='신청서 B']", "action": "click" },
    { "kind": "wait", "until": "text", "value": "opened:B" }
  ],
  "asserts": [ { "kind": "text", "value": "opened:B" } ]
}
JSON
printf '%s\n' '{}' > "$DIR/flows/$XP.values.json"

run_flow "$XP"
if [ "$RC" -ne 0 ]; then
	case "$OUT" in
		*"Executable doesn't exist"*|*"Chromium distribution"*|*"not found at"*)
			echo "  pw-fallback-locator: skipped (Playwright Chrome channel unavailable)"; exit 0 ;;
	esac
	printf '%s\n' "$OUT" | sed 's/^/    /' >&2; echo "  pw-fallback-locator xpath: failed" >&2; exit "$RC"
fi
case "$OUT" in *AQA_JOB_RESULT*'"status":"ok"'*) ;; *) printf '%s\n' "$OUT" >&2; echo "  pw-fallback-locator xpath: missing ok result" >&2; exit 1 ;; esac
echo "  pw-fallback-locator xpath: passed (clicked a no-semantic jGrid cell)"

# --- by:css — structural locator clicks row A (.underline-cell of the first rendered row) ---
cat > "$DIR/flows/$CSS.flow.json" <<JSON
{
  "name": "$CSS",
  "engine": "playwright",
  "startUrl": "$URL",
  "steps": [
    { "kind": "find", "by": "css", "value": ".grid-table .grid-row-rendered:first-child .underline-cell", "action": "click" },
    { "kind": "wait", "until": "text", "value": "opened:A" }
  ],
  "asserts": [ { "kind": "text", "value": "opened:A" } ]
}
JSON
printf '%s\n' '{}' > "$DIR/flows/$CSS.values.json"

run_flow "$CSS"
if [ "$RC" -ne 0 ]; then printf '%s\n' "$OUT" | sed 's/^/    /' >&2; echo "  pw-fallback-locator css: failed" >&2; exit "$RC"; fi
case "$OUT" in *AQA_JOB_RESULT*'"status":"ok"'*) ;; *) printf '%s\n' "$OUT" >&2; echo "  pw-fallback-locator css: missing ok result" >&2; exit 1 ;; esac
echo "  pw-fallback-locator css: passed (clicked a no-semantic jGrid cell)"
