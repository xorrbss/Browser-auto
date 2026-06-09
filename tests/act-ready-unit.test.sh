#!/usr/bin/env bash
# Browser-free unit for wait_actionable/click_ready/select_ready command flow.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/agent-browser" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> "$FAKE_LOG"
cmd=()
while [ "$#" -gt 0 ]; do
	case "$1" in --session) shift 2 ;; --json) shift ;; *) cmd+=("$1"); shift ;; esac
done
if [ "${cmd[0]:-}" = "eval" ]; then
	val="${FAKE_VALUE:-a}"
	printf '{"success":true,"data":{"result":{"count":1,"checked":false,"value":"%s","visible":true,"box":"1,2,3,4"}},"error":null}\n' "$val"
	exit 0
fi
printf '{"success":true,"data":{},"error":null}\n'
SH
chmod +x "$TMP/bin/agent-browser"

fail(){ echo "  act-ready-unit: $*" >&2; exit 1; }
has(){ grep -F -- "$1" "$FAKE_LOG" >/dev/null || fail "missing command: $1"; }

(
	export PATH="$TMP/bin:$PATH" PROBE_ROOT="$DIR" RUN_ID=unit AQA_SKIP_DAEMON_ENSURE=1
	export FAKE_LOG="$TMP/log" FAKE_SELECTED="$TMP/selected" FAKE_VALUE=b
	: > "$FAKE_LOG"
	source "$DIR/lib/env.sh"
	source "$DIR/lib/act.sh"
	wait_actionable label Subscribe --timeout 2
	click_ready label Subscribe --timeout 2
	select_ready label Choice b --timeout 2
	has "find label Subscribe click --exact --json"
	has "find label Subscribe click --exact --json"
)

echo "  act-ready-unit: all checks passed"
