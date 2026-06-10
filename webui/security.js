// webui/security.js - external-mode request gate and security metadata.
//
// Local pilot remains the default. External mode is intentionally fail-closed:
// if WEBUI_EXTERNAL_MODE=1 is set, every page/API/artifact/SSE request requires
// an explicit bearer token before the route can spawn, stream, or read anything.

const TRUE_RE = /^(1|true|yes|on)$/i;
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,}$/;
const TENANT_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SECRET_PATH_RE = /(^|\/)(fixtures\/auth|fixtures|data|\.git|node_modules|approve\/[^/]+\.pw-state\.json|flows\/[^/]+\.values\.json)(\/|$)/i;
const SECRET_FILE_RE = /\.(state\.json|values\.json|db|sqlite|sqlite3|cookie|cookies|env)$/i;

export function isExternalMode(env = process.env) {
	return TRUE_RE.test(String(env.WEBUI_EXTERNAL_MODE || env.AQA_EXTERNAL_MODE || ''));
}

export function configuredTenant(env = process.env) {
	const tenantId = String(env.WEBUI_TENANT_ID || env.AQA_TENANT_ID || (isExternalMode(env) ? '' : 'local')).trim();
	return tenantId && TENANT_RE.test(tenantId) ? tenantId : '';
}

export function configuredActor(env = process.env) {
	return {
		id: String(env.WEBUI_ACTOR_ID || env.AQA_WEBUI_ACTOR || env.AQA_ACTOR_ID || (isExternalMode(env) ? 'external' : 'local')).trim(),
		role: String(env.WEBUI_ACTOR_ROLE || env.AQA_WEBUI_ROLE || env.AQA_ACTOR_ROLE || (isExternalMode(env) ? 'viewer' : 'operator')).trim(),
	};
}

export function securityModeSummary(env = process.env) {
	const external = isExternalMode(env);
	const token = String(env.WEBUI_AUTH_TOKEN || env.AQA_WEBUI_AUTH_TOKEN || '');
	const csrf = String(env.WEBUI_CSRF_TOKEN || env.AQA_WEBUI_CSRF_TOKEN || '');
	const tenantId = configuredTenant(env);
	const actor = configuredActor(env);
	const configured = !external || (TOKEN_RE.test(token) && !!tenantId);
	return {
		mode: external ? 'external' : 'local-pilot',
		external,
		configured,
		tenantId: tenantId || null,
		actor,
		auth: external ? 'bearer-token-required' : 'local-loopback',
		csrf: external && csrf ? 'header-required' : external ? 'not-configured' : 'local-origin-only',
		noVnc: external ? 'must-be-fronted-or-disabled' : 'loopback-only',
	};
}

function bearerToken(req) {
	const h = String(req?.headers?.authorization || '');
	const m = /^Bearer\s+(.+)$/i.exec(h);
	return m ? m[1].trim() : '';
}

function sameHostUrl(value, allowedHosts) {
	if (!value) return true;
	try {
		return allowedHosts.has(new URL(String(value)).host.toLowerCase());
	} catch {
		return false;
	}
}

function mutates(method) {
	return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase());
}

export function secretPathBlocked(pathname) {
	const p = String(pathname || '').replace(/\\/g, '/');
	return SECRET_PATH_RE.test(p) || SECRET_FILE_RE.test(p);
}

export function authorizeHttpRequest(req, pathname, { allowedHosts = new Set(), env = process.env } = {}) {
	if (secretPathBlocked(pathname)) {
		return { ok: false, code: 404, error: 'not found', reason: 'secret-bearing paths are not served' };
	}
	if (!isExternalMode(env)) {
		return {
			ok: true,
			mode: 'local-pilot',
			tenantId: configuredTenant(env) || 'local',
			actor: configuredActor(env),
		};
	}

	const expected = String(env.WEBUI_AUTH_TOKEN || env.AQA_WEBUI_AUTH_TOKEN || '');
	const tenantId = configuredTenant(env);
	if (!TOKEN_RE.test(expected) || !tenantId) {
		return { ok: false, code: 503, error: 'external auth is not configured', reason: 'WEBUI_AUTH_TOKEN and WEBUI_TENANT_ID are required in external mode' };
	}

	const supplied = bearerToken(req);
	if (!supplied || supplied !== expected) {
		return { ok: false, code: 401, error: 'unauthorized', reason: 'valid bearer token required' };
	}

	if (mutates(req?.method)) {
		const origin = req.headers.origin;
		const referer = req.headers.referer;
		if (!origin && !referer) {
			return { ok: false, code: 403, error: 'origin or referer required', reason: 'external mutating requests require Origin or Referer' };
		}
		if (origin && !sameHostUrl(origin, allowedHosts)) {
			return { ok: false, code: 403, error: 'cross-origin request refused', reason: 'origin not allowed' };
		}
		if (!origin && referer && !sameHostUrl(referer, allowedHosts)) {
			return { ok: false, code: 403, error: 'cross-origin request refused', reason: 'referer not allowed' };
		}
		const csrf = String(env.WEBUI_CSRF_TOKEN || env.AQA_WEBUI_CSRF_TOKEN || '');
		if (csrf && String(req.headers['x-aqa-csrf'] || '') !== csrf) {
			return { ok: false, code: 403, error: 'csrf token required', reason: 'missing or wrong x-aqa-csrf' };
		}
	}

	return {
		ok: true,
		mode: 'external',
		tenantId,
		actor: configuredActor(env),
	};
}

export function applySecurityHeaders(res, { env = process.env } = {}) {
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('Referrer-Policy', 'same-origin');
	res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
	res.setHeader('X-Frame-Options', 'DENY');
	res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	if (isExternalMode(env)) {
		res.setHeader('Cache-Control', 'no-store');
		res.setHeader('Access-Control-Allow-Origin', 'null');
	}
}
