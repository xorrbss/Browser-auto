#!/usr/bin/env bash
# lib/preflight.sh - lightweight environment gate for the test suite.
#
# The CI runner no longer owns a browser service or video pipeline, so this
# preflight intentionally avoids browser startup, ffmpeg probing, and warmup.
# It only checks tools required by the current shell/unit test gate.

set -euo pipefail

PROBE_ROOT="${PROBE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export PROBE_ROOT

for tool in jq node; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "[preflight] FATAL: required tool '$tool' was not found on PATH." >&2
		exit 1
	fi
done

echo "[preflight] OK."
