#!/usr/bin/env bash
# Slow local fixture CI lane. Runs only localhost/file-backed RPA fixtures.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

AQA_PREFLIGHT_MANUAL=1
AQA_PREFLIGHT_ENTRYPOINT="bin/ci-slow-fixture.sh"
source "$ROOT/lib/preflight.sh"
preflight_require_core_tools
preflight_require_fixture_lane "ci-slow-fixture"

cd "$ROOT"
bash tests/rpa-fixture-e2e.test.sh
bash tests/rpa-local-fixture-e2e.test.sh
