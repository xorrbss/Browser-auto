#!/usr/bin/env bash
# bin/sync-system.sh - Playwright-only generic data collection wrapper.

set -euo pipefail
PROBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PROBE_ROOT

SYSTEM=""
while [ $# -gt 0 ]; do
	case "$1" in
		--system) SYSTEM="${2:-}"; shift 2 ;;
		*) echo "[sync-system] unknown arg: $1" >&2; exit 2 ;;
	esac
done
[ -n "$SYSTEM" ] || { echo "[sync-system] --system <name> required" >&2; exit 2; }

exec node "$PROBE_ROOT/bin/pw-rpa.mjs" sync --system "$SYSTEM"
