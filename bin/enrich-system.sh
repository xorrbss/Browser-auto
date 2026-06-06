#!/usr/bin/env bash
# bin/enrich-system.sh — GENERIC per-record DETAIL enrichment + (local) summarization for ANY
# registered system. Generalizes bin/enrich-approvals.sh onto the records path (the way sync-system.sh
# generalizes fetch-approvals.sh): for each record still lacking a summary, open its detail page
# (recipe.detail), extract arbitrary label→value fields + a body blob (extract-detail.js --generic),
# optionally summarize the body with the ON-PREM model (summarize.js), and store via store-records.js.
# upsertRecords MERGES data (json_patch) and COALESCEs summary, so this pass accumulates onto the list
# sync instead of clobbering it. Browser-driving → invoked serially. The body NEVER leaves the
# configured local/사내 endpoint. AI (the summary) is enrichment only, never a pass/fail gate.
#
# Usage:
#   SUMMARY_MODEL=exaone3.5:32b bash bin/enrich-system.sh --system <name> [--limit N]   # detail + summary
#   bash bin/enrich-system.sh --system <name>                                           # detail only
# Prereq: system registered (POST /api/systems) with a recipe carrying a "detail" block + a target_url,
# and a cached login (fixtures/auth/<name>.state.json). SUMMARY_* config: data/approvals.config.

set -euo pipefail
PROBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PROBE_ROOT

SYSTEM=""; LIMIT=0
while [ $# -gt 0 ]; do
	case "$1" in
		--system) SYSTEM="${2:-}"; shift 2 ;;
		--limit) LIMIT="${2:-0}"; shift 2 ;;
		*) echo "[enrich-system] unknown arg: $1" >&2; exit 2 ;;
	esac
done
[ -n "$SYSTEM" ] || { echo "[enrich-system] --system <name> required" >&2; exit 2; }

# SUMMARY_* (on-prem model) live in data/approvals.config (exported there so the child inherits them).
CONFIG="$PROBE_ROOT/data/approvals.config"
[ -f "$CONFIG" ] && . "$CONFIG"

TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT
RECIPE="$TMPD/recipe.json"
# Load recipe (to a FILE so Korean survives — never via argv) + target URL from the registry.
TARGET="$(cd "$PROBE_ROOT" && node -e '
const d=require("./lib/db.js");const h=d.openDb();const s=d.getSystem(h,process.argv[1]);
if(!s){console.error("no such system: "+process.argv[1]);process.exit(3);}
require("node:fs").writeFileSync(process.argv[2], JSON.stringify(s.recipe||{}));
process.stdout.write(s.target_url||"");
d.closeDb(h);
' "$SYSTEM" "$RECIPE")" || { echo "[enrich-system] failed to load system '$SYSTEM' from registry" >&2; exit 3; }
[ -n "$TARGET" ] || { echo "[enrich-system] system '$SYSTEM' has no target_url" >&2; exit 3; }

if [ "$(jq -r 'has("detail")' "$RECIPE")" != "true" ]; then
	echo "[enrich-system] recipe for '$SYSTEM' has no \"detail\" block (fields + bodyFromHeadingLevel) — nothing to enrich." >&2
	exit 3
fi
READY_TEXT="$(jq -r '.detail.ready.text // empty' "$RECIPE")"
DETAIL_URLGLOB="$(jq -r '.detail.urlGlob // empty' "$RECIPE")"

# Records to enrich: status='fetched' rows still missing a summary; their `key` is the click target's
# visible text in the list. One key per line (special chars survive the read). Capture into a file (NOT
# `mapfile < <(node)`, which discards the exit code and would mask a DB read failure as "nothing to do").
DOCLIST="$(mktemp)"; DOCERR="$(mktemp)"
if ! ( cd "$PROBE_ROOT" && node -e '
const d=require("./lib/db.js");const h=d.openDb();
let r=d.queryRecords(h,process.argv[1],{status:"fetched"}).filter(x=>!x.summary).map(x=>x.key);
d.closeDb(h);
const lim=parseInt(process.argv[2],10)||0; if(lim>0) r=r.slice(0,lim);
for(const k of r) console.log(k);
' "$SYSTEM" "$LIMIT" ) > "$DOCLIST" 2> "$DOCERR"; then
	echo "[enrich-system] ✗ could not read records from the DB:" >&2; cat "$DOCERR" >&2
	rm -f "$DOCLIST" "$DOCERR"; exit 1
fi
mapfile -t DOCS < "$DOCLIST"
rm -f "$DOCLIST" "$DOCERR"

if [ "${#DOCS[@]}" -eq 0 ]; then
	echo "[enrich-system] nothing to enrich (all fetched records already summarized, or none synced)."
	exit 0
fi
echo "[enrich-system] ${#DOCS[@]} record(s) to enrich for '$SYSTEM'."

source "$PROBE_ROOT/lib/env.sh"      # AB_AUTH, AB_JSON (.success contract)
source "$PROBE_ROOT/lib/cleanup.sh"  # close session on exit
source "$PROBE_ROOT/lib/assert.sh"   # wait_url (gate the click→detail navigation)

echo "[enrich-system] launching browser with cached '$SYSTEM' session…"
AB_AUTH "$SYSTEM" open </dev/null >/dev/null

i=0
for key in "${DOCS[@]}"; do
	echo "[enrich-system] ($((i+1))/${#DOCS[@]}) $key"
	# Back to the list, then open this record by its visible key text (same-tab navigation).
	AB_JSON navigate "$TARGET" </dev/null >/dev/null 2>&1 || true
	cj="$(AB_JSON find text "$key" click </dev/null)"
	if [ "$(printf '%s' "$cj" | jq -r '.success')" != "true" ]; then
		echo "  ⚠ click failed ($(printf '%s' "$cj" | jq -r '.error // "?"')) — skipping" >&2; continue
	fi
	# Reliability gate: the click must NAVIGATE to a detail URL — else skip (never snapshot the list).
	if [ -n "$DETAIL_URLGLOB" ] && ! wait_url "$DETAIL_URLGLOB" 12; then
		echo "  ⚠ click did not open a detail page (no $DETAIL_URLGLOB) — skipping $key" >&2; continue
	fi
	if [ -n "$READY_TEXT" ]; then
		AB_JSON wait --text "$READY_TEXT" --timeout 12000 </dev/null >/dev/null 2>&1 || true
	fi
	sj="$(AB_JSON snapshot </dev/null)"
	if [ "$(printf '%s' "$sj" | jq -r '.success')" != "true" ]; then
		echo "  ⚠ detail snapshot failed — skipping" >&2; continue
	fi
	# Extract arbitrary detail fields + raw_text (guard: idLabel==key rejects a wrong/list page). Keep
	# `key` + `raw_text` at top level for now: the summarizer reads raw_text and logs key; the records
	# wrap happens after. A guard failure → skip, never store.
	if printf '%s' "$sj" | jq '.data' | node "$PROBE_ROOT/bin/extract-detail.js" "$RECIPE" "$key" --generic \
		| jq -c --arg k "$key" '. + {key:$k}' > "$TMPD/$i.json"; then
		echo "  ✓ fields=$(jq -rc 'del(.raw_text,.key)|keys|join(",")' "$TMPD/$i.json"), body=$(jq -r '.raw_text|length' "$TMPD/$i.json") chars"
	else
		echo "  ⚠ skipped (extract-detail guard or error — wrong/list page not stored)" >&2; rm -f "$TMPD/$i.json"
	fi
	i=$((i+1))
done

# Combine all per-record items.
shopt -s nullglob
files=( "$TMPD"/[0-9]*.json )
shopt -u nullglob
if [ "${#files[@]}" -eq 0 ]; then
	echo "[enrich-system] no records successfully extracted." >&2; exit 1
fi
ITEMS="$TMPD/items.json"
jq -s '.' "${files[@]}" > "$ITEMS"

# Summarize (local model) if configured, then WRAP each item into the records shape
# {key, summary, data:{...detail fields incl raw_text}} and upsert (data merged, summary set).
WRAP='map({key:.key, summary:(.summary//null), data:(del(.key,.summary))})'
if [ -n "${SUMMARY_MODEL:-}" ]; then
	echo "[enrich-system] summarizing ${#files[@]} record(s) via local model '${SUMMARY_MODEL}'…"
	node "$PROBE_ROOT/bin/summarize.js" < "$ITEMS" | jq "$WRAP" | node "$PROBE_ROOT/bin/store-records.js" --system "$SYSTEM"
else
	echo "[enrich-system] SUMMARY_MODEL unset — storing detail fields only (set SUMMARY_MODEL + a local endpoint to summarize)."
	jq "$WRAP" < "$ITEMS" | node "$PROBE_ROOT/bin/store-records.js" --system "$SYSTEM"
fi
echo "[enrich-system] done."
