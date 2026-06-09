#!/usr/bin/env bash
# Browser-free unit for assert.sh waiter family.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/agent-browser" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
cmd=()
while [ "$#" -gt 0 ]; do
	case "$1" in --session) shift 2 ;; --json) shift ;; *) cmd+=("$1"); shift ;; esac
done
case "${cmd[*]}" in
	"get text body") printf '{"success":true,"data":{"text":"hello ready"},"error":null}\n' ;;
	"is visible #ok") printf '{"success":true,"data":{"visible":true},"error":null}\n' ;;
	"get count #gone") printf '{"success":true,"data":{"count":0},"error":null}\n' ;;
	"get box #stable") printf '{"success":true,"data":{"x":1,"y":2,"width":3,"height":4},"error":null}\n' ;;
	*) printf '{"success":false,"data":null,"error":"unexpected"}\n' ;;
esac
SH
chmod +x "$TMP/bin/agent-browser"

(
	export PATH="$TMP/bin:$PATH" PROBE_ROOT="$DIR" RUN_ID=unit AQA_SKIP_DAEMON_ENSURE=1
	source "$DIR/lib/env.sh"
	source "$DIR/lib/assert.sh"
	wait_text ready 1
	wait_visible '#ok' 1
	wait_gone '#gone' 1
	wait_stable '#stable' 2
	_url_match 'https://approval.office.hiworks.com/ibizsoftware.net/approval/document/lists/W/?&list_mode=W' '**/ibizsoftware.net/approval/document/lists/W' \
		|| { echo "  ✗ waiters-unit: trailing slash + query URL did not match route glob" >&2; exit 1; }
	if _url_match 'https://approval.office.hiworks.com/ibizsoftware.net/approval/document/lists/W/child' '**/ibizsoftware.net/approval/document/lists/W'; then
		echo "  ✗ waiters-unit: route glob matched a deeper child path" >&2; exit 1
	fi
)

echo "  waiters-unit: all checks passed"
