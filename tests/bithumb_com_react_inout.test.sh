#!/usr/bin/env bash
# tests/bithumb_com_react_inout.test.sh - COMPILED from flows/bithumb_com_react_inout.flow.json by bin/probe-record.sh.
# Edit the .flow.json and recompile, or edit here directly (then this becomes the source).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/bithumb_com_react_inout.flow.json"
