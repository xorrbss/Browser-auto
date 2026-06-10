#!/usr/bin/env bash
# Browser-free contract test for webui/flows.js clicked-row resolver.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail(){ echo "  x webui-flows-unit: $1" >&2; exit 1; }

FLOW_NAME="_webui_row_index_unit_$$"
MISSING_NAME="_webui_missing_snapshot_unit_$$"
RECIPE_NAME="_webui_row_recipe_$$"
RUN_OLD="20990101-000000-$((100000 + $$))"
RUN_NEW="20990101-000000-$((100001 + $$))"
FLOW="$DIR/flows/${FLOW_NAME}.flow.json"
MISSING_FLOW="$DIR/flows/${MISSING_NAME}.flow.json"
SNAP="$DIR/flows/${FLOW_NAME}.snapshot.txt"
RECIPE="$DIR/recipes/${RECIPE_NAME}.json"
ART_OLD="$DIR/artifacts/$RUN_OLD"
ART_NEW="$DIR/artifacts/$RUN_NEW"
trap 'rm -f "$FLOW" "$MISSING_FLOW" "$SNAP" "$RECIPE"; rm -rf "$ART_OLD" "$ART_NEW"' EXIT

cat > "$RECIPE" <<'JSON'
{
  "collection": { "name": "Tickets" },
  "key": "id",
  "columns": { "id": "id", "subject": "subject", "owner": "owner" }
}
JSON

cat > "$SNAP" <<'TREE'
- table "Tickets"
  - rowgroup
    - row
      - columnheader "id"
      - columnheader "subject"
      - columnheader "owner"
    - row
      - cell "T-1"
      - cell "Login bug"
      - cell "Alice"
    - row
      - cell "T-2"
      - cell "Slow page"
      - cell "Bob"
TREE

cat > "$FLOW" <<JSON
{
  "name": "$FLOW_NAME",
  "engine": "playwright",
  "startUrl": "https://example.test/tickets",
  "steps": [
    {
      "kind": "find",
      "needs_review": true,
      "action": "click",
      "candidates": [
        { "by": "title", "value": "Slow page" }
      ]
    }
  ],
  "asserts": []
}
JSON

cat > "$MISSING_FLOW" <<JSON
{
  "name": "$MISSING_NAME",
  "engine": "playwright",
  "startUrl": "https://example.test/tickets",
  "steps": [
    { "kind": "find", "by": "label", "value": "Ticket", "action": "fill", "text": "{{input_1}}" }
  ],
  "asserts": []
}
JSON

mkdir -p "$ART_OLD" "$ART_NEW"
cat > "$ART_OLD/report.json" <<JSON
[
  { "name": "$MISSING_NAME", "status": "pass", "durationMs": 7 }
]
JSON
cat > "$ART_NEW/report.json" <<JSON
[
  { "name": "$MISSING_NAME", "status": "fail", "durationMs": 9, "reason": "locator timeout on Ticket" }
]
JSON

FLOW_NAME="$FLOW_NAME" MISSING_NAME="$MISSING_NAME" RECIPE_NAME="$RECIPE_NAME" RUN_NEW="$RUN_NEW" node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
import { getFlow, listFlows, resolveClickedRecordStep } from './webui/flows.js';

const die = (m) => { console.error(m); process.exit(1); };

const ok = await resolveClickedRecordStep(process.env.FLOW_NAME, 0, process.env.RECIPE_NAME);
if (!ok.ok) die(`expected clicked-row resolve to pass, got: ${ok.error}`);
if (ok.rowIndex !== 1) die(`expected rowIndex=1 in API result, got ${ok.rowIndex}`);

const flow = JSON.parse(await readFile(`flows/${process.env.FLOW_NAME}.flow.json`, 'utf8'));
const step = flow.steps[0];
if (step.kind !== 'open_record') die(`expected open_record, got ${step.kind}`);
if (step.source !== 'row_index') die(`expected source=row_index, got ${step.source}`);
if (step.rowIndex !== 1) die(`expected persisted rowIndex=1, got ${step.rowIndex}`);

const missing = await resolveClickedRecordStep(process.env.MISSING_NAME, 0, process.env.RECIPE_NAME);
if (missing.ok) die('expected missing snapshot resolve to fail');
if (!/missing snapshot/.test(missing.error || '')) die(`missing snapshot error was unclear: ${missing.error}`);

const statusFlow = await getFlow(process.env.MISSING_NAME);
if (!statusFlow.missingValues.includes('input_1')) die('expected input_1 to be reported missing');
if (statusFlow.compiled !== false) die('expected missing flow to report compiled=false');
if (statusFlow.scenarioStatus.state !== 'missing-values') die(`expected missing-values state, got ${statusFlow.scenarioStatus.state}`);
if (!/missing values: input_1/.test(statusFlow.scenarioStatus.unrunnableReason || '')) die(`unclear unrunnable reason: ${statusFlow.scenarioStatus.unrunnableReason}`);
if (statusFlow.scenarioStatus.lastRun?.runId !== process.env.RUN_NEW) die(`expected newest run ${process.env.RUN_NEW}, got ${statusFlow.scenarioStatus.lastRun?.runId}`);
if (statusFlow.scenarioStatus.lastRun.status !== 'fail') die('expected newest run status=fail');
if (statusFlow.scenarioStatus.lastRun.runUrl !== `/api/runs/${process.env.RUN_NEW}`) die('expected safe runUrl link');
if (statusFlow.scenarioStatus.lastRun.reportUrl !== `/artifacts/${process.env.RUN_NEW}/report.json`) die('expected safe reportUrl link');
if (statusFlow.scenarioStatus.lastFailureReason !== 'locator timeout on Ticket') die(`expected explicit failure reason, got ${statusFlow.scenarioStatus.lastFailureReason}`);

const listed = (await listFlows()).find((f) => f.name === process.env.MISSING_NAME);
if (!listed) die('expected status flow in listFlows()');
if (listed.scenarioStatus.lastRun?.runId !== process.env.RUN_NEW) die('expected listFlows() to include latest run status');
NODE

echo "  ok webui-flows-unit: clicked-row resolver and scenario status summaries work"
