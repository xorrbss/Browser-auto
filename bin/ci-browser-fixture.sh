#!/usr/bin/env bash
# Local browser fixture CI lane. This must not require auth, OTP, or non-local targets.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

AQA_PREFLIGHT_MANUAL=1
AQA_PREFLIGHT_ENTRYPOINT="bin/ci-browser-fixture.sh"
source "$ROOT/lib/preflight.sh"
preflight_require_core_tools
preflight_require_fixture_lane "ci-browser-fixture"

cd "$ROOT"
exec bash tests/play-flow-smoke.test.sh
