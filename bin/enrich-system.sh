#!/usr/bin/env bash
# bin/enrich-system.sh - Playwright-only per-record detail enrichment wrapper.

set -euo pipefail
PROBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PROBE_ROOT

SYSTEM=""; LIMIT=0; KEY=""
while [ $# -gt 0 ]; do
	case "$1" in
		--system) SYSTEM="${2:-}"; shift 2 ;;
		--limit) LIMIT="${2:-0}"; shift 2 ;;
		--key) KEY="${2:-}"; shift 2 ;;
		*) echo "[enrich-system] unknown arg: $1" >&2; exit 2 ;;
	esac
done
[ -n "$SYSTEM" ] || { echo "[enrich-system] --system <name> required" >&2; exit 2; }

args=(enrich --system "$SYSTEM")
[ "${LIMIT:-0}" != 0 ] && args+=(--limit "$LIMIT")
[ -n "${KEY:-}" ] && args+=(--key "$KEY")
exec node "$PROBE_ROOT/bin/pw-rpa.mjs" "${args[@]}"
