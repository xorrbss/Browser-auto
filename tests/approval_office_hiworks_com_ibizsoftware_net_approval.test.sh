#!/usr/bin/env bash
# tests/approval_office_hiworks_com_ibizsoftware_net_approval.test.sh - COMPILED from flows/approval_office_hiworks_com_ibizsoftware_net_approval.flow.json by bin/probe-record.sh.
# Edit the .flow.json and recompile, or edit here directly (then this becomes the source).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/approval_office_hiworks_com_ibizsoftware_net_approval.flow.json"
