// webui/novnc-access.js - fail-closed noVNC access/route authorization and env registry wiring.
//
// Decides whether a request may reach a future authenticated proxy boundary;
// it does not start, proxy, or connect to noVNC.

import { cleanString, rbac } from './novnc-shared.js';
import {
	isNoVncProductionMode,
	validateNoVncExternalBoundary,
	validateNoVncRegistryIsolation,
} from './novnc-isolation.js';
import {
	createNoVncSessionRegistry,
	noVncSessionExpiry,
	publicNoVncSession,
} from './novnc-sessions.js';

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
