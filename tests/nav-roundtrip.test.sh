#!/usr/bin/env bash
# tests/nav-roundtrip.test.sh - COMPILED from flows/nav-roundtrip.flow.json by bin/probe-record.sh.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/nav-roundtrip.flow.json"
