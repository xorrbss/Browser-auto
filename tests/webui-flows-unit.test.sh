#!/usr/bin/env bash
# Browser-free contract test for webui/flows.js clicked-row resolver.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail(){ echo "  x webui-flows-unit: $1" >&2; exit 1; }

FLOW_NAME="_webui_row_index_unit_$$"
MISSING_NAME="_webui_missing_snapshot_unit_$$"
FALLBACK_NAME="_webui_field_value_unit_$$"
NO_FALLBACK_NAME="_webui_no_field_value_unit_$$"
HEADERLESS_NAME="_webui_headerless_row_unit_$$"
SCROLL_NAME="_webui_scroll_review_unit_$$"
SECRET_NAME="_webui_secret_values_unit_$$"
RECIPE_NAME="_webui_row_recipe_$$"
HEADERLESS_RECIPE_NAME="_webui_headerless_recipe_$$"
RUN_OLD="20990101-000000-$((100000 + $$))"
RUN_NEW="20990101-000000-$((100001 + $$))"
FLOW="$DIR/flows/${FLOW_NAME}.flow.json"
MISSING_FLOW="$DIR/flows/${MISSING_NAME}.flow.json"
FALLBACK_FLOW="$DIR/flows/${FALLBACK_NAME}.flow.json"
NO_FALLBACK_FLOW="$DIR/flows/${NO_FALLBACK_NAME}.flow.json"
HEADERLESS_FLOW="$DIR/flows/${HEADERLESS_NAME}.flow.json"
SCROLL_FLOW="$DIR/flows/${SCROLL_NAME}.flow.json"
SECRET_FLOW="$DIR/flows/${SECRET_NAME}.flow.json"
SECRET_VALUES="$DIR/flows/${SECRET_NAME}.values.json"
SNAP="$DIR/flows/${FLOW_NAME}.snapshot.txt"
HEADERLESS_SNAP="$DIR/flows/${HEADERLESS_NAME}.snapshot.txt"
RECIPE="$DIR/recipes/${RECIPE_NAME}.json"
HEADERLESS_RECIPE="$DIR/recipes/${HEADERLESS_RECIPE_NAME}.json"
ART_OLD="$DIR/artifacts/$RUN_OLD"
ART_NEW="$DIR/artifacts/$RUN_NEW"
trap 'rm -f "$FLOW" "$MISSING_FLOW" "$FALLBACK_FLOW" "$NO_FALLBACK_FLOW" "$HEADERLESS_FLOW" "$SCROLL_FLOW" "$SECRET_FLOW" "$SECRET_VALUES" "$SNAP" "$HEADERLESS_SNAP" "$RECIPE" "$HEADERLESS_RECIPE"; rm -rf "$ART_OLD" "$ART_NEW"' EXIT

cat > "$RECIPE" <<'JSON'
{
  "collection": { "name": "Tickets" },
  "key": "id",
  "columns": { "id": "id", "subject": "subject", "owner": "owner" }
}
JSON

cat > "$HEADERLESS_RECIPE" <<'JSON'
{
  "collection": { "name": "Tickets" },
  "key": "id",
  "columns": { "id": "id", "subject": "subject", "owner": "owner" },
  "columnIndexes": { "id": 0, "subject": 1, "owner": 2 }
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

cat > "$HEADERLESS_SNAP" <<'TREE'
- table "Tickets"
  - rowgroup
    - row
      - cell "id"
      - cell "subject"
      - cell "owner"
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
  "environment": "staging",
  "riskClass": "read",
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
  "environment": "staging",
  "riskClass": "read",
  "startUrl": "https://example.test/tickets",
  "steps": [
    { "kind": "find", "by": "label", "value": "Ticket", "action": "fill", "text": "{{input_1}}" }
  ],
  "asserts": []
}
JSON

cat > "$FALLBACK_FLOW" <<JSON
{
  "name": "$FALLBACK_NAME",
  "engine": "playwright",
  "environment": "staging",
  "riskClass": "read",
  "startUrl": "https://example.test/tickets",
  "steps": [
    {
      "kind": "find",
      "needs_review": true,
      "action": "click",
      "candidates": [
        { "by": "role", "value": "link", "name": "Slow page", "count": 1 },
        { "by": "text", "value": "Slow page", "count": 0 }
      ]
    }
  ],
  "asserts": []
}
JSON

cat > "$NO_FALLBACK_FLOW" <<JSON
{
  "name": "$NO_FALLBACK_NAME",
  "engine": "playwright",
  "environment": "staging",
  "riskClass": "read",
  "startUrl": "https://example.test/tickets",
  "steps": [
    {
      "kind": "find",
      "needs_review": true,
      "action": "click",
      "candidates": [
        { "by": "text", "value": "Edit", "count": 3 }
      ]
    }
  ],
  "asserts": []
}
JSON

cat > "$HEADERLESS_FLOW" <<JSON
{
  "name": "$HEADERLESS_NAME",
  "engine": "playwright",
  "environment": "staging",
  "riskClass": "read",
  "startUrl": "https://example.test/tickets",
  "steps": [
    {
      "kind": "find",
      "needs_review": true,
      "action": "click",
      "candidates": [
        { "by": "title", "value": "Slow page", "count": 1 }
      ]
    }
  ],
  "asserts": []
}
JSON

cat > "$SCROLL_FLOW" <<JSON
{
  "name": "$SCROLL_NAME",
  "engine": "playwright",
  "environment": "staging",
  "riskClass": "read",
  "startUrl": "https://example.test/tickets",
  "steps": [
    {
      "kind": "scroll",
      "needs_review": true,
      "unsupported": "container-scroll",
      "reason": "scrollable container gestures require a stable container locator and are not replayable as page scroll",
      "candidates": [],
      "recordedDir": "down",
      "recordedPx": 240
    },
    {
      "kind": "scroll",
      "needs_review": true,
      "unsupported": "container-scroll",
      "reason": "scrollable container gestures require a stable container locator and are not replayable as page scroll",
      "candidates": [
        { "by": "testid", "value": "scrollbox", "count": 1 }
      ],
      "recordedDir": "up",
      "recordedPx": 120
    },
    { "kind": "wait", "until": "text", "value": "Done" }
  ],
  "asserts": []
}
JSON

cat > "$SECRET_FLOW" <<JSON
{
  "name": "$SECRET_NAME",
  "engine": "playwright",
  "environment": "local",
  "riskClass": "read",
  "startUrl": "data:text/html,ok",
  "steps": [
    { "kind": "find", "by": "label", "value": "Password", "action": "fill", "text": "{{input_1}}" }
  ],
  "asserts": []
}
JSON
cat > "$SECRET_VALUES" <<'JSON'
{
  "input_1": "SECRET_PASSWORD_VALUE"
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
  { "name": "$MISSING_NAME", "status": "fail", "durationMs": 9, "reason": "locator timeout on Ticket password=hunter2", "artifacts": "artifacts/$RUN_NEW/$MISSING_NAME" }
]
JSON

FLOW_NAME="$FLOW_NAME" MISSING_NAME="$MISSING_NAME" FALLBACK_NAME="$FALLBACK_NAME" NO_FALLBACK_NAME="$NO_FALLBACK_NAME" HEADERLESS_NAME="$HEADERLESS_NAME" SCROLL_NAME="$SCROLL_NAME" SECRET_NAME="$SECRET_NAME" RECIPE_NAME="$RECIPE_NAME" HEADERLESS_RECIPE_NAME="$HEADERLESS_RECIPE_NAME" RUN_NEW="$RUN_NEW" node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
import { getFlow, listFlows, resolveClickedRecordStep, resolveStep } from './webui/flows.js';

const die = (m) => { console.error(m); process.exit(1); };

const ok = await resolveClickedRecordStep(process.env.FLOW_NAME, 0, process.env.RECIPE_NAME);
if (!ok.ok) die(`expected clicked-row resolve to pass, got: ${ok.error}`);
if (ok.rowIndex !== 1) die(`expected rowIndex=1 in API result, got ${ok.rowIndex}`);

const flow = JSON.parse(await readFile(`flows/${process.env.FLOW_NAME}.flow.json`, 'utf8'));
const step = flow.steps[0];
if (step.kind !== 'open_record') die(`expected open_record, got ${step.kind}`);
if (step.source !== 'row_index') die(`expected source=row_index, got ${step.source}`);
if (step.rowIndex !== 1) die(`expected persisted rowIndex=1, got ${step.rowIndex}`);

const fallback = await resolveClickedRecordStep(process.env.FALLBACK_NAME, 0, process.env.RECIPE_NAME);
if (!fallback.ok) die(`expected missing-snapshot field_value fallback to pass, got: ${fallback.error}`);
const fallbackFlow = JSON.parse(await readFile(`flows/${process.env.FALLBACK_NAME}.flow.json`, 'utf8'));
const fallbackStep = fallbackFlow.steps[0];
if (fallbackStep.source !== 'field_value') die(`expected source=field_value, got ${fallbackStep.source}`);
if (fallbackStep.field !== 'subject') die(`expected fallback field=subject, got ${fallbackStep.field}`);
if (fallbackStep.value !== 'Slow page') die(`expected fallback value=Slow page, got ${fallbackStep.value}`);

const noFallback = await resolveClickedRecordStep(process.env.NO_FALLBACK_NAME, 0, process.env.RECIPE_NAME);
if (noFallback.ok) die('expected missing snapshot without a unique captured value to fail');
if (!/missing snapshot/.test(noFallback.error || '') || !/capture-unique/.test(noFallback.error || '')) die(`missing snapshot fallback error was unclear: ${noFallback.error}`);

const headerless = await resolveClickedRecordStep(process.env.HEADERLESS_NAME, 0, process.env.HEADERLESS_RECIPE_NAME);
if (!headerless.ok) die(`expected headerless columnIndexes resolve to pass, got: ${headerless.error}`);
if (headerless.rowIndex !== 1) die(`expected headerless rowIndex=1, got ${headerless.rowIndex}`);
const headerlessFlow = JSON.parse(await readFile(`flows/${process.env.HEADERLESS_NAME}.flow.json`, 'utf8'));
if (headerlessFlow.steps[0].source !== 'row_index') die(`expected headerless source=row_index, got ${headerlessFlow.steps[0].source}`);

let scrollFlow = await getFlow(process.env.SCROLL_NAME);
const scrollReview = scrollFlow.needsReviewSteps[0];
if (scrollReview.kind !== 'scroll') die(`expected scroll review kind, got ${scrollReview.kind}`);
if (scrollReview.unsupported !== 'container-scroll') die(`expected container-scroll unsupported marker, got ${scrollReview.unsupported}`);
if (scrollReview.action !== null) die(`expected scroll review action=null, got ${scrollReview.action}`);
if (scrollReview.recordedDir !== 'down' || scrollReview.recordedPx !== 240) die('expected scroll review evidence metadata');
const scrollAsRecord = await resolveClickedRecordStep(process.env.SCROLL_NAME, 0, process.env.RECIPE_NAME);
if (scrollAsRecord.ok || !/only click steps/.test(scrollAsRecord.error || '')) die(`expected scroll open_record conversion to be refused, got ${JSON.stringify(scrollAsRecord)}`);
const scrollResolve = await resolveStep(process.env.SCROLL_NAME, 1, 0);
if (!scrollResolve.ok) die(`expected scroll container candidate resolve to pass, got ${scrollResolve.error}`);
scrollFlow = JSON.parse(await readFile(`flows/${process.env.SCROLL_NAME}.flow.json`, 'utf8'));
if (scrollFlow.steps.length !== 3 || scrollFlow.steps[0].needs_review !== true) die('container-scroll review must remain fail-closed until re-recorded or manually authored');
if (scrollFlow.steps[1].needs_review) die('resolved container scroll should no longer need review');
if (scrollFlow.steps[1].kind !== 'scroll' || scrollFlow.steps[1].container?.by !== 'testid' || scrollFlow.steps[1].container?.value !== 'scrollbox') die(`resolved container scroll has wrong shape: ${JSON.stringify(scrollFlow.steps[1])}`);
if (scrollFlow.steps[1].dir !== 'up' || scrollFlow.steps[1].px !== 120) die('resolved container scroll lost recorded direction/px');

const statusFlow = await getFlow(process.env.MISSING_NAME);
if (!statusFlow.missingValues.includes('input_1')) die('expected input_1 to be reported missing');
if (statusFlow.compiled !== false) die('expected missing flow to report compiled=false');
if (statusFlow.scenarioStatus.state !== 'missing-values') die(`expected missing-values state, got ${statusFlow.scenarioStatus.state}`);
if (!/missing values: input_1/.test(statusFlow.scenarioStatus.unrunnableReason || '')) die(`unclear unrunnable reason: ${statusFlow.scenarioStatus.unrunnableReason}`);
if (statusFlow.scenarioStatus.lastRun?.runId !== process.env.RUN_NEW) die(`expected newest run ${process.env.RUN_NEW}, got ${statusFlow.scenarioStatus.lastRun?.runId}`);
if (statusFlow.scenarioStatus.lastRun.status !== 'fail') die('expected newest run status=fail');
if (statusFlow.scenarioStatus.lastRun.runUrl !== `/api/runs/${process.env.RUN_NEW}`) die('expected safe runUrl link');
if (statusFlow.scenarioStatus.lastRun.reportUrl !== `/artifacts/${process.env.RUN_NEW}/report.json`) die('expected safe reportUrl link');
if (statusFlow.scenarioStatus.lastRun.artifactUrl !== `/artifacts/${process.env.RUN_NEW}/${process.env.MISSING_NAME}`) die(`expected safe per-test artifact link, got ${statusFlow.scenarioStatus.lastRun.artifactUrl}`);
if (statusFlow.scenarioStatus.lastFailureReason !== 'locator timeout on Ticket password=[redacted]') die(`expected sanitized failure reason, got ${statusFlow.scenarioStatus.lastFailureReason}`);

const listed = (await listFlows()).find((f) => f.name === process.env.MISSING_NAME);
if (!listed) die('expected status flow in listFlows()');
if (listed.scenarioStatus.lastRun?.runId !== process.env.RUN_NEW) die('expected listFlows() to include latest run status');

const secretFlow = await getFlow(process.env.SECRET_NAME);
if (JSON.stringify(secretFlow).includes('SECRET_PASSWORD_VALUE')) die('flow API leaked raw .values.json content');
if (secretFlow.valueStatus.input_1?.present !== true) die('flow API should expose value presence metadata');
if (secretFlow.values.input_1 !== '') die('flow API should not return stored secret value');
NODE

echo "  ok webui-flows-unit: clicked-row resolver and scenario status summaries work"
