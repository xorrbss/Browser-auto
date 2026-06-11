#!/usr/bin/env bash
# Browser-free unit tests for the static blocked-flow reporter.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail(){ echo "  blocked-flow-report-unit: $1" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/flows"
mkdir -p "$TMP/fixtures/auth/playwright"

cat > "$TMP/fixtures/auth/playwright/readyapp.state.json" <<'JSON'
{ "cookies": [{ "name": "session", "value": "AUTH_SECRET_SHOULD_NOT_LEAK" }], "origins": [] }
JSON

cat > "$TMP/fixtures/auth/playwright/staleapp.state.json" <<'JSON'
{ "cookies": [{ "name": "session", "value": "STALE_AUTH_SECRET_SHOULD_NOT_LEAK" }], "origins": [] }
JSON

cat > "$TMP/flows/local-ok.flow.json" <<'JSON'
{
  "name": "local-ok",
  "engine": "playwright",
  "environment": "local",
  "riskClass": "read",
  "startUrl": "data:text/html,ok",
  "steps": [
    { "kind": "find", "by": "text", "value": "OK", "action": "hover" }
  ],
  "asserts": []
}
JSON

cat > "$TMP/flows/operator-read.flow.json" <<'JSON'
{
  "name": "operator-read",
  "engine": "playwright",
  "environment": "live-readonly",
  "riskClass": "read",
  "app": "readyapp",
  "startUrl": "https://example.test/path?token=SHOULD_NOT_LEAK#frag",
  "steps": [
    { "kind": "find", "by": "text", "value": "Example", "action": "hover" }
  ],
  "asserts": []
}
JSON

cat > "$TMP/flows/live-readonly-submit.flow.json" <<'JSON'
{
  "name": "live-readonly-submit",
  "engine": "playwright",
  "environment": "live-readonly",
  "riskClass": "read",
  "startUrl": "https://example.test/form?password=SHOULD_NOT_LEAK",
  "steps": [
    { "kind": "find", "by": "role", "value": "button", "name": "Submit", "action": "click" }
  ],
  "asserts": []
}
JSON

cat > "$TMP/flows/stale-auth.flow.json" <<'JSON'
{
  "name": "stale-auth",
  "engine": "playwright",
  "environment": "live-readonly",
  "riskClass": "read",
  "app": "staleapp",
  "startUrl": "https://stale-auth.example.test/path?token=SHOULD_NOT_LEAK",
  "steps": [
    { "kind": "find", "by": "text", "value": "Example", "action": "hover" }
  ],
  "asserts": []
}
JSON

cat > "$TMP/flows/missing-auth.flow.json" <<'JSON'
{
  "name": "missing-auth",
  "engine": "playwright",
  "environment": "live-readonly",
  "riskClass": "read",
  "app": "missingapp",
  "startUrl": "https://missing-auth.example.test/path?token=SHOULD_NOT_LEAK",
  "steps": [
    { "kind": "find", "by": "text", "value": "Example", "action": "hover" }
  ],
  "asserts": []
}
JSON

cat > "$TMP/flows/invalid-engine-bad.flow.json" <<'JSON'
{
  "name": "invalid-engine-bad",
  "engine": "selenium",
  "environment": "live-action",
  "riskClass": "destructive",
  "startUrl": "https://invalid-engine.example.test/approve?otp=SHOULD_NOT_LEAK",
  "irreversibleAt": 99,
  "steps": [
    { "kind": "find", "needs_review": true, "action": "click", "candidates": [{ "by": "text", "value": "Approve" }] }
  ],
  "asserts": []
}
JSON

cat > "$TMP/flows/local-with-remote-url.flow.json" <<'JSON'
{
  "name": "local-with-remote-url",
  "engine": "playwright",
  "environment": "local",
  "riskClass": "read",
  "startUrl": "https://remote.example.test/a?secret=SHOULD_NOT_LEAK",
  "steps": [],
  "asserts": []
}
JSON

cat > "$TMP/flows/local-ok.values.json" <<'JSON'
{ "input_1": "SECRET_VALUE_SHOULD_NOT_BE_READ" }
JSON

node --check "$DIR/bin/blocked-flow-report.mjs" || fail "node --check failed"

FLOW_DIR="$TMP/flows" node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildBlockedFlowReport, renderMarkdownReport } from './bin/blocked-flow-report.mjs';

const fixedNow = 4102444800000;
const repoRoot = path.dirname(process.env.FLOW_DIR);
fs.utimesSync(path.join(repoRoot, 'fixtures/auth/playwright/readyapp.state.json'), new Date(fixedNow - 100), new Date(fixedNow - 100));
fs.utimesSync(path.join(repoRoot, 'fixtures/auth/playwright/staleapp.state.json'), new Date(fixedNow - 5000), new Date(fixedNow - 5000));

const report = await buildBlockedFlowReport({
	flowsDir: process.env.FLOW_DIR,
	repoRoot,
	nowMs: fixedNow,
	authStaleAfterMs: 1000,
});
assert.equal(report.generator, 'blocked-flow-report/v1');
assert.equal(report.metadataOnly, true);
assert.equal(report.authStateContentsRead, false);
assert.equal(report.authFreshness.mode, 'file-metadata-only');
assert.equal(report.totals.total, 7);
assert.equal(report.totals.runnableLocal, 1);
assert.equal(report.totals.operatorOnly, 1);
assert.equal(report.totals.blocked, 5);

const byName = Object.fromEntries(report.flows.map((flow) => [flow.name, flow]));
assert.equal(byName['local-ok'].status, 'runnable-local');
assert.equal(byName['operator-read'].status, 'operator-only');
assert.equal(byName['operator-read'].authFreshness.status, 'ready', 'ready auth is reported from metadata');
assert(byName['operator-read'].operatorHandoff.allowlistChecklist.some((gate) => gate.env === 'AQA_TARGET_ALLOWLIST'), 'operator handoff includes target allowlist checklist');
assert(byName['operator-read'].operatorHandoff.commands.validateOnly.includes('--validate-only'), 'validate-only command is generated');
assert.equal(byName['live-readonly-submit'].status, 'blocked');
assert(byName['live-readonly-submit'].blockers.some((b) => b.code === 'live_readonly_effectful_signal'));
assert.equal(byName['stale-auth'].status, 'blocked');
assert.equal(byName['stale-auth'].authFreshness.status, 'stale', 'stale auth is reported deterministically');
assert(byName['stale-auth'].blockers.some((b) => b.code === 'auth_refresh_required'), 'stale auth blocks replay prep');
assert.equal(byName['missing-auth'].authFreshness.status, 'missing', 'missing auth is reported deterministically');
assert(byName['missing-auth'].operatorHandoff.requiredGates.some((gate) => gate.id === 'auth-freshness' && gate.requiredCommand.includes('setup/auth.sh missingapp')), 'missing auth handoff names setup/auth command without a path');
assert.equal(byName['invalid-engine-bad'].status, 'blocked');
for (const code of ['invalid_engine', 'needs_review', 'missing_irreversible_gate', 'destructive_operator_only']) {
	assert(byName['invalid-engine-bad'].blockers.some((b) => b.code === code), `invalid-engine blocker ${code}`);
}
const invalidReview = byName['invalid-engine-bad'].needsReviewSteps[0];
assert.equal(invalidReview.index, '0', 'needs_review step index is reported');
assert.equal(invalidReview.candidateSummary.count, 1, 'candidate count is reported');
assert(invalidReview.candidateSummary.text.includes('Approve'), 'candidate summary is reported');
assert(byName['invalid-engine-bad'].compile.blockedReason.includes('needs_review'), 'compile blocked reason names needs_review');
assert(byName['invalid-engine-bad'].replay.blockedReason.includes('needs_review'), 'replay blocked reason names needs_review');
assert(byName['invalid-engine-bad'].operatorHandoff.requiredGates.some((gate) => gate.id === 'dry-run-evidence'), 'live-action dry-run gate is reported');
assert(byName['invalid-engine-bad'].operatorHandoff.requiredGates.some((gate) => gate.id === 'owner-approval'), 'live-action owner approval gate is reported');
assert(byName['local-with-remote-url'].blockers.some((b) => b.code === 'non_local_url_in_local_flow'));

const json = JSON.stringify(report);
assert(!json.includes('SHOULD_NOT_LEAK'), 'query/hash secrets are sanitized');
assert(!json.includes('SECRET_VALUE_SHOULD_NOT_BE_READ'), 'values sidecar is never read');
assert(!json.includes('AUTH_SECRET_SHOULD_NOT_LEAK') && !json.includes('STALE_AUTH_SECRET_SHOULD_NOT_LEAK'), 'auth state contents are never read');
assert(!json.includes('fixtures/auth') && !json.includes('.state.json'), 'secret-bearing auth paths are not exposed');
const md = renderMarkdownReport(report);
assert(md.includes('| invalid-engine-bad | blocked |'));
assert(md.includes('needs_review step 0'), 'markdown includes needs_review step details');
assert(md.includes('Required gate dry-run-evidence'), 'markdown includes live-action dry-run gate');
assert(!md.includes('SHOULD_NOT_LEAK'), 'markdown uses sanitized report only');
NODE

if node "$DIR/bin/blocked-flow-report.mjs" --flows "$TMP/flows" > "$TMP/report.json" 2>"$TMP/err"; then
	fail "CLI should exit non-zero when blocked flows exist"
fi
grep -q '"decision": "Review Required"' "$TMP/report.json" || fail "CLI JSON decision missing"
if grep -R "SHOULD_NOT_LEAK\\|SECRET_VALUE_SHOULD_NOT_BE_READ\\|AUTH_SECRET_SHOULD_NOT_LEAK\\|STALE_AUTH_SECRET_SHOULD_NOT_LEAK\\|fixtures/auth\\|state.json" "$TMP/report.json" "$TMP/err"; then
	fail "CLI leaked query or values sidecar data"
fi
node "$DIR/bin/blocked-flow-report.mjs" --flows "$TMP/flows" --format markdown > "$TMP/report.md" || [ "$?" -eq 2 ] || fail "markdown CLI unexpected exit"
grep -q "Blocked Flow Report" "$TMP/report.md" || fail "markdown report missing title"

echo "  blocked-flow-report-unit: all checks passed"
