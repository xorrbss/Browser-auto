// webui/novnc-sessions.js - noVNC session record normalization, public views, and session registry.
//
// Models tenant/job-scoped session lifecycle (open/terminal states, expiry,
// teardown metadata) without starting or proxying noVNC.

import {
	ACTOR_RE,
	BROWSER_ISOLATION,
	DEFAULT_BROWSER_ROOT,
	DEFAULT_IDLE_TIMEOUT_MS,
	DEFAULT_SESSION_TTL_MS,
	TEARDOWN_REASON_RE,
	TEARDOWN_STATES,
	TENANT_RE,
	bool,
	cleanString,
	generateNoVncSessionId,
	iso,
	nowMs,
	rbac,
	requireId,
	toDurationMs,
	toTimeMs,
} from './novnc-shared.js';
import {
	buildNoVncTeardownManifest,
	deriveNoVncBrowserPaths,
	validateNoVncRegistryIsolation,
} from './novnc-isolation.js';

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
