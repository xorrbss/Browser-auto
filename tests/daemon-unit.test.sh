#!/usr/bin/env bash
# Browser-free unit tests for lib/daemon.sh. Uses a fake agent-browser and a fake
# recovery script so the test never opens Chrome or touches the real daemon.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/bin" "$TMP/probe/bin" "$TMP/home/.agent-browser"
FAKE_LOG="$TMP/log"
FAKE_RECOVERED="$TMP/recovered"

cat > "$TMP/bin/agent-browser" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$FAKE_LOG"
case "${FAKE_MODE:-healthy}" in
	healthy)
		if [ "${*: -1}" = "--json" ]; then printf '{"success":true,"data":{"url":"about:blank"}}\n'; fi
		exit 0
		;;
	recover)
		if [ -f "$FAKE_RECOVERED" ]; then
			if [ "${*: -1}" = "--json" ]; then printf '{"success":true,"data":{"url":"about:blank"}}\n'; fi
			exit 0
		fi
		exit 1
		;;
	fail)
		exit 1
		;;
esac
SH
chmod +x "$TMP/bin/agent-browser"

cat > "$TMP/probe/bin/daemon-recover.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
echo recover >> "$FAKE_LOG"
: > "$FAKE_RECOVERED"
SH
chmod +x "$TMP/probe/bin/daemon-recover.sh"

fail() { echo "  daemon-unit: $*" >&2; exit 1; }
assert_log_has() { grep -F -- "$1" "$FAKE_LOG" >/dev/null || fail "missing log entry: $1"; }
assert_log_not_has() { ! grep -F -- "$1" "$FAKE_LOG" >/dev/null || fail "unexpected log entry: $1"; }

run_case() {
	local mode="$1" want_rc="$2"
	: > "$TMP/log"
	rm -f "$TMP/recovered"
	set +e
	(
		set -euo pipefail
		export PATH="$TMP/bin:$PATH"
		export HOME="$TMP/home"
		export PROBE_ROOT="$TMP/probe"
		export AGENT_BROWSER_HOME="$TMP/home/.agent-browser"
		export FAKE_LOG="$TMP/log"
		export FAKE_MODE="$mode"
		export FAKE_RECOVERED="$TMP/recovered"
		export AQA_DAEMON_PROBE_TIMEOUT=1
		source "$DIR/lib/daemon.sh"
		ensure_daemon >"$TMP/out" 2>&1
	)
	local rc=$?
	set -e
	[ "$rc" = "$want_rc" ] || fail "mode=$mode expected rc=$want_rc got rc=$rc"
}

run_case healthy 0
assert_log_has "--session aqa-daemon-health open about:blank"
assert_log_has "--session aqa-daemon-health get url --json"
assert_log_not_has "recover"

run_case recover 0
assert_log_has "recover"

run_case fail 1
assert_log_has "recover"

echo "  daemon-unit: all checks passed"
