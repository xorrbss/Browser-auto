#!/usr/bin/env bash
# tests/login.test.sh - COMPILED from flows/login.flow.json by bin/probe-record.sh.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/login.flow.json"
