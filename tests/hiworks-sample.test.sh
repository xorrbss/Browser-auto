#!/usr/bin/env bash
# tests/hiworks-sample.test.sh - COMPILED from flows/hiworks-sample.flow.json by bin/probe-record.sh.
# Edit the .flow.json and recompile, or edit here directly (then this becomes the source).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/hiworks-sample.flow.json"
