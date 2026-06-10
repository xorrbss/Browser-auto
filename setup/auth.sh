#!/usr/bin/env bash
# setup/auth.sh - one-time headed Playwright login that caches session state.
#
# Usage:
#   APP=myapp LOGIN_URL="https://app.example.com/login" SUCCESS_URL="**/dashboard" bash setup/auth.sh
#   bash setup/auth.sh myapp https://app.example.com/login '**/dashboard'
#
# The saved state is fixtures/auth/playwright/<APP>.state.json. Human OTP/2FA is
# completed in the headed Playwright window; deterministic replay consumes the
# saved state later.

set -euo pipefail
PROBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PROBE_ROOT

ARGS=()
while [ $# -gt 0 ]; do
	case "${1:-}" in
		--engine)
			[ $# -ge 2 ] || { echo "usage: bash setup/auth.sh [--engine playwright] <app> <login_url> <success_url>" >&2; exit 2; }
			[ "$2" = "playwright" ] || { echo "[auth] invalid engine '$2' (auth is Playwright-only)" >&2; exit 2; }
			shift 2 ;;
		*) ARGS+=("$1"); shift ;;
	esac
done
set -- "${ARGS[@]}"

APP="${1:-${APP:-}}"
LOGIN_URL="${2:-${LOGIN_URL:-}}"
SUCCESS_URL="${3:-${SUCCESS_URL:-}}"
if [ -z "$APP" ] || [ -z "$LOGIN_URL" ] || [ -z "$SUCCESS_URL" ]; then
	echo "usage: bash setup/auth.sh [--engine playwright] <app> <login_url> <success_url>" >&2
	echo "  e.g: bash setup/auth.sh myapp https://app.example.com/login '**/dashboard'" >&2
	exit 2
fi

STATE_DIR="${PROBE_ROOT}/fixtures/auth/playwright"
STATE_FILE="${STATE_DIR}/${APP}.state.json"
mkdir -p "$STATE_DIR"

# approve/auth-pw.mjs waits by substring, not glob. Preserve the existing
# glob-friendly CLI by using the literal part of a glob as the success needle.
SUCCESS_NEEDLE="${SUCCESS_URL//\*/}"
[ -n "$SUCCESS_NEEDLE" ] || SUCCESS_NEEDLE="$SUCCESS_URL"

echo "[auth] engine=playwright; opening headed Playwright login -> $STATE_FILE"
exec env AQA_AUTH_STOPFILE="${AQA_AUTH_STOPFILE:-}" node "$PROBE_ROOT/approve/auth-pw.mjs" "$LOGIN_URL" "$SUCCESS_NEEDLE" "$STATE_FILE"
