// webui/novnc-isolation.js - noVNC browser-path isolation, external boundary, and teardown manifests.
//
// Derives tenant/job/session-scoped browser paths and validates fail-closed
// isolation preflight and cleanup manifests; no I/O.

import crypto from 'node:crypto';
import path from 'node:path';
import {
	BROWSER_ISOLATION,
	DEFAULT_BROWSER_ROOT,
	ISOLATION_MANIFEST_KIND,
	TEARDOWN_MANIFEST_KIND,
	TERMINAL_TEARDOWN_REASONS,
	bool,
	cleanString,
	ensureInside,
	ensureUnderSession,
	envBoolAny,
	envModeAny,
	isInsidePath,
	lower,
	manifestHash,
	optionalPath,
	pathKey,
	requirePathComponent,
} from './novnc-shared.js';

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
