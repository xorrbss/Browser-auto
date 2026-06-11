#!/usr/bin/env bash
# Browser-free unit checks for the local external-mode rehearsal wrapper.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$DIR"

bash -n bin/local-external-rehearsal.sh

OUT="$(WEBUI_LOCAL_EXTERNAL_DATA_DIR="$TMP/rehearsal" WEBUI_PORT=4399 bash bin/local-external-rehearsal.sh --check-config)"
[[ "$OUT" == *'"ok": true'* ]] || { echo "$OUT" >&2; exit 1; }
[[ "$OUT" == *'"mode": "external"'* ]] || { echo "$OUT" >&2; exit 1; }
[[ "$OUT" == *'"secretStore": "encrypted-local"'* ]] || { echo "$OUT" >&2; exit 1; }
[[ "$OUT" == *'"noVnc": "disabled"'* ]] || { echo "$OUT" >&2; exit 1; }
[[ "$OUT" == *'"auditSink": "jsonl"'* ]] || { echo "$OUT" >&2; exit 1; }

PRINT="$(WEBUI_LOCAL_EXTERNAL_DATA_DIR="$TMP/rehearsal" WEBUI_PORT=4399 bash bin/local-external-rehearsal.sh --print-env)"
[[ "$PRINT" == *'http://127.0.0.1:4399'* ]] || { echo "$PRINT" >&2; exit 1; }
[[ "$PRINT" == *'Authorization: Bearer operator00000001'* ]] || { echo "$PRINT" >&2; exit 1; }
[[ "$PRINT" == *'WEBUI_RUNNER_API_AUTH_TOKEN=operator00000001'* ]] || { echo "$PRINT" >&2; exit 1; }
[[ "$PRINT" == *'node bin/runner-worker.mjs --api http://127.0.0.1:4399/api/runner'* ]] || { echo "$PRINT" >&2; exit 1; }

if WEBUI_LOCAL_EXTERNAL_DATA_DIR="$TMP/bad" NOVNC_DISABLE=0 bash bin/local-external-rehearsal.sh --check-config >"$TMP/bad.out" 2>&1; then
	echo "local external rehearsal accepted enabled noVNC" >&2
	exit 1
fi
BAD="$(cat "$TMP/bad.out")"
[[ "$BAD" == *'NOVNC_DISABLE=1 is required'* ]] || { echo "$BAD" >&2; exit 1; }

echo "  local-external-rehearsal-unit: all checks passed"
