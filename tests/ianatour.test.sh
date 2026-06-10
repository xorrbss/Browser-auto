#!/usr/bin/env bash
# tests/ianatour.test.sh - COMPILED from flows/ianatour.flow.json by bin/probe-record.sh.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/ianatour.flow.json"
