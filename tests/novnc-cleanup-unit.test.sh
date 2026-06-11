#!/usr/bin/env bash
# Browser-free tests for deterministic noVNC cleanup queue behavior.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
NODE_BIN="${NODE_BIN:-${NODE:-}}"
if [ -n "$NODE_BIN" ]; then
	NODE_BIN="$(command -v "$NODE_BIN" 2>/dev/null || printf '%s' "$NODE_BIN")"
else
	NODE_BIN="$(command -v node 2>/dev/null || command -v node.exe 2>/dev/null || true)"
fi
if [ -z "$NODE_BIN" ]; then
	echo "  novnc-cleanup-unit: node not found" >&2
	exit 1
fi
to_node_path() {
	if command -v cygpath >/dev/null 2>&1; then
		cygpath -m "$1"
	elif command -v wslpath >/dev/null 2>&1 && [[ "$NODE_BIN" == *.exe ]]; then
		wslpath -w "$1"
	else
		printf '%s' "$1"
	fi
}
TMP_NODE="$(to_node_path "$TMP")"

cleanup() {
	rm -rf "$TMP"
}
trap cleanup EXIT

(
	cd "$DIR"
	TMP_NODE="$TMP_NODE" "$NODE_BIN" --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
	buildNoVncTeardownManifest,
	createNoVncSessionRecord,
	createNoVncSessionRegistry,
} from './webui/novnc.js';
import {
	createNoVncCleanupPlan,
	createNoVncCleanupQueue,
	createNoVncFsCleanupAdapter,
	publicNoVncCleanupPlan,
	runNoVncCleanupPlan,
	validateNoVncCleanupRecord,
} from './webui/novnc-cleanup.js';

const now = Date.parse('2026-06-10T00:00:05.000Z');
const browserRoot = path.join(process.env.TMP_NODE, 'browser-sessions');
const actor = { id: 'ownerA', role: 'owner' };

async function exists(p) {
	try {
		await fs.stat(p);
		return true;
	} catch (e) {
		if (e && e.code === 'ENOENT') return false;
		throw e;
	}
}

async function seedBrowserState(paths) {
	await fs.mkdir(paths.profileDir, { recursive: true });
	await fs.mkdir(paths.downloadsDir, { recursive: true });
	await fs.mkdir(paths.screenshotsDir, { recursive: true });
	await fs.mkdir(paths.videoDir, { recursive: true });
	await fs.writeFile(path.join(paths.profileDir, 'prefs.txt'), 'fake profile data');
	await fs.writeFile(path.join(paths.downloadsDir, 'download.txt'), 'fake download data');
	await fs.writeFile(path.join(paths.screenshotsDir, 'screen.txt'), 'fake screenshot data');
	await fs.writeFile(path.join(paths.videoDir, 'video.txt'), 'fake video data');
	await fs.writeFile(paths.storageStatePath, 'fake storage state');
}

function pendingRecord(sessionId, jobId, state = 'canceled') {
	return createNoVncSessionRecord({
		sessionId,
		tenantId: 'tenant_a',
		jobId,
		actor,
		state,
		createdAt: '2026-06-10T00:00:00.000Z',
		expiresAt: '2026-06-10T00:10:00.000Z',
		browserRoot,
	}, { now });
}

function withBrowserPaths(record, browserPaths) {
	const next = {
		...record,
		browserPaths: Object.freeze(browserPaths),
	};
	return {
		...next,
		teardownManifest: buildNoVncTeardownManifest(next),
	};
}

const registry = createNoVncSessionRegistry([
	{
		sessionId: 'cancel_s',
		tenantId: 'tenant_a',
		jobId: 'job_cancel',
		actor,
		createdAt: '2026-06-10T00:00:00.000Z',
		expiresAt: '2026-06-10T00:10:00.000Z',
		browserRoot,
	},
	{
		sessionId: 'timeout_s',
		tenantId: 'tenant_a',
		jobId: 'job_timeout',
		actor,
		createdAt: '2026-06-10T00:00:00.000Z',
		expiresAt: '2026-06-10T00:10:00.000Z',
		browserRoot,
	},
	{
		sessionId: 'finish_s',
		tenantId: 'tenant_a',
		jobId: 'job_finish',
		actor,
		createdAt: '2026-06-10T00:00:00.000Z',
		expiresAt: '2026-06-10T00:10:00.000Z',
		browserRoot,
	},
	{
		sessionId: 'restart_s',
		tenantId: 'tenant_a',
		jobId: 'job_restart',
		actor,
		createdAt: '2026-06-10T00:00:00.000Z',
		expiresAt: '2026-06-10T00:10:00.000Z',
		browserRoot,
	},
], { now, browserRoot });

const canceled = registry.cancelJob('job_cancel', { now });
const timedOut = registry.expireJob('job_timeout', { now });
const finished = registry.finishJob('job_finish', { now });
registry.closeAll({ now, reason: 'server-restart' });
const restarted = registry.get('restart_s');

const queue = createNoVncCleanupQueue({ allowCompletedRestart: true, now });
assert.equal(queue.enqueue(canceled).queued, true, 'cancel teardown manifest enqueues cleanup');
assert.equal(queue.enqueue(timedOut).queued, true, 'timeout teardown manifest enqueues cleanup');
assert.equal(queue.enqueue(finished).queued, true, 'finished job teardown manifest enqueues cleanup');
assert.equal(queue.enqueue(restarted).queued, true, 'restart teardown manifest enqueues cleanup when restart reconciliation is enabled');
assert.equal(queue.pending().length, 4, 'queued cleanup tracks cancel, timeout, finished, and restart sessions');
const publicPlan = publicNoVncCleanupPlan(queue.get('cancel_s'));
assert.equal(publicPlan.pathsExposed, false, 'public cleanup plan metadata does not mark raw paths exposed');
assert.equal(publicPlan.targets.some((target) => target.path), false, 'public cleanup plan omits raw target paths');

await seedBrowserState(canceled.browserPaths);
const fsQueue = createNoVncCleanupQueue({ now });
const enqueued = fsQueue.enqueue(canceled);
assert.equal(enqueued.queued, true, 'fake browser-session root cleanup is queued');
const fsResult = await fsQueue.run('cancel_s', createNoVncFsCleanupAdapter({ root: browserRoot }), { now });
assert.equal(fsResult.ok, true, 'fake browser-session cleanup completes');
assert.equal(await exists(canceled.browserPaths.profileDir), false, 'profile directory is removed');
assert.equal(await exists(canceled.browserPaths.downloadsDir), false, 'downloads directory is removed');
assert.equal(await exists(canceled.browserPaths.storageStatePath), false, 'storage state path is removed');
assert.equal(await exists(canceled.browserPaths.sessionRoot), true, 'session root is retained as scoped container metadata');

const shared = withBrowserPaths(pendingRecord('shared_s', 'job_shared'), {
	...pendingRecord('shared_s', 'job_shared').browserPaths,
	downloadsDir: pendingRecord('shared_s', 'job_shared').browserPaths.profileDir,
});
const sharedValidation = validateNoVncCleanupRecord(shared);
assert.equal(sharedValidation.ok, false, 'shared profile/download cleanup roots are refused');
assert(sharedValidation.findings.some((finding) => finding.reason === 'shared-profile-download-root'), 'shared root refusal is explicit');
assert.equal(createNoVncCleanupQueue({ now }).enqueue(shared).status, 'refused', 'shared roots are not queued');

const scopedBase = pendingRecord('bad_scope_s', 'job_bad_scope');
const badScoped = withBrowserPaths(scopedBase, {
	...scopedBase.browserPaths,
	profileDir: path.join(browserRoot, 'tenant_a', 'shared-profile'),
});
const scopedValidation = validateNoVncCleanupRecord(badScoped);
assert.equal(scopedValidation.ok, false, 'cleanup enforces tenant/job/session scoped paths');
assert(scopedValidation.findings.some((finding) => finding.reason === 'profile-outside-session-root'), 'profile outside session root is reported');

const retryRecord = pendingRecord('retry_s', 'job_retry');
const retryPlan = createNoVncCleanupPlan(retryRecord, { now, maxAttempts: 3 });
const removed = [];
let failDownloadsOnce = true;
const flakyAdapter = {
	removePath(target) {
		if (target.kind === 'downloads' && failDownloadsOnce) {
			failDownloadsOnce = false;
			throw new Error('download target locked');
		}
		removed.push(target.kind);
		return { removed: true };
	},
};
let retryResult = await runNoVncCleanupPlan(retryPlan, flakyAdapter, { now });
assert.equal(retryResult.status, 'failed', 'partial cleanup failure marks the plan failed');
assert.equal(retryResult.retryable, true, 'partial cleanup failure remains retryable before max attempts');
assert.equal(retryPlan.targets.find((target) => target.kind === 'profile').done, true, 'successful targets stay completed after a partial failure');
assert.equal(retryPlan.targets.find((target) => target.kind === 'downloads').done, false, 'failed target remains pending for retry');
retryResult = await runNoVncCleanupPlan(retryPlan, flakyAdapter, { now });
assert.equal(retryResult.status, 'complete', 'partial cleanup retry completes remaining target');
assert.equal(removed.filter((kind) => kind === 'profile').length, 1, 'completed profile cleanup is not repeated on retry');
assert.equal(removed.filter((kind) => kind === 'downloads').length, 1, 'failed downloads cleanup is retried once');

const closed = createNoVncSessionRecord({
	sessionId: 'closed_s',
	tenantId: 'tenant_a',
	jobId: 'job_closed',
	actor,
	state: 'closed',
	createdAt: '2026-06-10T00:00:00.000Z',
	expiresAt: '2026-06-10T00:10:00.000Z',
	browserRoot,
}, { now });
const closedQueue = createNoVncCleanupQueue({ now });
let closedResult = closedQueue.enqueue(closed);
assert.equal(closedResult.queued, false, 'closed complete sessions are idempotent no-ops by default');
assert.equal(closedResult.status, 'already-complete', 'closed complete sessions report already-complete');
closedResult = closedQueue.enqueue(closed);
assert.equal(closedResult.status, 'already-complete', 'closed complete enqueue stays idempotent');

console.log('  novnc-cleanup-unit: cleanup queue checks passed');
NODE
)
