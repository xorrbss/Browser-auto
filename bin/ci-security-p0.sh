#!/usr/bin/env bash
# Fixture-only CI lane for the P0 security gate.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

AQA_PREFLIGHT_MANUAL=1
AQA_PREFLIGHT_ENTRYPOINT="bin/ci-security-p0.sh"
source "$ROOT/lib/preflight.sh"
preflight_require_core_tools
preflight_require_fixture_lane "ci-security-p0"

cd "$ROOT"
exec bash tests/security-p0-gate.test.sh
