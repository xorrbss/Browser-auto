// webui/novnc-cleanup.js - deterministic noVNC browser-state cleanup queue.
//
// This worker consumes noVNC teardown manifests and removes only scoped
// browser-session targets. It does not start, proxy, or connect to noVNC.

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
	validateNoVncIsolationPreflight,
	validateNoVncTeardownManifest,
} from './novnc.js';

const CLEANUP_PLAN_KIND = 'aqa.novnc-cleanup-plan';
const CLEANUP_TARGETS = Object.freeze([
	Object.freeze({ kind: 'profile', field: 'profileDir', type: 'dir', required: true }),
	Object.freeze({ kind: 'downloads', field: 'downloadsDir', type: 'dir', required: true }),
	Object.freeze({ kind: 'screenshots', field: 'screenshotsDir', type: 'dir', required: false }),
	Object.freeze({ kind: 'video', field: 'videoDir', type: 'dir', required: false }),
	Object.freeze({ kind: 'storageState', field: 'storageStatePath', type: 'file', required: true }),
]);
const PENDING_TEARDOWN_STATES = new Set(['pending', 'failed']);
const COMPLETED_TEARDOWN_STATES = new Set(['complete', 'not-required']);
const QUEUEABLE_REASONS = new Set(['cancel', 'timeout', 'job-complete', 'server-shutdown', 'server-restart', 'restart', 'reconcile', 'interrupted']);
const COMPLETED_RESTART_REASONS = new Set(['server-shutdown', 'server-restart', 'restart', 'reconcile', 'interrupted']);
const DEFAULT_MAX_ATTEMPTS = 3;

function cleanString(value) {
	return typeof value === 'string' ? value.trim() : '';
}

function nowMs(value) {
	if (typeof value === 'function') return Number(value());
	if (value != null) return Number(value);
	return Date.now();
}

function iso(ms) {
	return new Date(ms).toISOString();
}

function hashJson(value) {
	return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
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

function isStrictlyInsidePath(parent, candidate) {
	const rel = path.relative(parent, candidate);
	return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function pathsOverlap(a, b) {
	return pathKey(a) === pathKey(b) || isInsidePath(a, b) || isInsidePath(b, a);
}

function planHash(plan) {
	const copy = {
		...plan,
		targets: (plan.targets || []).map((target) => ({ ...target })),
	};
	delete copy.planHash;
	return hashJson(copy);
}

function cleanupFinding(reason, message, field = '') {
	return { reason, message, field };
}

function normalizeRecordState(record) {
	return {
		sessionId: cleanString(record?.sessionId || record?.id),
		tenantId: cleanString(record?.tenantId || record?.tenant),
		jobId: cleanString(record?.jobId || record?.job),
		state: cleanString(record?.state).toLowerCase(),
		teardownState: cleanString(record?.teardownState || record?.teardown?.state).toLowerCase(),
		teardownReason: cleanString(record?.teardownReason || record?.teardown?.reason),
	};
}

function scopedRelative(root, value) {
	return path.relative(root, value).replace(/\\/g, '/');
}

function expectedSessionRoot(root, { tenantId, jobId, sessionId }) {
	return path.join(root, tenantId, 'jobs', jobId, 'sessions', sessionId);
}

function targetFromPath({ root, sessionRoot, kind, type, targetPath }) {
	const resolved = path.resolve(targetPath);
	return {
		kind,
		type,
		path: resolved,
		relativePath: scopedRelative(root, resolved),
		sessionRelativePath: scopedRelative(sessionRoot, resolved),
		done: false,
		attempts: 0,
		completedAt: null,
		lastError: '',
	};
}

function cloneTarget(target) {
	return { ...target };
}

function finalizePlan(plan) {
	plan.planHash = planHash(plan);
	return plan;
}

function validateRawPlan(plan) {
	const findings = [];
	if (!plan || typeof plan !== 'object') {
		findings.push(cleanupFinding('missing-plan', 'cleanup plan is required'));
		return findings;
	}
	if (plan.planKind !== CLEANUP_PLAN_KIND) {
		findings.push(cleanupFinding('invalid-plan-kind', 'cleanup plan kind is unexpected', 'planKind'));
	}
	if (cleanString(plan.planHash) && plan.planHash !== planHash(plan)) {
		findings.push(cleanupFinding('plan-hash-mismatch', 'cleanup plan hash must match its contents', 'planHash'));
	}
	if (!cleanString(plan.sessionId)) findings.push(cleanupFinding('missing-session-id', 'cleanup plan requires a session id', 'sessionId'));
	if (!Array.isArray(plan.targets) || plan.targets.length === 0) {
		findings.push(cleanupFinding('missing-targets', 'cleanup plan requires at least one target', 'targets'));
	}
	return findings;
}

export function validateNoVncCleanupRecord(record, opts = {}) {
	const findings = [];
	const normalized = normalizeRecordState(record);
	if (!record || typeof record !== 'object') {
		findings.push(cleanupFinding('missing-record', 'noVNC session record is required'));
		return Object.freeze({ ok: false, allowed: false, findings: Object.freeze(findings), targets: Object.freeze([]) });
	}

	const teardown = validateNoVncTeardownManifest(record, record.teardownManifest);
	for (const finding of teardown.findings) {
		findings.push(cleanupFinding(finding.reason, finding.message, finding.field));
	}

	if (!record.browserPaths || typeof record.browserPaths !== 'object') {
		findings.push(cleanupFinding('missing-browser-paths', 'cleanup requires scoped browser paths', 'browserPaths'));
		return Object.freeze({ ok: false, allowed: false, findings: Object.freeze(findings), targets: Object.freeze([]) });
	}

	const paths = record.browserPaths;
	const root = path.resolve(String(paths.root || ''));
	const sessionRoot = path.resolve(String(paths.sessionRoot || ''));
	if (!root || !sessionRoot) {
		findings.push(cleanupFinding('missing-browser-root', 'cleanup requires browser root and session root paths', 'browserPaths'));
		return Object.freeze({ ok: false, allowed: false, findings: Object.freeze(findings), targets: Object.freeze([]) });
	}
	if (pathKey(root) === pathKey(sessionRoot)) {
		findings.push(cleanupFinding('session-root-shared-with-browser-root', 'cleanup may not target the shared browser root', 'sessionRoot'));
	}
	if (!isStrictlyInsidePath(root, sessionRoot)) {
		findings.push(cleanupFinding('session-root-not-scoped', 'sessionRoot must stay under the noVNC browser root', 'sessionRoot'));
	}
	const expectedRoot = expectedSessionRoot(root, normalized);
	if (pathKey(sessionRoot) !== pathKey(expectedRoot)) {
		findings.push(cleanupFinding('session-root-not-tenant-job-session-scoped', 'sessionRoot must include tenantId/jobs/jobId/sessions/sessionId', 'sessionRoot'));
	}

	const isolation = validateNoVncIsolationPreflight({
		tenantId: normalized.tenantId,
		jobId: normalized.jobId,
		sessionId: normalized.sessionId,
		browserRoot: root,
		profileDir: paths.profileDir,
		downloadsDir: paths.downloadsDir,
	}, { externalMode: true });
	for (const finding of isolation.findings) {
		findings.push(cleanupFinding(finding.reason, finding.message, finding.field));
	}

	const targets = [];
	const seen = new Map();
	for (const spec of CLEANUP_TARGETS) {
		const rawPath = cleanString(paths[spec.field]);
		if (!rawPath) {
			if (spec.required) findings.push(cleanupFinding(`missing-${spec.kind}-target`, `${spec.kind} cleanup target is required`, spec.field));
			continue;
		}
		const targetPath = path.resolve(rawPath);
		if (!isStrictlyInsidePath(root, targetPath)) {
			findings.push(cleanupFinding(`${spec.kind}-outside-browser-root`, `${spec.kind} cleanup target must stay inside the noVNC browser root`, spec.field));
		}
		if (!isStrictlyInsidePath(sessionRoot, targetPath)) {
			findings.push(cleanupFinding(`${spec.kind}-outside-session-root`, `${spec.kind} cleanup target must stay under the tenant/job/session root`, spec.field));
		}
		const key = pathKey(targetPath);
		if (seen.has(key)) {
			findings.push(cleanupFinding('shared-cleanup-target', `${spec.kind} shares a cleanup target with ${seen.get(key)}`, spec.field));
		}
		seen.set(key, spec.kind);
		targets.push(targetFromPath({ root, sessionRoot, kind: spec.kind, type: spec.type, targetPath }));
	}
	const profile = cleanString(paths.profileDir) ? path.resolve(paths.profileDir) : '';
	const downloads = cleanString(paths.downloadsDir) ? path.resolve(paths.downloadsDir) : '';
	if (profile && downloads && pathsOverlap(profile, downloads)) {
		findings.push(cleanupFinding('shared-profile-download-root', 'profileDir and downloadsDir must be separate non-overlapping cleanup roots', 'browserPaths'));
	}

	if (PENDING_TEARDOWN_STATES.has(normalized.teardownState) && !QUEUEABLE_REASONS.has(normalized.teardownReason)) {
		findings.push(cleanupFinding('unsupported-teardown-reason', 'pending cleanup requires a supported noVNC teardown reason', 'teardownReason'));
	}
	if (COMPLETED_TEARDOWN_STATES.has(normalized.teardownState)) {
		const allowCompletedRestart = !!opts.allowCompletedRestart && normalized.teardownState === 'complete' && COMPLETED_RESTART_REASONS.has(normalized.teardownReason);
		if (!allowCompletedRestart) {
			findings.push(cleanupFinding('cleanup-not-required', 'completed or not-required teardown is idempotent and is not queued', 'teardownState'));
		}
	}

	return Object.freeze({
		ok: findings.length === 0,
		allowed: findings.length === 0,
		findings: Object.freeze(findings),
		targets: Object.freeze(targets.map((target) => Object.freeze(target))),
	});
}

export function createNoVncCleanupPlan(record, opts = {}) {
	const validation = validateNoVncCleanupRecord(record, opts);
	if (!validation.ok) {
		const reason = validation.findings[0]?.reason || 'invalid-cleanup-record';
		throw new Error(`noVNC cleanup plan refused: ${reason}`);
	}
	const t = iso(nowMs(opts.now));
	const normalized = normalizeRecordState(record);
	const paths = record.browserPaths;
	const root = path.resolve(paths.root);
	const sessionRoot = path.resolve(paths.sessionRoot);
	const plan = {
		planKind: CLEANUP_PLAN_KIND,
		version: 1,
		sessionId: normalized.sessionId,
		tenantId: normalized.tenantId,
		jobId: normalized.jobId,
		state: normalized.state,
		teardownState: normalized.teardownState,
		teardownReason: normalized.teardownReason,
		teardownManifestHash: cleanString(record.teardownManifest?.manifestHash),
		status: 'pending',
		createdAt: t,
		startedAt: null,
		completedAt: null,
		attempts: 0,
		maxAttempts: Number.isFinite(Number(opts.maxAttempts)) ? Number(opts.maxAttempts) : DEFAULT_MAX_ATTEMPTS,
		rootHash: hashJson(pathKey(root)),
		sessionRelativePath: scopedRelative(root, sessionRoot),
		pathsExposed: false,
		lastError: '',
		targets: validation.targets.map(cloneTarget),
	};
	return finalizePlan(plan);
}

export function publicNoVncCleanupPlan(plan) {
	if (!plan) return null;
	return {
		planKind: plan.planKind,
		version: plan.version,
		sessionId: plan.sessionId,
		tenantId: plan.tenantId,
		jobId: plan.jobId,
		state: plan.state,
		teardownState: plan.teardownState,
		teardownReason: plan.teardownReason,
		teardownManifestHash: plan.teardownManifestHash,
		status: plan.status,
		createdAt: plan.createdAt,
		startedAt: plan.startedAt,
		completedAt: plan.completedAt,
		attempts: plan.attempts,
		maxAttempts: plan.maxAttempts,
		rootHash: plan.rootHash,
		sessionRelativePath: plan.sessionRelativePath,
		pathsExposed: false,
		targets: Array.isArray(plan.targets)
			? plan.targets.map((target) => ({
				kind: target.kind,
				type: target.type,
				relativePath: target.relativePath,
				sessionRelativePath: target.sessionRelativePath,
				done: !!target.done,
				attempts: Number(target.attempts || 0),
				completedAt: target.completedAt || null,
				lastError: cleanString(target.lastError),
			}))
			: [],
		planHash: plan.planHash,
		lastError: cleanString(plan.lastError),
	};
}

export function validateNoVncCleanupPlan(plan) {
	const findings = validateRawPlan(plan);
	if (findings.length === 0) {
		const rootHash = cleanString(plan.rootHash);
		if (!rootHash.startsWith('sha256:')) findings.push(cleanupFinding('invalid-root-hash', 'cleanup plan must carry a hashed root', 'rootHash'));
		if (plan.pathsExposed !== false) findings.push(cleanupFinding('paths-exposed', 'cleanup plan must not be public with raw paths exposed', 'pathsExposed'));
		for (const target of plan.targets || []) {
			if (!cleanString(target.kind)) findings.push(cleanupFinding('missing-target-kind', 'cleanup target kind is required', 'targets'));
			if (!cleanString(target.path)) findings.push(cleanupFinding('missing-target-path', 'cleanup target path is required internally', 'targets'));
			if (!cleanString(target.relativePath)) findings.push(cleanupFinding('missing-relative-path', 'cleanup target relative path is required', 'targets'));
		}
	}
	return Object.freeze({
		ok: findings.length === 0,
		allowed: findings.length === 0,
		findings: Object.freeze(findings),
	});
}

async function callRemove(adapter, target, plan) {
	if (typeof adapter === 'function') return adapter(target, plan);
	if (adapter && typeof adapter.removePath === 'function') return adapter.removePath(target, plan);
	throw new Error('cleanup adapter must provide removePath(target, plan)');
}

function normalizeError(error) {
	return cleanString((error && error.message) || String(error || 'cleanup failed')) || 'cleanup failed';
}

export async function runNoVncCleanupPlan(plan, adapter, opts = {}) {
	const validation = validateNoVncCleanupPlan(plan);
	if (!validation.ok) {
		return {
			ok: false,
			status: 'refused',
			plan,
			findings: validation.findings,
			completedTargets: Object.freeze([]),
			failedTargets: Object.freeze([]),
			retryable: false,
		};
	}
	if (plan.status === 'complete') {
		return {
			ok: true,
			status: 'complete',
			plan,
			findings: Object.freeze([]),
			completedTargets: Object.freeze([]),
			failedTargets: Object.freeze([]),
			retryable: false,
			idempotent: true,
		};
	}

	const t = iso(nowMs(opts.now));
	const completedTargets = [];
	const failedTargets = [];
	plan.startedAt ||= t;
	plan.attempts = Number(plan.attempts || 0) + 1;
	for (const target of plan.targets) {
		if (target.done) continue;
		target.attempts = Number(target.attempts || 0) + 1;
		try {
			await callRemove(adapter, target, plan);
			target.done = true;
			target.completedAt = t;
			target.lastError = '';
			completedTargets.push(target.kind);
		} catch (error) {
			target.lastError = normalizeError(error);
			failedTargets.push({ kind: target.kind, error: target.lastError });
		}
	}

	if (failedTargets.length) {
		plan.status = 'failed';
		plan.completedAt = null;
		plan.lastError = failedTargets.map((target) => `${target.kind}: ${target.error}`).join('; ');
	} else {
		plan.status = 'complete';
		plan.completedAt = t;
		plan.lastError = '';
	}
	finalizePlan(plan);
	return {
		ok: plan.status === 'complete',
		status: plan.status,
		plan,
		findings: Object.freeze([]),
		completedTargets: Object.freeze(completedTargets),
		failedTargets: Object.freeze(failedTargets),
		retryable: plan.status !== 'complete' && Number(plan.attempts || 0) < Number(plan.maxAttempts || DEFAULT_MAX_ATTEMPTS),
	};
}

export function createNoVncCleanupQueue(opts = {}) {
	const plans = new Map();
	const maxAttempts = Number.isFinite(Number(opts.maxAttempts)) ? Number(opts.maxAttempts) : DEFAULT_MAX_ATTEMPTS;
	const allowCompletedRestart = !!opts.allowCompletedRestart;

	function enqueue(record, enqueueOpts = {}) {
		const normalized = normalizeRecordState(record);
		const includeCompletedRestart = enqueueOpts.allowCompletedRestart ?? allowCompletedRestart;
		if (normalized.teardownState === 'complete' && !(includeCompletedRestart && COMPLETED_RESTART_REASONS.has(normalized.teardownReason))) {
			return { queued: false, status: 'already-complete', plan: plans.get(normalized.sessionId) || null, findings: Object.freeze([]) };
		}
		if (normalized.teardownState === 'not-required') {
			return { queued: false, status: 'not-required', plan: null, findings: Object.freeze([]) };
		}
		const validation = validateNoVncCleanupRecord(record, { allowCompletedRestart: includeCompletedRestart });
		if (!validation.ok) {
			return { queued: false, status: 'refused', plan: null, findings: validation.findings };
		}
		const existing = plans.get(normalized.sessionId);
		if (existing && existing.status !== 'complete') {
			return { queued: true, status: existing.status, plan: existing, findings: Object.freeze([]), existing: true };
		}
		const plan = createNoVncCleanupPlan(record, {
			...enqueueOpts,
			allowCompletedRestart: includeCompletedRestart,
			maxAttempts,
			now: enqueueOpts.now ?? opts.now,
		});
		plans.set(plan.sessionId, plan);
		return { queued: true, status: plan.status, plan, findings: Object.freeze([]), existing: false };
	}

	function get(sessionId) {
		return plans.get(cleanString(sessionId)) || null;
	}

	function list() {
		return [...plans.values()].map(publicNoVncCleanupPlan);
	}

	function pending() {
		return [...plans.values()].filter((plan) => ['pending', 'failed'].includes(plan.status) && Number(plan.attempts || 0) < Number(plan.maxAttempts || maxAttempts));
	}

	async function run(sessionId, adapter, runOpts = {}) {
		const plan = get(sessionId);
		if (!plan) return { ok: false, status: 'not-found', plan: null, findings: Object.freeze([cleanupFinding('missing-plan', 'cleanup plan not found', 'sessionId')]), retryable: false };
		return runNoVncCleanupPlan(plan, adapter, { ...runOpts, now: runOpts.now ?? opts.now });
	}

	async function runNext(adapter, runOpts = {}) {
		const plan = pending()[0] || null;
		if (!plan) return { ok: true, status: 'empty', plan: null, findings: Object.freeze([]), retryable: false };
		return run(plan.sessionId, adapter, runOpts);
	}

	return Object.freeze({
		enqueue,
		get,
		list,
		pending,
		run,
		runNext,
	});
}

export function createNoVncFsCleanupAdapter({ root } = {}) {
	const browserRoot = path.resolve(String(root || ''));
	if (!cleanString(root)) throw new Error('cleanup fs adapter requires an explicit browser root');
	return Object.freeze({
		async removePath(target) {
			const targetPath = path.resolve(String(target?.path || ''));
			if (!isStrictlyInsidePath(browserRoot, targetPath)) {
				throw new Error('cleanup target must stay inside the configured browser root');
			}
			await fs.rm(targetPath, { recursive: true, force: true });
			return { removed: true };
		},
	});
}
