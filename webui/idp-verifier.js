// webui/idp-verifier.js - deterministic fixture IdP verification helpers.
//
// These helpers are intentionally local-test only. They verify signed fixture
// material without contacting a live IdP and never include raw tokens, claims,
// assertions, headers, or signing material in failure results.

import crypto from 'node:crypto';

export const FIXTURE_IDP_SECRET = 'agent-qa-fixture-idp-verifier-v1-test-key';

const ACTOR_RE = /^[A-Za-z0-9_.@-]{1,120}$/;
const TENANT_RE = /^[A-Za-z0-9_-]{1,80}$/;
const CLAIM_NAME_RE = /^[A-Za-z0-9_.:/@-]{1,160}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,80}$/;
const JWT_PART_RE = /^[A-Za-z0-9_-]+$/;
const DEFAULT_ALLOWED_ROLES = Object.freeze(['viewer', 'operator', 'owner', 'admin']);
const DEFAULT_PROXY_HEADERS = Object.freeze({
	issuer: 'x-aqa-fixture-idp-issuer',
	audience: 'x-aqa-fixture-idp-audience',
	expiresAt: 'x-aqa-fixture-idp-exp',
	signature: 'x-aqa-fixture-idp-signature',
	user: 'x-aqa-fixture-user',
	tenant: 'x-aqa-fixture-tenant',
	role: 'x-aqa-fixture-role',
});

function cleanString(value) {
	return typeof value === 'string' ? value.trim() : '';
}

function fail(provider, reason, code = 401) {
	return Object.freeze({
		ok: false,
		code,
		error: 'idp verifier refused',
		reason,
		provider,
	});
}

function ok(provider, principal) {
	return Object.freeze({
		ok: true,
		provider,
		principal: Object.freeze({
			id: principal.id,
			tenantId: principal.tenantId,
			role: principal.role,
			source: `${provider}-fixture`,
		}),
	});
}

function base64UrlEncode(value) {
	return Buffer.from(value).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlDecode(value) {
	const text = String(value || '');
	const padded = text + '='.repeat((4 - (text.length % 4)) % 4);
	return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function hmac(input, secret = FIXTURE_IDP_SECRET) {
	return base64UrlEncode(crypto.createHmac('sha256', String(secret)).update(String(input)).digest());
}

function safeEqualText(a, b) {
	const aa = Buffer.from(String(a || ''), 'utf8');
	const bb = Buffer.from(String(b || ''), 'utf8');
	return aa.length === bb.length && aa.length > 0 && crypto.timingSafeEqual(aa, bb);
}

function canonicalJson(value) {
	if (value === null) return 'null';
	if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
	if (typeof value === 'object') {
		return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
	}
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return JSON.stringify(value);
	}
	return 'null';
}

function nowSeconds(value = Date.now()) {
	const raw = typeof value === 'function' ? value() : value;
	const number = raw instanceof Date ? raw.getTime() : Number(raw);
	if (!Number.isFinite(number)) return Math.floor(Date.now() / 1000);
	return Math.floor(number > 9999999999 ? number / 1000 : number);
}

function toEpochSeconds(value, label) {
	if (value == null || value === '') return NaN;
	if (value instanceof Date) return Math.floor(value.getTime() / 1000);
	if (typeof value === 'number' && Number.isFinite(value)) {
		return Math.floor(value > 9999999999 ? value / 1000 : value);
	}
	if (typeof value === 'string') {
		const text = value.trim();
		if (/^\d+$/.test(text)) return toEpochSeconds(Number(text), label);
		const parsed = Date.parse(text);
		if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
	}
	throw new Error(`${label} must be an epoch seconds, epoch ms, or ISO timestamp value`);
}

function unwrapMapping(mapping) {
	if (!mapping) return {};
	if (mapping.fields && typeof mapping.fields === 'object') return mapping.fields;
	return mapping;
}

function normalizeMapping(mapping, provider, { headers = false } = {}) {
	const raw = unwrapMapping(mapping);
	const re = headers ? HEADER_NAME_RE : CLAIM_NAME_RE;
	const fields = {};
	const seen = new Set();
	for (const field of ['user', 'tenant', 'role']) {
		const value = cleanString(raw?.[field]);
		if (!value || !re.test(value)) return { ok: false, reason: 'claim mapping invalid' };
		const normalized = headers ? value.toLowerCase() : value;
		if (seen.has(normalized.toLowerCase())) return { ok: false, reason: 'claim mapping invalid' };
		fields[field] = normalized;
		seen.add(normalized.toLowerCase());
	}
	return { ok: true, provider, fields: Object.freeze(fields) };
}

function getMappedValue(source, name) {
	if (!source || typeof source !== 'object') return undefined;
	if (Object.prototype.hasOwnProperty.call(source, name)) return source[name];
	let current = source;
	for (const part of String(name).split('.')) {
		if (!part || !current || typeof current !== 'object' || !Object.prototype.hasOwnProperty.call(current, part)) {
			return undefined;
		}
		current = current[part];
	}
	return current;
}

function valueList(value) {
	if (Array.isArray(value)) return value.flatMap((entry) => valueList(entry));
	if (value == null) return [];
	const text = cleanString(String(value));
	return text ? [text] : [];
}

function principalFromClaims(provider, source, mapping, { tenantId = '', allowedRoles = DEFAULT_ALLOWED_ROLES } = {}) {
	const idValues = valueList(getMappedValue(source, mapping.user));
	const tenantValues = valueList(getMappedValue(source, mapping.tenant));
	const roleValues = valueList(getMappedValue(source, mapping.role));
	if (idValues.length !== 1 || tenantValues.length !== 1 || roleValues.length !== 1) {
		return fail(provider, 'required mapped claim missing', 401);
	}
	const id = idValues[0];
	const claimTenant = tenantValues[0];
	const role = roleValues[0];
	if (!ACTOR_RE.test(id) || !TENANT_RE.test(claimTenant)) return fail(provider, 'mapped claim invalid', 401);
	if (tenantId && claimTenant !== tenantId) return fail(provider, 'tenant mismatch', 403);
	const roles = new Set((allowedRoles || DEFAULT_ALLOWED_ROLES).map((entry) => cleanString(entry)).filter(Boolean));
	if (!roles.has(role)) return fail(provider, 'role is not allowed', 403);
	return ok(provider, { id, tenantId: claimTenant, role });
}

function expectedAudienceMatch(actual, expected) {
	const expectedList = valueList(expected);
	if (!expectedList.length) return false;
	const actualList = valueList(actual);
	return actualList.some((entry) => expectedList.includes(entry));
}

function requireExpected(provider, issuer, audience) {
	if (!cleanString(issuer) || !valueList(audience).length) {
		return fail(provider, 'verifier config invalid', 503);
	}
	return null;
}

function parseJwt(token) {
	const parts = String(token || '').split('.');
	if (parts.length !== 3 || parts.some((part) => !JWT_PART_RE.test(part))) return null;
	try {
		return {
			header: JSON.parse(base64UrlDecode(parts[0]).toString('utf8')),
			payload: JSON.parse(base64UrlDecode(parts[1]).toString('utf8')),
			signature: parts[2],
			signingInput: `${parts[0]}.${parts[1]}`,
		};
	} catch {
		return null;
	}
}

export function createFixtureJwt(payload = {}, {
	secret = FIXTURE_IDP_SECRET,
	header = { alg: 'HS256', typ: 'JWT' },
	issuer = '',
	audience = '',
	expiresAt = null,
	expiresInSeconds = 300,
	now = Date.now(),
} = {}) {
	const issuedAt = nowSeconds(now);
	const exp = expiresAt == null ? issuedAt + Number(expiresInSeconds || 300) : toEpochSeconds(expiresAt, 'expiresAt');
	const body = {
		...(payload || {}),
		...(issuer ? { iss: issuer } : {}),
		...(audience ? { aud: audience } : {}),
		iat: payload?.iat ?? issuedAt,
		exp: payload?.exp ?? exp,
	};
	const encodedHeader = base64UrlEncode(JSON.stringify(header));
	const encodedPayload = base64UrlEncode(JSON.stringify(body));
	const signingInput = `${encodedHeader}.${encodedPayload}`;
	return `${signingInput}.${hmac(signingInput, secret)}`;
}

export function verifyOidcFixtureJwt(token, {
	issuer = '',
	audience = '',
	claimMapping = null,
	tenantId = '',
	allowedRoles = DEFAULT_ALLOWED_ROLES,
	secret = FIXTURE_IDP_SECRET,
	now = Date.now(),
	clockSkewSeconds = 0,
} = {}) {
	const provider = 'oidc';
	const expected = requireExpected(provider, issuer, audience);
	if (expected) return expected;
	const mapping = normalizeMapping(claimMapping, provider);
	if (!mapping.ok) return fail(provider, mapping.reason, 503);
	const parsed = parseJwt(token);
	if (!parsed) return fail(provider, 'token format invalid');
	if (parsed.header?.alg !== 'HS256') return fail(provider, 'signature algorithm refused');
	if (!safeEqualText(hmac(parsed.signingInput, secret), parsed.signature)) return fail(provider, 'signature invalid');
	if (cleanString(parsed.payload?.iss) !== cleanString(issuer)) return fail(provider, 'issuer mismatch');
	if (!expectedAudienceMatch(parsed.payload?.aud, audience)) return fail(provider, 'audience mismatch');
	const current = nowSeconds(now);
	const skew = Math.max(0, Number(clockSkewSeconds) || 0);
	if (!Number.isFinite(Number(parsed.payload?.exp)) || Number(parsed.payload.exp) <= current - skew) return fail(provider, 'token expired');
	if (parsed.payload?.nbf != null && Number(parsed.payload.nbf) > current + skew) return fail(provider, 'token not active yet');
	if (parsed.payload?.iat != null && Number(parsed.payload.iat) > current + skew) return fail(provider, 'token issued in future');
	return principalFromClaims(provider, parsed.payload, mapping.fields, { tenantId, allowedRoles });
}

function samlPayload(input = {}) {
	const issuer = cleanString(input.issuer);
	const audience = cleanString(input.audience);
	const subject = cleanString(input.subject || input.nameId || input.user);
	const tenantId = cleanString(input.tenantId || input.tenant);
	const role = cleanString(input.role || 'viewer');
	const now = nowSeconds(input.now ?? Date.now());
	const notBefore = input.notBefore == null ? now - 60 : toEpochSeconds(input.notBefore, 'notBefore');
	const expiresAt = input.expiresAt == null ? now + 300 : toEpochSeconds(input.expiresAt, 'expiresAt');
	return {
		schema: 'agent-qa-fixture-saml-v1',
		issuer,
		audience,
		subject: { nameId: subject },
		conditions: { notBefore, notOnOrAfter: expiresAt },
		attributes: {
			...(input.attributes || {}),
			uid: input.attributes?.uid ?? subject,
			tenant: input.attributes?.tenant ?? tenantId,
			role: input.attributes?.role ?? role,
		},
	};
}

export function createFixtureSamlAssertion(input = {}, { secret = FIXTURE_IDP_SECRET } = {}) {
	const payload = samlPayload(input);
	return Object.freeze({
		...payload,
		signature: Object.freeze({
			alg: 'HS256',
			value: hmac(canonicalJson(payload), secret),
		}),
	});
}

function parseAssertion(assertion) {
	if (!assertion) return null;
	if (typeof assertion === 'string') {
		try {
			return JSON.parse(assertion);
		} catch {
			return null;
		}
	}
	if (typeof assertion === 'object') return assertion;
	return null;
}

export function verifySamlFixtureAssertion(assertion, {
	issuer = '',
	audience = '',
	claimMapping = null,
	tenantId = '',
	allowedRoles = DEFAULT_ALLOWED_ROLES,
	secret = FIXTURE_IDP_SECRET,
	now = Date.now(),
	clockSkewSeconds = 0,
} = {}) {
	const provider = 'saml';
	const expected = requireExpected(provider, issuer, audience);
	if (expected) return expected;
	const mapping = normalizeMapping(claimMapping, provider);
	if (!mapping.ok) return fail(provider, mapping.reason, 503);
	const parsed = parseAssertion(assertion);
	const signature = parsed?.signature;
	if (!parsed || parsed.schema !== 'agent-qa-fixture-saml-v1' || signature?.alg !== 'HS256') {
		return fail(provider, 'assertion format invalid');
	}
	const { signature: _signature, ...unsigned } = parsed;
	if (!safeEqualText(hmac(canonicalJson(unsigned), secret), signature.value)) return fail(provider, 'signature invalid');
	if (cleanString(parsed.issuer) !== cleanString(issuer)) return fail(provider, 'issuer mismatch');
	if (!expectedAudienceMatch(parsed.audience, audience)) return fail(provider, 'audience mismatch');
	const current = nowSeconds(now);
	const skew = Math.max(0, Number(clockSkewSeconds) || 0);
	const notBefore = Number(parsed.conditions?.notBefore);
	const expiresAt = Number(parsed.conditions?.notOnOrAfter);
	if (Number.isFinite(notBefore) && notBefore > current + skew) return fail(provider, 'assertion not active yet');
	if (!Number.isFinite(expiresAt) || expiresAt <= current - skew) return fail(provider, 'assertion expired');
	const claims = {
		...(parsed.attributes || {}),
		nameId: parsed.subject?.nameId,
	};
	return principalFromClaims(provider, claims, mapping.fields, { tenantId, allowedRoles });
}

function normalizeHeaders(headers = {}) {
	const normalized = {};
	for (const [key, value] of Object.entries(headers || {})) {
		normalized[String(key).toLowerCase()] = Array.isArray(value) ? value.join(',') : String(value ?? '');
	}
	return normalized;
}

function proxySignatureInput(headers, names) {
	return canonicalJson({
		issuer: cleanString(headers[names.issuer]),
		audience: cleanString(headers[names.audience]),
		expiresAt: cleanString(headers[names.expiresAt]),
		user: cleanString(headers[names.user]),
		tenant: cleanString(headers[names.tenant]),
		role: cleanString(headers[names.role]),
	});
}

export function createFixtureAuthProxyHeaders(input = {}, {
	secret = FIXTURE_IDP_SECRET,
	claimMapping = null,
	headerNames = {},
	expiresAt = null,
	expiresInSeconds = 300,
	now = Date.now(),
} = {}) {
	const mapping = normalizeMapping(claimMapping || DEFAULT_PROXY_HEADERS, 'auth-proxy', { headers: true });
	const mapped = mapping.ok ? mapping.fields : {
		user: DEFAULT_PROXY_HEADERS.user,
		tenant: DEFAULT_PROXY_HEADERS.tenant,
		role: DEFAULT_PROXY_HEADERS.role,
	};
	const names = {
		...DEFAULT_PROXY_HEADERS,
		...Object.fromEntries(Object.entries(headerNames || {}).map(([key, value]) => [key, cleanString(value).toLowerCase()])),
		...mapped,
	};
	const exp = expiresAt == null ? nowSeconds(now) + Number(expiresInSeconds || 300) : toEpochSeconds(expiresAt, 'expiresAt');
	const headers = normalizeHeaders({
		[names.issuer]: cleanString(input.issuer),
		[names.audience]: cleanString(input.audience),
		[names.expiresAt]: String(exp),
		[names.user]: cleanString(input.user || input.id || input.subject),
		[names.tenant]: cleanString(input.tenantId || input.tenant),
		[names.role]: cleanString(input.role || 'viewer'),
		...(input.headers || {}),
	});
	headers[names.signature] = hmac(proxySignatureInput(headers, names), secret);
	return Object.freeze(headers);
}

export function verifyAuthProxyFixtureHeaders(headers, {
	issuer = '',
	audience = '',
	claimMapping = null,
	tenantId = '',
	allowedRoles = DEFAULT_ALLOWED_ROLES,
	secret = FIXTURE_IDP_SECRET,
	trusted = false,
	headerNames = {},
	now = Date.now(),
	clockSkewSeconds = 0,
} = {}) {
	const provider = 'auth-proxy';
	if (!trusted) return fail(provider, 'proxy boundary is not trusted', 503);
	const expected = requireExpected(provider, issuer, audience);
	if (expected) return expected;
	const mapping = normalizeMapping(claimMapping || DEFAULT_PROXY_HEADERS, provider, { headers: true });
	if (!mapping.ok) return fail(provider, mapping.reason, 503);
	const names = {
		...DEFAULT_PROXY_HEADERS,
		...Object.fromEntries(Object.entries(headerNames || {}).map(([key, value]) => [key, cleanString(value).toLowerCase()])),
		...mapping.fields,
	};
	const normalized = normalizeHeaders(headers);
	if (!cleanString(normalized[names.signature])) return fail(provider, 'signature invalid');
	if (!safeEqualText(hmac(proxySignatureInput(normalized, names), secret), normalized[names.signature])) {
		return fail(provider, 'signature invalid');
	}
	if (cleanString(normalized[names.issuer]) !== cleanString(issuer)) return fail(provider, 'issuer mismatch');
	if (!expectedAudienceMatch(normalized[names.audience], audience)) return fail(provider, 'audience mismatch');
	const current = nowSeconds(now);
	const skew = Math.max(0, Number(clockSkewSeconds) || 0);
	const expiresAt = Number(normalized[names.expiresAt]);
	if (!Number.isFinite(expiresAt) || expiresAt <= current - skew) return fail(provider, 'header assertion expired');
	const claims = {
		[mapping.fields.user]: normalized[mapping.fields.user],
		[mapping.fields.tenant]: normalized[mapping.fields.tenant],
		[mapping.fields.role]: normalized[mapping.fields.role],
	};
	return principalFromClaims(provider, claims, mapping.fields, { tenantId, allowedRoles });
}

export function idpVerifierCapabilitySummary(type = '') {
	const provider = cleanString(type).toLowerCase();
	return Object.freeze({
		type: provider,
		deterministic: true,
		liveIdpIntegrated: false,
		fixtureOnly: true,
		supports: Object.freeze({
			fixtureOidcJwtVerification: provider === 'oidc',
			fixtureSamlAssertionVerification: provider === 'saml',
			fixtureAuthProxyHeaderVerification: provider === 'auth-proxy',
			liveOidcJwtVerification: false,
			liveSamlAssertionHandling: false,
			trustedProxyHeaderAuth: false,
		}),
	});
}
