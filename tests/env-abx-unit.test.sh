#!/usr/bin/env bash
# Browser-free unit for ABX: .success, not process exit, is the verdict.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/bin"

cat > "$TMP/bin/agent-browser" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
case "${FAKE_AB:-ok}" in
	ok) printf '{"success":true,"data":{"ok":1},"error":null}\n'; exit 0 ;;
	fail-exit0) printf '{"success":false,"data":null,"error":"not found"}\n'; exit 0 ;;
	garbage) printf 'not-json\n'; exit 0 ;;
esac
SH
chmod +x "$TMP/bin/agent-browser"

fail(){ echo "  env-abx-unit: $*" >&2; exit 1; }

(
	export PATH="$TMP/bin:$PATH" PROBE_ROOT="$DIR" RUN_ID=unit AQA_SKIP_DAEMON_ENSURE=1
	source "$DIR/lib/env.sh"
	FAKE_AB=ok ABX click '#ok' >/dev/null || fail "ABX rejected success=true"
	if FAKE_AB=fail-exit0 ABX click '#missing' >/dev/null 2>"$TMP/err"; then fail "ABX accepted success=false with exit 0"; fi
	grep -q 'not found' "$TMP/err" || fail "ABX did not report agent-browser error"
	if FAKE_AB=garbage ABX click '#bad' >/dev/null 2>/dev/null; then fail "ABX accepted invalid JSON"; fi
)

echo "  env-abx-unit: all checks passed"
