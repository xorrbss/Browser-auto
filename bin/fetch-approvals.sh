#!/usr/bin/env bash
# bin/fetch-approvals.sh — P0 결재 sync: log into the groupware (cached auth), open the approval
# inbox, snapshot it, extract the pending 결재 items, and store them in the approvals DB.
#
# Browser-driving (shares the agent-browser daemon) -> invoked by the webui serial queue
# (POST /api/sync) or standalone. AI-FREE and deterministic: it reads the live page, NO LLM in
# the loop (the optional summary is a separate, policy-gated step, NOT part of P0). Every
# agent-browser call goes through the env.sh .success contract — exit codes lie on 0.27.0.
#
# Usage:
#   bash bin/fetch-approvals.sh --app <gw> --url <inbox-url>
#   GW_APP=<gw> GW_INBOX_URL=<inbox-url> bash bin/fetch-approvals.sh
#
# Prereq: a one-time login cache must exist (fixtures/auth/<gw>.state.json). Create it once with:
#   APP=<gw> LOGIN_URL=<login-url> SUCCESS_URL='**/<post-login-glob>' bash setup/auth.sh

set -euo pipefail
PROBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PROBE_ROOT

APP="${GW_APP:-}"
INBOX_URL="${GW_INBOX_URL:-}"
while [ $# -gt 0 ]; do
	case "$1" in
		--app) APP="${2:-}"; shift 2 ;;
		--url) INBOX_URL="${2:-}"; shift 2 ;;
		*) echo "[fetch-approvals] unknown arg: $1" >&2; exit 2 ;;
	esac
done

# Fallback config (gitignored, deployment-local): data/approvals.config can set GW_APP / GW_INBOX_URL
# so a bare `bash bin/fetch-approvals.sh` AND the webui "동기화" button (POST /api/sync passes only
# --app) work without repeating the inbox URL. Explicit --app/--url and env vars take precedence.
CONFIG="$PROBE_ROOT/data/approvals.config"
if [ -f "$CONFIG" ]; then
	# shellcheck source=/dev/null
	. "$CONFIG"
	: "${APP:=${GW_APP:-}}"
	: "${INBOX_URL:=${GW_INBOX_URL:-}}"
fi

if [ -z "$APP" ]; then
	echo "[fetch-approvals] --app <name> (cached-auth app) is required." >&2
	echo "  e.g: bash bin/fetch-approvals.sh --app mygw --url https://gw.example.com/approval/pending" >&2
	exit 2
fi
if [ -z "$INBOX_URL" ]; then
	echo "[fetch-approvals] --url <inbox-url> (or GW_INBOX_URL) is required." >&2
	exit 2
fi

# Resolve the READ recipe (committed product STRUCTURE: recipes/<app>.json — collection.name +
# columns→headers + optional strip/ready). Selected by --app, mirroring fixtures/auth/<app>.state.json.
# This is the one declarative file that makes the engine site-agnostic; absent ⇒ fail loud (never guess).
RECIPE="$PROBE_ROOT/recipes/${APP}.json"
if [ ! -s "$RECIPE" ]; then
	echo "[fetch-approvals] no recipe for app '$APP' — create $RECIPE (collection.name + columns→headers). See README '결재 (approval) sync'." >&2
	exit 3
fi
# Sanity-pin: a recipe's own .app must match --app (catches a mis-copied recipe pointing at the wrong list).
recipe_app="$(jq -r '.app // empty' "$RECIPE")"
if [ -n "$recipe_app" ] && [ "$recipe_app" != "$APP" ]; then
	echo "[fetch-approvals] recipe app mismatch: $RECIPE declares app '$recipe_app' but --app is '$APP'." >&2
	exit 2
fi

source "$PROBE_ROOT/lib/env.sh"      # S, AB_AUTH, AB_JSON, BATCH (the .success contract)
source "$PROBE_ROOT/lib/cleanup.sh"  # EXIT trap: close this session (record stop no-ops here)
source "$PROBE_ROOT/lib/assert.sh"   # wait_url (gate any in-extractor transition)

# The inbox snapshot is an authoring aid for the (site-specific) extractor AND may contain
# company PII, so it lives under the gitignored data/ dir — never flows/ (committed) .
DATA_DIR="$PROBE_ROOT/data"
mkdir -p "$DATA_DIR"
SNAP="$DATA_DIR/approval-inbox.snapshot.json"

# Every agent-browser call below gets `</dev/null` — the fd-hang footgun auth.sh documents: a
# heavy AJAX app's daemon child can inherit the shell's stdin/stdout fd and wedge a `$(...)`
# capture or pipe forever. We also SPLIT launch from navigation: `open` (no url) creates the
# context with the cached cookies, then `navigate` goes to the inbox — a single `open <url>` on
# a long-polling app can block waiting for an idle that never comes.
echo "[fetch-approvals] launching browser with cached '$APP' session…"
# AB_AUTH returns 1 (fails loud) if fixtures/auth/<app>.state.json is missing -> never logged-out.
AB_AUTH "$APP" open </dev/null >/dev/null

echo "[fetch-approvals] navigating to inbox…"
nav_json="$(ABX navigate "$INBOX_URL" </dev/null)"
if [ "$(printf '%s' "$nav_json" | jq -r '.success')" != "true" ]; then
	echo "[fetch-approvals] ✗ navigate failed: $(printf '%s' "$nav_json" | jq -r '.error // "unknown"')" >&2
	exit 1
fi
landed="$(printf '%s' "$nav_json" | jq -r '.data.url // empty')"
# Generic stale-session guard: if the host changed (e.g. bounced to a login host), warn. We do not
# hardcode any product's login host here (that stays in the site-specific extractor) — a redirect
# away from the requested inbox host means the cached session likely expired; the extractor then
# fails loud ("table not found"), but this points at the real cause first.
want_host="$(printf '%s' "$INBOX_URL" | sed -E 's#^[a-z]+://([^/]+).*#\1#')"
got_host="$(printf '%s' "$landed" | sed -E 's#^[a-z]+://([^/]+).*#\1#')"
if [ -n "$got_host" ] && [ "$got_host" != "$want_host" ]; then
	echo "[fetch-approvals] ⚠ redirected ${want_host} -> ${got_host} — cached session may be expired (re-run setup/auth.sh if extraction is empty)." >&2
fi
echo "[fetch-approvals] landed: ${landed:-?}"

# Optional settle gate (recipe.ready): wait for a header text before snapshotting an async-rendered
# list. Uses the verified-working in-batch `wait --text`; NEVER `wait --url` (broken glob on 0.27.0).
ready_text="$(jq -r '.ready.text // empty' "$RECIPE")"
if [ -n "$ready_text" ]; then
	ready_to="$(jq -r '(.ready.timeout // 15)' "$RECIPE")"
	echo "[fetch-approvals] waiting for list to render (text: \"$ready_text\", ${ready_to}s)…"
	wait_text "$ready_text" "$ready_to"; rj='{"success":true}'
	if [ "$(printf '%s' "$rj" | jq -r '.success')" != "true" ]; then
		echo "[fetch-approvals] ✗ ready gate failed (text \"$ready_text\" not seen): $(printf '%s' "$rj" | jq -r '.error // "timeout"')" >&2
		exit 1
	fi
fi

# --- Snapshot + extract (paginated if recipe.pagination.mode set) -> dedupe -> DB -------------
# bin/extract-approvals.js is GENERIC; recipes/<app>.json supplies the table + column map. When the
# list paginates (recipe.pagination.mode=="combobox"), we drive the single page-number <select> with
# its TRANSIENT @ref (read fresh from each page's snapshot, NEVER stored — @ref is forbidden only as a
# persisted locator) and accumulate every page, deduped by doc_id.
PAGINATE="$(jq -r '.pagination.mode // empty' "$RECIPE")"
ITEMS_DIR="$(mktemp -d)"

snap_json="$(ABX snapshot </dev/null)"
if [ "$(printf '%s' "$snap_json" | jq -r '.success')" != "true" ]; then
	echo "[fetch-approvals] ✗ inbox snapshot failed: $(printf '%s' "$snap_json" | jq -r '.error // "unknown"')" >&2
	rm -rf "$ITEMS_DIR"; exit 1
fi
cur="$(printf '%s' "$snap_json" | jq '.data')"
printf '%s' "$cur" > "$SNAP"   # first page kept as the detail-authoring aid
echo "[fetch-approvals] inbox snapshot saved -> $SNAP"

# Page 1. pipefail makes a failing extractor (e.g. table-not-found on a stale session, or a
# markup-drift guard) fail the whole sync — never a partial/silent store.
printf '%s' "$cur" | node "$PROBE_ROOT/bin/extract-approvals.js" "$RECIPE" > "$ITEMS_DIR/p001.json"
prev_ids="$(jq -r '[.[].doc_id]|sort|join(",")' "$ITEMS_DIR/p001.json")"
echo "[fetch-approvals] page 1: $(jq 'length' "$ITEMS_DIR/p001.json") rows"

if [ "$PAGINATE" = "combobox" ]; then
	# Total pages = count of NUMERIC options under the page <select> (non-numeric = filter dropdowns).
	total="$(printf '%s' "$cur" | jq '[.refs[]|select(.role=="option" and (((.name//"")|test("^[0-9]+$"))))]|length')"
	[ "$total" -ge 1 ] 2>/dev/null || total=1
	[ "$total" -gt 100 ] && total=100   # runaway guard
	echo "[fetch-approvals] paginating via combobox: $total page(s)…"
	for ((p=2; p<=total; p++)); do
		ref="$(printf '%s' "$cur" | jq -r '.refs|to_entries[]|select(.value.role=="combobox")|.key' | head -1)"
		[ -n "$ref" ] || { echo "  ⚠ no combobox on page — stopping pagination" >&2; break; }
		ABX select "@$ref" "$p" </dev/null >/dev/null 2>&1 || true
		# Gate: poll until the row set CHANGES (the AJAX page actually loaded), capturing it once loaded.
		loaded=0
		for _t in $(seq 1 12); do
			cur="$(ABX snapshot </dev/null 2>/dev/null | jq '.data' 2>/dev/null || true)"
			printf '%s' "$cur" | node "$PROBE_ROOT/bin/extract-approvals.js" "$RECIPE" > "$ITEMS_DIR/.try.json" 2>/dev/null || true
			ids="$(jq -r '[.[].doc_id]|sort|join(",")' "$ITEMS_DIR/.try.json" 2>/dev/null || true)"
			if [ -n "$ids" ] && [ "$ids" != "$prev_ids" ]; then
				mv "$ITEMS_DIR/.try.json" "$ITEMS_DIR/$(printf 'p%03d' "$p").json"; loaded=1; break
			fi
			sleep 0.5
		done
		if [ "$loaded" != 1 ]; then
			# Surface a fail-loud guard reason (e.g. cell-count drift) instead of silently swallowing it
			# on page 2+ via the gate's 2>/dev/null polling.
			err="$(printf '%s' "$cur" | node "$PROBE_ROOT/bin/extract-approvals.js" "$RECIPE" 2>&1 >/dev/null || true)"
			echo "  ⚠ page $p did not settle (${err:-no new rows}) — stopping (storing pages so far)" >&2; break
		fi
		prev_ids="$ids"
		echo "  page $p: $(jq 'length' "$ITEMS_DIR/$(printf 'p%03d' "$p").json") rows"
	done
fi

jq -s 'add | unique_by(.doc_id)' "$ITEMS_DIR"/p*.json > "$ITEMS_DIR/all.json"
echo "[fetch-approvals] total unique 결재: $(jq 'length' "$ITEMS_DIR/all.json")"
node "$PROBE_ROOT/bin/store-approvals.js" < "$ITEMS_DIR/all.json"
rm -rf "$ITEMS_DIR"
echo "[fetch-approvals] done."
