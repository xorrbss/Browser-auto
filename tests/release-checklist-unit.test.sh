#!/usr/bin/env bash
# Browser-free unit for the release handoff checklist CLI.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/aqa-release-checklist.XXXXXX")"
cleanup() {
	rm -rf "$TMPROOT"
}
trap cleanup EXIT

to_node_path() {
	if command -v cygpath >/dev/null 2>&1; then
		cygpath -m "$1"
	else
		printf '%s' "$1"
	fi
}

REPO="$TMPROOT/repo"
mkdir -p "$REPO"
git init -q "$REPO"
git -C "$REPO" config user.email release-checklist@example.invalid
git -C "$REPO" config user.name "Release Checklist Test"

printf 'clean baseline\n' > "$REPO/tracked.txt"
git -C "$REPO" add tracked.txt
git -C "$REPO" commit -q -m init

printf 'changed baseline\nTOPSECRET_DIRTY_VALUE\n' > "$REPO/tracked.txt"
printf 'untracked TOKEN_SHOULD_NOT_APPEAR\n' > "$REPO/scratch-note.txt"

RUN_ID="20990101-010101-123"
ART="$REPO/artifacts/$RUN_ID"
mkdir -p "$ART"
printf '[{"name":"login","status":"pass","cookie":"COOKIE_SECRET_SHOULD_NOT_APPEAR"}]\n' > "$ART/report.json"
printf '<testsuite secret="JUNIT_SECRET_SHOULD_NOT_APPEAR"></testsuite>\n' > "$ART/report.junit.xml"
printf 'login\tpass\tRESULTS_SECRET_SHOULD_NOT_APPEAR\n' > "$ART/results.tsv"

READINESS="$TMPROOT/readiness.json"
cat > "$READINESS" <<'JSON'
{
  "decision": "No-Go",
  "state": "no-go",
  "document": "dev/active/productization/P0-SERVICE-OPEN.md",
  "total": 4,
  "checked": 1,
  "open": 3,
  "blockers": [
    { "section": "P0-A", "text": "Require login for every route" }
  ],
  "matrix": [
    {
      "id": "P0-A",
      "title": "Auth",
      "status": "contract-only",
      "checklist": { "total": 2, "checked": 1, "open": 1 },
      "implemented": ["external auth gate"],
      "contractOnly": ["claim/header mapping validation"],
      "externalBlocked": ["real IdP/SSO login"],
      "releaseBlocking": true
    },
    {
      "id": "P0-F",
      "title": "Durable Jobs",
      "status": "contract-only",
      "checklist": { "total": 2, "checked": 0, "open": 2 },
      "implemented": ["SQLite job states"],
      "contractOnly": ["audit outbox metadata"],
      "externalBlocked": ["production audit webhook connector"],
      "releaseBlocking": true
    }
  ],
  "releaseChecklist": {
    "decision": "No-Go",
    "requiredCommands": [
      "node --check <repo js/mjs/cjs>",
      "bash tests/security-p0-gate.test.sh",
      "bash run.sh"
    ],
    "ciLanes": [
      {
        "id": "security-p0-gate",
        "label": "Security P0 Gate",
        "command": "bash tests/security-p0-gate.test.sh",
        "ciAllowed": true,
        "liveAuthAllowed": false,
        "nonLocalAllowed": false,
        "liveActionAllowed": false
      },
      {
        "id": "operator-only",
        "label": "Operator-Only Live/Non-Local Lane",
        "command": "operator-approved named flow only",
        "ciAllowed": false,
        "ciBlockedReason": "requires operator-owned auth/target allowlist and may contact non-local systems",
        "liveAuthAllowed": true,
        "nonLocalAllowed": true,
        "liveActionAllowed": false
      }
    ],
    "ciBlockedLanes": [
      {
        "id": "operator-only",
        "reason": "requires operator-owned auth/target allowlist and may contact non-local systems"
      }
    ],
    "operatorOnlyLaneBlockedInCi": true,
    "openSections": ["P0-A"],
    "contractOnly": ["P0-A"],
    "externalBlocked": ["P0-F"],
    "missingEvidence": [
      {
        "section": "P0-A",
        "category": "contract-only",
        "item": "claim/header mapping validation",
        "requiredCommand": "bash tests/webui-auth-context-unit.test.sh",
        "currentEvidence": "local deterministic contract/preflight coverage only",
        "requiredEvidence": "owner-reviewed deployment acceptance evidence",
        "blockerReason": "P0-A remains contract-only until deployment acceptance evidence exists"
      },
      {
        "section": "P0-F",
        "category": "external-blocked",
        "item": "production audit webhook connector",
        "requiredCommand": "operator-owned webhook acceptance evidence",
        "currentEvidence": "no local fixture can prove production webhook delivery",
        "requiredEvidence": "deployed webhook delivery audit",
        "blockerReason": "P0-F remains externally blocked until webhook delivery evidence exists"
      }
    ]
  }
}
JSON

REPO_NODE="$(to_node_path "$REPO")"
READINESS_NODE="$(to_node_path "$READINESS")"
REPORT_NODE="$(to_node_path "$ART/report.json")"
REPORT_REL="artifacts/$RUN_ID/report.json"
JUNIT_REL="artifacts/$RUN_ID/report.junit.xml"
RESULTS_REL="artifacts/$RUN_ID/results.tsv"

META_PASS="$TMPROOT/run-metadata-pass.json"
cat > "$META_PASS" <<JSON
{
  "runId": "$RUN_ID",
  "status": "pass",
  "deterministic": true,
  "paths": {
    "reportJson": "$REPORT_REL",
    "junitXml": "$JUNIT_REL",
    "resultsTsv": "$RESULTS_REL"
  },
  "summary": {
    "total": 3,
    "passed": 3,
    "failed": 0,
    "durationMs": 42
  }
}
JSON

META_FAIL="$TMPROOT/run-metadata-fail.json"
cat > "$META_FAIL" <<JSON
{
  "runId": "$RUN_ID",
  "status": "fail",
  "deterministic": true,
  "summaryPath": "$REPORT_REL",
  "summary": {
    "total": 3,
    "passed": 2,
    "failed": 1
  }
}
JSON

OUT_JSON="$TMPROOT/handoff.json"
node "$DIR/bin/release-checklist.mjs" \
	--repo "$REPO_NODE" \
	--readiness "$READINESS_NODE" \
	--test-metadata "$(to_node_path "$META_PASS")" \
	--format json > "$OUT_JSON"

OUT_JSON_NODE="$(to_node_path "$OUT_JSON")" node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const out = JSON.parse(readFileSync(process.env.OUT_JSON_NODE, 'utf8'));
assert.equal(out.generator, 'release-checklist/v1');
assert.equal(out.decision, 'No-Go', 'blockers force No-Go');
assert.equal(out.operatorOnlyLaneBlockedInCi, true, 'operator-only lane is CI blocked');
assert(out.ciBlockedLanes.some((lane) => lane.id === 'operator-only'), 'CI blocked lanes include operator-only');
assert(out.requiredLocalCommands.includes('node --check bin/release-checklist.mjs'), 'CLI syntax check is required');
assert(out.requiredLocalCommands.includes('bash tests/release-checklist-unit.test.sh'), 'new unit test is required');
assert(out.requiredLocalCommands.includes('bash tests/security-p0-gate.test.sh'), 'P0 gate command is required');
assert(out.requiredLocalCommands.includes('bash run.sh'), 'deterministic suite command is required');
assert(out.requiredLocalCommands.includes('bash tests/webui-auth-context-unit.test.sh'), 'local evidence command is included');
assert(out.requiredEvidence.some((item) => item.section === 'P0-A' && item.category === 'contract-only'), 'contract-only required evidence is included');
assert(out.requiredEvidence.some((item) => item.section === 'P0-F' && item.category === 'external-blocked'), 'external-blocked required evidence is included');
assert.equal(out.lastRun.runId, '20990101-010101-123');
assert.equal(out.lastRun.summaryPath, 'artifacts/20990101-010101-123/report.json');
assert.equal(out.lastRun.rawContentsRead, false, 'raw artifact contents are not read');
assert.equal(out.lastRun.summary.failed, 0, 'metadata summary is preserved');
assert.equal(out.dirtyWorktree.dirty, true, 'dirty worktree is summarized');
assert(out.dirtyWorktree.counts.modified >= 1, 'modified count is included');
assert(out.dirtyWorktree.counts.untracked >= 1, 'untracked count is included');
assert(out.blockers.some((b) => b.type === 'p0-contract-only' && b.section === 'P0-A'), 'contract-only blocker is present');
assert(out.blockers.some((b) => b.type === 'p0-external-blocked' && b.section === 'P0-F'), 'external blocker is present');
assert(out.blockers.some((b) => b.type === 'p0-contract-evidence-missing' && b.requiredCommand === 'bash tests/webui-auth-context-unit.test.sh'), 'contract-only evidence blocker carries command');
assert(out.blockers.some((b) => b.type === 'p0-external-evidence-missing' && /webhook/.test(b.blockerReason)), 'external evidence blocker carries reason');
assert(out.blockers.some((b) => b.type === 'dirty-worktree'), 'dirty worktree blocker is present');
const serialized = JSON.stringify(out);
assert(!serialized.includes('TOPSECRET_DIRTY_VALUE'), 'dirty file contents are not exposed');
assert(!serialized.includes('TOKEN_SHOULD_NOT_APPEAR'), 'untracked file contents are not exposed');
assert(!serialized.includes('COOKIE_SECRET_SHOULD_NOT_APPEAR'), 'report content is not exposed');
assert(!serialized.includes('JUNIT_SECRET_SHOULD_NOT_APPEAR'), 'JUnit content is not exposed');
assert(!serialized.includes('RESULTS_SECRET_SHOULD_NOT_APPEAR'), 'results content is not exposed');
NODE

OUT_MD="$TMPROOT/handoff.md"
node "$DIR/bin/release-checklist.mjs" \
	--repo "$REPO_NODE" \
	--readiness "$READINESS_NODE" \
	--format markdown > "$OUT_MD"

grep -q 'Decision: No-Go' "$OUT_MD"
grep -q '## Required Evidence' "$OUT_MD"
grep -q 'P0-A contract-only' "$OUT_MD"
grep -q 'P0-F external-blocked' "$OUT_MD"
grep -q 'CI blocked' "$OUT_MD"
grep -q '## Dirty Worktree' "$OUT_MD"
grep -q 'Status: metadata-only' "$OUT_MD"
grep -q "Summary path: \`artifacts/$RUN_ID/report.json\`" "$OUT_MD"
if grep -q 'COOKIE_SECRET_SHOULD_NOT_APPEAR' "$OUT_MD"; then
	echo "  release-checklist-unit: markdown leaked raw report contents" >&2
	exit 1
fi
if grep -q 'TOPSECRET_DIRTY_VALUE' "$OUT_MD"; then
	echo "  release-checklist-unit: markdown leaked dirty file contents" >&2
	exit 1
fi

OUT_FAIL="$TMPROOT/handoff-fail.json"
node "$DIR/bin/release-checklist.mjs" \
	--repo "$REPO_NODE" \
	--readiness "$READINESS_NODE" \
	--test-metadata "$(to_node_path "$META_FAIL")" \
	--format json > "$OUT_FAIL"

OUT_FAIL_NODE="$(to_node_path "$OUT_FAIL")" node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const out = JSON.parse(readFileSync(process.env.OUT_FAIL_NODE, 'utf8'));
assert.equal(out.decision, 'No-Go');
assert(out.blockers.some((b) => b.type === 'last-run-failed'), 'failed deterministic metadata blocks handoff');
NODE

if node "$DIR/bin/release-checklist.mjs" \
	--repo "$REPO_NODE" \
	--readiness "$READINESS_NODE" \
	--test-metadata "$REPORT_NODE" \
	--format json > "$TMPROOT/raw-report-out.json" 2> "$TMPROOT/raw-report-err.txt"; then
	echo "  release-checklist-unit: raw report.json was accepted as metadata" >&2
	exit 1
fi
grep -q 'refusing to read raw artifact file as metadata' "$TMPROOT/raw-report-err.txt"

( cd "$DIR" && REPO_NODE="$REPO_NODE" node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { buildReleaseHandoff } from './bin/release-checklist.mjs';

const handoff = await buildReleaseHandoff({
	repoRoot: process.env.REPO_NODE,
	now: '2099-01-01T00:00:00.000Z',
	readiness: {
		decision: 'Review Required',
		matrix: [],
		releaseChecklist: {
			ciLanes: [{ id: 'operator-only', label: 'Operator Only', ciAllowed: true }],
			requiredCommands: [],
		},
	},
	testMetadata: {
		runId: '20990101-010101-123',
		status: 'pass',
		deterministic: true,
		summaryPath: 'artifacts/20990101-010101-123/report.json',
		summary: { total: 1, passed: 1, failed: 0 },
	},
	dirtyWorktree: {
		available: true,
		dirty: false,
		counts: { total: 0, staged: 0, modified: 0, untracked: 0, deleted: 0, renamed: 0, conflicted: 0 },
		entries: [],
	},
});
assert.equal(handoff.decision, 'No-Go', 'operator-only CI allowance is a blocker');
assert(handoff.blockers.some((b) => b.type === 'operator-only-ci'), 'operator-only CI blocker is reported');
NODE
)

echo "  release-checklist-unit: release checklist handoff is metadata-only and fail-closed"
