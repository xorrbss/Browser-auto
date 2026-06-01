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

APP="${APP:?set APP=<name> (e.g. APP=samsung)}"
LOGIN_URL="${LOGIN_URL:?set LOGIN_URL=<login page url>}"
SUCCESS_URL="${SUCCESS_URL:?set SUCCESS_URL=<url pattern that means logged-in, e.g. **/dashboard>}"
# How long to wait for the human to finish (default 5 min). OTP + reading email is slow.
HUMAN_TIMEOUT_MS="${HUMAN_TIMEOUT_MS:-300000}"

STATE_DIR="${PROBE_ROOT}/fixtures/auth"
STATE_FILE="${STATE_DIR}/${APP}.state.json"
mkdir -p "$STATE_DIR"

# Isolated, headed session so the human can see and drive the real window.
SESS="auth-${APP}"

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

# Block on the success URL. This is the wait-for-human gate: it returns as soon as the
# human-driven browser navigates to the logged-in URL. Failure (timeout) exits non-zero.
if ! agent-browser --session "$SESS" wait --url "$SUCCESS_URL" --timeout "$HUMAN_TIMEOUT_MS" >/dev/null 2>&1; then
	echo "[auth] FATAL: did not reach '$SUCCESS_URL' within timeout. Login not saved." >&2
	agent-browser --session "$SESS" close >/dev/null 2>&1 || true
	exit 1
fi

echo "[auth] login detected. Saving state -> $STATE_FILE"
agent-browser --session "$SESS" state save "$STATE_FILE" >/dev/null

agent-browser --session "$SESS" close >/dev/null 2>&1 || true
echo "[auth] OK. Tests can now start with:  AB --state \"$STATE_FILE\" open <url>"
