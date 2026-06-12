#!/usr/bin/env bash
# Local-only external-mode E2E: WebUI server + authenticated runner API + outbound runner worker.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

(
	cd "$DIR"
	NODE_NO_WARNINGS=1 AQA_LOCAL_EXTERNAL_SMOKE_TIMEOUT_MS=90000 node bin/local-external-runner-smoke.mjs >/dev/null
)

echo "  local-external-runner-e2e: all checks passed"
