#!/usr/bin/env bash
# Browser-free checks for the read-only operations dashboard model.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail(){ echo "  webui-ops-dashboard-unit: $1" >&2; exit 1; }

node --check "$DIR/webui/public/ops-dashboard.js" || fail "ops-dashboard syntax failed"
node --check "$DIR/webui/public/app.js" || fail "app syntax failed"

node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { buildOpsDashboardModel, redactOpsText } from './webui/public/ops-dashboard.js';

assert.equal(
	redactOpsText('https://example.test/path?token=abc&password=hunter2#frag'),
	'https://example.test/path',
	'URL query and hash are removed',
);
assert(!redactOpsText('C:\\Users\\tenant\\secret\\state.json').includes('Users'), 'local paths are redacted');
assert(!redactOpsText('token=abc password=hunter2').includes('abc'), 'inline secret values are redacted');

const model = buildOpsDashboardModel({
	readiness: {
		decision: 'No-Go',
		matrix: [
			{ id: 'P0-A', status: 'contract-only', checklist: { open: 2 }, implemented: ['auth'], contractOnly: ['idp'], externalBlocked: ['real IdP'] },
			{ id: 'P0-F', status: 'implemented', checklist: { open: 0 }, implemented: ['jobs'], contractOnly: [], externalBlocked: [] },
		],
		ciLanes: [
			{ id: 'security-p0-gate', ciAllowed: true, liveActionAllowed: false, liveAuthAllowed: false, nonLocalAllowed: false, command: 'bash tests/security-p0-gate.test.sh' },
			{ id: 'dev-integration-readonly', ciAllowed: false, liveActionAllowed: false, liveAuthAllowed: true, nonLocalAllowed: true, developmentIntegrationAllowed: true, approvalRequired: false, command: 'bash bin/dev-integration-readonly.sh --allowlist https://host flow' },
			{ id: 'operator-only', ciAllowed: false, liveActionAllowed: true, liveAuthAllowed: true, nonLocalAllowed: true, command: 'operator-approved named flow only' },
		],
		releaseChecklist: {
			generator: 'test/v1',
			openSections: ['P0-A'],
			contractOnly: ['P0-A'],
			externalBlocked: ['P0-A'],
			operatorOnlyLaneBlockedInCi: true,
		},
		blockedFlows: {
			staticAnalysisOnly: true,
			totals: { total: 2, runnableLocal: 0, operatorOnly: 1, blocked: 1 },
			flows: [
				{ name: 'checkout-secret', status: 'blocked', blockers: [{ code: 'needs_review', message: 'token=flow_secret' }] },
				{ name: 'live-read', status: 'operator-only', blockers: [{ code: 'non_local_operator_only' }] },
			],
		},
	},
	queue: { metrics: { running: 1, queued: 2, lastFailureReason: 'failed token=queue_secret' } },
	auditSummary: { latestAt: '2026-06-10T00:00:00Z' },
	rbac: { actorId: 'owner@example.test', role: 'owner' },
});

assert.equal(model.p0Rows.length, 2, 'P0 matrix rows are present');
assert.equal(model.laneRows.length, 3, 'CI lane rows are present');
assert(model.laneRows.some((row) => row.lane === 'dev-integration-readonly' && row.live === 'dev-readonly'), 'dev integration lane is not labeled operator-only');
assert(model.blockerRows.some((row) => row.area === 'P0-A' && row.reason === 'contract-only'), 'blockers include contract-only P0 section');
assert(model.blockerRows.some((row) => row.area === 'flow:checkout-secret' && /needs_review/.test(row.reason)), 'blockers include static blocked flows');
assert(model.tiles.some((tile) => tile.label === 'Flow Static Analysis' && tile.detail.includes('no replay')), 'tiles expose no-replay flow analysis');
const rendered = JSON.stringify(model);
assert(!rendered.includes('queue_secret'), 'queue failure detail is redacted');
assert(!rendered.includes('flow_secret'), 'flow blocker detail is summarized by code only');
assert(rendered.includes('dev-readonly lane'), 'development read-only lane is visible');
assert(rendered.includes('production approval separate'), 'production approval is separated from dev integration');
NODE

echo "  webui-ops-dashboard-unit: all checks passed"
