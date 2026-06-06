#!/usr/bin/env bash
# bin/analyze-system.sh — structure analysis for a registered system (the 구조분석 button).
#
# Opens the system's target list (cached auth), snapshots it, and proposes an extraction recipe
# (bin/propose-recipe.js: detect tables/headers + on-prem model mapping, with a deterministic
# fallback). Saves data/<name>.snapshot.json (PII, gitignored) + data/<name>.proposed.json. The
# webui then loads the proposal into the recipe form for the human to review/edit before saving.
#
#   bash bin/analyze-system.sh --system <name>
# Prereq: system registered with target_url + a cached login (fixtures/auth/<name>.state.json).

set -euo pipefail
PROBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PROBE_ROOT

SYSTEM=""
while [ $# -gt 0 ]; do
	case "$1" in
		--system) SYSTEM="${2:-}"; shift 2 ;;
		*) echo "[analyze] unknown arg: $1" >&2; exit 2 ;;
	esac
done
[ -n "$SYSTEM" ] || { echo "[analyze] --system <name> required" >&2; exit 2; }

DATA_DIR="$PROBE_ROOT/data"; mkdir -p "$DATA_DIR"
SNAP="$DATA_DIR/${SYSTEM}.snapshot.json"
PROPOSED="$DATA_DIR/${SYSTEM}.proposed.json"

TARGET="$(cd "$PROBE_ROOT" && node -e '
const d=require("./lib/db.js");const h=d.openDb();const s=d.getSystem(h,process.argv[1]);
if(!s){console.error("no such system: "+process.argv[1]);process.exit(3);}
process.stdout.write(s.target_url||"");
d.closeDb(h);
' "$SYSTEM")" || { echo "[analyze] failed to load system '$SYSTEM'" >&2; exit 3; }
[ -n "$TARGET" ] || { echo "[analyze] system '$SYSTEM' has no target_url" >&2; exit 3; }

source "$PROBE_ROOT/lib/env.sh"
source "$PROBE_ROOT/lib/cleanup.sh"

echo "[analyze] '$SYSTEM' → launching browser (cached auth)…"
AB_AUTH "$SYSTEM" open </dev/null >/dev/null

echo "[analyze] navigating to target…"
nav="$(AB_JSON navigate "$TARGET" </dev/null)"
if [ "$(printf '%s' "$nav" | jq -r '.success')" != "true" ]; then
	echo "[analyze] ✗ navigate failed: $(printf '%s' "$nav" | jq -r '.error // "unknown"')" >&2; exit 1
fi
echo "[analyze] landed: $(printf '%s' "$nav" | jq -r '.data.url // "?"')"

snap="$(AB_JSON snapshot </dev/null)"
if [ "$(printf '%s' "$snap" | jq -r '.success')" != "true" ]; then
	echo "[analyze] ✗ snapshot failed" >&2; exit 1
fi
printf '%s' "$snap" | jq '.data' > "$SNAP"
echo "[analyze] snapshot saved -> $SNAP"

echo "[analyze] proposing recipe (detect tables + on-prem model)…"
node "$PROBE_ROOT/bin/propose-recipe.js" < "$SNAP" > "$PROPOSED"
echo "[analyze] proposal saved -> $PROPOSED"
echo "[analyze] detected: $(jq -rc '.tables|map("\(.name)(\(.headers|length)h,\(.rowCount)r)")|join(", ")' "$PROPOSED" 2>/dev/null)"
echo "[analyze] proposedBy: $(jq -r '.proposedBy // "?"' "$PROPOSED" 2>/dev/null)"
echo "[analyze] done."
