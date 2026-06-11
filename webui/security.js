// webui/security.js - authenticated request context and security metadata.
//
// Local pilot remains the default. External mode is intentionally fail-closed:
// if WEBUI_EXTERNAL_MODE=1 is set, every page/API/artifact/SSE request requires
// an authenticated tenant-scoped principal before the route can spawn, stream,
// or read anything.

import crypto from 'node:crypto';
import { isSecretBearingPath } from './secrets.js';
export {
	FIXTURE_IDP_SECRET,
	createFixtureAuthProxyHeaders,
	createFixtureJwt,
	createFixtureSamlAssertion,
	idpVerifierCapabilitySummary,
	verifyAuthProxyFixtureHeaders,
	verifyOidcFixtureJwt,
	verifySamlFixtureAssertion,
} from './idp-verifier.js';

const TRUE_RE = /^(1|true|yes|on)$/i;
const TOKEN_RE = /^[A-Za-z0-9._~+/=-]{16,}$/;
const TENANT_RE = /^[A-Za-z0-9_-]{1,80}$/;
const ACTOR_RE = /^[A-Za-z0-9_.@-]{1,120}$/;
const CLAIM_NAME_RE = /^[A-Za-z0-9_.:/@-]{1,160}$/;
const SESSION_COOKIE = 'aqa_webui_token';
const COOKIE_NAME_RE = /^[A-Za-z0-9_~-]{1,80}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,80}$/;
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const AUTH_PROVIDER_ALIASES = Object.freeze({
	'local': 'local-pilot',
	'local-pilot': 'local-pilot',
	'pilot': 'local-pilot',
	'static': 'static',
	'token': 'static',
	'fixture': 'static',
	'oidc': 'oidc',
	'openid-connect': 'oidc',
	'saml': 'saml',
	'saml2': 'saml',
	'auth-proxy': 'auth-proxy',
	'external-proxy': 'auth-proxy',
	'trusted-proxy': 'auth-proxy',
});
const CORS_ALLOWED_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const CORS_ALLOWED_HEADERS = Object.freeze(['authorization', 'content-type', 'x-aqa-csrf', 'x-aqa-tenant', 'x-tenant-id']);
const LOGGED_OUT_SESSION_IDS = new Set();
const CLAIM_FIELDS = Object.freeze(['user', 'tenant', 'role']);
const CLAIM_MAPPING_ENV = Object.freeze({
	oidc: Object.freeze({
		user: Object.freeze(['WEBUI_OIDC_USER_CLAIM', 'AQA_WEBUI_OIDC_USER_CLAIM', 'WEBUI_OIDC_CLAIM_USER', 'AQA_WEBUI_OIDC_CLAIM_USER', 'WEBUI_IDP_USER_CLAIM', 'AQA_WEBUI_IDP_USER_CLAIM']),
		tenant: Object.freeze(['WEBUI_OIDC_TENANT_CLAIM', 'AQA_WEBUI_OIDC_TENANT_CLAIM', 'WEBUI_OIDC_CLAIM_TENANT', 'AQA_WEBUI_OIDC_CLAIM_TENANT', 'WEBUI_IDP_TENANT_CLAIM', 'AQA_WEBUI_IDP_TENANT_CLAIM']),
		role: Object.freeze(['WEBUI_OIDC_ROLE_CLAIM', 'AQA_WEBUI_OIDC_ROLE_CLAIM', 'WEBUI_OIDC_CLAIM_ROLE', 'AQA_WEBUI_OIDC_CLAIM_ROLE', 'WEBUI_IDP_ROLE_CLAIM', 'AQA_WEBUI_IDP_ROLE_CLAIM']),
	}),
	saml: Object.freeze({
		user: Object.freeze(['WEBUI_SAML_USER_ATTRIBUTE', 'AQA_WEBUI_SAML_USER_ATTRIBUTE', 'WEBUI_SAML_ATTRIBUTE_USER', 'AQA_WEBUI_SAML_ATTRIBUTE_USER', 'WEBUI_SAML_USER_CLAIM', 'AQA_WEBUI_SAML_USER_CLAIM', 'WEBUI_IDP_USER_CLAIM', 'AQA_WEBUI_IDP_USER_CLAIM']),
		tenant: Object.freeze(['WEBUI_SAML_TENANT_ATTRIBUTE', 'AQA_WEBUI_SAML_TENANT_ATTRIBUTE', 'WEBUI_SAML_ATTRIBUTE_TENANT', 'AQA_WEBUI_SAML_ATTRIBUTE_TENANT', 'WEBUI_SAML_TENANT_CLAIM', 'AQA_WEBUI_SAML_TENANT_CLAIM', 'WEBUI_IDP_TENANT_CLAIM', 'AQA_WEBUI_IDP_TENANT_CLAIM']),
		role: Object.freeze(['WEBUI_SAML_ROLE_ATTRIBUTE', 'AQA_WEBUI_SAML_ROLE_ATTRIBUTE', 'WEBUI_SAML_ATTRIBUTE_ROLE', 'AQA_WEBUI_SAML_ATTRIBUTE_ROLE', 'WEBUI_SAML_ROLE_CLAIM', 'AQA_WEBUI_SAML_ROLE_CLAIM', 'WEBUI_IDP_ROLE_CLAIM', 'AQA_WEBUI_IDP_ROLE_CLAIM']),
	}),
	'auth-proxy': Object.freeze({
		user: Object.freeze(['WEBUI_AUTH_PROXY_HEADER_USER', 'AQA_WEBUI_AUTH_PROXY_HEADER_USER']),
		tenant: Object.freeze(['WEBUI_AUTH_PROXY_HEADER_TENANT', 'AQA_WEBUI_AUTH_PROXY_HEADER_TENANT']),
		role: Object.freeze(['WEBUI_AUTH_PROXY_HEADER_ROLE', 'AQA_WEBUI_AUTH_PROXY_HEADER_ROLE']),
	}),
});
const CLAIM_MAPPING_LABEL = Object.freeze({
	oidc: Object.freeze({
		user: 'WEBUI_OIDC_USER_CLAIM',
		tenant: 'WEBUI_OIDC_TENANT_CLAIM',
		role: 'WEBUI_OIDC_ROLE_CLAIM',
	}),
	saml: Object.freeze({
		user: 'WEBUI_SAML_USER_ATTRIBUTE',
		tenant: 'WEBUI_SAML_TENANT_ATTRIBUTE',
		role: 'WEBUI_SAML_ROLE_ATTRIBUTE',
	}),
	'auth-proxy': Object.freeze({
		user: 'WEBUI_AUTH_PROXY_HEADER_USER',
		tenant: 'WEBUI_AUTH_PROXY_HEADER_TENANT',
		role: 'WEBUI_AUTH_PROXY_HEADER_ROLE',
	}),
});

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

function cleanString(value) {
	return typeof value === 'string' ? value.trim() : '';
}

function bool(value) {
	if (value === true || value === 1) return true;
	return TRUE_RE.test(String(value || ''));
}

function boolEnv(value, fallback = false) {
	if (value == null || value === '') return fallback;
	if (/^(0|false|no|off)$/i.test(String(value))) return false;
	return bool(value);
}

function splitList(value) {
	return String(value || '').split(',').map((part) => part.trim()).filter(Boolean);
}

function normalizeAuthProviderName(value, external) {
	const raw = cleanString(value || (external ? 'static' : 'local-pilot')).toLowerCase();
	return AUTH_PROVIDER_ALIASES[raw] || raw || (external ? 'static' : 'local-pilot');
}

function urlMetadata(value, label, { required = true, httpsOnly = true } = {}) {
	const raw = cleanString(value);
	if (!raw) {
		return { ok: !required, value: '', origin: '', host: '', error: required ? `${label} is required` : '' };
	}
	try {
		const url = new URL(raw);
		if (!['http:', 'https:'].includes(url.protocol)) {
			return { ok: false, value: raw, origin: '', host: '', error: `${label} must be http(s)` };
		}
		if (httpsOnly && url.protocol !== 'https:') {
			return { ok: false, value: raw, origin: '', host: '', error: `${label} must use https` };
		}
		return { ok: true, value: raw, origin: url.origin, host: url.host.toLowerCase(), error: '' };
	} catch {
		return { ok: false, value: raw, origin: '', host: '', error: `${label} must be a valid URL` };
	}
}

function requireCleanValue(value, label, re) {
	const text = cleanString(value);
	if (!text) return `${label} is required`;
	if (re && !re.test(text)) return `${label} is invalid`;
	return '';
}

function fingerprintConfigured(value) {
	const text = cleanString(value);
	return !!text && /^[A-Fa-f0-9:]{32,200}$/.test(text);
}

function envFirst(env, names) {
	for (const name of names || []) {
		const value = cleanString(env[name]);
		if (value) return { key: name, value };
	}
	return { key: '', value: '' };
}

function freezePlainObject(obj) {
	return Object.freeze({ ...(obj || {}) });
}

function validateDistinctMapping(type, values) {
	const errors = [];
	const seen = new Map();
	for (const field of CLAIM_FIELDS) {
		const value = cleanString(values[field]).toLowerCase();
		if (!value) continue;
		const previous = seen.get(value);
		if (previous) {
			const noun = type === 'auth-proxy' ? 'headers' : 'claims';
			errors.push(`${type} ${previous} and ${field} ${noun} must be distinct`);
		} else {
			seen.set(value, field);
		}
	}
	return errors;
}

export function providerClaimMappingConfig(type, env = process.env) {
	const normalized = normalizeAuthProviderName(type || env.WEBUI_AUTH_PROVIDER || env.AQA_WEBUI_AUTH_PROVIDER || '', isExternalMode(env));
	const envMap = CLAIM_MAPPING_ENV[normalized];
	if (!envMap) {
		return Object.freeze({
			type: normalized,
			required: false,
			valid: true,
			source: 'not-required',
			fields: Object.freeze({}),
			configuredKeys: Object.freeze({}),
			errors: Object.freeze([]),
		});
	}

	const errors = [];
	const fields = {};
	const configuredKeys = {};
	const re = normalized === 'auth-proxy' ? HEADER_NAME_RE : CLAIM_NAME_RE;
	const source = normalized === 'auth-proxy' ? 'trusted-proxy-headers' : `${normalized}-claims`;
	for (const field of CLAIM_FIELDS) {
		const label = CLAIM_MAPPING_LABEL[normalized]?.[field] || `${normalized}.${field}`;
		const picked = envFirst(env, envMap[field]);
		if (!picked.value) {
			errors.push(`${label} is required`);
			continue;
		}
		if (!re.test(picked.value)) {
			errors.push(`${label} is invalid`);
			continue;
		}
		fields[field] = normalized === 'auth-proxy' ? picked.value.toLowerCase() : picked.value;
		configuredKeys[field] = picked.key;
	}
	errors.push(...validateDistinctMapping(normalized, fields));

	return Object.freeze({
		type: normalized,
		required: true,
		valid: errors.length === 0,
		source,
		fields: freezePlainObject(fields),
		configuredKeys: freezePlainObject(configuredKeys),
		errors: Object.freeze(errors),
	});
}

function providerCapabilities({ type, external, configured, valid, integrated, claimMapping, errors, warnings }) {
	const metadataValidated = ['oidc', 'saml', 'auth-proxy'].includes(type);
	const liveOidc = type === 'oidc';
	const liveSaml = type === 'saml';
	return Object.freeze({
		type,
		configured,
		valid,
		integrated,
		deterministic: true,
		liveIdpIntegrated: false,
		validatesProviderMetadata: metadataValidated,
		validatesClaimMapping: !!claimMapping.required,
		requiredClaims: Object.freeze(claimMapping.required ? CLAIM_FIELDS.slice() : []),
		claimMapping: Object.freeze({
			required: !!claimMapping.required,
			valid: !!claimMapping.valid,
			source: claimMapping.source,
			fields: freezePlainObject(claimMapping.fields),
			errors: Object.freeze(claimMapping.errors || []),
		}),
		supports: Object.freeze({
			bearerAuthMaterial: type !== 'local-pilot',
			sessionCookieAuthMaterial: type !== 'local-pilot',
			fixtureOidcJwtVerification: type === 'oidc',
			fixtureSamlAssertionVerification: type === 'saml',
			fixtureAuthProxyHeaderVerification: type === 'auth-proxy',
			liveOidcCodeFlow: false,
			liveOidcJwtVerification: false,
			liveSamlAssertionHandling: false,
			trustedProxyHeaderAuth: false,
		}),
		notes: Object.freeze([
			...(liveOidc ? ['OIDC readiness is metadata and claim-map validation only; live OIDC login/JWT verification is not integrated'] : []),
			...(liveSaml ? ['SAML readiness is metadata and attribute-map validation only; live SAML assertion handling is not integrated'] : []),
			...(type === 'auth-proxy' ? ['Auth-proxy readiness validates the declared proxy boundary and headers; header values are not trusted directly by this build'] : []),
			...(warnings || []),
		]),
		errors: Object.freeze(errors || []),
	});
}

export function authProviderConfig(env = process.env) {
	const external = isExternalMode(env);
	const type = normalizeAuthProviderName(env.WEBUI_AUTH_PROVIDER || env.AQA_WEBUI_AUTH_PROVIDER || '', external);
	const errors = [];
	const warnings = [];
	const details = {};
	const claimMapping = providerClaimMappingConfig(type, env);

	if (!['local-pilot', 'static', 'oidc', 'saml', 'auth-proxy'].includes(type)) {
		errors.push(`WEBUI_AUTH_PROVIDER "${type}" is not supported`);
	}
	if (external && type === 'local-pilot') {
		errors.push('local-pilot auth provider is not allowed in external mode');
	}

	if (type === 'oidc') {
		const issuer = urlMetadata(env.WEBUI_OIDC_ISSUER || env.AQA_WEBUI_OIDC_ISSUER, 'WEBUI_OIDC_ISSUER');
		const discovery = urlMetadata(env.WEBUI_OIDC_DISCOVERY_URL || env.AQA_WEBUI_OIDC_DISCOVERY_URL, 'WEBUI_OIDC_DISCOVERY_URL', { required: false });
		const jwks = urlMetadata(env.WEBUI_OIDC_JWKS_URI || env.AQA_WEBUI_OIDC_JWKS_URI, 'WEBUI_OIDC_JWKS_URI', { required: false });
		if (!issuer.ok) errors.push(issuer.error);
		if (discovery.error) errors.push(discovery.error);
		if (jwks.error) errors.push(jwks.error);
		const clientIdError = requireCleanValue(env.WEBUI_OIDC_CLIENT_ID || env.AQA_WEBUI_OIDC_CLIENT_ID, 'WEBUI_OIDC_CLIENT_ID');
		if (clientIdError) errors.push(clientIdError);
		details.issuerOrigin = issuer.origin || null;
		details.discoveryOrigin = discovery.origin || null;
		details.jwksOrigin = jwks.origin || null;
		details.clientIdConfigured = !clientIdError;
		warnings.push('OIDC provider metadata is validated only; live token exchange/JWT verification is not integrated in this build');
	}

	if (type === 'saml') {
		const sso = urlMetadata(env.WEBUI_SAML_SSO_URL || env.AQA_WEBUI_SAML_SSO_URL, 'WEBUI_SAML_SSO_URL');
		if (!sso.ok) errors.push(sso.error);
		const entityError = requireCleanValue(env.WEBUI_SAML_ENTITY_ID || env.AQA_WEBUI_SAML_ENTITY_ID, 'WEBUI_SAML_ENTITY_ID');
		if (entityError) errors.push(entityError);
		if (!fingerprintConfigured(env.WEBUI_SAML_CERT_FINGERPRINT || env.AQA_WEBUI_SAML_CERT_FINGERPRINT)) {
			errors.push('WEBUI_SAML_CERT_FINGERPRINT is required');
		}
		details.ssoOrigin = sso.origin || null;
		details.entityIdConfigured = !entityError;
		details.certFingerprintConfigured = fingerprintConfigured(env.WEBUI_SAML_CERT_FINGERPRINT || env.AQA_WEBUI_SAML_CERT_FINGERPRINT);
		warnings.push('SAML provider metadata is validated only; live assertion handling is not integrated in this build');
	}

	if (type === 'auth-proxy') {
		const issuer = cleanString(env.WEBUI_AUTH_PROXY_ISSUER || env.AQA_WEBUI_AUTH_PROXY_ISSUER || '');
		if (!issuer) errors.push('WEBUI_AUTH_PROXY_ISSUER is required');
		if (!boolEnv(env.WEBUI_AUTH_PROXY_TRUSTED || env.AQA_WEBUI_AUTH_PROXY_TRUSTED, false)) {
			errors.push('WEBUI_AUTH_PROXY_TRUSTED=1 is required to declare an authenticated proxy boundary');
		}
		details.issuerConfigured = !!issuer;
		warnings.push('Auth-proxy headers are not trusted directly by this build; a deterministic bearer/session guard is still required');
	}
	if (claimMapping.required) {
		details.claimMapping = Object.freeze({
			required: true,
			valid: claimMapping.valid,
			source: claimMapping.source,
			fields: claimMapping.fields,
			configuredKeys: claimMapping.configuredKeys,
		});
		if (!claimMapping.valid) errors.push(...claimMapping.errors);
	}

	const configured = errors.length === 0 && (type === 'local-pilot' ? !external : true);
	const capabilities = providerCapabilities({
		type,
		external,
		configured,
		valid: errors.length === 0,
		integrated: type === 'static' || type === 'local-pilot',
		claimMapping,
		errors,
		warnings,
	});
	return Object.freeze({
		type,
		configured,
		valid: errors.length === 0,
		integrated: type === 'static' || type === 'local-pilot',
		errors: Object.freeze(errors),
		warnings: Object.freeze(warnings),
		details: Object.freeze(details),
		capabilities,
	});
}

export function authProviderCapabilitySummary(env = process.env) {
	return authProviderConfig(env).capabilities;
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
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string') {
		const raw = value.trim();
		const n = Number(raw);
		if (Number.isFinite(n) && /^\d+$/.test(raw)) return n;
		const t = Date.parse(raw);
		if (Number.isFinite(t)) return t;
	}
	throw new Error(`${label} must be a finite epoch ms value or ISO timestamp`);
}

function iso(ms) {
	return new Date(ms).toISOString();
}

function configuredSessionTtlMs(env = process.env) {
	const raw = cleanString(env.WEBUI_SESSION_TTL_SECONDS || env.AQA_WEBUI_SESSION_TTL_SECONDS || '');
	if (!raw) return DEFAULT_SESSION_TTL_MS;
	const seconds = Number(raw);
	if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_SESSION_TTL_MS;
	return Math.floor(seconds * 1000);
}

export function sessionCookieName(env = process.env) {
	const configured = cleanString(env.WEBUI_SESSION_COOKIE_NAME || env.AQA_WEBUI_SESSION_COOKIE_NAME || '');
	return COOKIE_NAME_RE.test(configured) ? configured : SESSION_COOKIE;
}

function normalizeSameSite(value) {
	const text = cleanString(value || 'Strict').toLowerCase();
	if (text === 'none') return 'None';
	if (text === 'lax') return 'Lax';
	return 'Strict';
}

export function sessionCookieOptions(env = process.env) {
	const sameSite = normalizeSameSite(env.WEBUI_SESSION_SAMESITE || env.WEBUI_COOKIE_SAMESITE || 'Strict');
	const secureRaw = env.WEBUI_SESSION_SECURE ?? env.WEBUI_COOKIE_SECURE;
	const secure = isExternalMode(env) || boolEnv(secureRaw, sameSite === 'None');
	return Object.freeze({
		name: sessionCookieName(env),
		path: '/',
		httpOnly: true,
		secure: secure || sameSite === 'None',
		sameSite,
		maxAgeSeconds: Math.floor(configuredSessionTtlMs(env) / 1000),
	});
}

function configuredPublicUrl(env = process.env) {
	return cleanString(
		env.WEBUI_PUBLIC_URL
		|| env.AQA_WEBUI_PUBLIC_URL
		|| env.WEBUI_EXTERNAL_URL
		|| env.AQA_WEBUI_EXTERNAL_URL
		|| env.WEBUI_BASE_URL
		|| env.AQA_WEBUI_BASE_URL
		|| env.WEBUI_PUBLIC_ORIGIN
		|| env.AQA_WEBUI_PUBLIC_ORIGIN
		|| ''
	);
}

export function sessionCookieDeploymentPreflight(env = process.env) {
	const external = isExternalMode(env);
	const opts = sessionCookieOptions(env);
	const errors = [];
	const warnings = [];
	if (!external) {
		return Object.freeze({
			ok: true,
			external: false,
			httpsRequired: false,
			publicOrigin: '',
			cookie: opts,
			errors: Object.freeze([]),
			warnings: Object.freeze([]),
		});
	}

	const publicUrl = urlMetadata(configuredPublicUrl(env), 'WEBUI_PUBLIC_URL');
	if (!publicUrl.ok) errors.push(publicUrl.error);
	const configuredName = cleanString(env.WEBUI_SESSION_COOKIE_NAME || env.AQA_WEBUI_SESSION_COOKIE_NAME || '');
	if (configuredName && !COOKIE_NAME_RE.test(configuredName)) {
		errors.push('WEBUI_SESSION_COOKIE_NAME is invalid');
	}
	const sameSiteRaw = cleanString(env.WEBUI_SESSION_SAMESITE || env.WEBUI_COOKIE_SAMESITE || '');
	if (sameSiteRaw && !/^(strict|lax|none)$/i.test(sameSiteRaw)) {
		errors.push('WEBUI_SESSION_SAMESITE must be Strict, Lax, or None');
	}
	const ttlRaw = cleanString(env.WEBUI_SESSION_TTL_SECONDS || env.AQA_WEBUI_SESSION_TTL_SECONDS || '');
	if (ttlRaw) {
		const ttl = Number(ttlRaw);
		if (!Number.isFinite(ttl) || ttl <= 0) errors.push('WEBUI_SESSION_TTL_SECONDS must be a positive number');
	}
	if (!opts.httpOnly) errors.push('session cookie must be HttpOnly');
	if (!opts.secure) errors.push('session cookie must be Secure in external mode');
	if (opts.sameSite === 'None' && !opts.secure) errors.push('SameSite=None requires Secure session cookies');
	if (opts.maxAgeSeconds <= 0) errors.push('session cookie Max-Age must be positive');
	if (/^(0|false|no|off)$/i.test(String(env.WEBUI_SESSION_SECURE ?? env.WEBUI_COOKIE_SECURE ?? ''))) {
		warnings.push('external mode forces Secure session cookies even when WEBUI_SESSION_SECURE is disabled');
	}

	return Object.freeze({
		ok: errors.length === 0,
		external: true,
		httpsRequired: true,
		publicOrigin: publicUrl.origin || '',
		cookie: opts,
		errors: Object.freeze(errors),
		warnings: Object.freeze(warnings),
	});
}

function encodeCookieValue(value) {
	return encodeURIComponent(String(value || ''));
}

function serializeCookie({ name, value, path = '/', httpOnly = true, secure = false, sameSite = 'Strict', maxAgeSeconds = null, expires = null }) {
	const parts = [`${name}=${encodeCookieValue(value)}`, `Path=${path || '/'}`];
	if (httpOnly) parts.push('HttpOnly');
	if (secure) parts.push('Secure');
	if (sameSite) parts.push(`SameSite=${sameSite}`);
	if (maxAgeSeconds != null) parts.push(`Max-Age=${Math.max(0, Math.floor(Number(maxAgeSeconds) || 0))}`);
	if (expires) parts.push(`Expires=${expires instanceof Date ? expires.toUTCString() : String(expires)}`);
	return parts.join('; ');
}

export function sessionCookieHeader(sessionId, { env = process.env, maxAgeSeconds = null, expires = null } = {}) {
	const opts = sessionCookieOptions(env);
	return serializeCookie({
		...opts,
		value: sessionId,
		maxAgeSeconds: maxAgeSeconds == null ? opts.maxAgeSeconds : maxAgeSeconds,
		expires,
	});
}

export function clearSessionCookieHeader(env = process.env) {
	return serializeCookie({
		...sessionCookieOptions(env),
		value: '',
		maxAgeSeconds: 0,
		expires: new Date(0),
	});
}

function normalizePrincipal(entry, env, index, source) {
	const token = cleanString(entry?.token);
	const actorId = cleanString(entry?.id || entry?.actorId || entry?.user || entry?.username || entry?.name || `user_${index + 1}`);
	const role = cleanString(entry?.role || 'viewer');
	const tenantId = cleanString(entry?.tenantId || entry?.tenant || configuredTenant(env));
	if (!TOKEN_RE.test(token)) return null;
	if (!ACTOR_RE.test(actorId)) return null;
	if (!tenantId || !TENANT_RE.test(tenantId)) return null;
	return Object.freeze({ token, id: actorId, role, tenantId, source });
}

function parsePrincipalJson(raw, env) {
	try {
		const parsed = JSON.parse(raw);
		const entries = Array.isArray(parsed)
			? parsed
			: parsed && typeof parsed === 'object'
				? Object.entries(parsed).map(([token, value]) => ({ ...(value && typeof value === 'object' ? value : {}), token }))
				: [];
		return { principals: entries.map((entry, i) => normalizePrincipal(entry, env, i, 'auth-users')).filter(Boolean), error: '' };
	} catch {
		return { principals: [], error: 'WEBUI_AUTH_USERS must be valid JSON' };
	}
}

function normalizeSession(entry, env, index, source, now = Date.now()) {
	const sessionId = cleanString(entry?.sessionId || entry?.session || entry?.sid || entry?.cookie || entry?.token);
	if (!TOKEN_RE.test(sessionId)) return null;
	const createdMs = toTimeMs(entry?.createdAt || entry?.issuedAt || entry?.iat, nowMs(now), `session[${index}].createdAt`);
	let expiresMs;
	if (entry?.expiresAt != null || entry?.exp != null) {
		expiresMs = toTimeMs(entry?.expiresAt ?? entry?.exp, createdMs + configuredSessionTtlMs(env), `session[${index}].expiresAt`);
	} else if (entry?.ttlMs != null || entry?.ttlSeconds != null) {
		const ttl = entry?.ttlMs != null ? Number(entry.ttlMs) : Number(entry.ttlSeconds) * 1000;
		if (!Number.isFinite(ttl) || ttl <= 0) return null;
		expiresMs = createdMs + ttl;
	} else {
		expiresMs = createdMs + configuredSessionTtlMs(env);
	}
	const actorId = cleanString(entry?.actorId || entry?.user || entry?.username || entry?.actor?.id || entry?.name || `session_user_${index + 1}`);
	const role = cleanString(entry?.role || entry?.actor?.role || 'viewer');
	const tenantId = cleanString(entry?.tenantId || entry?.tenant || configuredTenant(env));
	if (!ACTOR_RE.test(actorId)) return null;
	if (!tenantId || !TENANT_RE.test(tenantId)) return null;
	const csrfToken = cleanString(entry?.csrfToken || entry?.csrf || entry?.csrfHeader || '');
	return Object.freeze({
		sessionId,
		id: actorId,
		role,
		tenantId,
		source,
		createdAt: iso(createdMs),
		createdAtMs: createdMs,
		expiresAt: iso(expiresMs),
		expiresAtMs: expiresMs,
		loggedOut: bool(entry?.loggedOut) || bool(entry?.logout) || bool(entry?.revoked),
		csrfToken,
	});
}

function parseSessionJson(raw, env, now = Date.now()) {
	try {
		const parsed = JSON.parse(raw);
		const entries = Array.isArray(parsed)
			? parsed
			: parsed && typeof parsed === 'object'
				? Object.entries(parsed).map(([sessionId, value]) => ({ ...(value && typeof value === 'object' ? value : {}), sessionId }))
				: [];
		return { sessions: entries.map((entry, i) => normalizeSession(entry, env, i, 'auth-sessions', now)).filter(Boolean), error: '' };
	} catch {
		return { sessions: [], error: 'WEBUI_AUTH_SESSIONS must be valid JSON' };
	}
}

function configuredAuthSessions(env = process.env, { now = Date.now() } = {}) {
	const rawSessions = cleanString(env.WEBUI_AUTH_SESSIONS || env.AQA_WEBUI_AUTH_SESSIONS || '');
	if (!rawSessions) return { sessions: [], source: 'auth-sessions', configured: false, error: '' };
	const parsed = parseSessionJson(rawSessions, env, now);
	return { ...parsed, source: 'auth-sessions', configured: parsed.sessions.length > 0 };
}

function configuredAuthPrincipals(env = process.env) {
	const rawUsers = cleanString(env.WEBUI_AUTH_USERS || env.AQA_WEBUI_AUTH_USERS || '');
	if (rawUsers) {
		const parsed = parsePrincipalJson(rawUsers, env);
		return { ...parsed, source: 'auth-users', configured: parsed.principals.length > 0 };
	}
	const token = cleanString(env.WEBUI_AUTH_TOKEN || env.AQA_WEBUI_AUTH_TOKEN || '');
	const tenantId = configuredTenant(env);
	if (!TOKEN_RE.test(token) || !tenantId) {
		return { principals: [], source: 'legacy-token', configured: false, error: '' };
	}
	const actor = configuredActor(env);
	const principal = normalizePrincipal({ token, id: actor.id, role: actor.role, tenantId }, env, 0, 'legacy-token');
	return { principals: principal ? [principal] : [], source: 'legacy-token', configured: !!principal, error: '' };
}

function configuredAuthMaterial(env = process.env, opts = {}) {
	const principals = configuredAuthPrincipals(env);
	const sessions = configuredAuthSessions(env, opts);
	return {
		principals,
		sessions,
		configured: principals.configured || sessions.configured,
		error: principals.error || sessions.error || '',
	};
}

export function createSessionRecord(input, { env = process.env, now = Date.now(), ttlMs = configuredSessionTtlMs(env) } = {}) {
	const createdAt = nowMs(now);
	return normalizeSession({
		...(input || {}),
		createdAt: input?.createdAt ?? createdAt,
		expiresAt: input?.expiresAt ?? (createdAt + ttlMs),
	}, env, 0, 'created-session', now);
}

export function sessionExpired(session, now = Date.now()) {
	return !!session && nowMs(now) >= Number(session.expiresAtMs);
}

export function sessionLoggedOut(session) {
	return !!session && (session.loggedOut || LOGGED_OUT_SESSION_IDS.has(session.sessionId));
}

export function validateSessionRecord(session, { now = Date.now() } = {}) {
	if (!session) return { ok: false, code: 401, error: 'unauthorized', reason: 'valid session cookie required' };
	if (sessionLoggedOut(session)) return { ok: false, code: 401, error: 'session expired', reason: 'session is logged out' };
	if (sessionExpired(session, now)) return { ok: false, code: 401, error: 'session expired', reason: 'session is expired' };
	return { ok: true, session };
}

export function logoutSessionId(sessionId) {
	const id = cleanString(sessionId);
	if (!id) return false;
	LOGGED_OUT_SESSION_IDS.add(id);
	return true;
}

export function resetLoggedOutSessionsForTests() {
	LOGGED_OUT_SESSION_IDS.clear();
}

function unique(values) {
	return [...new Set(values.filter(Boolean))];
}

export function securityModeSummary(env = process.env) {
	const external = isExternalMode(env);
	const csrf = cleanString(env.WEBUI_CSRF_TOKEN || env.AQA_WEBUI_CSRF_TOKEN || '');
	const provider = authProviderConfig(env);
	const cors = configuredCorsPolicy(env);
	const authConfig = configuredAuthMaterial(env);
	const principals = authConfig.principals.principals;
	const sessions = authConfig.sessions.sessions;
	const cookiePreflight = sessionCookieDeploymentPreflight(env);
	const sessionCookieRequired = external && sessions.length > 0;
	const tenants = unique([...principals.map((p) => p.tenantId), ...sessions.map((s) => s.tenantId)]);
	const tenantId = configuredTenant(env) || (tenants.length === 1 ? tenants[0] : '');
	const actor = principals.length === 1 && sessions.length === 0
		? { id: principals[0].id, role: principals[0].role, tenantId: principals[0].tenantId }
		: configuredActor(env);
	const configured = !external || (provider.valid && cors.ok && authConfig.configured && (!sessionCookieRequired || cookiePreflight.ok));
	const authMode = external
		? principals.length && sessions.length
			? 'bearer-token-or-session-cookie-required'
			: sessions.length
				? 'session-cookie-required'
				: authConfig.principals.source === 'auth-users'
					? 'tenant-principal-token-required'
					: 'bearer-token-required'
		: 'local-loopback';
	return {
		mode: external ? 'external' : 'local-pilot',
		external,
		configured,
		tenantId: tenantId || null,
		tenants,
		actor,
		auth: authMode,
		authPrincipals: external ? principals.length : 1,
		authSessions: external ? sessions.length : 0,
		authProvider: external ? {
			type: provider.type,
			configured: provider.configured,
			valid: provider.valid,
			integrated: provider.integrated,
			errors: provider.errors,
			warnings: provider.warnings,
			details: provider.details,
			capabilities: provider.capabilities,
		} : { type: provider.type, configured: provider.configured, valid: provider.valid, integrated: provider.integrated },
		authConfigError: authConfig.error || provider.errors.join('; ') || cors.errors.join('; ') || (sessionCookieRequired ? cookiePreflight.errors.join('; ') : '') || null,
		csrf: external && csrf ? 'global-header-required' : external ? 'session-token-required-for-cookie-auth' : 'local-origin-only',
		cors: external ? {
			mode: cors.configured ? 'explicit-allowlist' : 'deny-by-default',
			configured: cors.configured,
			allowedOrigins: cors.allowedOrigins,
			errors: cors.errors,
		} : { mode: 'same-origin-local', configured: false },
		sessionCookie: external ? {
			name: sessionCookieName(env),
			sameSite: sessionCookieOptions(env).sameSite,
			secure: sessionCookieOptions(env).secure,
			maxAgeSeconds: sessionCookieOptions(env).maxAgeSeconds,
			preflight: Object.freeze({
				required: sessionCookieRequired,
				ok: cookiePreflight.ok,
				publicOrigin: cookiePreflight.publicOrigin,
				errors: cookiePreflight.errors,
				warnings: cookiePreflight.warnings,
			}),
		} : null,
		noVnc: external ? 'must-be-fronted-or-disabled' : 'loopback-only',
	};
}

function bearerToken(req) {
	const h = String(req?.headers?.authorization || '');
	const m = /^Bearer\s+(.+)$/i.exec(h);
	return m ? m[1].trim() : '';
}

function cookieToken(req, env = process.env) {
	const cookie = String(req?.headers?.cookie || '');
	for (const part of cookie.split(';')) {
		const [rawName, ...rawValue] = part.split('=');
		if (rawName && rawName.trim() === sessionCookieName(env)) {
			try {
				return decodeURIComponent(rawValue.join('=').trim());
			} catch {
				return rawValue.join('=').trim();
			}
		}
	}
	return '';
}

function requestCredential(req, env = process.env) {
	const bearer = bearerToken(req);
	if (bearer) return { token: bearer, scheme: 'bearer' };
	const cookie = cookieToken(req, env);
	if (cookie) return { token: cookie, scheme: 'cookie' };
	return { token: '', scheme: '' };
}

function safeTokenEqual(a, b) {
	const aa = Buffer.from(String(a || ''), 'utf8');
	const bb = Buffer.from(String(b || ''), 'utf8');
	return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}

function findSessionById(sessions, sessionId) {
	return sessions.find((candidate) => safeTokenEqual(sessionId, candidate.sessionId)) || null;
}

function principalFromSession(session) {
	return Object.freeze({
		id: session.id,
		role: session.role,
		tenantId: session.tenantId,
		source: session.source || 'session',
	});
}

function sessionCsrfToken(session, env = process.env) {
	return cleanString(session?.csrfToken || env.WEBUI_CSRF_TOKEN || env.AQA_WEBUI_CSRF_TOKEN || '');
}

function authorizeSessionCredential(sessionId, sessionsConfig, { now = Date.now() } = {}) {
	const session = findSessionById(sessionsConfig.sessions, sessionId);
	if (!session) return { ok: false, code: 401, error: 'unauthorized', reason: 'valid session cookie required' };
	const valid = validateSessionRecord(session, { now });
	if (!valid.ok) return valid;
	return { ok: true, session, principal: principalFromSession(session) };
}

export function logoutSessionFromRequest(req, res, { env = process.env } = {}) {
	const sessionId = cookieToken(req, env);
	const loggedOut = sessionId ? logoutSessionId(sessionId) : false;
	if (res) res.setHeader('Set-Cookie', clearSessionCookieHeader(env));
	return { ok: true, loggedOut };
}

function buildRequestContext({ mode, principal, authScheme, localBypass = false, session = null }) {
	const tenantId = principal.tenantId;
	return Object.freeze({
		mode,
		authenticated: !localBypass,
		localBypass,
		tenant: Object.freeze({ id: tenantId }),
		tenantId,
		actor: Object.freeze({
			id: principal.id,
			role: principal.role,
			tenantId,
		}),
		auth: Object.freeze({
			scheme: authScheme,
			principalSource: principal.source || mode,
			session: session ? Object.freeze({
				expiresAt: session.expiresAt,
				csrfRequired: !!session.csrfToken,
			}) : null,
		}),
	});
}

function sameHostUrl(value, allowedHosts) {
	if (!value) return true;
	try {
		return allowedHosts.has(new URL(String(value)).host.toLowerCase());
	} catch {
		return false;
	}
}

function normalizedOrigin(value) {
	const raw = cleanString(value);
	if (!raw) return '';
	try {
		const url = new URL(raw);
		if (!['http:', 'https:'].includes(url.protocol)) return '';
		return `${url.protocol}//${url.host.toLowerCase()}`;
	} catch {
		return '';
	}
}

function browserSourceAllowed(value, allowedHosts, env = process.env) {
	if (!value) return true;
	if (sameHostUrl(value, allowedHosts)) return true;
	const origin = normalizedOrigin(value);
	if (!origin) return false;
	return configuredCorsPolicy(env).allowedOrigins.includes(origin);
}

export function configuredCorsPolicy(env = process.env) {
	const raw = env.WEBUI_ALLOWED_ORIGINS || env.AQA_WEBUI_ALLOWED_ORIGINS || '';
	const errors = [];
	const allowedOrigins = [];
	for (const entry of splitList(raw)) {
		if (entry === '*') {
			errors.push('WEBUI_ALLOWED_ORIGINS must not use wildcard "*"');
			continue;
		}
		const origin = normalizedOrigin(entry);
		if (!origin) {
			errors.push(`WEBUI_ALLOWED_ORIGINS contains invalid origin "${entry}"`);
			continue;
		}
		allowedOrigins.push(origin);
	}
	return Object.freeze({
		ok: errors.length === 0,
		configured: allowedOrigins.length > 0,
		allowedOrigins: Object.freeze([...new Set(allowedOrigins)]),
		allowedMethods: CORS_ALLOWED_METHODS,
		allowedHeaders: CORS_ALLOWED_HEADERS,
		allowCredentials: true,
		errors: Object.freeze(errors),
	});
}

export function corsResponseHeaders(origin, { env = process.env } = {}) {
	const policy = configuredCorsPolicy(env);
	const normalized = normalizedOrigin(origin);
	if (!policy.ok || !normalized || !policy.allowedOrigins.includes(normalized)) return {};
	return {
		'Access-Control-Allow-Origin': normalized,
		'Access-Control-Allow-Credentials': 'true',
		'Access-Control-Expose-Headers': 'X-AQA-Redaction',
		'Vary': 'Origin',
	};
}

export function authorizeCorsPreflight(req, { env = process.env } = {}) {
	if (!isExternalMode(env)) {
		return { ok: true, code: 204, headers: {}, reason: '' };
	}
	const policy = configuredCorsPolicy(env);
	if (!policy.ok) {
		return { ok: false, code: 503, error: 'cors policy is not configured', reason: policy.errors.join('; ') };
	}
	const origin = normalizedOrigin(req?.headers?.origin || '');
	if (!origin || !policy.allowedOrigins.includes(origin)) {
		return { ok: false, code: 403, error: 'cors origin refused', reason: 'origin is not in WEBUI_ALLOWED_ORIGINS' };
	}
	const requestedMethod = cleanString(req?.headers?.['access-control-request-method'] || '').toUpperCase();
	if (requestedMethod && !policy.allowedMethods.includes(requestedMethod)) {
		return { ok: false, code: 405, error: 'cors method refused', reason: 'requested method is not allowed' };
	}
	const allowedHeaders = new Set(policy.allowedHeaders);
	const requestedHeaders = splitList(String(req?.headers?.['access-control-request-headers'] || '').toLowerCase());
	const deniedHeaders = requestedHeaders.filter((header) => !allowedHeaders.has(header));
	if (deniedHeaders.length) {
		return { ok: false, code: 403, error: 'cors headers refused', reason: `requested headers are not allowed: ${deniedHeaders.join(', ')}` };
	}
	return {
		ok: true,
		code: 204,
		reason: '',
		headers: {
			...corsResponseHeaders(origin, { env }),
			'Access-Control-Allow-Methods': policy.allowedMethods.join(', '),
			'Access-Control-Allow-Headers': policy.allowedHeaders.join(', '),
			'Access-Control-Max-Age': '600',
		},
	};
}

function mutates(method) {
	return ['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(method || '').toUpperCase());
}

function requestedTenant(req) {
	return cleanString(req?.headers?.['x-aqa-tenant'] || req?.headers?.['x-tenant-id'] || '');
}

// Delegate to the canonical secret-path classifier in secrets.js so the URL-route gate and the
// static-file gate (staticFilePolicy) block exactly the same set; a single source prevents drift.
export function secretPathBlocked(pathname) {
	const path = String(pathname || '').split('?')[0];
	if (path === '/api' || path.startsWith('/api/')) return false;
	return isSecretBearingPath(path);
}

export function authenticateRequestContext(req, { env = process.env, now = Date.now() } = {}) {
	if (!isExternalMode(env)) {
		const tenantId = configuredTenant(env) || 'local';
		const actor = configuredActor(env);
		return {
			ok: true,
			context: buildRequestContext({
				mode: 'local-pilot',
				principal: { id: actor.id || 'local', role: actor.role || 'operator', tenantId, source: 'local-pilot' },
				authScheme: 'local-pilot',
				localBypass: true,
			}),
		};
	}

	const provider = authProviderConfig(env);
	if (!provider.valid) {
		return {
			ok: false,
			code: 503,
			error: 'external auth provider is not configured',
			reason: provider.errors.join('; ') || 'WEBUI_AUTH_PROVIDER is not valid',
		};
	}

	const authConfig = configuredAuthMaterial(env, { now });
	if (!authConfig.configured) {
		return {
			ok: false,
			code: 503,
			error: 'external auth is not configured',
			reason: authConfig.error || 'WEBUI_AUTH_TOKEN and WEBUI_TENANT_ID, WEBUI_AUTH_USERS, or WEBUI_AUTH_SESSIONS are required in external mode',
		};
	}
	if (authConfig.sessions.configured) {
		const cookiePreflight = sessionCookieDeploymentPreflight(env);
		if (!cookiePreflight.ok) {
			return {
				ok: false,
				code: 503,
				error: 'session cookie deployment is not configured',
				reason: cookiePreflight.errors.join('; ') || 'WEBUI_PUBLIC_URL and Secure session cookie settings are required',
			};
		}
	}

	const supplied = requestCredential(req, env);
	if (!supplied.token) {
		return { ok: false, code: 401, error: 'unauthorized', reason: 'valid bearer token or session cookie required' };
	}

	if (supplied.scheme === 'cookie') {
		const sessionAuth = authorizeSessionCredential(supplied.token, authConfig.sessions, { now });
		if (!sessionAuth.ok) return sessionAuth;
		return {
			ok: true,
			context: buildRequestContext({
				mode: 'external',
				principal: sessionAuth.principal,
				authScheme: 'cookie',
				session: sessionAuth.session,
			}),
			session: sessionAuth.session,
		};
	}

	const principal = authConfig.principals.principals.find((candidate) => safeTokenEqual(supplied.token, candidate.token));
	if (!principal) {
		return { ok: false, code: 401, error: 'unauthorized', reason: 'valid bearer token or session cookie required' };
	}
	return {
		ok: true,
		context: buildRequestContext({
			mode: 'external',
			principal,
			authScheme: supplied.scheme || 'bearer',
		}),
	};
}

export function authorizeHttpRequest(req, pathname, { allowedHosts = new Set(), env = process.env, now = Date.now() } = {}) {
	if (secretPathBlocked(pathname)) {
		return { ok: false, code: 404, error: 'not found', reason: 'secret-bearing paths are not served' };
	}
	if (isExternalMode(env)) {
		const cors = configuredCorsPolicy(env);
		if (!cors.ok) return { ok: false, code: 503, error: 'cors policy is not configured', reason: cors.errors.join('; ') };
	}
	const auth = authenticateRequestContext(req, { env, now });
	if (!auth.ok) return auth;
	const context = auth.context;

	if (isExternalMode(env)) {
		const tenantHeader = requestedTenant(req);
		if (tenantHeader && (!TENANT_RE.test(tenantHeader) || tenantHeader !== context.tenantId)) {
			return { ok: false, code: 403, error: 'tenant mismatch', reason: 'request tenant does not match authenticated tenant' };
		}
	}

	if (isExternalMode(env) && mutates(req?.method)) {
		const origin = req.headers.origin;
		const referer = req.headers.referer;
		const browserSensitive = context.auth?.scheme === 'cookie' || !!origin || !!referer;
		if (browserSensitive) {
			if (!origin && !referer) {
				return { ok: false, code: 403, error: 'origin or referer required', reason: 'browser mutations require Origin or Referer' };
			}
			if (origin && !browserSourceAllowed(origin, allowedHosts, env)) {
				return { ok: false, code: 403, error: 'cross-origin request refused', reason: 'origin not allowed' };
			}
			if (referer && !browserSourceAllowed(referer, allowedHosts, env)) {
				return { ok: false, code: 403, error: 'cross-origin request refused', reason: 'referer not allowed' };
			}
		}
		if (context.auth?.scheme === 'cookie') {
			const csrf = sessionCsrfToken(auth.session, env);
			if (!csrf) {
				return { ok: false, code: 403, error: 'csrf token required', reason: 'cookie-authenticated mutations require a configured CSRF token' };
			}
			if (!safeTokenEqual(req.headers['x-aqa-csrf'] || '', csrf)) {
				return { ok: false, code: 403, error: 'csrf token required', reason: 'missing or wrong x-aqa-csrf' };
			}
		}
	}

	return {
		ok: true,
		mode: context.mode,
		tenantId: context.tenantId,
		actor: context.actor,
		context,
	};
}

function appendVary(res, value) {
	const current = String(res.getHeader?.('Vary') || '').trim();
	const values = new Set(splitList(current));
	for (const entry of splitList(value)) values.add(entry);
	if (values.size) res.setHeader('Vary', [...values].join(', '));
}

export function applySecurityHeaders(res, { env = process.env, req = null, origin = '' } = {}) {
	res.setHeader('X-Content-Type-Options', 'nosniff');
	res.setHeader('Referrer-Policy', 'same-origin');
	res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
	res.setHeader('X-Frame-Options', 'DENY');
	res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
	if (isExternalMode(env)) {
		res.setHeader('Cache-Control', 'no-store');
		appendVary(res, 'Origin');
		const corsHeaders = corsResponseHeaders(origin || req?.headers?.origin || '', { env });
		for (const [key, value] of Object.entries(corsHeaders)) {
			if (key === 'Vary') appendVary(res, value);
			else res.setHeader(key, value);
		}
	}
}
