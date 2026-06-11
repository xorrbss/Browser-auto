#!/usr/bin/env bash
# Documentation-only lane guard. Operator-only work must be started by a human, never CI.
set -euo pipefail

echo "ci-operator-only-guard: refused: operator-only live/non-local lanes are not automated" >&2
echo "ci-operator-only-guard: see dev/active/live-readiness/RUNBOOK.md for the human-run checklist" >&2
exit 1
