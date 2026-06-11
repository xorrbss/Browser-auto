#!/usr/bin/env bash
# Browser-free tests for deterministic noVNC session authorization and route stubs.
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
	echo "  novnc-boundary-unit: node not found" >&2
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
PORT=$((5300 + RANDOM % 1000))
SRV=""

OWNER_A_TOKEN="ownerA0000000001"
OWNER_B_TOKEN="ownerB0000000001"
VIEWER_A_TOKEN="viewerA000000001"
AUTH_USERS="$(printf '[{"token":"%s","id":"ownerA","role":"owner","tenantId":"tenant_a"},{"token":"%s","id":"ownerB","role":"owner","tenantId":"tenant_b"},{"token":"%s","id":"viewerA","role":"viewer","tenantId":"tenant_a"}]' "$OWNER_A_TOKEN" "$OWNER_B_TOKEN" "$VIEWER_A_TOKEN")"
NOVNC_SESSIONS='[
	{"sessionId":"active_s","tenantId":"tenant_a","jobId":"job_active","actor":{"id":"ownerA","role":"owner"},"createdAt":"2026-06-10T00:00:00.000Z","expiresAt":"2099-01-01T00:00:00.000Z"},
	{"sessionId":"expired_s","tenantId":"tenant_a","jobId":"job_expired","actor":{"id":"ownerA","role":"owner"},"createdAt":"2026-06-10T00:00:00.000Z","expiresAt":"2026-06-10T00:00:01.000Z"},
	{"sessionId":"canceled_s","tenantId":"tenant_a","jobId":"job_canceled","actor":{"id":"ownerA","role":"owner"},"createdAt":"2026-06-10T00:00:00.000Z","expiresAt":"2099-01-01T00:00:00.000Z","canceled":true},
	{"sessionId":"closed_s","tenantId":"tenant_a","jobId":"job_closed","actor":{"id":"ownerA","role":"owner"},"createdAt":"2026-06-10T00:00:00.000Z","expiresAt":"2099-01-01T00:00:00.000Z","closed":true},
	{"sessionId":"finished_s","tenantId":"tenant_a","jobId":"job_finished","actor":{"id":"ownerA","role":"owner"},"createdAt":"2026-06-10T00:00:00.000Z","expiresAt":"2099-01-01T00:00:00.000Z","finished":true},
	{"sessionId":"idle_s","tenantId":"tenant_a","jobId":"job_idle","actor":{"id":"ownerA","role":"owner"},"createdAt":"2000-01-01T00:00:00.000Z","expiresAt":"2099-01-01T00:00:00.000Z","lastAccessedAt":"2000-01-01T00:00:00.000Z","idleTimeoutMs":1000}
]'

cleanup() {
	if [ -n "$SRV" ]; then
		kill "$SRV" 2>/dev/null || true
		wait "$SRV" 2>/dev/null || true
	fi
	rm -rf "$TMP"
}
trap cleanup EXIT

(
	cd "$DIR"
	"$NODE_BIN" --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import {
	authorizeNoVncAccess,
	createNoVncSessionRecord,
	createNoVncSessionRegistry,
	deriveNoVncBrowserPaths,
	generateNoVncSessionId,
	isNoVncRoutePath,
	isNoVncProductionMode,
	noVncRegistryFromEnv,
	noVncSessionExpiry,
	parseNoVncRoute,
	publicNoVncSession,
	validateNoVncExternalBoundary,
	validateNoVncIsolationPreflight,
	validateNoVncRegistryIsolation,
	validateNoVncTeardownManifest,
} from './webui/novnc.js';
import path from 'node:path';

const now = Date.parse('2026-06-10T00:00:05.000Z');
const ownerA = {
	mode: 'external',
	authenticated: true,
	tenant: { id: 'tenant_a' },
	tenantId: 'tenant_a',
	actor: { id: 'ownerA', role: 'owner', tenantId: 'tenant_a' },
	auth: { scheme: 'bearer' },
};
const ownerB = {
	mode: 'external',
	authenticated: true,
	tenant: { id: 'tenant_b' },
	tenantId: 'tenant_b',
	actor: { id: 'ownerB', role: 'owner', tenantId: 'tenant_b' },
	auth: { scheme: 'bearer' },
};
const viewerA = {
	mode: 'external',
	authenticated: true,
	tenant: { id: 'tenant_a' },
	tenantId: 'tenant_a',
	actor: { id: 'viewerA', role: 'viewer', tenantId: 'tenant_a' },
	auth: { scheme: 'bearer' },
};

const active = createNoVncSessionRecord({
	sessionId: 'active_s',
	tenantId: 'tenant_a',
	jobId: 'job_active',
	actor: { id: 'ownerA', role: 'owner' },
	createdAt: '2026-06-10T00:00:00.000Z',
	expiresAt: '2026-06-10T00:10:00.000Z',
});
assert.equal(active.tenantId, 'tenant_a', 'session records carry tenant id');
assert.equal(active.jobId, 'job_active', 'session records carry job id');
assert.equal(active.actor.id, 'ownerA', 'session records carry actor id');
assert.equal(active.role, 'owner', 'session records carry actor role');
assert.equal(active.state, 'open', 'new session is open');
assert.equal(active.teardown.state, 'not-required', 'open sessions do not require teardown yet');
assert.match(active.teardownManifest.manifestHash, /^sha256:[0-9a-f]{64}$/, 'session records carry a deterministic teardown manifest hash');
assert.equal(validateNoVncTeardownManifest(active).ok, true, 'open session teardown manifest validates');
assert.equal(active.browserIsolation.scope, 'tenant-job-session', 'browser isolation is tenant/job/session scoped');
const publicActive = publicNoVncSession(active);
assert.equal(publicActive.browserPaths, undefined, 'public noVNC sessions do not expose raw browser paths');
assert.equal(publicActive.browserIsolation.pathsExposed, false, 'public noVNC sessions report that paths are not exposed');
assert.equal(publicActive.teardownManifest.pathsExposed, false, 'public noVNC sessions expose only sanitized teardown manifest metadata');

const registry = createNoVncSessionRegistry([
	active,
	{
		sessionId: 'expired_s',
		tenantId: 'tenant_a',
		jobId: 'job_expired',
		actor: { id: 'ownerA', role: 'owner' },
		createdAt: '2026-06-10T00:00:00.000Z',
		expiresAt: '2026-06-10T00:00:01.000Z',
	},
	{
		sessionId: 'canceled_s',
		tenantId: 'tenant_a',
		jobId: 'job_canceled',
		actor: { id: 'ownerA', role: 'owner' },
		createdAt: '2026-06-10T00:00:00.000Z',
		expiresAt: '2026-06-10T00:10:00.000Z',
		canceled: true,
	},
	{
		sessionId: 'closed_s',
		tenantId: 'tenant_a',
		jobId: 'job_closed',
		actor: { id: 'ownerA', role: 'owner' },
		createdAt: '2026-06-10T00:00:00.000Z',
		expiresAt: '2026-06-10T00:10:00.000Z',
		closed: true,
	},
	{
		sessionId: 'finished_s',
		tenantId: 'tenant_a',
		jobId: 'job_finished',
		actor: { id: 'ownerA', role: 'owner' },
		createdAt: '2026-06-10T00:00:00.000Z',
		expiresAt: '2026-06-10T00:10:00.000Z',
		finished: true,
	},
	{
		sessionId: 'idle_s',
		tenantId: 'tenant_a',
		jobId: 'job_idle',
		actor: { id: 'ownerA', role: 'owner' },
		createdAt: '2026-06-10T00:00:00.000Z',
		expiresAt: '2026-06-10T00:10:00.000Z',
		lastAccessedAt: '2026-06-10T00:00:00.000Z',
		idleTimeoutMs: 1000,
	},
], { now });
assert.equal(registry.get('canceled_s').teardown.state, 'pending', 'canceled sessions require cleanup');
assert.equal(registry.get('canceled_s').teardown.reason, 'cancel', 'canceled sessions record cancel teardown reason');
assert.equal(registry.get('finished_s').teardown.state, 'pending', 'finished sessions require cleanup');
assert.equal(registry.get('finished_s').teardown.reason, 'job-complete', 'finished sessions record job-complete teardown reason');
assert.equal(registry.get('closed_s').teardown.state, 'complete', 'closed sessions model completed cleanup');
assert.equal(registry.get('closed_s').teardown.required, false, 'closed sessions do not require further teardown');
assert.equal(validateNoVncTeardownManifest(registry.get('canceled_s')).ok, true, 'canceled session teardown manifest validates');
assert.equal(validateNoVncTeardownManifest(registry.get('finished_s')).ok, true, 'finished session teardown manifest validates');
assert.equal(validateNoVncTeardownManifest(registry.get('closed_s')).ok, true, 'closed session teardown manifest validates');
const tamperedCancelManifest = { ...registry.get('canceled_s').teardownManifest, reason: 'timeout' };
assert.equal(validateNoVncTeardownManifest(registry.get('canceled_s'), tamperedCancelManifest).ok, false, 'tampered cancel teardown manifest is rejected');

let decision = authorizeNoVncAccess({ registry, sessionId: 'active_s', context: null, now });
assert.equal(decision.code, 401, 'missing authenticated context is denied');

decision = authorizeNoVncAccess({ registry, sessionId: 'active_s', context: ownerB, now });
assert.equal(decision.code, 403, 'cross-tenant session id access is denied');
assert.match(decision.reason, /tenant mismatch/, 'cross-tenant denial names tenant mismatch');

decision = authorizeNoVncAccess({ registry, jobId: 'job_active', context: ownerB, now });
assert.equal(decision.code, 403, 'cross-tenant guessed job id access is denied');

decision = authorizeNoVncAccess({ registry, sessionId: 'active_s', context: viewerA, now });
assert.equal(decision.code, 403, 'viewer cannot access noVNC even in the same tenant');
assert.match(decision.reason, /live-action/, 'viewer denial names required permission');

decision = authorizeNoVncAccess({ registry, sessionId: 'expired_s', context: ownerA, now });
assert.equal(decision.code, 410, 'expired noVNC session is denied');
assert.match(decision.reason, /expired/, 'expired denial is explicit');

decision = authorizeNoVncAccess({ registry, sessionId: 'canceled_s', context: ownerA, now });
assert.equal(decision.code, 410, 'canceled noVNC session is denied');
assert.match(decision.reason, /canceled/, 'canceled denial is explicit');

decision = authorizeNoVncAccess({ registry, sessionId: 'closed_s', context: ownerA, now });
assert.equal(decision.code, 410, 'closed noVNC session is denied');
assert.match(decision.reason, /closed/, 'closed denial is explicit');

decision = authorizeNoVncAccess({ registry, sessionId: 'finished_s', context: ownerA, now });
assert.equal(decision.code, 410, 'finished noVNC session is denied');
assert.match(decision.reason, /finished/, 'finished denial is explicit');

decision = authorizeNoVncAccess({ registry, sessionId: 'idle_s', context: ownerA, now });
assert.equal(decision.code, 410, 'idle-timed-out noVNC session is denied');
assert.match(decision.reason, /idle timeout/, 'idle timeout denial is explicit');
assert.equal(noVncSessionExpiry(registry.get('idle_s'), now).kind, 'idle', 'idle timeout reports an idle expiry kind');

decision = authorizeNoVncAccess({ registry, sessionId: 'active_s', jobId: 'wrong_job', context: ownerA, now });
assert.equal(decision.code, 403, 'session/job mismatch is denied');

decision = authorizeNoVncAccess({ registry, sessionId: 'active_s', context: ownerA, now });
assert.equal(decision.ok, true, 'same-tenant owner can pass the helper gate before the proxy stub refuses connection');

registry.cancelJob('job_active', { now });
decision = authorizeNoVncAccess({ registry, sessionId: 'active_s', context: ownerA, now });
assert.equal(decision.code, 410, 'canceling a job closes its noVNC access');
assert.equal(registry.get('active_s').teardown.state, 'pending', 'canceling a job marks teardown pending');
assert.equal(registry.get('active_s').teardown.reason, 'cancel', 'canceling a job records cancel teardown reason');

const lifecycleRegistry = createNoVncSessionRegistry([
	{
		sessionId: 'done_s',
		tenantId: 'tenant_a',
		jobId: 'job_done',
		actor: { id: 'ownerA', role: 'owner' },
		createdAt: '2026-06-10T00:00:00.000Z',
		expiresAt: '2026-06-10T00:10:00.000Z',
	},
	{
		sessionId: 'timeout_s',
		tenantId: 'tenant_a',
		jobId: 'job_timeout',
		actor: { id: 'ownerA', role: 'owner' },
		createdAt: '2026-06-10T00:00:00.000Z',
		expiresAt: '2026-06-10T00:10:00.000Z',
	},
	{
		sessionId: 'shutdown_s',
		tenantId: 'tenant_a',
		jobId: 'job_shutdown',
		actor: { id: 'ownerA', role: 'owner' },
		createdAt: '2026-06-10T00:00:00.000Z',
		expiresAt: '2026-06-10T00:10:00.000Z',
	},
], { now });
lifecycleRegistry.finishJob('job_done', { now });
assert.equal(lifecycleRegistry.get('done_s').state, 'finished', 'job completion marks noVNC session finished');
assert.equal(lifecycleRegistry.get('done_s').teardown.state, 'pending', 'job completion marks teardown pending');
assert.equal(lifecycleRegistry.get('done_s').teardown.reason, 'job-complete', 'job completion records teardown reason');
lifecycleRegistry.expireJob('job_timeout', { now });
assert.equal(lifecycleRegistry.get('timeout_s').state, 'expired', 'job timeout marks noVNC session expired');
assert.equal(lifecycleRegistry.get('timeout_s').teardown.reason, 'timeout', 'job timeout records timeout teardown reason');
const closedOnShutdown = lifecycleRegistry.closeAll({ now, reason: 'server-shutdown' });
assert.equal(closedOnShutdown.length, 1, 'server shutdown closes remaining open noVNC sessions');
assert.equal(lifecycleRegistry.get('shutdown_s').teardown.state, 'complete', 'server shutdown marks the model closed');
assert.equal(lifecycleRegistry.get('shutdown_s').teardown.reason, 'server-shutdown', 'server shutdown records teardown reason');
assert.equal(validateNoVncTeardownManifest(lifecycleRegistry.get('done_s')).ok, true, 'job-complete teardown manifest validates');
assert.equal(validateNoVncTeardownManifest(lifecycleRegistry.get('timeout_s')).ok, true, 'timeout teardown manifest validates');
assert.equal(validateNoVncTeardownManifest(lifecycleRegistry.get('shutdown_s')).ok, true, 'restart/shutdown teardown manifest validates');

const sharedRegistry = createNoVncSessionRegistry([
	{
		sessionId: 'shared_b',
		tenantId: 'tenant_b',
		jobId: 'job_shared',
		actor: { id: 'ownerB', role: 'owner' },
		createdAt: '2026-06-10T00:00:00.000Z',
		expiresAt: '2026-06-10T00:10:00.000Z',
	},
	{
		sessionId: 'shared_a',
		tenantId: 'tenant_a',
		jobId: 'job_shared',
		actor: { id: 'ownerA', role: 'owner' },
		createdAt: '2026-06-10T00:00:00.000Z',
		expiresAt: '2026-06-10T00:10:00.000Z',
	},
], { now });
decision = authorizeNoVncAccess({ registry: sharedRegistry, jobId: 'job_shared', context: ownerB, now });
assert.equal(decision.ok, true, 'job-only lookup selects the authenticated tenant session when job ids collide');
assert.equal(decision.session.sessionId, 'shared_b', 'tenant-specific job lookup does not leak the first inserted tenant');

const touchRegistry = createNoVncSessionRegistry([
	{
		sessionId: 'touch_s',
		tenantId: 'tenant_a',
		jobId: 'job_touch',
		actor: { id: 'ownerA', role: 'owner' },
		createdAt: '2026-06-10T00:00:00.000Z',
		expiresAt: '2026-06-10T00:10:00.000Z',
		lastAccessedAt: '2026-06-10T00:00:04.500Z',
		idleTimeoutMs: 1000,
	},
], { now });
decision = authorizeNoVncAccess({ registry: touchRegistry, sessionId: 'touch_s', context: ownerA, now });
assert.equal(decision.ok, true, 'active idle session authorizes before the idle deadline');
assert.equal(touchRegistry.get('touch_s').idleExpiresAt, '2026-06-10T00:00:06.000Z', 'authorized access refreshes the idle deadline');

const generated = generateNoVncSessionId();
assert.match(generated, /^nv_[A-Za-z0-9_-]{32,}$/, 'generated noVNC session ids are high-entropy URL-safe tokens');

const browserRoot = path.join(process.cwd(), 'data', 'novnc-boundary-root');
const paths = deriveNoVncBrowserPaths({ tenantId: 'tenant_a', jobId: 'job_active', sessionId: 'active_s' }, { root: browserRoot });
for (const [key, value] of Object.entries(paths)) {
	if (key === 'root') continue;
	const rel = path.relative(paths.root, value);
	assert.ok(rel && !rel.startsWith('..') && !path.isAbsolute(rel), `${key} stays inside the noVNC browser root`);
}
assert.match(paths.profileDir.replace(/\\/g, '/'), /tenant_a\/jobs\/job_active\/sessions\/active_s\/profile$/, 'profile path is tenant/job/session scoped');
assert.match(paths.downloadsDir.replace(/\\/g, '/'), /tenant_a\/jobs\/job_active\/sessions\/active_s\/downloads$/, 'downloads path is tenant/job/session scoped');
assert.throws(() => deriveNoVncBrowserPaths({ tenantId: 'tenant_a', jobId: '../escape', sessionId: 'active_s' }, { root: browserRoot }), /jobId/, 'path traversal job ids are refused');
assert.throws(() => deriveNoVncBrowserPaths({
	tenantId: 'tenant_a',
	jobId: 'job_active',
	sessionId: 'active_s',
	profileDir: path.join(browserRoot, 'shared-profile'),
}, { root: browserRoot }), /tenant\/job\/session scoped/, 'shared explicit profile roots are refused');

let preflight = validateNoVncIsolationPreflight({
	tenantId: 'tenant_a',
	jobId: 'job_active',
	sessionId: 'active_s',
	browserRoot,
	externalMode: true,
});
assert.equal(preflight.ok, true, 'external isolation preflight accepts derived tenant/job/session roots');
assert.match(preflight.manifest.manifestHash, /^sha256:[0-9a-f]{64}$/, 'isolation preflight produces a deterministic manifest hash');

preflight = validateNoVncIsolationPreflight({
	tenantId: 'tenant_a',
	jobId: 'job_active',
	sessionId: 'active_s',
	externalMode: true,
});
assert.equal(preflight.ok, false, 'external isolation preflight requires an explicit browser root');
assert(preflight.findings.some((f) => f.reason === 'missing-browser-root'), 'missing browser root finding is reported');

const allocated = createNoVncSessionRegistry([], { now, browserRoot }).allocate({
	tenantId: 'tenant_a',
	jobId: 'job_alloc',
	actor: { id: 'ownerA', role: 'owner' },
});
assert.match(allocated.sessionId, /^nv_[A-Za-z0-9_-]{32,}$/, 'allocated sessions get unguessable ids by default');
assert.match(allocated.browserPaths.downloadsDir.replace(/\\/g, '/'), /tenant_a\/jobs\/job_alloc\/sessions\/nv_[A-Za-z0-9_-]+\/downloads$/, 'allocated download dir stays under tenant/job/session');
const allocatedPublic = publicNoVncSession(allocated);
assert.equal(allocatedPublic.browserPaths, undefined, 'allocated public session hides browser paths');
assert.equal(allocatedPublic.browserIsolation.scope, 'tenant-job-session', 'allocated public session carries isolation policy');
assert.equal(validateNoVncRegistryIsolation([allocated], { externalMode: true }).ok, true, 'external registry isolation accepts scoped allocated paths');
assert.throws(() => createNoVncSessionRegistry([], { now, externalMode: true }).allocate({
	tenantId: 'tenant_a',
	jobId: 'job_missing_root',
	actor: { id: 'ownerA', role: 'owner' },
}), /WEBUI_NOVNC_BROWSER_ROOT/, 'external allocation without a browser root is refused');

const duplicateRecordA = createNoVncSessionRecord({
	sessionId: 'dup_a',
	tenantId: 'tenant_a',
	jobId: 'job_dup_a',
	actor: { id: 'ownerA', role: 'owner' },
	createdAt: '2026-06-10T00:00:00.000Z',
	expiresAt: '2026-06-10T00:10:00.000Z',
	browserRoot,
});
const duplicateRecordB = {
	...createNoVncSessionRecord({
		sessionId: 'dup_b',
		tenantId: 'tenant_a',
		jobId: 'job_dup_b',
		actor: { id: 'ownerA', role: 'owner' },
		createdAt: '2026-06-10T00:00:00.000Z',
		expiresAt: '2026-06-10T00:10:00.000Z',
		browserRoot,
	}),
	browserPaths: duplicateRecordA.browserPaths,
};
let registryPreflight = validateNoVncRegistryIsolation([duplicateRecordA, duplicateRecordB], { externalMode: true });
assert.equal(registryPreflight.ok, false, 'external registry isolation rejects shared browser roots across sessions');
assert(registryPreflight.findings.some((f) => f.reason === 'shared-profile-root'), 'shared profile root finding is reported');

let boundary = validateNoVncExternalBoundary({ WEBUI_EXTERNAL_MODE: '1' });
assert.equal(boundary.ok, false, 'external noVNC without disable/auth boundary fails closed');
assert(boundary.findings.some((f) => f.reason === 'external-novnc-passwordless'), 'passwordless external noVNC finding is reported');
boundary = validateNoVncExternalBoundary({ WEBUI_EXTERNAL_MODE: '1', NOVNC_DISABLE: '1' });
assert.equal(boundary.ok, true, 'external noVNC disabled mode is accepted');
assert.equal(boundary.mode, 'disabled', 'disabled noVNC boundary mode is explicit');
boundary = validateNoVncExternalBoundary({ WEBUI_EXTERNAL_MODE: '1', NOVNC_AUTH_BOUNDARY: 'authenticated-proxy' });
assert.equal(boundary.ok, false, 'authenticated proxy boundary requires TLS, tenant-session auth, and browser root');
for (const reason of ['missing-proxy-tls', 'missing-proxy-tenant-session-auth', 'missing-browser-root']) {
	assert(boundary.findings.some((f) => f.reason === reason), `${reason} boundary finding is reported`);
}
boundary = validateNoVncExternalBoundary({
	WEBUI_EXTERNAL_MODE: '1',
	NOVNC_AUTH_BOUNDARY: 'authenticated-proxy',
	NOVNC_PROXY_TLS: '1',
	NOVNC_PROXY_AUTH: 'tenant-session',
	WEBUI_NOVNC_BROWSER_ROOT: browserRoot,
});
assert.equal(boundary.ok, true, 'authenticated TLS tenant/session proxy boundary is accepted');
assert.equal(boundary.pathsExposed, false, 'boundary preflight does not expose raw browser paths publicly');

let envRegistry = noVncRegistryFromEnv({
	WEBUI_EXTERNAL_MODE: '1',
	WEBUI_NOVNC_SESSIONS: '[{"sessionId":"env_s","tenantId":"tenant_a","jobId":"job_env","actor":{"id":"ownerA","role":"owner"}}]',
});
assert.match(envRegistry.error, /passwordless noVNC/, 'external env session registry refuses passwordless noVNC');
assert.equal(isNoVncProductionMode({ WEBUI_REQUIRE_DURABLE_JOBS: '1' }), true, 'durable service mode is treated as noVNC production mode');
assert.equal(isNoVncProductionMode({ WEBUI_MODE: 'service' }), true, 'service deployment mode is treated as noVNC production mode');
envRegistry = noVncRegistryFromEnv({
	WEBUI_REQUIRE_DURABLE_JOBS: '1',
	WEBUI_NOVNC_SESSIONS: '[{"sessionId":"durable_s","tenantId":"tenant_a","jobId":"job_durable","actor":{"id":"ownerA","role":"owner"}}]',
});
assert.match(envRegistry.error, /passwordless noVNC/, 'durable service noVNC registry refuses passwordless noVNC');
envRegistry = noVncRegistryFromEnv({
	WEBUI_MODE: 'service',
	NOVNC_AUTH_BOUNDARY: 'authenticated-proxy',
	NOVNC_PROXY_TLS: '1',
	NOVNC_PROXY_AUTH: 'tenant-session',
	WEBUI_NOVNC_SESSIONS: '[{"sessionId":"service_s","tenantId":"tenant_a","jobId":"job_service","actor":{"id":"ownerA","role":"owner"}}]',
});
assert.match(envRegistry.error, /WEBUI_NOVNC_BROWSER_ROOT/, 'service-mode authenticated proxy noVNC registry requires a browser root');
envRegistry = noVncRegistryFromEnv({
	WEBUI_EXTERNAL_MODE: '1',
	NOVNC_AUTH_BOUNDARY: 'authenticated-proxy',
	NOVNC_PROXY_TLS: '1',
	NOVNC_PROXY_AUTH: 'tenant-session',
	WEBUI_NOVNC_BROWSER_ROOT: browserRoot,
	WEBUI_NOVNC_SESSIONS: '[{"sessionId":"env_s","tenantId":"tenant_a","jobId":"job_env","actor":{"id":"ownerA","role":"owner"}}]',
}, { now });
assert.equal(envRegistry.error, '', 'external env session registry accepts scoped browser root');
assert.equal(envRegistry.registry.get('env_s').browserPaths.profileDir.endsWith(path.join('tenant_a', 'jobs', 'job_env', 'sessions', 'env_s', 'profile')), true, 'env session profile root is derived per tenant/job/session');

let route = parseNoVncRoute('/novnc/sessions/active_s/ws');
assert.equal(route.ok, true, 'session websocket route is recognized');
assert.equal(route.sessionId, 'active_s', 'session id is parsed from noVNC route');
assert.equal(route.websocket, true, 'websocket route is marked');
route = parseNoVncRoute('/novnc/jobs/job_active?session=active_s');
assert.equal(route.jobId, 'job_active', 'job id route is parsed');
assert.equal(route.sessionId, 'active_s', 'session query is parsed');
assert.equal(isNoVncRoutePath('/vnc.html?session=active_s'), true, 'legacy noVNC client path is recognized');

console.log('  novnc-boundary-unit: helper authorization checks passed');
NODE
)

( cd "$DIR" && exec env AQA_DB_PATH="$TMP_NODE/t.db" WEBUI_PORT="$PORT" WEBUI_KEEP_RUNS=999999 WEBUI_EXTERNAL_MODE=1 WEBUI_AUTH_USERS="$AUTH_USERS" NOVNC_AUTH_BOUNDARY=authenticated-proxy NOVNC_PROXY_TLS=1 NOVNC_PROXY_AUTH=tenant-session WEBUI_NOVNC_BROWSER_ROOT="$TMP_NODE/browser-root" WEBUI_NOVNC_SESSIONS="$NOVNC_SESSIONS" "$NODE_BIN" webui/server.js >"$TMP/server.log" 2>&1 ) &
SRV=$!

if ! PORT="$PORT" OWNER_A_TOKEN="$OWNER_A_TOKEN" OWNER_B_TOKEN="$OWNER_B_TOKEN" VIEWER_A_TOKEN="$VIEWER_A_TOKEN" "$NODE_BIN" --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import net from 'node:net';

const port = process.env.PORT;
const ownerAToken = process.env.OWNER_A_TOKEN;
const ownerBToken = process.env.OWNER_B_TOKEN;
const viewerAToken = process.env.VIEWER_A_TOKEN;
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (let i = 0; i < 80; i++) {
	try {
		const r = await fetch(base + '/api/runs');
		if (r.status === 401) break;
	} catch {}
	await sleep(100);
	if (i === 79) throw new Error('server did not become ready');
}

const auth = (token) => token ? { Authorization: `Bearer ${token}` } : {};
let r = await fetch(base + '/novnc/sessions/active_s');
assert.equal(r.status, 401, 'HTTP noVNC route rejects unauthenticated requests');

r = await fetch(base + '/novnc/sessions/active_s', { headers: auth(viewerAToken) });
assert.equal(r.status, 403, 'HTTP noVNC route rejects same-tenant viewer');

r = await fetch(base + '/novnc/sessions/active_s', { headers: auth(ownerBToken) });
assert.equal(r.status, 403, 'HTTP noVNC route rejects cross-tenant owner');
let body = await r.json();
assert.match(body.reason || '', /tenant mismatch/, 'cross-tenant HTTP denial is explicit');

r = await fetch(base + '/novnc/sessions/expired_s', { headers: auth(ownerAToken) });
assert.equal(r.status, 410, 'HTTP noVNC route rejects expired sessions');

r = await fetch(base + '/novnc/sessions/canceled_s', { headers: auth(ownerAToken) });
assert.equal(r.status, 410, 'HTTP noVNC route rejects canceled sessions');

r = await fetch(base + '/novnc/sessions/closed_s', { headers: auth(ownerAToken) });
assert.equal(r.status, 410, 'HTTP noVNC route rejects closed sessions');

r = await fetch(base + '/novnc/sessions/finished_s', { headers: auth(ownerAToken) });
assert.equal(r.status, 410, 'HTTP noVNC route rejects finished sessions');

r = await fetch(base + '/novnc/sessions/idle_s', { headers: auth(ownerAToken) });
assert.equal(r.status, 410, 'HTTP noVNC route rejects idle-timed-out sessions');
body = await r.json();
assert.match(body.reason || '', /idle timeout/, 'idle timeout HTTP denial is explicit');

r = await fetch(base + '/novnc/sessions/active_s', { headers: auth(ownerAToken) });
assert.equal(r.status, 503, 'HTTP noVNC route stub stays fail-closed after authorization');
body = await r.json();
assert.match(body.reason || '', /do not proxy or start noVNC/, 'authorized noVNC route is still a disabled stub');
assert.equal(body.session.browserIsolation.pathsExposed, false, 'HTTP noVNC stub does not expose raw browser paths');
assert.equal(body.session.teardown.state, 'not-required', 'HTTP noVNC stub reports teardown state');
assert.match(body.session.teardownManifest.manifestHash, /^sha256:[0-9a-f]{64}$/, 'HTTP noVNC stub reports sanitized teardown manifest hash');

function upgrade(path, token) {
	return new Promise((resolve, reject) => {
		const socket = net.connect({ host: '127.0.0.1', port: Number(port) }, () => {
			const headers = [
				`GET ${path} HTTP/1.1`,
				`Host: 127.0.0.1:${port}`,
				'Connection: Upgrade',
				'Upgrade: websocket',
				'Sec-WebSocket-Version: 13',
				'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
			];
			if (token) headers.push(`Authorization: Bearer ${token}`);
			socket.write(headers.join('\r\n') + '\r\n\r\n');
		});
		let data = '';
		socket.setEncoding('utf8');
		socket.on('data', (chunk) => { data += chunk; });
		socket.on('end', () => resolve(data));
		socket.on('close', () => resolve(data));
		socket.on('error', reject);
		setTimeout(() => {
			socket.destroy();
			resolve(data);
		}, 2000);
	});
}

function status(raw) {
	const m = /^HTTP\/1\.1\s+(\d+)/.exec(raw || '');
	return m ? Number(m[1]) : 0;
}

let raw = await upgrade('/novnc/sessions/active_s/ws', '');
assert.equal(status(raw), 401, 'websocket noVNC upgrade rejects unauthenticated requests');
assert.equal(raw.includes('101 Switching Protocols'), false, 'unauthorized websocket is never upgraded');

raw = await upgrade('/novnc/sessions/active_s/ws', ownerBToken);
assert.equal(status(raw), 403, 'websocket noVNC upgrade rejects cross-tenant requests');
assert.equal(raw.includes('101 Switching Protocols'), false, 'cross-tenant websocket is never upgraded');

raw = await upgrade('/novnc/sessions/active_s/ws', ownerAToken);
assert.equal(status(raw), 503, 'authorized websocket still fails closed because proxying is disabled');
assert.equal(raw.includes('101 Switching Protocols'), false, 'authorized websocket route remains a stub');

console.log('  novnc-boundary-unit: HTTP and websocket route stub checks passed');
NODE
then
	cat "$TMP/server.log" >&2
	exit 1
fi
