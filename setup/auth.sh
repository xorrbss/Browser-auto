#!/usr/bin/env bash
# setup/auth.sh - one-time headed Playwright login that caches session state.
#
# Usage:
#   APP=myapp LOGIN_URL="https://app.example.com/login" SUCCESS_URL="**/dashboard" bash setup/auth.sh
#   bash setup/auth.sh myapp https://app.example.com/login '**/dashboard'
#
# In local pilot mode the saved state is fixtures/auth/playwright/<APP>.state.json.
# In external/encrypted secret mode the headed browser writes to a temporary file,
# then the wrapper imports that JSON into the configured WebUI secret backend and
# removes the temporary plaintext file. Human OTP/2FA is completed in the headed
# Playwright window; deterministic replay consumes the saved state later.

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
case "$APP" in
	*[!A-Za-z0-9_-]*)
		echo "[auth] invalid app name '$APP' (use [A-Za-z0-9_-])" >&2
		exit 2 ;;
esac

STATE_DIR="${PROBE_ROOT}/fixtures/auth/playwright"
STATE_FILE="${STATE_DIR}/${APP}.state.json"
AUTH_STORAGE_MODE="$(
	cd "$PROBE_ROOT"
	node --input-type=module - <<'NODE'
import { authStateStoreMode } from './webui/auth.js';
const mode = authStateStoreMode();
if (!mode.ok) {
	console.error(`[auth] ${mode.error}`);
	process.exit(1);
}
console.log(mode.mode);
NODE
)"

TMP_STATE_DIR=""
cleanup() {
	if [ -n "$TMP_STATE_DIR" ]; then rm -rf "$TMP_STATE_DIR"; fi
}
trap cleanup EXIT

if [ "$AUTH_STORAGE_MODE" = "secret" ]; then
	TMP_STATE_DIR="$(mktemp -d)"
	STATE_FILE="${TMP_STATE_DIR}/${APP}.state.json"
else
	mkdir -p "$STATE_DIR"
fi

# approve/auth-pw.mjs waits by substring, not glob. Preserve the existing
# glob-friendly CLI by using the literal part of a glob as the success needle.
SUCCESS_NEEDLE="${SUCCESS_URL//\*/}"
[ -n "$SUCCESS_NEEDLE" ] || SUCCESS_NEEDLE="$SUCCESS_URL"

if [ "$AUTH_STORAGE_MODE" = "secret" ]; then
	echo "[auth] engine=playwright; opening headed Playwright login -> configured secret backend"
else
	echo "[auth] engine=playwright; opening headed Playwright login -> $STATE_FILE"
fi

env AQA_AUTH_STOPFILE="${AQA_AUTH_STOPFILE:-}" node "$PROBE_ROOT/approve/auth-pw.mjs" "$LOGIN_URL" "$SUCCESS_NEEDLE" "$STATE_FILE"

if [ "$AUTH_STORAGE_MODE" = "secret" ]; then
	cd "$PROBE_ROOT"
	node --input-type=module - "$APP" "$STATE_FILE" <<'NODE'
import { storeAuthStateFromFile } from './webui/auth.js';

const app = process.argv[2];
const filePath = process.argv[3];
const result = await storeAuthStateFromFile(app, filePath);
if (!result.ok) {
	console.error(`[auth] failed to store auth state in secret backend: ${result.error}`);
	process.exit(1);
}
console.error(`[auth] storageState saved -> ${result.secretStorage?.ref || 'configured secret backend'}`);
NODE
fi
