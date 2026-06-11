// webui/novnc.js - deterministic noVNC session metadata and fail-closed authorization.
//
// This module does not start, proxy, or connect to noVNC. It only models
// tenant/job-scoped sessions and decides whether a request may reach a future
// authenticated proxy boundary.

import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rbac = require('../lib/rbac.js');

const TENANT_RE = /^[A-Za-z0-9_-]{1,80}$/;
const ACTOR_RE = /^[A-Za-z0-9_.@-]{1,120}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,160}$/;
const PATH_COMPONENT_RE = /^[A-Za-z0-9_-]{1,120}$/;
const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
const DEFAULT_IDLE_TIMEOUT_MS = 0;
const DEFAULT_BROWSER_ROOT = path.resolve(import.meta.dirname, '..', 'data', 'browser-sessions');
const TEARDOWN_STATES = new Set(['not-required', 'pending', 'complete', 'failed']);
const TEARDOWN_REASON_RE = /^[A-Za-z0-9_.:-]{0,80}$/;
const TEARDOWN_MANIFEST_KIND = 'aqa.novnc-teardown-manifest';
const ISOLATION_MANIFEST_KIND = 'aqa.novnc-isolation-preflight';
const PRODUCTION_MODE_RE = /^(external|service|prod|production)$/i;
const TERMINAL_TEARDOWN_REASONS = new Set(['cancel', 'timeout', 'job-complete', 'close', 'server-shutdown', 'server-restart', 'restart', 'reconcile', 'interrupted']);
const BROWSER_ISOLATION = Object.freeze({
	scope: 'tenant-job-session',
	profile: 'scoped',
	downloads: 'scoped',
	screenshots: 'scoped',
	video: 'scoped',
	storageState: 'scoped',
	pathsExposed: false,
});

function cleanString(value) {
	return typeof value === 'string' ? value.trim() : '';
}

function lower(value) {
	return cleanString(value).toLowerCase();
}

function bool(value) {
	return value === true || value === 1 || /^(1|true|yes|on)$/i.test(String(value || ''));
}

function envBoolAny(env, names) {
	return names.some((name) => bool(env?.[name]));
}

function envModeAny(env, names) {
	return names.some((name) => PRODUCTION_MODE_RE.test(cleanString(env?.[name])));
}

export function isNoVncProductionMode(env = process.env, opts = {}) {
	return bool(opts.externalMode)
		|| envBoolAny(env, ['WEBUI_EXTERNAL_MODE', 'AQA_EXTERNAL_MODE', 'WEBUI_SERVICE_MODE', 'AQA_SERVICE_MODE', 'WEBUI_REQUIRE_DURABLE_JOBS'])
		|| envModeAny(env, ['WEBUI_MODE', 'AQA_MODE', 'WEBUI_DEPLOYMENT_MODE']);
}

export function validateNoVncExternalBoundary(env = process.env, opts = {}) {
	const externalMode = isNoVncProductionMode(env, opts);
	const disabled = bool(env?.NOVNC_DISABLE);
	const authBoundary = lower(env?.NOVNC_AUTH_BOUNDARY);
	const proxyTls = bool(env?.NOVNC_PROXY_TLS);
	const proxyAuth = lower(env?.NOVNC_PROXY_AUTH);
	const proxyUrl = cleanString(env?.NOVNC_PROXY_URL);
	const browserRoot = cleanString(env?.WEBUI_NOVNC_BROWSER_ROOT || env?.AQA_NOVNC_BROWSER_ROOT || opts.browserRoot || '');
	const profileRoot = cleanString(env?.WEBUI_NOVNC_PROFILE_ROOT || env?.AQA_NOVNC_PROFILE_ROOT || env?.NOVNC_PROFILE_ROOT);
	const downloadRoot = cleanString(env?.WEBUI_NOVNC_DOWNLOAD_ROOT || env?.AQA_NOVNC_DOWNLOAD_ROOT || env?.NOVNC_DOWNLOAD_ROOT);
	const findings = [];

	if (authBoundary && authBoundary !== 'authenticated-proxy') {
		findings.push(isolationFinding('invalid-auth-boundary', 'NOVNC_AUTH_BOUNDARY must be empty or authenticated-proxy', 'NOVNC_AUTH_BOUNDARY'));
	}
	if (proxyAuth && proxyAuth !== 'tenant-session') {
		findings.push(isolationFinding('invalid-proxy-auth', 'NOVNC_PROXY_AUTH must be empty or tenant-session', 'NOVNC_PROXY_AUTH'));
	}
	if (proxyUrl && !proxyUrl.startsWith('https://')) {
		findings.push(isolationFinding('insecure-proxy-url', 'NOVNC_PROXY_URL must start with https:// when set', 'NOVNC_PROXY_URL'));
	}

	if (externalMode && !disabled) {
		if (authBoundary !== 'authenticated-proxy') {
			findings.push(isolationFinding('external-novnc-passwordless', 'external/service mode refuses passwordless noVNC; set NOVNC_DISABLE=1 or NOVNC_AUTH_BOUNDARY=authenticated-proxy', 'NOVNC_AUTH_BOUNDARY'));
		} else {
			if (!proxyTls) findings.push(isolationFinding('missing-proxy-tls', 'NOVNC_AUTH_BOUNDARY=authenticated-proxy requires NOVNC_PROXY_TLS=1', 'NOVNC_PROXY_TLS'));
			if (proxyAuth !== 'tenant-session') findings.push(isolationFinding('missing-proxy-tenant-session-auth', 'NOVNC_AUTH_BOUNDARY=authenticated-proxy requires NOVNC_PROXY_AUTH=tenant-session', 'NOVNC_PROXY_AUTH'));
			if (!browserRoot) {
				findings.push(isolationFinding('missing-browser-root', 'WEBUI_NOVNC_BROWSER_ROOT is required when external noVNC is enabled', 'WEBUI_NOVNC_BROWSER_ROOT'));
			} else if (!path.isAbsolute(browserRoot)) {
				findings.push(isolationFinding('relative-browser-root', 'WEBUI_NOVNC_BROWSER_ROOT must be an absolute path', 'WEBUI_NOVNC_BROWSER_ROOT'));
			}
			if (profileRoot || downloadRoot) {
				findings.push(isolationFinding('shared-browser-root', 'shared browser profile/download roots are not allowed in external mode; derive tenant/job/session roots from WEBUI_NOVNC_BROWSER_ROOT', 'browserRoot'));
			}
		}
	}

	return Object.freeze({
		ok: findings.length === 0,
		allowed: findings.length === 0,
		externalMode,
		disabled,
		mode: disabled ? 'disabled' : authBoundary === 'authenticated-proxy' ? 'authenticated-proxy' : 'local-passwordless',
		authBoundary,
		proxyTls,
		proxyAuth,
		browserRoot,
		pathsExposed: false,
		findings: Object.freeze(findings),
	});
}

function nowMs(value) {
	if (typeof value === 'function') return Number(value());
	if (value != null) return Number(value);
	return Date.now();
}

function toTimeMs(value, fallback, label) {
	if (value == null || value === '') return fallback;
	if (value instanceof Date) {
		const t = value.getTime();
		if (Number.isFinite(t)) return t;
	}
	if (typeof value === 'number') {
		if (Number.isFinite(value)) return value;
	}
	if (typeof value === 'string') {
		const n = Number(value);
		if (Number.isFinite(n) && /^\d+$/.test(value.trim())) return n;
		const t = Date.parse(value);
		if (Number.isFinite(t)) return t;
	}
	throw new Error(`${label} must be a finite epoch ms value or ISO timestamp`);
}

function toDurationMs(value, fallback, label) {
	if (value == null || value === '') return fallback;
	if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
	if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value);
	throw new Error(`${label} must be a non-negative finite millisecond duration`);
}

function iso(ms) {
	return new Date(ms).toISOString();
}

function manifestHash(manifest) {
	const copy = { ...manifest };
	delete copy.manifestHash;
	return `sha256:${crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex')}`;
}

function pathKey(value) {
	const resolved = path.resolve(String(value || ''));
	const trimmed = resolved.replace(/[\\/]+$/, '');
	return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

function isInsidePath(parent, candidate) {
	const rel = path.relative(parent, candidate);
	return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function optionalPath(input, keys) {
	for (const key of keys) {
		const value = cleanString(input?.[key]);
		if (value) return value;
	}
	const paths = input?.paths && typeof input.paths === 'object' ? input.paths : {};
	for (const key of keys) {
		const value = cleanString(paths?.[key]);
		if (value) return value;
	}
	return '';
}

function requireId(label, value, re = ID_RE) {
	const text = cleanString(value);
	if (!text || !re.test(text)) throw new Error(`${label} is required and must match ${re}`);
	return text;
}

function requirePathComponent(label, value) {
	return requireId(label, value, PATH_COMPONENT_RE);
}

function ensureInside(root, candidate, label) {
	const rel = path.relative(root, candidate);
	if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return candidate;
	throw new Error(`${label} must stay inside ${root}`);
}

function ensureUnderSession(sessionRoot, candidate, label) {
	const rel = path.relative(sessionRoot, candidate);
	if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return candidate;
	throw new Error(`${label} must be tenant/job/session scoped under ${sessionRoot}`);
}

export function generateNoVncSessionId({ randomBytes = crypto.randomBytes } = {}) {
	const bytes = randomBytes(24);
	const token = Buffer.from(bytes).toString('base64url');
	return `nv_${token}`;
}

export function deriveNoVncBrowserPaths(input, opts = {}) {
	if (!input || typeof input !== 'object') throw new Error('browser path input is required');
	const tenantId = requirePathComponent('tenantId', input.tenantId || input.tenant);
	const jobId = requirePathComponent('jobId', input.jobId || input.job);
	const sessionId = requirePathComponent('sessionId', input.sessionId || input.id);
	const root = path.resolve(String(opts.root || input.browserRoot || input.root || DEFAULT_BROWSER_ROOT));
	const sessionRoot = ensureInside(root, path.join(root, tenantId, 'jobs', jobId, 'sessions', sessionId), 'sessionRoot');
	const explicitProfile = optionalPath(input, ['profileDir', 'profileRoot', 'browserProfileDir', 'userDataDir', 'userDataRoot']);
	const explicitDownloads = optionalPath(input, ['downloadsDir', 'downloadDir', 'downloadsRoot', 'downloadRoot']);
	const profileDir = explicitProfile ? path.resolve(explicitProfile) : path.join(sessionRoot, 'profile');
	const downloadsDir = explicitDownloads ? path.resolve(explicitDownloads) : path.join(sessionRoot, 'downloads');
	ensureInside(root, profileDir, 'profileDir');
	ensureInside(root, downloadsDir, 'downloadsDir');
	ensureUnderSession(sessionRoot, profileDir, 'profileDir');
	ensureUnderSession(sessionRoot, downloadsDir, 'downloadsDir');
	if (pathKey(profileDir) === pathKey(downloadsDir)) {
		throw new Error('profileDir and downloadsDir must be distinct tenant/job/session scoped roots');
	}
	return Object.freeze({
		root,
		tenantRoot: ensureInside(root, path.join(root, tenantId), 'tenantRoot'),
		jobRoot: ensureInside(root, path.join(root, tenantId, 'jobs', jobId), 'jobRoot'),
		sessionRoot,
		profileDir: ensureUnderSession(sessionRoot, profileDir, 'profileDir'),
		downloadsDir: ensureUnderSession(sessionRoot, downloadsDir, 'downloadsDir'),
		screenshotsDir: ensureInside(root, path.join(sessionRoot, 'screenshots'), 'screenshotsDir'),
		videoDir: ensureInside(root, path.join(sessionRoot, 'video'), 'videoDir'),
		storageStatePath: ensureInside(root, path.join(sessionRoot, 'storage-state.json'), 'storageStatePath'),
	});
}

function isolationFinding(reason, message, field = '') {
	return { reason, message, field };
}

function scopedPathSummary(paths) {
	return Object.freeze({
		rootHash: `sha256:${crypto.createHash('sha256').update(pathKey(paths.root)).digest('hex')}`,
		sessionRelative: path.relative(paths.root, paths.sessionRoot).replace(/\\/g, '/'),
		profileRelative: path.relative(paths.root, paths.profileDir).replace(/\\/g, '/'),
		downloadsRelative: path.relative(paths.root, paths.downloadsDir).replace(/\\/g, '/'),
	});
}

function buildIsolationManifest({ tenantId, jobId, sessionId, paths, externalMode = false, findings = [] }) {
	const manifest = {
		manifestKind: ISOLATION_MANIFEST_KIND,
		version: 1,
		tenantId,
		jobId,
		sessionId,
		externalMode: !!externalMode,
		scope: BROWSER_ISOLATION.scope,
		pathsExposed: false,
		profile: 'tenant-job-session',
		downloads: 'tenant-job-session',
		storageState: 'tenant-job-session',
		relativePaths: paths ? scopedPathSummary(paths) : null,
		allowed: findings.length === 0,
		findings: findings.map((f) => ({ reason: f.reason, field: f.field || '', message: f.message })),
	};
	manifest.manifestHash = manifestHash(manifest);
	return Object.freeze(manifest);
}

export function validateNoVncIsolationPreflight(input, opts = {}) {
	const findings = [];
	const source = input && typeof input === 'object' ? input : {};
	const externalMode = bool(opts.externalMode ?? source.externalMode);
	let tenantId = '';
	let jobId = '';
	let sessionId = '';
	let paths = null;
	const explicitRoot = cleanString(opts.root || source.browserRoot || source.root);
	try {
		tenantId = requirePathComponent('tenantId', source.tenantId || source.tenant);
		jobId = requirePathComponent('jobId', source.jobId || source.job);
		sessionId = requirePathComponent('sessionId', source.sessionId || source.id);
	} catch (e) {
		findings.push(isolationFinding('invalid-session-scope', (e && e.message) || String(e), 'scope'));
	}
	if (externalMode && !explicitRoot) {
		findings.push(isolationFinding('missing-browser-root', 'external/service noVNC sessions require WEBUI_NOVNC_BROWSER_ROOT or AQA_NOVNC_BROWSER_ROOT', 'browserRoot'));
	}
	if (tenantId && jobId && sessionId) {
		try {
			paths = deriveNoVncBrowserPaths(source, opts);
			const expectedSession = path.join(paths.root, tenantId, 'jobs', jobId, 'sessions', sessionId);
			if (pathKey(paths.sessionRoot) !== pathKey(expectedSession)) {
				findings.push(isolationFinding('session-root-not-scoped', 'sessionRoot must include tenantId/jobs/jobId/sessions/sessionId', 'sessionRoot'));
			}
			if (!isInsidePath(paths.sessionRoot, paths.profileDir)) {
				findings.push(isolationFinding('profile-root-not-scoped', 'profileDir must stay under the tenant/job/session root', 'profileDir'));
			}
			if (!isInsidePath(paths.sessionRoot, paths.downloadsDir)) {
				findings.push(isolationFinding('downloads-root-not-scoped', 'downloadsDir must stay under the tenant/job/session root', 'downloadsDir'));
			}
			if (pathKey(paths.profileDir) === pathKey(paths.downloadsDir)) {
				findings.push(isolationFinding('profile-download-root-shared', 'profileDir and downloadsDir must be distinct roots', 'profileDir'));
			}
		} catch (e) {
			findings.push(isolationFinding('invalid-browser-paths', (e && e.message) || String(e), 'browserRoot'));
		}
	}
	const manifest = buildIsolationManifest({ tenantId, jobId, sessionId, paths, externalMode, findings });
	return Object.freeze({
		ok: findings.length === 0,
		allowed: findings.length === 0,
		findings: Object.freeze(findings),
		paths,
		manifest,
	});
}

export function validateNoVncRegistryIsolation(records, opts = {}) {
	const findings = [];
	const list = Array.isArray(records) ? records : [];
	const externalMode = bool(opts.externalMode);
	const seenProfiles = new Map();
	const seenDownloads = new Map();
	for (const record of list) {
		if (!record) continue;
		if (externalMode && !record.browserPaths) {
			findings.push(isolationFinding('missing-browser-paths', `session ${record.sessionId || 'unknown'} lacks scoped browser paths`, 'browserPaths'));
			continue;
		}
		if (!record.browserPaths) continue;
		const preflight = validateNoVncIsolationPreflight({
			tenantId: record.tenantId,
			jobId: record.jobId,
			sessionId: record.sessionId,
			browserRoot: record.browserPaths.root,
			profileDir: record.browserPaths.profileDir,
			downloadsDir: record.browserPaths.downloadsDir,
		}, { externalMode });
		for (const finding of preflight.findings) findings.push(finding);
		const profileKey = pathKey(record.browserPaths.profileDir);
		const downloadKey = pathKey(record.browserPaths.downloadsDir);
		if (seenProfiles.has(profileKey)) {
			findings.push(isolationFinding('shared-profile-root', `sessions ${seenProfiles.get(profileKey)} and ${record.sessionId} share a browser profile root`, 'profileDir'));
		} else {
			seenProfiles.set(profileKey, record.sessionId);
		}
		if (seenDownloads.has(downloadKey)) {
			findings.push(isolationFinding('shared-downloads-root', `sessions ${seenDownloads.get(downloadKey)} and ${record.sessionId} share a downloads root`, 'downloadsDir'));
		} else {
			seenDownloads.set(downloadKey, record.sessionId);
		}
	}
	return Object.freeze({
		ok: findings.length === 0,
		allowed: findings.length === 0,
		findings: Object.freeze(findings),
	});
}

export function buildNoVncTeardownManifest(record, opts = {}) {
	const reason = cleanString(opts.reason || record?.teardownReason || record?.teardown?.reason || '');
	const requestedAt = cleanString(record?.teardownRequestedAt || record?.teardown?.requestedAt || '');
	const completedAt = cleanString(record?.teardownCompletedAt || record?.teardown?.completedAt || '');
	const paths = record?.browserPaths || null;
	const manifest = {
		manifestKind: TEARDOWN_MANIFEST_KIND,
		version: 1,
		tenantId: cleanString(record?.tenantId),
		jobId: cleanString(record?.jobId),
		sessionId: cleanString(record?.sessionId || record?.id),
		state: cleanString(record?.state),
		teardownState: cleanString(record?.teardownState || record?.teardown?.state || ''),
		reason,
		required: !!(record?.teardownRequired || record?.teardown?.required),
		requestedAt: requestedAt || null,
		completedAt: completedAt || null,
		pathsExposed: false,
		cleanupTargets: Object.freeze({
			profile: !!paths?.profileDir,
			downloads: !!paths?.downloadsDir,
			screenshots: !!paths?.screenshotsDir,
			video: !!paths?.videoDir,
			storageState: !!paths?.storageStatePath,
		}),
		scope: BROWSER_ISOLATION.scope,
	};
	manifest.manifestHash = manifestHash(manifest);
	return Object.freeze(manifest);
}

function teardownFinding(reason, message, field = '') {
	return { reason, message, field };
}

export function validateNoVncTeardownManifest(record, manifest = record?.teardownManifest) {
	const findings = [];
	if (!record || typeof record !== 'object') {
		findings.push(teardownFinding('missing-record', 'noVNC session record is required'));
		return Object.freeze({ ok: false, allowed: false, findings: Object.freeze(findings) });
	}
	const terminal = record.state && record.state !== 'open';
	if (!manifest || typeof manifest !== 'object') {
		if (terminal) findings.push(teardownFinding('missing-teardown-manifest', 'terminal noVNC sessions require a cleanup manifest', 'teardownManifest'));
		return Object.freeze({ ok: findings.length === 0, allowed: findings.length === 0, findings: Object.freeze(findings) });
	}
	if (manifest.manifestKind !== TEARDOWN_MANIFEST_KIND) findings.push(teardownFinding('invalid-teardown-manifest-kind', 'teardown manifest kind is unexpected', 'manifestKind'));
	if (manifest.manifestHash !== manifestHash(manifest)) findings.push(teardownFinding('teardown-manifest-hash-mismatch', 'teardown manifest hash must match its contents', 'manifestHash'));
	for (const field of ['tenantId', 'jobId', 'sessionId', 'state', 'teardownState']) {
		const expected = field === 'sessionId' ? cleanString(record.sessionId || record.id) : cleanString(record[field]);
		if (cleanString(manifest[field]) !== expected) findings.push(teardownFinding(`teardown-${field}-mismatch`, `teardown manifest ${field} must match the session record`, field));
	}
	if (cleanString(manifest.reason) !== cleanString(record.teardownReason || record.teardown?.reason || '')) {
		findings.push(teardownFinding('teardown-reason-mismatch', 'teardown manifest reason must match the session record', 'reason'));
	}
	if (!!manifest.required !== !!record.teardownRequired) {
		findings.push(teardownFinding('teardown-required-mismatch', 'teardown manifest required flag must match the session record', 'required'));
	}
	if (record.state === 'canceled' && manifest.reason !== 'cancel') findings.push(teardownFinding('cancel-manifest-reason', 'canceled sessions require a cancel cleanup manifest', 'reason'));
	if (record.state === 'expired' && manifest.reason !== 'timeout') findings.push(teardownFinding('timeout-manifest-reason', 'expired sessions require a timeout cleanup manifest', 'reason'));
	if (record.state === 'closed' && manifest.reason && !TERMINAL_TEARDOWN_REASONS.has(manifest.reason)) {
		findings.push(teardownFinding('restart-manifest-reason', 'closed/restart cleanup manifest has an unsupported reason', 'reason'));
	}
	if ((record.teardownState === 'pending' || record.teardownState === 'failed') && !manifest.requestedAt) {
		findings.push(teardownFinding('missing-teardown-requested-at', 'pending cleanup requires requestedAt metadata', 'requestedAt'));
	}
	if (record.teardownState === 'complete' && !manifest.completedAt) {
		findings.push(teardownFinding('missing-teardown-completed-at', 'completed cleanup requires completedAt metadata', 'completedAt'));
	}
	if (record.browserPaths) {
		const isolation = validateNoVncIsolationPreflight({
			tenantId: record.tenantId,
			jobId: record.jobId,
			sessionId: record.sessionId,
			browserRoot: record.browserPaths.root,
			profileDir: record.browserPaths.profileDir,
			downloadsDir: record.browserPaths.downloadsDir,
		});
		for (const finding of isolation.findings) findings.push(finding);
		if (manifest.cleanupTargets?.profile !== true || manifest.cleanupTargets?.downloads !== true || manifest.cleanupTargets?.storageState !== true) {
			findings.push(teardownFinding('missing-cleanup-targets', 'cleanup manifest must cover profile, downloads, and storage state targets', 'cleanupTargets'));
		}
	}
	return Object.freeze({
		ok: findings.length === 0,
		allowed: findings.length === 0,
		findings: Object.freeze(findings),
	});
}

function normalizeActor(input) {
	const actor = input?.actor && typeof input.actor === 'object' ? input.actor : {};
	const id = requireId('actor.id', input?.actorId || actor.id || input?.createdBy || 'unknown', ACTOR_RE);
	const role = cleanString(input?.role || actor.role);
	if (!rbac.isKnownRole(role)) throw new Error(`actor.role must be one of ${rbac.ROLES.join(', ')}`);
	return Object.freeze({ id, role });
}

function normalizeState(input) {
	const state = cleanString(input?.state || '').toLowerCase();
	const canceled = bool(input?.canceled) || bool(input?.cancelled) || state === 'canceled' || state === 'cancelled';
	const closed = bool(input?.closed) || state === 'closed';
	const finished = bool(input?.finished) || ['finished', 'complete', 'completed', 'done'].includes(state);
	const expired = bool(input?.expired) || ['expired', 'timed-out', 'timed_out', 'timeout'].includes(state);
	if (state && !['open', 'canceled', 'cancelled', 'closed', 'finished', 'complete', 'completed', 'done', 'expired', 'timed-out', 'timed_out', 'timeout'].includes(state)) {
		throw new Error('state must be open, canceled, cancelled, closed, finished, or expired');
	}
	if (canceled) return { state: 'canceled', canceled: true, closed: false, finished: false, expired: false };
	if (expired) return { state: 'expired', canceled: false, closed: false, finished: false, expired: true };
	if (finished) return { state: 'finished', canceled: false, closed: false, finished: true, expired: false };
	if (closed) return { state: 'closed', canceled: false, closed: true, finished: false, expired: false };
	return { state: 'open', canceled: false, closed: false, finished: false, expired: false };
}

function defaultTeardownForState(state) {
	switch (state.state) {
		case 'canceled': return { state: 'pending', reason: 'cancel' };
		case 'expired': return { state: 'pending', reason: 'timeout' };
		case 'finished': return { state: 'pending', reason: 'job-complete' };
		case 'closed': return { state: 'complete', reason: 'close' };
		default: return { state: 'not-required', reason: '' };
	}
}

function normalizeTeardown(input, state, fallbackNow) {
	const nested = input?.teardown && typeof input.teardown === 'object' ? input.teardown : {};
	const defaults = defaultTeardownForState(state);
	const teardownState = cleanString(input?.teardownState || nested.state || defaults.state).toLowerCase();
	if (!TEARDOWN_STATES.has(teardownState)) throw new Error('teardownState must be not-required, pending, complete, or failed');
	const teardownReason = cleanString(input?.teardownReason || nested.reason || defaults.reason);
	if (!TEARDOWN_REASON_RE.test(teardownReason)) throw new Error('teardownReason contains invalid characters');
	const requestedAtRaw = input?.teardownRequestedAt || nested.requestedAt;
	const completedAtRaw = input?.teardownCompletedAt || nested.completedAt;
	const requestedAtMs = requestedAtRaw != null
		? toTimeMs(requestedAtRaw, null, 'teardownRequestedAt')
		: (teardownState === 'pending' || teardownState === 'failed' ? fallbackNow : null);
	const completedAtMs = completedAtRaw != null
		? toTimeMs(completedAtRaw, null, 'teardownCompletedAt')
		: (teardownState === 'complete' ? fallbackNow : null);
	return {
		teardownState,
		teardownReason,
		teardownRequired: teardownState === 'pending' || teardownState === 'failed',
		teardownRequestedAt: requestedAtMs == null ? null : iso(requestedAtMs),
		teardownRequestedAtMs: requestedAtMs,
		teardownCompletedAt: completedAtMs == null ? null : iso(completedAtMs),
		teardownCompletedAtMs: completedAtMs,
		teardown: Object.freeze({
			state: teardownState,
			reason: teardownReason,
			required: teardownState === 'pending' || teardownState === 'failed',
			requestedAt: requestedAtMs == null ? null : iso(requestedAtMs),
			completedAt: completedAtMs == null ? null : iso(completedAtMs),
		}),
	};
}

export function createNoVncSessionRecord(input, {
	now = Date.now(),
	ttlMs = DEFAULT_SESSION_TTL_MS,
	hardTtlMs = ttlMs,
	idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
	browserRoot = '',
} = {}) {
	if (!input || typeof input !== 'object') throw new Error('noVNC session input is required');
	const createdMs = toTimeMs(input.createdAt, nowMs(now), 'createdAt');
	const currentMs = nowMs(now);
	const actor = normalizeActor(input);
	const state = normalizeState(input);
	const hardMs = toDurationMs(input.hardTtlMs ?? input.ttlMs, hardTtlMs, 'hardTtlMs');
	const idleMs = toDurationMs(input.idleTimeoutMs ?? input.idleTtlMs, idleTimeoutMs, 'idleTimeoutMs');
	const hardExpiresMs = toTimeMs(input.hardExpiresAt || input.expiresAt, createdMs + hardMs, 'hardExpiresAt');
	if (hardExpiresMs <= createdMs && !(input.hardExpiresAt || input.expiresAt)) throw new Error('hardExpiresAt must be after createdAt');
	const lastAccessedMs = toTimeMs(input.lastAccessedAt || input.touchedAt || input.accessedAt, createdMs, 'lastAccessedAt');
	const idleExpiresMs = input.idleExpiresAt != null
		? toTimeMs(input.idleExpiresAt, null, 'idleExpiresAt')
		: idleMs > 0
			? lastAccessedMs + idleMs
			: null;
	const expiresMs = Math.min(hardExpiresMs, idleExpiresMs == null ? Number.POSITIVE_INFINITY : idleExpiresMs);
	const canceledAtMs = state.canceled ? toTimeMs(input.canceledAt || input.cancelledAt, nowMs(now), 'canceledAt') : null;
	const closedAtMs = state.closed ? toTimeMs(input.closedAt, nowMs(now), 'closedAt') : null;
	const finishedAtMs = state.finished ? toTimeMs(input.finishedAt || input.completedAt || input.doneAt, nowMs(now), 'finishedAt') : null;
	const expiredAtMs = state.expired ? toTimeMs(input.expiredAt || input.timedOutAt, nowMs(now), 'expiredAt') : null;
	const sessionId = requireId('sessionId', input.sessionId || input.id);
	const tenantId = requireId('tenantId', input.tenantId || input.tenant, TENANT_RE);
	const jobId = requireId('jobId', input.jobId || input.job);
	const pathsRoot = cleanString(input.browserRoot || input.pathRoot || browserRoot);
	const browserPaths = pathsRoot ? deriveNoVncBrowserPaths({ tenantId, jobId, sessionId }, { root: pathsRoot }) : null;
	const teardown = normalizeTeardown(input, state, currentMs);
	const record = {
		sessionId,
		id: sessionId,
		tenantId,
		jobId,
		actor,
		actorId: actor.id,
		role: actor.role,
		createdAt: iso(createdMs),
		createdAtMs: createdMs,
		lastAccessedAt: iso(lastAccessedMs),
		lastAccessedAtMs: lastAccessedMs,
		idleTimeoutMs: idleMs,
		idleExpiresAt: idleExpiresMs == null ? null : iso(idleExpiresMs),
		idleExpiresAtMs: idleExpiresMs,
		hardTtlMs: hardMs,
		hardExpiresAt: iso(hardExpiresMs),
		hardExpiresAtMs: hardExpiresMs,
		expiresAt: iso(expiresMs),
		expiresAtMs: expiresMs,
		canceled: state.canceled,
		cancelled: state.canceled,
		canceledAt: canceledAtMs == null ? null : iso(canceledAtMs),
		closed: state.closed,
		closedAt: closedAtMs == null ? null : iso(closedAtMs),
		finished: state.finished,
		finishedAt: finishedAtMs == null ? null : iso(finishedAtMs),
		expired: state.expired,
		expiredAt: expiredAtMs == null ? null : iso(expiredAtMs),
		state: state.state,
		...teardown,
		browserIsolation: BROWSER_ISOLATION,
		browserPaths,
	};
	return Object.freeze({
		...record,
		teardownManifest: buildNoVncTeardownManifest(record),
	});
}

export function publicNoVncSession(record) {
	if (!record) return null;
	return {
		sessionId: record.sessionId,
		tenantId: record.tenantId,
		jobId: record.jobId,
		actor: record.actor,
		actorId: record.actorId,
		role: record.role,
		createdAt: record.createdAt,
		expiresAt: record.expiresAt,
		lastAccessedAt: record.lastAccessedAt,
		idleExpiresAt: record.idleExpiresAt,
		hardExpiresAt: record.hardExpiresAt,
		canceled: !!record.canceled,
		cancelled: !!record.cancelled,
		closed: !!record.closed,
		finished: !!record.finished,
		expired: !!record.expired,
		state: record.state,
		teardownState: record.teardownState,
		teardownReason: record.teardownReason,
		teardownRequired: !!record.teardownRequired,
		teardown: record.teardown,
		teardownManifest: record.teardownManifest,
		browserIsolation: record.browserIsolation || BROWSER_ISOLATION,
	};
}

export function noVncSessionExpiry(record, now = Date.now()) {
	if (!record) return { expired: false, kind: '', reason: '' };
	const t = nowMs(now);
	if (record.expired || record.state === 'expired') {
		return { expired: true, kind: 'state', reason: 'noVNC session is expired' };
	}
	if (record.idleExpiresAtMs != null && t >= Number(record.idleExpiresAtMs)) {
		return { expired: true, kind: 'idle', reason: 'noVNC session idle timeout expired' };
	}
	const hard = Number(record.hardExpiresAtMs ?? record.expiresAtMs);
	if (Number.isFinite(hard) && t >= hard) {
		return { expired: true, kind: 'hard', reason: 'noVNC session hard expiry expired' };
	}
	const legacy = Number(record.expiresAtMs);
	if (Number.isFinite(legacy) && t >= legacy) {
		return { expired: true, kind: 'hard', reason: 'noVNC session is expired' };
	}
	return { expired: false, kind: '', reason: '' };
}

export function noVncSessionExpired(record, now = Date.now()) {
	return noVncSessionExpiry(record, now).expired;
}

export function createNoVncSessionRegistry(initialSessions = [], opts = {}) {
	const sessions = new Map();

	function upsert(input) {
		const record = createNoVncSessionRecord(input, opts);
		sessions.set(record.sessionId, record);
		return record;
	}

	function allocate(input, allocateOpts = {}) {
		const base = input && typeof input === 'object' ? input : {};
		let sessionId = cleanString(base.sessionId || base.id);
		for (let i = 0; !sessionId && i < 10; i += 1) {
			const candidate = generateNoVncSessionId(allocateOpts);
			if (!sessions.has(candidate)) sessionId = candidate;
		}
		if (!sessionId) throw new Error('could not allocate a unique noVNC session id');
		const effectiveBrowserRoot = base.browserRoot || allocateOpts.browserRoot || opts.browserRoot || (opts.externalMode ? '' : DEFAULT_BROWSER_ROOT);
		if (opts.externalMode && !cleanString(effectiveBrowserRoot)) {
			throw new Error('external/service noVNC allocation requires WEBUI_NOVNC_BROWSER_ROOT or AQA_NOVNC_BROWSER_ROOT');
		}
		return upsert({
			...base,
			sessionId,
			browserRoot: effectiveBrowserRoot,
		});
	}

	function get(sessionId) {
		return sessions.get(cleanString(sessionId)) || null;
	}

	function findByJob(jobId, tenantId = '') {
		const id = cleanString(jobId);
		const tenant = cleanString(tenantId);
		for (const record of sessions.values()) {
			if (record.jobId === id && (!tenant || record.tenantId === tenant)) return record;
		}
		return null;
	}

	function list() {
		return [...sessions.values()].map(publicNoVncSession);
	}

	function replace(sessionId, patch) {
		const current = get(sessionId);
		if (!current) return null;
		const merged = {
			...current,
			...patch,
			actor: current.actor,
			browserPaths: current.browserPaths,
		};
		const hardExpiresMs = Number(merged.hardExpiresAtMs ?? merged.expiresAtMs);
		const idleExpiresMs = merged.idleExpiresAtMs == null ? null : Number(merged.idleExpiresAtMs);
		const expiresMs = Math.min(hardExpiresMs, idleExpiresMs == null ? Number.POSITIVE_INFINITY : idleExpiresMs);
		const teardownState = patch.teardownState || merged.teardownState || 'not-required';
		const teardownReason = patch.teardownReason ?? merged.teardownReason ?? '';
		const teardownRequired = teardownState === 'pending' || teardownState === 'failed';
		const teardownRequestedAt = patch.teardownRequestedAt !== undefined ? patch.teardownRequestedAt : merged.teardownRequestedAt;
		const teardownCompletedAt = patch.teardownCompletedAt !== undefined ? patch.teardownCompletedAt : merged.teardownCompletedAt;
		const draft = {
			...merged,
			expiresAt: iso(expiresMs),
			expiresAtMs: expiresMs,
			teardownState,
			teardownReason,
			teardownRequired,
			teardownRequestedAt,
			teardownRequestedAtMs: teardownRequestedAt ? Date.parse(teardownRequestedAt) : null,
			teardownCompletedAt,
			teardownCompletedAtMs: teardownCompletedAt ? Date.parse(teardownCompletedAt) : null,
			teardown: Object.freeze({
				state: teardownState,
				reason: teardownReason,
				required: teardownRequired,
				requestedAt: teardownRequestedAt || null,
				completedAt: teardownCompletedAt || null,
			}),
			browserIsolation: merged.browserIsolation || BROWSER_ISOLATION,
		};
		const next = Object.freeze({
			...draft,
			teardownManifest: buildNoVncTeardownManifest(draft),
		});
		sessions.set(next.sessionId, next);
		return next;
	}

	function touchSession(sessionId, { now = Date.now() } = {}) {
		const current = get(sessionId);
		if (!current || current.state !== 'open') return current;
		const t = nowMs(now);
		const idleExpiresAtMs = Number(current.idleTimeoutMs) > 0 ? t + Number(current.idleTimeoutMs) : null;
		return replace(sessionId, {
			lastAccessedAt: iso(t),
			lastAccessedAtMs: t,
			idleExpiresAt: idleExpiresAtMs == null ? null : iso(idleExpiresAtMs),
			idleExpiresAtMs,
		});
	}

	function terminalPatch(state, atField, { now = Date.now(), reason = '' } = {}) {
		const t = iso(nowMs(now));
		const teardownState = state === 'closed' ? 'complete' : 'pending';
		const teardownReason = cleanString(reason) || defaultTeardownForState({ state }).reason || state;
		return {
			canceled: state === 'canceled',
			cancelled: state === 'canceled',
			canceledAt: state === 'canceled' ? t : null,
			closed: state === 'closed',
			closedAt: state === 'closed' ? t : null,
			finished: state === 'finished',
			finishedAt: state === 'finished' ? t : null,
			expired: state === 'expired',
			expiredAt: state === 'expired' ? t : null,
			state,
			[atField]: t,
			teardownState,
			teardownReason,
			teardownRequired: teardownState === 'pending',
			teardownRequestedAt: teardownState === 'pending' ? t : null,
			teardownCompletedAt: teardownState === 'complete' ? t : null,
		};
	}

	function cancelSession(sessionId, opts = {}) {
		return replace(sessionId, terminalPatch('canceled', 'canceledAt', opts));
	}

	function cancelJob(jobId, opts = {}) {
		const record = findByJob(jobId, opts.tenantId);
		return record ? cancelSession(record.sessionId, opts) : null;
	}

	function closeSession(sessionId, opts = {}) {
		return replace(sessionId, terminalPatch('closed', 'closedAt', opts));
	}

	function closeJob(jobId, opts = {}) {
		const record = findByJob(jobId, opts.tenantId);
		return record ? closeSession(record.sessionId, opts) : null;
	}

	function finishSession(sessionId, opts = {}) {
		return replace(sessionId, terminalPatch('finished', 'finishedAt', opts));
	}

	function finishJob(jobId, opts = {}) {
		const record = findByJob(jobId, opts.tenantId);
		return record ? finishSession(record.sessionId, opts) : null;
	}

	function expireSession(sessionId, opts = {}) {
		return replace(sessionId, terminalPatch('expired', 'expiredAt', opts));
	}

	function expireJob(jobId, opts = {}) {
		const record = findByJob(jobId, opts.tenantId);
		return record ? expireSession(record.sessionId, opts) : null;
	}

	function closeAll(opts = {}) {
		const tenant = cleanString(opts.tenantId);
		const closed = [];
		for (const record of sessions.values()) {
			if (tenant && record.tenantId !== tenant) continue;
			if (record.state !== 'open') continue;
			const next = closeSession(record.sessionId, opts);
			if (next) closed.push(publicNoVncSession(next));
		}
		return closed;
	}

	for (const entry of Array.isArray(initialSessions) ? initialSessions : []) upsert(entry);

	return Object.freeze({
		allocate,
		upsert,
		get,
		findByJob,
		list,
		touchSession,
		cancelSession,
		cancelJob,
		closeSession,
		closeJob,
		finishSession,
		finishJob,
		expireSession,
		expireJob,
		closeAll,
		validateIsolation: (validateOpts = {}) => validateNoVncRegistryIsolation([...sessions.values()], { externalMode: opts.externalMode, ...validateOpts }),
	});
}

function unwrapContext(source) {
	if (source && typeof source === 'object' && source.context) return source.context;
	if (source && typeof source === 'object' && source.actor && (source.tenant || source.tenantId)) return source;
	return null;
}

function contextTenantId(context) {
	return cleanString(context?.tenant?.id || context?.tenantId || context?.actor?.tenantId || '');
}

function contextActor(context) {
	return {
		id: cleanString(context?.actor?.id || 'unknown') || 'unknown',
		role: cleanString(context?.actor?.role || ''),
	};
}

function deny(code, error, reason, extra = {}) {
	return { ok: false, allowed: false, code, error, reason, ...extra };
}

function lookupSession(registry, { sessionId = '', jobId = '', tenantId = '' } = {}) {
	const sid = cleanString(sessionId);
	const jid = cleanString(jobId);
	const bySession = sid ? registry?.get?.(sid) : null;
	const byTenantJob = !bySession && jid && tenantId ? registry?.findByJob?.(jid, tenantId) : null;
	const byAnyJob = !bySession && !byTenantJob && jid ? registry?.findByJob?.(jid) : null;
	const byJob = byTenantJob || byAnyJob;
	const record = bySession || byJob || null;
	if (!record) return { record: null, mismatch: false };
	return { record, mismatch: !!(sid && jid && record.jobId !== jid) };
}

export function authorizeNoVncAccess({
	registry,
	sessionId = '',
	jobId = '',
	context,
	now = Date.now(),
	requiredPermission = 'live-action',
	touch = true,
} = {}) {
	const ctx = unwrapContext(context);
	if (!ctx || ctx.authenticated !== true || ctx.localBypass) {
		return deny(401, 'unauthorized', 'authenticated noVNC request context required');
	}
	const tenantId = contextTenantId(ctx);
	const actor = contextActor(ctx);
	if (!tenantId) return deny(401, 'unauthorized', 'tenant-scoped noVNC request context required');
	const lookup = lookupSession(registry, { sessionId, jobId, tenantId });
	const record = lookup.record;
	if (!record) return deny(404, 'not found', 'noVNC session not found');
	if (lookup.mismatch) return deny(403, 'forbidden', 'noVNC session/job mismatch', { session: publicNoVncSession(record) });
	if (record.tenantId !== tenantId) {
		return deny(403, 'forbidden', 'noVNC session tenant mismatch', {
			tenantId,
			sessionTenantId: record.tenantId,
		});
	}
	const roleAuth = rbac.authorize(actor, requiredPermission);
	if (!roleAuth.allowed) {
		return deny(403, 'forbidden', roleAuth.reason, {
			tenantId,
			actor,
			requiredPermissions: [requiredPermission],
		});
	}
	if (record.canceled || record.cancelled) {
		return deny(410, 'gone', 'noVNC session is canceled', { session: publicNoVncSession(record) });
	}
	if (record.finished) {
		return deny(410, 'gone', 'noVNC session is finished', { session: publicNoVncSession(record) });
	}
	if (record.closed) {
		return deny(410, 'gone', 'noVNC session is closed', { session: publicNoVncSession(record) });
	}
	const expiry = noVncSessionExpiry(record, now);
	if (expiry.expired) {
		return deny(410, 'gone', expiry.reason, { session: publicNoVncSession(record), expiryKind: expiry.kind });
	}
	const touched = touch && registry?.touchSession ? registry.touchSession(record.sessionId, { now }) || record : record;
	return {
		ok: true,
		allowed: true,
		code: 200,
		tenantId,
		actor,
		requiredPermissions: [requiredPermission],
		session: publicNoVncSession(touched),
	};
}

function decodedPart(value) {
	try {
		return decodeURIComponent(value || '');
	} catch {
		return '';
	}
}

function queryFirst(searchParams, keys) {
	for (const key of keys) {
		const value = searchParams.get(key);
		if (value) return cleanString(value);
	}
	return '';
}

export function parseNoVncRoute(value) {
	let url;
	try {
		url = value instanceof URL ? value : new URL(String(value || ''), 'http://localhost');
	} catch {
		return { ok: false, pathname: '', sessionId: '', jobId: '', websocket: false };
	}
	const p = url.pathname;
	const sessionFromQuery = queryFirst(url.searchParams, ['sessionId', 'session', 'sid']);
	const jobFromQuery = queryFirst(url.searchParams, ['jobId', 'job']);
	const websocket = /(?:^|\/)(?:ws|websocket|websockify)(?:\/|$)/i.test(p);
	let m = /^\/api\/novnc\/sessions\/([^/]+)(?:\/(?:connect|ws|websocket))?$/i.exec(p)
		|| /^\/(?:novnc|noVNC)\/sessions\/([^/]+)(?:\/(?:connect|ws|websocket))?$/i.exec(p)
		|| /^\/websockify\/([^/]+)$/i.exec(p);
	if (m) {
		return {
			ok: true,
			pathname: p,
			kind: 'session',
			sessionId: decodedPart(m[1]),
			jobId: jobFromQuery,
			websocket,
		};
	}
	m = /^\/(?:novnc|noVNC)\/jobs\/([^/]+)(?:\/(?:connect|ws|websocket))?$/i.exec(p);
	if (m) {
		return {
			ok: true,
			pathname: p,
			kind: 'job',
			sessionId: sessionFromQuery,
			jobId: decodedPart(m[1]),
			websocket,
		};
	}
	if (p === '/vnc.html' || /^\/(?:novnc|noVNC|vnc|websockify)(?:\/|$)/.test(p)) {
		return {
			ok: true,
			pathname: p,
			kind: 'generic',
			sessionId: sessionFromQuery,
			jobId: jobFromQuery,
			websocket,
		};
	}
	return { ok: false, pathname: p, sessionId: '', jobId: '', websocket: false };
}

export function isNoVncRoutePath(pathname) {
	return parseNoVncRoute(pathname).ok;
}

export function authorizeNoVncRoute({ registry, route, context, now = Date.now() } = {}) {
	const parsed = route?.ok === true || route?.ok === false ? route : parseNoVncRoute(route || '');
	if (!parsed.ok) return deny(404, 'not found', 'not a noVNC route');
	return authorizeNoVncAccess({
		registry,
		sessionId: parsed.sessionId,
		jobId: parsed.jobId,
		context,
		now,
	});
}

export function noVncRegistryFromEnv(env = process.env, opts = {}) {
	const browserRoot = cleanString(env.WEBUI_NOVNC_BROWSER_ROOT || env.AQA_NOVNC_BROWSER_ROOT || opts.browserRoot || '');
	const externalMode = isNoVncProductionMode(env, opts);
	const registry = createNoVncSessionRegistry([], { ...opts, externalMode, ...(browserRoot ? { browserRoot } : {}) });
	const boundary = validateNoVncExternalBoundary(env, { ...opts, externalMode, browserRoot });
	if (!boundary.ok) {
		return {
			registry,
			error: boundary.findings.map((f) => f.message).join('; '),
			configured: false,
			boundary,
		};
	}
	const raw = cleanString(env.WEBUI_NOVNC_SESSIONS || env.AQA_NOVNC_SESSIONS || '');
	if (!raw) return { registry, error: '', configured: false };
	if (externalMode && !browserRoot) {
		return {
			registry,
			error: 'WEBUI_NOVNC_SESSIONS in external/service mode requires WEBUI_NOVNC_BROWSER_ROOT or AQA_NOVNC_BROWSER_ROOT',
			configured: false,
		};
	}
	try {
		const parsed = JSON.parse(raw);
		const entries = Array.isArray(parsed)
			? parsed
			: parsed && typeof parsed === 'object'
				? Object.entries(parsed).map(([sessionId, value]) => ({ ...(value && typeof value === 'object' ? value : {}), sessionId }))
				: [];
		const records = [];
		for (const entry of entries) records.push(registry.upsert(entry));
		const isolation = validateNoVncRegistryIsolation(records, { externalMode });
		if (!isolation.ok) {
			const reasons = isolation.findings.map((f) => f.reason).join(', ');
			return {
				registry,
				error: `WEBUI_NOVNC_SESSIONS isolation preflight failed: ${reasons}`,
				configured: false,
			};
		}
		return { registry, error: '', configured: true };
	} catch (e) {
		return {
			registry,
			error: `WEBUI_NOVNC_SESSIONS must contain valid noVNC session records: ${(e && e.message) || e}`,
			configured: false,
		};
	}
}
