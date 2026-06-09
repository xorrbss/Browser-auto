#!/usr/bin/env bash
# bin/enrich-approvals.sh — P0+ DETAIL enrichment + (local) summarization.
#
# For each pending (대기) doc that still lacks a summary, open its detail page, extract dept +
# raw_text (bin/extract-detail.js, recipe-driven), then — if a LOCAL model is configured — summarize
# the body (bin/summarize.js, on-prem only) and store everything. Kept SEPARATE from the fast list
# sync (fetch-approvals.sh) so the dashboard shows the list immediately and the slower per-document
# pass fills in. Browser-driving → run one at a time (serial). AI (the summary) is enrichment only,
# never a pass/fail gate. The body never leaves the configured local/사내 endpoint.
#
# Usage:
#   SUMMARY_MODEL=qwen2.5:7b bash bin/enrich-approvals.sh           # detail + summary
#   bash bin/enrich-approvals.sh                                    # detail only (no SUMMARY_MODEL)
#   bash bin/enrich-approvals.sh --app hiworks --url <inbox> --limit 3
# Config: data/approvals.config (GW_APP/GW_INBOX_URL) like fetch-approvals; SUMMARY_* for the model.

set -euo pipefail
PROBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PROBE_ROOT

APP="${GW_APP:-}"
INBOX_URL="${GW_INBOX_URL:-}"
LIMIT=0   # 0 = all docs needing enrichment
while [ $# -gt 0 ]; do
	case "$1" in
		--app) APP="${2:-}"; shift 2 ;;
		--url) INBOX_URL="${2:-}"; shift 2 ;;
		--limit) LIMIT="${2:-0}"; shift 2 ;;
		*) echo "[enrich] unknown arg: $1" >&2; exit 2 ;;
	esac
done

CONFIG="$PROBE_ROOT/data/approvals.config"
if [ -f "$CONFIG" ]; then . "$CONFIG"; : "${APP:=${GW_APP:-}}"; : "${INBOX_URL:=${GW_INBOX_URL:-}}"; fi
[ -n "$APP" ] || { echo "[enrich] --app <name> required" >&2; exit 2; }
[ -n "$INBOX_URL" ] || { echo "[enrich] --url <inbox-url> (or GW_INBOX_URL) required" >&2; exit 2; }

RECIPE="$PROBE_ROOT/recipes/${APP}.json"
[ -s "$RECIPE" ] || { echo "[enrich] no recipe $RECIPE" >&2; exit 3; }
if [ "$(jq -r 'has("detail")' "$RECIPE")" != "true" ]; then
	echo "[enrich] recipe $RECIPE has no \"detail\" block (fields + bodyFromHeadingLevel) — nothing to enrich." >&2
	exit 3
fi
READY_TEXT="$(jq -r '.detail.ready.text // empty' "$RECIPE")"

# Docs to enrich: pending (status='fetched') rows still missing a summary. The doc_id is the click
# target's visible text in the list. Emitted one-per-line so special chars survive the read.
# Run node WITH cwd=PROBE_ROOT so a relative require resolves (an absolute MSYS path like
# /c/project/... is not a valid Node module path on Windows). db.js derives its own DB path.
# Capture into a file (NOT `mapfile < <(node)`, which discards the node exit code and would mask a
# DB read failure as an empty "nothing to enrich"). Check the exit code → fail loud on a real error.
DOCLIST="$(mktemp)"; DOCERR="$(mktemp)"
if ! ( cd "$PROBE_ROOT" && node -e '
const d=require("./lib/db.js");const h=d.openDb();
let r=d.listApprovals(h,{status:"fetched"}).filter(x=>!x.summary).map(x=>x.doc_id);
d.closeDb(h);
const lim=parseInt(process.argv[1],10)||0; if(lim>0) r=r.slice(0,lim);
for(const id of r) console.log(id);
' "$LIMIT" ) > "$DOCLIST" 2> "$DOCERR"; then
	echo "[enrich] ✗ could not read pending docs from the DB:" >&2; cat "$DOCERR" >&2
	rm -f "$DOCLIST" "$DOCERR"; exit 1
fi
mapfile -t DOCS < "$DOCLIST"
rm -f "$DOCLIST" "$DOCERR"

if [ "${#DOCS[@]}" -eq 0 ]; then
	echo "[enrich] nothing to enrich (all pending docs already have a summary, or none synced)."
	exit 0
fi
echo "[enrich] ${#DOCS[@]} doc(s) to enrich for '$APP'."

source "$PROBE_ROOT/lib/env.sh"      # AB_AUTH, AB_JSON (.success contract)
source "$PROBE_ROOT/lib/cleanup.sh"  # close session on exit
source "$PROBE_ROOT/lib/assert.sh"   # wait_url (gate the click→detail navigation)
DETAIL_URLGLOB="$(jq -r '.detail.urlGlob // empty' "$RECIPE")"

TMPD="$(mktemp -d)"; trap 'rm -rf "$TMPD"' EXIT

echo "[enrich] launching browser with cached '$APP' session…"
AB_AUTH "$APP" open </dev/null >/dev/null   # context with cached cookies

i=0
for doc in "${DOCS[@]}"; do
	echo "[enrich] ($((i+1))/${#DOCS[@]}) $doc"
	# Back to the list, then open this doc by its visible doc-number text (same-tab navigation).
	ABX navigate "$INBOX_URL" </dev/null >/dev/null 2>&1 || { echo "  WARN: list navigation failed; skipping $doc" >&2; continue; }
	# `|| true`: a chained `find … click` exits NON-ZERO when the element isn't found (e.g. the doc is on
	# another list page) — without it, set -e would ABORT the whole batch instead of skipping this doc.
	cj="$(ABX find text "$doc" click </dev/null 2>/dev/null || true)"
	if [ "$(printf '%s' "$cj" | jq -r '.success' 2>/dev/null)" != "true" ]; then
		echo "  ⚠ not on the current list page / click failed ($(printf '%s' "$cj" | jq -r '.error // "?"' 2>/dev/null)) — skipping" >&2; continue
	fi
	# Reliability gate: the click must actually NAVIGATE to a document detail URL. If it does not
	# (e.g. the row wasn't clickable / the page stayed on the list), skip — never snapshot the list.
	if [ -n "$DETAIL_URLGLOB" ] && ! wait_url "$DETAIL_URLGLOB" 12; then
		echo "  ⚠ click did not open a detail page (no $DETAIL_URLGLOB) — skipping $doc" >&2; continue
	fi
	# Settle the detail render (recipe.detail.ready) before snapshotting; in-batch wait --text only.
	if [ -n "$READY_TEXT" ]; then
		wait_text "$READY_TEXT" 12 >/dev/null 2>&1 || true
	fi
	sj="$(ABX snapshot </dev/null 2>/dev/null || true)"
	if [ "$(printf '%s' "$sj" | jq -r '.success' 2>/dev/null)" != "true" ]; then
		echo "  ⚠ detail snapshot failed — skipping" >&2; continue
	fi
	# Extract dept + raw_text (passing the expected doc_id so extract-detail's guard rejects a
	# wrong/list page), attach the doc_id, save this doc's item. A guard failure → skip, never store.
	if printf '%s' "$sj" | jq '.data' | node "$PROBE_ROOT/bin/extract-detail.js" "$RECIPE" "$doc" \
		| jq -c --arg id "$doc" '. + {doc_id:$id}' > "$TMPD/$i.json"; then
		echo "  ✓ dept=$(jq -r '.dept // "?"' "$TMPD/$i.json"), body=$(jq -r '.raw_text|length' "$TMPD/$i.json") chars"
	else
		echo "  ⚠ skipped (extract-detail guard or error — wrong/list page not stored)" >&2; rm -f "$TMPD/$i.json"
	fi
	i=$((i+1))
done

# Combine all per-doc items.
shopt -s nullglob
files=( "$TMPD"/*.json )
shopt -u nullglob
if [ "${#files[@]}" -eq 0 ]; then
	echo "[enrich] no documents successfully extracted." >&2; exit 1
fi
ITEMS="$TMPD/items.json"
jq -s '.' "${files[@]}" > "$ITEMS"

# Summarize (local model) only if configured; otherwise store dept+raw_text now (summary later).
if [ -n "${SUMMARY_MODEL:-}" ]; then
	echo "[enrich] summarizing ${#files[@]} doc(s) via local model '${SUMMARY_MODEL}'…"
	node "$PROBE_ROOT/bin/summarize.js" < "$ITEMS" | node "$PROBE_ROOT/bin/store-approvals.js"
else
	echo "[enrich] SUMMARY_MODEL unset — storing dept + raw_text only (set SUMMARY_MODEL + a local endpoint to summarize)."
	node "$PROBE_ROOT/bin/store-approvals.js" < "$ITEMS"
fi
echo "[enrich] done."
