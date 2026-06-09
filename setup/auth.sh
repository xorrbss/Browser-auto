#!/usr/bin/env bash
# setup/auth.sh — one-time interactive login that caches session state.
#
# The ONLY place human-in-the-loop (OTP/2FA/captcha/SSO) lives. Run it once per app;
# every test then starts from the cached state and replays unattended. Generic by
# design — no site is hardcoded; pass the app via env so it works for any site:
#
#   APP=myapp \
#   LOGIN_URL="https://app.example.com/login" \
#   SUCCESS_URL="**/dashboard" \
#   bash setup/auth.sh
#
# It opens a REAL (headed) Chrome window, you complete the whole login including OTP by
# hand, and the script blocks on SUCCESS_URL until you land there, then saves state to
# fixtures/auth/<APP>.state.json. SUCCESS_URL matching works across origins, which is
# why we gate on the post-login URL rather than snapshotting the (cross-origin) OTP
# iframe — that iframe is invisible to agent-browser snapshots (engine limitation).

set -euo pipefail
PROBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PROBE_ROOT

ENGINE="${ENGINE:-playwright}"
ARGS=()
while [ $# -gt 0 ]; do
	case "${1:-}" in
		--engine)
			[ $# -ge 2 ] || { echo "usage: bash setup/auth.sh [--engine agent-browser|playwright] <app> <login_url> <success_url>" >&2; exit 2; }
			ENGINE="$2"; shift 2 ;;
		*) ARGS+=("$1"); shift ;;
	esac
done
set -- "${ARGS[@]}"
case "$ENGINE" in
	agent-browser|playwright) ;;
	*) echo "[auth] invalid engine '$ENGINE' (expected agent-browser or playwright)" >&2; exit 2 ;;
esac

# Accept config as positional args (auth.sh <app> <login_url> <success_url>) OR env
# vars. Args are preferred because they survive terminals that wrap/split long
# multi-line env-prefixed commands; env vars stay supported for CI use.
APP="${1:-${APP:-}}"
LOGIN_URL="${2:-${LOGIN_URL:-}}"
SUCCESS_URL="${3:-${SUCCESS_URL:-}}"
if [ -z "$APP" ] || [ -z "$LOGIN_URL" ] || [ -z "$SUCCESS_URL" ]; then
	echo "usage: bash setup/auth.sh [--engine agent-browser|playwright] <app> <login_url> <success_url>" >&2
	echo "  e.g: bash setup/auth.sh myapp https://app.example.com/login '**/dashboard'  # default: playwright" >&2
	echo "       bash setup/auth.sh --engine agent-browser myapp https://app.example.com/login '**/dashboard'" >&2
	exit 2
fi
# How long to wait for the human to finish (default 5 min). OTP + reading email is slow.
HUMAN_TIMEOUT_MS="${HUMAN_TIMEOUT_MS:-300000}"

# Human-confirm-save escape (web UI only): if AQA_AUTH_STOPFILE is set, the UI can touch it to mean
# "I finished logging in — save the current session now". This rescues portals that return to the
# EXACT login URL after login, where the got!=LOGIN_URL auto-detect guard below can never fire.
# Standalone CLI runs leave it unset, so the watch is never true and behavior is unchanged.
STOPFILE="${AQA_AUTH_STOPFILE:-}"

STATE_DIR="${PROBE_ROOT}/fixtures/auth"
STATE_FILE="${STATE_DIR}/${APP}.state.json"
mkdir -p "$STATE_DIR"

if [ "$ENGINE" = "playwright" ]; then
	STATE_DIR="${PROBE_ROOT}/fixtures/auth/playwright"
	STATE_FILE="${STATE_DIR}/${APP}.state.json"
	mkdir -p "$STATE_DIR"
	# approve/auth-pw.mjs waits by substring, not glob. Preserve the existing glob-friendly
	# CLI by using the literal part of an agent-browser-style glob as the success needle.
	SUCCESS_NEEDLE="${SUCCESS_URL//\*/}"
	[ -n "$SUCCESS_NEEDLE" ] || SUCCESS_NEEDLE="$SUCCESS_URL"
	echo "[auth] engine=playwright; opening headed Playwright login -> $STATE_FILE"
	exec node "$PROBE_ROOT/approve/auth-pw.mjs" "$LOGIN_URL" "$SUCCESS_NEEDLE" "$STATE_FILE"
fi

# Isolated, headed session so the human can see and drive the real window.
SESS="auth-${APP}"

# Force a visible window. agent-browser.json sets headless:true for deterministic
# replay; auth is the one flow that MUST be visible, so we override via both the flag
# and the env var (the env var beats project config) to be certain the window appears.
export AGENT_BROWSER_HEADED=1

# Standalone auth does not source env.sh, so it owns the shared daemon-health
# gate before its first agent-browser call.
# shellcheck source=../lib/daemon.sh
source "$PROBE_ROOT/lib/daemon.sh"
ensure_daemon
export AQA_DAEMON_ENSURED=1

echo "[auth] opening $LOGIN_URL in a real Chrome window (session: $SESS)..."
agent-browser --session "$SESS" --headed open "$LOGIN_URL" >/dev/null

cat <<EOF

  ============================================================
  COMPLETE THE LOGIN IN THE BROWSER WINDOW NOW.
  Enter credentials and the OTP/2FA code by hand.
  This script is waiting until the page reaches:
      $SUCCESS_URL
  (timeout: $(( HUMAN_TIMEOUT_MS / 1000 ))s)
  ============================================================

EOF

# Block on the success URL by POLLING `get url` — NOT `agent-browser wait --url`, which is
# broken for glob patterns on 0.27.0: it IGNORES --timeout, hangs ~34s, then fails with
# `os error 10060` ("Failed to read"); only plain substrings work (reconfirmed 2026-06-03).
# `get url` is 100% reliable, so we poll it (~1s) until SUCCESS_URL matches or the human
# timeout elapses. This mirrors lib/assert.sh::wait_url, but auth.sh is a standalone setup
# script that sources no lib/, so the matcher is inlined below.
#
# _url_match <got> <want>: 0 if URL matches. <want> is an agent-browser-style glob (** and *
# both collapse to a bash * wildcard, matched against the whole URL with optional ?query/#frag)
# OR a plain substring. The other glob metacharacters ([ and ?) are made literal so a URL
# containing them can never false-match. KEEP IN SYNC with lib/assert.sh::_url_match.
_url_match() {
	local got="$1" want="$2" glob
	glob="${want//\[/[[]}"        # literal [  -> [[]
	glob="${glob//\?/[?]}"        # literal ?  -> [?]
	glob="${glob//\*\*/\*}"       # **         -> *   (sole wildcard)
	case "$got" in
		$glob | $glob\?* | $glob\#*) return 0 ;;   # glob match (whole URL, optional query/frag)
		*"$want"*) return 0 ;;                      # literal-substring fallback
		*) return 1 ;;
	esac
}

deadline=$(( $(date +%s) + HUMAN_TIMEOUT_MS / 1000 ))
matched=0
while [ "$(date +%s)" -lt "$deadline" ]; do
	# Browser is already open (warm daemon) so $() is safe; </dev/null guards the fd-hang
	# footgun, and `|| true` keeps a transient mid-navigation get-url failure from aborting
	# the poll under `set -e` (we just retry until the deadline).
	url_json="$(agent-browser --session "$SESS" get url --json 2>/dev/null </dev/null || true)"
	got="$(printf '%s' "$url_json" | jq -r 'if .success then .data.url else empty end' 2>/dev/null || true)"
	# Human pressed [로그인 완료·저장] in the web UI: save the live session as-is. Require a real URL
	# ([ -n "$got" ]) so we never save a blank/unopened tab. This is the only path that can complete
	# when the post-login URL equals the login URL (the auto-detect guard below intentionally won't).
	if [ -n "$STOPFILE" ] && [ -f "$STOPFILE" ] && [ -n "$got" ]; then
		echo "[auth] confirm-save requested — saving the current session." >&2
		matched=1; break
	fi
	# Only accept the match once the page has navigated away from the login URL (so a SUCCESS_URL that is also a suffix/substring of LOGIN_URL cannot false-match the login page itself).
	if [ -n "$got" ] && [ "$got" != "$LOGIN_URL" ] && _url_match "$got" "$SUCCESS_URL"; then matched=1; break; fi
	sleep 1
done
if [ "$matched" != 1 ]; then
	echo "[auth] FATAL: did not reach '$SUCCESS_URL' within $(( HUMAN_TIMEOUT_MS / 1000 ))s. Login not saved." >&2
	agent-browser --session "$SESS" close >/dev/null 2>&1 || true
	exit 1
fi

echo "[auth] login detected. Saving state -> $STATE_FILE"
agent-browser --session "$SESS" state save "$STATE_FILE" >/dev/null

agent-browser --session "$SESS" close >/dev/null 2>&1 || true
echo "[auth] OK. Tests can now start with:  AB --state \"$STATE_FILE\" open <url>"
