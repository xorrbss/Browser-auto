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
# Prereq: system registered (POST /api/systems) with a recipe carrying a "detail" block (INCLUDING
# detail.idLabel — the per-record identity guard) + a target_url, and a cached login
# (fixtures/auth/<name>.state.json). SUMMARY_* config: data/approvals.config.

set -euo pipefail
PROBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PROBE_ROOT

SYSTEM=""; LIMIT=0; KEY=""
while [ $# -gt 0 ]; do
	case "$1" in
		--system) SYSTEM="${2:-}"; shift 2 ;;
		--limit) LIMIT="${2:-0}"; shift 2 ;;
		--key) KEY="${2:-}"; shift 2 ;;   # enrich ONE specific record (must be reachable on the list)
		*) echo "[enrich-system] unknown arg: $1" >&2; exit 2 ;;
	esac
done
[ -n "$SYSTEM" ] || { echo "[enrich-system] --system <name> required" >&2; exit 2; }

ENGINE="$(cd "$PROBE_ROOT" && node -e '
const d=require("./lib/db.js");const e=require("./lib/engine.js");const h=d.openDb();const s=d.getSystem(h,process.argv[1]);
if(!s){console.error("no such system: "+process.argv[1]);process.exit(3);}
process.stdout.write(e.systemEngine(s));
d.closeDb(h);
' "$SYSTEM")" || { echo "[enrich-system] failed to load system '$SYSTEM' from registry" >&2; exit 3; }
if [ "$ENGINE" = "playwright" ]; then
	args=(enrich --system "$SYSTEM")
	[ "${LIMIT:-0}" != 0 ] && args+=(--limit "$LIMIT")
	[ -n "${KEY:-}" ] && args+=(--key "$KEY")
	exec node "$PROBE_ROOT/bin/pw-rpa.mjs" "${args[@]}"
fi

# SUMMARY_* (on-prem model) live in data/approvals.config (exported there so the child inherits them).
CONFIG="$PROBE_ROOT/data/approvals.config"
[ -f "$CONFIG" ] && . "$CONFIG"

# TMPD is cleaned by an explicit `rm -rf` at EVERY exit (NOT an EXIT trap): lib/cleanup.sh, sourced
# below, installs its own EXIT trap (record stop + session close) and would replace ours — mirror
# sync-system.sh's convention and remove TMPD inline so nothing leaks.
TMPD="$(mktemp -d)"
RECIPE="$TMPD/recipe.json"
# Load recipe (to a FILE so Korean survives — never via argv) + target URL from the registry.
TARGET="$(cd "$PROBE_ROOT" && node -e '
const d=require("./lib/db.js");const h=d.openDb();const s=d.getSystem(h,process.argv[1]);
if(!s){console.error("no such system: "+process.argv[1]);process.exit(3);}
require("node:fs").writeFileSync(process.argv[2], JSON.stringify(s.recipe||{}));
process.stdout.write(s.target_url||"");
d.closeDb(h);
' "$SYSTEM" "$RECIPE")" || { echo "[enrich-system] failed to load system '$SYSTEM' from registry" >&2; rm -rf "$TMPD"; exit 3; }
[ -n "$TARGET" ] || { echo "[enrich-system] system '$SYSTEM' has no target_url" >&2; rm -rf "$TMPD"; exit 3; }

if [ "$(jq -r 'has("detail")' "$RECIPE")" != "true" ]; then
	echo "[enrich-system] recipe for '$SYSTEM' has no \"detail\" block (fields + bodyFromHeadingLevel) — nothing to enrich." >&2
	rm -rf "$TMPD"; exit 3
fi
# detail.idLabel is MANDATORY on the generic path: it is the ONLY per-record identity guard
# (extract-detail verifies the opened detail page's idLabel == the record key, rejecting a wrong/list
# page). detail.urlGlob only proves SOME detail URL opened, not the RIGHT record. Refuse without it.
ID_LABEL="$(jq -r '.detail.idLabel // empty' "$RECIPE")"
[ -n "$ID_LABEL" ] || { echo "[enrich-system] recipe.detail.idLabel is REQUIRED on the generic path (per-record identity guard) — refusing to enrich without it." >&2; rm -rf "$TMPD"; exit 3; }
READY_TEXT="$(jq -r '.detail.ready.text // empty' "$RECIPE")"
DETAIL_URLGLOB="$(jq -r '.detail.urlGlob // empty' "$RECIPE")"

# Records to enrich: a single --key, else status='fetched' rows still missing a summary; their `key` is
# the click target's visible text in the list. One key per line (special chars survive the read).
# Capture into a file (NOT `mapfile < <(node)`, which discards the exit code and would mask a DB read
# failure as "nothing to do").
if [ -n "$KEY" ]; then
	DOCS=("$KEY")
else
	DOCLIST="$(mktemp)"; DOCERR="$(mktemp)"
	if ! ( cd "$PROBE_ROOT" && node -e '
const d=require("./lib/db.js");const h=d.openDb();
let r=d.queryRecords(h,process.argv[1],{status:"fetched"}).filter(x=>!x.summary).map(x=>x.key);
d.closeDb(h);
const lim=parseInt(process.argv[2],10)||0; if(lim>0) r=r.slice(0,lim);
for(const k of r) console.log(k);
' "$SYSTEM" "$LIMIT" ) > "$DOCLIST" 2> "$DOCERR"; then
		echo "[enrich-system] ✗ could not read records from the DB:" >&2; cat "$DOCERR" >&2
		rm -f "$DOCLIST" "$DOCERR"; rm -rf "$TMPD"; exit 1
	fi
	mapfile -t DOCS < "$DOCLIST"
	rm -f "$DOCLIST" "$DOCERR"
fi

if [ "${#DOCS[@]}" -eq 0 ]; then
	echo "[enrich-system] nothing to enrich (all fetched records already summarized, or none synced)."
	rm -rf "$TMPD"; exit 0
fi
echo "[enrich-system] ${#DOCS[@]} record(s) to enrich for '$SYSTEM'."

source "$PROBE_ROOT/lib/env.sh"      # AB_AUTH, AB_JSON (.success contract)
source "$PROBE_ROOT/lib/cleanup.sh"  # close session on exit (installs its own EXIT trap)
source "$PROBE_ROOT/lib/assert.sh"   # wait_url (gate the click→detail navigation)

echo "[enrich-system] launching browser with cached '$SYSTEM' session…"
AB_AUTH "$SYSTEM" open </dev/null >/dev/null

# Pagination context (so enrich reaches docs on ANY list page, not just page 1). Mirror sync-system.sh:
# the total page count = the number of page-number <option>s, and page 1's key signature lets a combobox
# page change be detected as "settled". extract-list.js yields the per-page keys from a list snapshot.
LIST_READY="$(jq -r '.ready.text // empty' "$RECIPE")"
PAGINATE="$(jq -r '.pagination.mode // empty' "$RECIPE")"
EX_LIST="$PROBE_ROOT/bin/extract-list.js"
_list_keysig() { printf '%s' "$1" | node "$EX_LIST" "$RECIPE" 2>/dev/null | jq -r '[.[].key]|sort|join(",")' 2>/dev/null || true; }
ABX navigate "$TARGET" </dev/null >/dev/null || { rm -rf "$TMPD"; exit 1; }
[ -z "$LIST_READY" ] || wait_text "$LIST_READY" 15 >/dev/null 2>&1 || true
P1SNAP="$(ABX snapshot </dev/null 2>/dev/null | jq '.data' 2>/dev/null || true)"
SIG1="$(_list_keysig "$P1SNAP")"
TOTAL=1
if [ "$PAGINATE" = "combobox" ]; then
	# Shared fail-closed page decision (bin/pager-decide.js → guards.pagerDecision, same rule as the
	# Playwright engine): a single clean 1..N <select>; anything else ⇒ page 1 only (a doc on an unscanned
	# page then falls through to "not found on any page" + skip — never a wrong-combobox page change).
	read -r _pk TOTAL _pref < <(printf '%s' "$P1SNAP" | node "$PROBE_ROOT/bin/pager-decide.js" "$PAGINATE") || true
	case "${_pk:-}" in
		pager) : ;;
		uncertain) echo "[enrich-system] ⚠ page combobox ambiguous / not a clean 1..N — scanning page 1 only (fail-closed)" >&2; TOTAL=1 ;;
		*) TOTAL=1 ;;
	esac
	[ "$TOTAL" -gt 100 ] && TOTAL=100
fi
echo "[enrich-system] list has $TOTAL page(s)."

i=0
for key in "${DOCS[@]}"; do
	echo "[enrich-system] ($((i+1))/${#DOCS[@]}) $key"
	# Back to the list, then open this record by its visible key text (same-tab navigation). SUBSTRING
	# match (NOT --exact): a doc id/key is rendered INSIDE a larger cell, so --exact finds nothing
	# (verified live: "Element not found"). The wrong-record risk is covered by extract-detail's
	# MANDATORY idLabel==key guard, which rejects+skips a detail page whose 문서번호 differs.
	# `|| true`: a chained `find … click` returns a NON-ZERO exit when the element isn't found (e.g. the
	# doc is on another list page) — without it, set -e would ABORT the whole batch instead of skipping
	# this one doc. The .success check below turns a not-found / transient daemon error into a skip.
	# Re-navigate to page 1 (we may be on a previous doc's detail page), then SCAN list pages until the
	# click lands — a target doc can be on any page. Page forward via the combobox @ref (read FRESH per
	# page, never stored), settling when the key set differs from page 1 (mirrors sync-system.sh).
	ABX navigate "$TARGET" </dev/null >/dev/null 2>&1 || { echo "  WARN: list navigation failed; skipping $key" >&2; continue; }
	[ -z "$LIST_READY" ] || wait_text "$LIST_READY" 12 >/dev/null 2>&1 || true
	clicked=0
	for ((p=1; p<=TOTAL; p++)); do
		if [ "$p" -gt 1 ]; then
			cur="$(ABX snapshot </dev/null 2>/dev/null | jq '.data' 2>/dev/null || true)"
			read -r _k _t ref < <(printf '%s' "$cur" | node "$PROBE_ROOT/bin/pager-decide.js" "$PAGINATE" 2>/dev/null) || true
			[ -n "${ref:-}" ] || break
			ABX select "@$ref" "$p" </dev/null >/dev/null 2>&1 || true
			for _t in $(seq 1 12); do
				ids="$(_list_keysig "$(ABX snapshot </dev/null 2>/dev/null | jq '.data' 2>/dev/null || true)")"
				[ -n "$ids" ] && [ "$ids" != "$SIG1" ] && break
				sleep 0.5
			done
		fi
		cj="$(ABX find text "$key" click </dev/null 2>/dev/null || true)"
		[ "$(printf '%s' "$cj" | jq -r '.success' 2>/dev/null)" = "true" ] && { clicked=1; break; }
	done
	if [ "$clicked" != 1 ]; then
		echo "  ⚠ not found on any of $TOTAL list page(s) / click failed — skipping" >&2; continue
	fi
	# Reliability gate: the click must NAVIGATE to a detail URL — else skip (never snapshot the list).
	if [ -n "$DETAIL_URLGLOB" ] && ! wait_url "$DETAIL_URLGLOB" 12; then
		echo "  ⚠ click did not open a detail page (no $DETAIL_URLGLOB) — skipping $key" >&2; continue
	fi
	if [ -n "$READY_TEXT" ]; then
		wait_text "$READY_TEXT" 12 >/dev/null 2>&1 || true
	fi
	sj="$(ABX snapshot </dev/null 2>/dev/null || true)"
	if [ "$(printf '%s' "$sj" | jq -r '.success' 2>/dev/null)" != "true" ]; then
		echo "  ⚠ detail snapshot failed — skipping" >&2; continue
	fi
	# Extract arbitrary detail fields + raw_text. extract-detail --generic ENFORCES idLabel==key (the
	# recipe's idLabel is mandatory, checked above), rejecting a wrong/list page → that record is
	# skipped, never stored. Keep `key` + `raw_text` at top level for now: the summarizer reads raw_text
	# and logs key; the records wrap happens after.
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
	echo "[enrich-system] no records successfully extracted." >&2; rm -rf "$TMPD"; exit 1
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
rm -rf "$TMPD"
echo "[enrich-system] done."
