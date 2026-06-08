#!/usr/bin/env bash
# tests/agent-isolation-unit.test.sh — STRUCTURAL safety pin (DESIGN I3): the natural-language / classify
# layer (webui/agent.js + the /api/agent routing in webui/routes-rpa.js) has NO path to the effectful approve
# EXECUTION. The on-prem model only CLASSIFIES (sync / summarize / query / approve-candidates / review-prepare);
# it can NEVER reach the approve leaf or the approve route. The ONLY approve execution is POST /api/approve/run
# in webui/routes-approve.js, reached by the human's "선택 항목 결재" click — never by the model. A future edit
# that wired the model onto the approve path (or passed --live from the NL layer) FAILS this test. The 'review'
# composite intent only PREPARES the human checkbox surface (sync/summarize), so it must also stay clean.
# Browser-free, deterministic; part of the run.sh gate.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail=0

# The NL/classify modules must not reference the approve execution path in any form.
FORBIDDEN='routes-approve|approve-run|approvePost|nodeLeaf|/api/approve|--live'
for f in webui/agent.js webui/routes-rpa.js; do
	if grep -nE "$FORBIDDEN" "$DIR/$f" >/dev/null 2>&1; then
		echo "  ✗ agent-isolation: $f references the approve EXECUTION path (DESIGN I3 — the model must never reach approve):"
		grep -nE "$FORBIDDEN" "$DIR/$f" | sed 's/^/      /'
		fail=1
	fi
done

# The 'approve' NL intent must remain CANDIDATES-ONLY (a read query), never execution.
if ! grep -nE "action === 'approve'.*runQuery" "$DIR/webui/routes-rpa.js" >/dev/null 2>&1; then
	echo "  ✗ agent-isolation: the /api/agent 'approve' intent is not candidates-only (runQuery) in routes-rpa.js"
	fail=1
fi

# The 'review' NL intent must only PREPARE (enqueue a read/summarize job) — never an approve job.
if grep -nE "action === 'review'" "$DIR/webui/routes-rpa.js" >/dev/null 2>&1; then
	if grep -nE "kind: ?'approve'" "$DIR/webui/routes-rpa.js" >/dev/null 2>&1; then
		echo "  ✗ agent-isolation: the 'review' intent path enqueues an approve job — must only sync/summarize"
		fail=1
	fi
fi

if [ "$fail" -eq 0 ]; then echo "  ✓ agent-isolation: NL/classify layer has no path to approve execution (DESIGN I3 holds)"; fi
exit "$fail"
