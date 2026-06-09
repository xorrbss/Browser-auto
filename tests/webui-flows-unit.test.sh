#!/usr/bin/env bash
# Browser-free contract test for webui/flows.js clicked-row resolver.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail(){ echo "  x webui-flows-unit: $1" >&2; exit 1; }

FLOW_NAME="_webui_row_index_unit_$$"
MISSING_NAME="_webui_missing_snapshot_unit_$$"
RECIPE_NAME="_webui_row_recipe_$$"
FLOW="$DIR/flows/${FLOW_NAME}.flow.json"
MISSING_FLOW="$DIR/flows/${MISSING_NAME}.flow.json"
SNAP="$DIR/flows/${FLOW_NAME}.snapshot.txt"
RECIPE="$DIR/recipes/${RECIPE_NAME}.json"
trap 'rm -f "$FLOW" "$MISSING_FLOW" "$SNAP" "$RECIPE"' EXIT

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
  "engine": "agent-browser",
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
  "engine": "agent-browser",
  "startUrl": "https://example.test/tickets",
  "steps": [
    { "kind": "find", "by": "title", "value": "T-1", "action": "click" }
  ],
  "asserts": []
}
JSON

FLOW_NAME="$FLOW_NAME" MISSING_NAME="$MISSING_NAME" RECIPE_NAME="$RECIPE_NAME" node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
import { resolveClickedRecordStep } from './webui/flows.js';

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
NODE

echo "  ok webui-flows-unit: clicked-row resolver persists rowIndex and fails without snapshot"
