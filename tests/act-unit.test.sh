#!/usr/bin/env bash
# Browser-free unit for lib/act.sh command construction and set_check behavior.

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
	checked=false; [ -f "$FAKE_CHECKED" ] && checked="$(cat "$FAKE_CHECKED")"
	printf '{"success":true,"data":{"result":{"count":1,"checked":%s}},"error":null}\n' "$checked"
	exit 0
fi
if [ "${cmd[0]:-}" = "find" ]; then
	action="${cmd[3]:-click}"
	case "$action" in
		check) printf true > "$FAKE_CHECKED" ;;
		click)
			if [ -f "$FAKE_CHECKED" ] && [ "$(cat "$FAKE_CHECKED")" = true ]; then printf false > "$FAKE_CHECKED"; else printf true > "$FAKE_CHECKED"; fi
			;;
	esac
	printf '{"success":true,"data":{},"error":null}\n'
	exit 0
fi
printf '{"success":true,"data":{},"error":null}\n'
SH
chmod +x "$TMP/bin/agent-browser"

fail(){ echo "  act-unit: $*" >&2; exit 1; }
has(){ grep -F -- "$1" "$FAKE_LOG" >/dev/null || fail "missing command: $1"; }
not_has(){ ! grep -F -- "$1" "$FAKE_LOG" >/dev/null || fail "unexpected command: $1"; }

(
	export PATH="$TMP/bin:$PATH" PROBE_ROOT="$DIR" RUN_ID=unit AQA_SKIP_DAEMON_ENSURE=1
	export FAKE_LOG="$TMP/log" FAKE_CHECKED="$TMP/checked"
	: > "$FAKE_LOG"; rm -f "$FAKE_CHECKED"
	source "$DIR/lib/env.sh"
	source "$DIR/lib/act.sh"

	resolve_one role checkbox --name Subscribe >/dev/null
	has "find role checkbox hover --name Subscribe --exact --json"

	set_check label Subscribe true
	[ "$(cat "$FAKE_CHECKED")" = true ] || fail "set_check true did not set checked=true"
	has "find label Subscribe check --exact --json"

	set_check label Subscribe false
	[ "$(cat "$FAKE_CHECKED")" = false ] || fail "set_check false did not set checked=false"
	has "find label Subscribe click --exact --json"
	not_has "uncheck"
)

echo "  act-unit: all checks passed"
