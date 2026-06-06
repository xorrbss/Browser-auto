#!/usr/bin/env bash
# bin/sync-system.sh — GENERIC data-collection sync for any registered system.
#
# Generalizes bin/fetch-approvals.sh: instead of the hardcoded 결재 app, it loads a registered
# system's recipe + target URL from the DB registry (lib/db.js `systems`), drives the cached-auth
# browser to the list, paginates, extracts rows with bin/extract-list.js (arbitrary fields), and
# stores them via bin/store-records.js into the generic `records` table. Browser-driving → invoked
# through the webui serial queue (POST /api/systems/:name/sync) or standalone.
#
#   bash bin/sync-system.sh --system <name>
# Prereq: the system is registered (POST /api/systems) AND a one-time login is cached
#   (fixtures/auth/<name>.state.json via setup/auth.sh / the 인증 button).

set -euo pipefail
PROBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PROBE_ROOT

SYSTEM=""
while [ $# -gt 0 ]; do
	case "$1" in
		--system) SYSTEM="${2:-}"; shift 2 ;;
		*) echo "[sync-system] unknown arg: $1" >&2; exit 2 ;;
	esac
done
[ -n "$SYSTEM" ] || { echo "[sync-system] --system <name> required" >&2; exit 2; }

TMPD="$(mktemp -d)"
RECIPE="$TMPD/recipe.json"
# Load the system's recipe (written to a temp FILE by node so Korean survives — never via argv) and
# its target URL (stdout). Fail loud if the system isn't registered or has no target.
TARGET="$(cd "$PROBE_ROOT" && node -e '
const d=require("./lib/db.js");const h=d.openDb();const s=d.getSystem(h,process.argv[1]);
if(!s){console.error("no such system: "+process.argv[1]);process.exit(3);}
require("node:fs").writeFileSync(process.argv[2], JSON.stringify(s.recipe||{}));
process.stdout.write(s.target_url||"");
d.closeDb(h);
' "$SYSTEM" "$RECIPE")" || { echo "[sync-system] failed to load system '$SYSTEM' from registry" >&2; rm -rf "$TMPD"; exit 3; }
[ -n "$TARGET" ] || { echo "[sync-system] system '$SYSTEM' has no target_url" >&2; rm -rf "$TMPD"; exit 3; }

source "$PROBE_ROOT/lib/env.sh"      # S, AB_AUTH, AB_JSON
source "$PROBE_ROOT/lib/cleanup.sh"  # close session on exit
source "$PROBE_ROOT/lib/assert.sh"   # (parity with fetch-approvals)

EX="$PROBE_ROOT/bin/extract-list.js"
READY_TEXT="$(jq -r '.ready.text // empty' "$RECIPE")"
PAGINATE="$(jq -r '.pagination.mode // empty' "$RECIPE")"

echo "[sync-system] '$SYSTEM' → launching browser (cached auth)…"
AB_AUTH "$SYSTEM" open </dev/null >/dev/null   # fails loud if fixtures/auth/<system>.state.json missing

echo "[sync-system] navigating to target…"
nav="$(AB_JSON navigate "$TARGET" </dev/null || true)"   # || true: report loud below, not a silent set -e abort
if [ "$(printf '%s' "$nav" | jq -r '.success // empty' 2>/dev/null)" != "true" ]; then
	echo "[sync-system] ✗ navigate failed: $(printf '%s' "$nav" | jq -r '.error // "unknown"')" >&2; rm -rf "$TMPD"; exit 1
fi
echo "[sync-system] landed: $(printf '%s' "$nav" | jq -r '.data.url // "?"')"

if [ -n "$READY_TEXT" ]; then
	AB_JSON wait --text "$READY_TEXT" --timeout 15000 </dev/null >/dev/null 2>&1 || true
fi

ITEMS_DIR="$TMPD/items"; mkdir -p "$ITEMS_DIR"
cur="$(AB_JSON snapshot </dev/null | jq '.data' 2>/dev/null || true)"
printf '%s' "$cur" | node "$EX" "$RECIPE" > "$ITEMS_DIR/p001.json"
prev="$(jq -r '[.[].key]|sort|join(",")' "$ITEMS_DIR/p001.json")"
echo "[sync-system] page 1: $(jq 'length' "$ITEMS_DIR/p001.json") rows"

if [ "$PAGINATE" = "combobox" ]; then
	total="$(printf '%s' "$cur" | jq '[.refs[]|select(.role=="option" and (((.name//"")|test("^[0-9]+$"))))]|length')"
	[ "$total" -ge 1 ] 2>/dev/null || total=1
	[ "$total" -gt 100 ] && total=100
	echo "[sync-system] paginating: $total page(s)…"
	for ((p=2; p<=total; p++)); do
		ref="$(printf '%s' "$cur" | jq -r '.refs|to_entries[]|select(.value.role=="combobox")|.key' | head -1)"
		[ -n "$ref" ] || { echo "  ⚠ no combobox — stopping" >&2; break; }
		AB select "@$ref" "$p" </dev/null >/dev/null 2>&1 || true
		loaded=0
		for _t in $(seq 1 12); do
			cur="$(AB_JSON snapshot </dev/null | jq '.data' 2>/dev/null || true)"
			printf '%s' "$cur" | node "$EX" "$RECIPE" > "$ITEMS_DIR/.try.json" 2>/dev/null || true
			ids="$(jq -r '[.[].key]|sort|join(",")' "$ITEMS_DIR/.try.json" 2>/dev/null || true)"
			if [ -n "$ids" ] && [ "$ids" != "$prev" ]; then mv "$ITEMS_DIR/.try.json" "$ITEMS_DIR/$(printf 'p%03d' "$p").json"; loaded=1; break; fi
			sleep 0.5
		done
		if [ "$loaded" != 1 ]; then echo "  ⚠ page $p did not load — stopping (storing pages so far)" >&2; break; fi
		prev="$ids"
		echo "  page $p: $(jq 'length' "$ITEMS_DIR/$(printf 'p%03d' "$p").json") rows"
	done
fi

jq -s 'add | unique_by(.key)' "$ITEMS_DIR"/p*.json > "$TMPD/all.json"
echo "[sync-system] total unique: $(jq 'length' "$TMPD/all.json")"
node "$PROBE_ROOT/bin/store-records.js" --system "$SYSTEM" < "$TMPD/all.json"
rm -rf "$TMPD"
echo "[sync-system] done."
