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
nav_json="$(AB_JSON navigate "$INBOX_URL" </dev/null)"
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

# Snapshot the settled inbox via the .success-checked JSON envelope, then save just the data.
snap_json="$(AB_JSON snapshot </dev/null)"
if [ "$(printf '%s' "$snap_json" | jq -r '.success')" != "true" ]; then
	echo "[fetch-approvals] ✗ inbox snapshot failed: $(printf '%s' "$snap_json" | jq -r '.error // "unknown"')" >&2
	exit 1
fi
printf '%s' "$snap_json" | jq '.data' > "$SNAP"
echo "[fetch-approvals] inbox snapshot saved -> $SNAP"

# --- Extraction (the ONE site-coupled step) ---------------------------------------------------
# bin/extract-approvals.js maps THIS groupware's inbox DOM -> a JSON array of items
# (stdin: the snapshot above; stdout: [{doc_id,title,drafter,dept,submitted_at,amount,raw_text}]).
# It is authored ONCE per product from the saved snapshot, because the markup is product-specific
# and fabricating row/field locators would risk exactly the silent-wrong-element matches this
# framework exists to prevent. Until it exists, we STOP LOUD rather than store nothing or guess.
EXTRACTOR="$PROBE_ROOT/bin/extract-approvals.js"
if [ ! -s "$EXTRACTOR" ]; then
	cat >&2 <<EOF

[fetch-approvals] EXTRACTION NOT YET AUTHORED — stopping (no items stored).
  Author bin/extract-approvals.js from the snapshot just saved:
      stdin : $SNAP
      stdout: JSON array of { doc_id, title, drafter, dept, submitted_at, amount, raw_text }
  Then re-run; this script pipes it to bin/store-approvals.js automatically.

  # TODO: [BLOCKED]
  #   violated: 가정 금지 — no live groupware DOM to map inbox rows -> fields
  #   reason:   결재 inbox markup is product-specific; guessing locators risks the
  #             silent-wrong-element matches the framework exists to prevent
  #   required_change: author bin/extract-approvals.js from the saved snapshot (one-time, per product)
EOF
	exit 3
fi

# Author-complete path: snapshot -> items (site extractor) -> DB (shared store). pipefail makes a
# failing extractor fail the whole sync (never a partial/silent store).
node "$EXTRACTOR" < "$SNAP" | node "$PROBE_ROOT/bin/store-approvals.js"
echo "[fetch-approvals] done."
