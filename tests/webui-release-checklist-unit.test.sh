#!/usr/bin/env bash
# Browser-free unit for the WebUI release checklist adapter.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/aqa-webui-release-checklist.XXXXXX")"
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
git -C "$REPO" config user.email webui-release-checklist@example.invalid
git -C "$REPO" config user.name "WebUI Release Checklist Test"

printf 'clean baseline\n' > "$REPO/tracked.txt"
git -C "$REPO" add tracked.txt
git -C "$REPO" commit -q -m init

printf 'changed baseline\nDIRTY_SECRET_SHOULD_NOT_APPEAR\n' > "$REPO/tracked.txt"
printf 'UNTRACKED_SECRET_SHOULD_NOT_APPEAR\n' > "$REPO/scratch-note.txt"

RUN_ID="20990101-020202-456"
ART="$REPO/artifacts/$RUN_ID"
mkdir -p "$ART"
printf '[{"name":"login","status":"pass","cookie":"REPORT_SECRET_SHOULD_NOT_APPEAR"}]\n' > "$ART/report.json"
printf '<testsuite token="JUNIT_SECRET_SHOULD_NOT_APPEAR"></testsuite>\n' > "$ART/report.junit.xml"
printf 'login\tpass\tRESULTS_SECRET_SHOULD_NOT_APPEAR\n' > "$ART/results.tsv"

REPO_NODE="$(to_node_path "$REPO")"
REPORT_NODE="$(to_node_path "$ART/report.json")"

( cd "$DIR" && REPO_NODE="$REPO_NODE" REPORT_NODE="$REPORT_NODE" node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import {
	RELEASE_CHECKLIST_API_ROUTE,
	buildWebuiReleaseChecklist,
	getWebuiReleaseChecklist,
	releaseChecklistFormatForRequest,
	releaseChecklistGet,
	renderWebuiReleaseChecklist,
} from './webui/release-checklist.js';

const readiness = {
	decision: 'No-Go',
	state: 'no-go',
	document: 'dev/active/productization/P0-SERVICE-OPEN.md',
	total: 2,
	checked: 0,
	open: 2,
	blockers: [{ section: 'P0-A', text: 'Require login for every route' }],
	matrix: [
		{
			id: 'P0-A',
			title: 'Auth',
			status: 'contract-only',
			checklist: { total: 1, checked: 0, open: 1 },
			implemented: ['external auth gate'],
			contractOnly: ['claim/header mapping validation'],
			externalBlocked: ['real IdP/SSO login'],
			releaseBlocking: true,
		},
	],
	releaseChecklist: {
		decision: 'No-Go',
		requiredCommands: ['bash tests/security-p0-gate.test.sh', 'bash run.sh'],
		ciLanes: [
			{
				id: 'security-p0-gate',
				label: 'Security P0 Gate',
				command: 'bash tests/security-p0-gate.test.sh',
				ciAllowed: true,
				liveAuthAllowed: false,
				nonLocalAllowed: false,
				liveActionAllowed: false,
			},
			{
				id: 'operator-only',
				label: 'Operator-Only Live/Non-Local Lane',
				command: 'operator-approved named flow only',
				ciAllowed: false,
				ciBlockedReason: 'requires operator-owned auth/target allowlist and may contact non-local systems',
				liveAuthAllowed: true,
				nonLocalAllowed: true,
				liveActionAllowed: false,
			},
		],
		ciBlockedLanes: [
			{ id: 'operator-only', reason: 'requires operator-owned auth/target allowlist and may contact non-local systems' },
		],
		operatorOnlyLaneBlockedInCi: true,
		openSections: ['P0-A'],
		contractOnly: ['P0-A'],
		externalBlocked: ['P0-A'],
		missingEvidence: [
			{
				section: 'P0-A',
				category: 'contract-only',
				item: 'claim/header mapping validation',
				requiredCommand: 'bash tests/webui-auth-context-unit.test.sh',
				currentEvidence: 'local deterministic contract/preflight coverage only',
				requiredEvidence: 'owner-reviewed deployment acceptance evidence',
				blockerReason: 'P0-A remains contract-only until deployment acceptance evidence exists',
			},
			{
				section: 'P0-A',
				category: 'external-blocked',
				item: 'real IdP/SSO login',
				requiredCommand: 'operator-owned IdP acceptance evidence',
				currentEvidence: 'no local fixture can prove real IdP login',
				requiredEvidence: 'operator-owned IdP acceptance evidence',
				blockerReason: 'P0-A remains externally blocked until IdP login evidence exists',
			},
		],
	},
};

const baseOptions = {
	repoRoot: process.env.REPO_NODE,
	readiness,
	now: '2099-01-01T00:00:00.000Z',
};

const handoff = await buildWebuiReleaseChecklist(baseOptions);
assert.equal(handoff.generator, 'release-checklist/v1');
assert.equal(handoff.decision, 'No-Go', 'WebUI adapter preserves No-Go status');
assert.equal(handoff.operatorOnlyLaneBlockedInCi, true, 'operator-only lane stays blocked in CI');
assert.equal(handoff.operatorOnlyLane.ciAllowed, false, 'operator-only lane is not CI allowed');
assert(handoff.ciBlockedLanes.some((lane) => lane.id === 'operator-only'), 'blocked lanes list includes operator-only');
assert.equal(handoff.lastRun.runId, '20990101-020202-456');
assert.equal(handoff.lastRun.status, 'metadata-only', 'artifact scan reports metadata-only status');
assert.equal(handoff.lastRun.rawContentsRead, false, 'last run metadata says raw contents were not read');
assert.equal(handoff.artifactHandling.rawArtifactContentsRead, false, 'artifact handling is metadata-only');
assert.equal(handoff.dirtyWorktree.dirty, true, 'dirty worktree is summarized as metadata');
assert(handoff.blockers.some((b) => b.type === 'p0-contract-only' && b.section === 'P0-A'), 'contract-only P0 status blocks release');
assert(handoff.blockers.some((b) => b.type === 'p0-contract-evidence-missing' && b.requiredCommand.includes('webui-auth-context-unit')), 'contract evidence blocker carries command');
assert(handoff.requiredEvidence.some((item) => item.category === 'external-blocked' && item.requiredEvidence.includes('IdP')), 'required external evidence is preserved');
assert(handoff.blockers.some((b) => b.type === 'dirty-worktree'), 'dirty worktree blocks release handoff');

const jsonText = renderWebuiReleaseChecklist(handoff, 'json').body;
const markdownText = renderWebuiReleaseChecklist(handoff, 'markdown').body;
assert.equal(JSON.parse(jsonText).decision, 'No-Go', 'JSON generation is supported');
assert(markdownText.includes('Decision: No-Go'), 'Markdown generation is supported');
assert(markdownText.includes('## Required Evidence'), 'Markdown includes required evidence');
assert(markdownText.includes('P0-A external-blocked'), 'Markdown includes external evidence gaps');
assert(markdownText.includes('operator-only: CI blocked'), 'Markdown exposes operator lane as CI blocked');
assert(markdownText.includes('Raw artifact contents read: no'), 'Markdown reports metadata-only artifact handling');
for (const text of [jsonText, markdownText]) {
	assert(!text.includes('REPORT_SECRET_SHOULD_NOT_APPEAR'), 'report contents are not exposed');
	assert(!text.includes('JUNIT_SECRET_SHOULD_NOT_APPEAR'), 'JUnit contents are not exposed');
	assert(!text.includes('RESULTS_SECRET_SHOULD_NOT_APPEAR'), 'results contents are not exposed');
	assert(!text.includes('DIRTY_SECRET_SHOULD_NOT_APPEAR'), 'dirty file contents are not exposed');
	assert(!text.includes('UNTRACKED_SECRET_SHOULD_NOT_APPEAR'), 'untracked file contents are not exposed');
}

const renderedJson = await getWebuiReleaseChecklist({ ...baseOptions, format: 'json' });
assert.equal(renderedJson.contentType, 'application/json; charset=utf-8');
assert.equal(JSON.parse(renderedJson.body).artifactHandling.mode, 'metadata-only');
assert(JSON.parse(renderedJson.body).requiredEvidence.length >= 2, 'JSON route body carries required evidence');
const renderedMarkdown = await getWebuiReleaseChecklist({ ...baseOptions, format: 'markdown' });
assert.equal(renderedMarkdown.contentType, 'text/markdown; charset=utf-8');
assert(renderedMarkdown.body.includes('## CI Lanes'));

assert.equal(
	releaseChecklistFormatForRequest(new URL('http://127.0.0.1/api/release-checklist?format=markdown')),
	'markdown',
	'format query selects Markdown',
);
assert.equal(
	releaseChecklistFormatForRequest(new URL('http://127.0.0.1/api/release-checklist'), { accept: 'text/markdown' }),
	'markdown',
	'Accept header can select Markdown',
);
assert.equal(
	releaseChecklistFormatForRequest(new URL('http://127.0.0.1/api/release-checklist')),
	'json',
	'JSON is the default API format',
);

await assert.rejects(
	() => buildWebuiReleaseChecklist({ ...baseOptions, testMetadataPath: process.env.REPORT_NODE }),
	/refusing raw artifact file/,
	'raw report.json is refused as test metadata input',
);

function fakeRes() {
	return {
		headers: {},
		statusCode: 0,
		body: '',
		setHeader(key, value) {
			this.headers[key.toLowerCase()] = value;
		},
		writeHead(code, headers = {}) {
			this.statusCode = code;
			for (const [key, value] of Object.entries(headers)) this.headers[key.toLowerCase()] = value;
		},
		end(body = '') {
			this.body += body;
		},
	};
}

const jsonRes = fakeRes();
let sentJson = null;
let handled = await releaseChecklistGet(
	RELEASE_CHECKLIST_API_ROUTE,
	new URL('http://127.0.0.1/api/release-checklist?format=json'),
	jsonRes,
	{
		options: baseOptions,
		sendJson(res, code, obj) {
			sentJson = obj;
			res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify(obj));
		},
	},
);
assert.equal(handled, true, 'route adapter handles the release checklist API path');
assert.equal(sentJson.decision, 'No-Go', 'JSON route sends the handoff object');
assert.equal(jsonRes.headers['x-aqa-artifact-handling'], 'metadata-only', 'JSON route marks metadata-only handling');

const mdRes = fakeRes();
handled = await releaseChecklistGet(
	RELEASE_CHECKLIST_API_ROUTE,
	new URL('http://127.0.0.1/api/release-checklist?format=markdown'),
	mdRes,
	{ options: baseOptions },
);
assert.equal(handled, true, 'Markdown route is handled');
assert.equal(mdRes.statusCode, 200);
assert.equal(mdRes.headers['content-type'], 'text/markdown; charset=utf-8');
assert(mdRes.body.includes('Decision: No-Go'), 'Markdown route writes checklist body');

const missRes = fakeRes();
handled = await releaseChecklistGet('/api/not-release-checklist', new URL('http://127.0.0.1/api/not-release-checklist'), missRes, { options: baseOptions });
assert.equal(handled, false, 'route adapter ignores unrelated paths');

console.log('  webui-release-checklist-unit: WebUI release checklist adapter is metadata-only and No-Go');
NODE
)
