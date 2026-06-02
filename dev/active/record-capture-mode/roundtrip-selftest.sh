#!/usr/bin/env bash
# Phase 3 round-trip self-test (no human): drive capture() with synthetic clicks, then
# build-flow -> compile -> run.sh must be green. Uses AQA_CAPTURE_SESSION/SECONDS hooks.
set -u
export PATH="/c/Users/dream/AppData/Roaming/npm:$PATH"
cd /c/project/agent-qa || exit 1
SESS=aqaselftest
NAME=aqaselftest

# clean prior artifacts
rm -f "flows/${NAME}.flow.json" "flows/${NAME}.values.json" "tests/${NAME}.test.sh"
agent-browser --session "$SESS" close >/dev/null 2>&1 </dev/null || true

# warm the daemon (file redirect, never a pipe -> no cold-spawn fd hang)
agent-browser --session warm open about:blank >/dev/null 2>&1 </dev/null || true

# launch capture() in background: auto-stop after 15s, fixed session
AQA_CAPTURE_SESSION="$SESS" AQA_CAPTURE_SECONDS=15 \
  bash bin/probe-record.sh capture "$NAME" "https://example.com/" >/tmp/aqa_cap.out 2>&1 &
CAPPID=$!

# wait for the injected listener to be live on the capture session
ready=false
for i in $(seq 1 40); do
  r="$(agent-browser --session "$SESS" eval --json "window.__aqaInstalled===true" 2>/dev/null </dev/null)"
  if [ "$(printf '%s' "$r" | jq -r '.data.result // false' 2>/dev/null)" = "true" ]; then ready=true; break; fi
  sleep 0.5
done
echo "listener ready: $ready"

# drive a real (CDP) click on a stable, non-navigating element
agent-browser --session "$SESS" click "h1" >/dev/null 2>&1 </dev/null || true
sleep 1

# let capture() auto-stop, drain, and build the flow
wait "$CAPPID"
echo "=== capture() output ==="; cat /tmp/aqa_cap.out

echo "=== flows/${NAME}.flow.json ==="
cat "flows/${NAME}.flow.json" 2>/dev/null || { echo "NO FLOW PRODUCED"; exit 1; }

echo "=== compile ==="
bash bin/probe-record.sh compile "flows/${NAME}.flow.json" || { echo "COMPILE FAILED (needs_review?)"; exit 1; }

echo "=== run.sh ${NAME} (round-trip replay) ==="
bash run.sh "$NAME"
echo "run.sh exit=$?"
