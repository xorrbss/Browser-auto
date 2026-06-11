#!/usr/bin/env bash
# Tiny deterministic fixture used by the local external-mode server+runner smoke.
set -euo pipefail

echo 'AQA_JOB_RESULT={"status":"ok","fixture":"local-external-smoke"}'
echo 'local external smoke fixture passed'
