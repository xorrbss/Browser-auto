#!/usr/bin/env bash
# Browser-free tests for WebUI external-mode fail-closed security gates.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
PORT=$((5200 + RANDOM % 1000))
VIEWER_TOKEN="viewer0000000001"
OPERATOR_TOKEN="operator00000001"
OWNER_TOKEN="owner00000000001"
ADMIN_TOKEN="admin00000000001"
VIEWER_SESSION="sessviewer000001"
OWNER_SESSION="sessowner0000001"
VIEWER_CSRF="csrf-viewer-0001"
OWNER_CSRF="csrf-owner-0001"
TRUSTED_ORIGIN="https://console.example.test"
AUTH_USERS="$(printf '[{"token":"%s","id":"viewer1","role":"viewer","tenantId":"tenant_a"},{"token":"%s","id":"operator1","role":"operator","tenantId":"tenant_a"},{"token":"%s","id":"owner1","role":"owner","tenantId":"tenant_a"},{"token":"%s","id":"admin1","role":"admin","tenantId":"tenant_a"}]' "$VIEWER_TOKEN" "$OPERATOR_TOKEN" "$OWNER_TOKEN" "$ADMIN_TOKEN")"
AUTH_SESSIONS="$(printf '[{"sessionId":"%s","actorId":"viewer1","role":"viewer","tenantId":"tenant_a","createdAt":"2026-06-10T00:00:00.000Z","expiresAt":"2099-01-01T00:00:00.000Z","csrfToken":"%s"},{"sessionId":"%s","actorId":"owner1","role":"owner","tenantId":"tenant_a","createdAt":"2026-06-10T00:00:00.000Z","expiresAt":"2099-01-01T00:00:00.000Z","csrfToken":"%s"}]' "$VIEWER_SESSION" "$VIEWER_CSRF" "$OWNER_SESSION" "$OWNER_CSRF")"
SRV=""

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
	node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import {
	authProviderCapabilitySummary,
	authProviderConfig,
	authenticateRequestContext,
	authorizeCorsPreflight,
	authorizeHttpRequest,
	configuredCorsPolicy,
	corsResponseHeaders,
	secretPathBlocked,
	securityModeSummary,
	sessionCookieDeploymentPreflight,
	sessionCookieOptions,
} from './webui/security.js';

const allowedHosts = new Set(['127.0.0.1:4310', 'localhost:4310']);
const req = (method, headers = {}) => ({ method, headers });
const externalEnv = {
	WEBUI_EXTERNAL_MODE: '1',
	WEBUI_AUTH_TOKEN: '0123456789abcdef',
	WEBUI_TENANT_ID: 'tenant_a',
	WEBUI_ACTOR_ID: 'alice',
	WEBUI_ACTOR_ROLE: 'viewer',
};
const authUsersEnv = {
	WEBUI_EXTERNAL_MODE: '1',
	WEBUI_PUBLIC_URL: 'https://console.example.test',
	WEBUI_AUTH_USERS: JSON.stringify([
		{ token: 'viewer0000000001', id: 'viewer1', role: 'viewer', tenantId: 'tenant_a' },
		{ token: 'operator00000001', id: 'operator1', role: 'operator', tenantId: 'tenant_a' },
		{ token: 'owner00000000001', id: 'owner1', role: 'owner', tenantId: 'tenant_a' },
		{ token: 'admin00000000001', id: 'admin1', role: 'admin', tenantId: 'tenant_a' },
	]),
	WEBUI_AUTH_SESSIONS: JSON.stringify([
		{ sessionId: 'sessviewer000001', actorId: 'viewer1', role: 'viewer', tenantId: 'tenant_a', createdAt: '2026-06-10T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', csrfToken: 'csrf-viewer-0001' },
		{ sessionId: 'sessowner0000001', actorId: 'owner1', role: 'owner', tenantId: 'tenant_a', createdAt: '2026-06-10T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z', csrfToken: 'csrf-owner-0001' },
	]),
};
const trustedCorsEnv = { ...authUsersEnv, WEBUI_ALLOWED_ORIGINS: 'https://console.example.test' };
const validOidcEnv = {
	...authUsersEnv,
	WEBUI_AUTH_PROVIDER: 'oidc',
	WEBUI_OIDC_ISSUER: 'https://idp.example.test/tenant-a',
	WEBUI_OIDC_CLIENT_ID: 'browser-auto-webui',
	WEBUI_OIDC_USER_CLAIM: 'sub',
	WEBUI_OIDC_TENANT_CLAIM: 'tenant_id',
	WEBUI_OIDC_ROLE_CLAIM: 'roles',
};
const invalidOidcEnv = {
	...authUsersEnv,
	WEBUI_AUTH_PROVIDER: 'oidc',
	WEBUI_OIDC_ISSUER: 'http://idp.example.test/tenant-a',
};
const missingClaimOidcEnv = {
	...authUsersEnv,
	WEBUI_AUTH_PROVIDER: 'oidc',
	WEBUI_OIDC_ISSUER: 'https://idp.example.test/tenant-a',
	WEBUI_OIDC_CLIENT_ID: 'browser-auto-webui',
};
const validSamlEnv = {
	...authUsersEnv,
	WEBUI_AUTH_PROVIDER: 'saml',
	WEBUI_SAML_SSO_URL: 'https://idp.example.test/sso',
	WEBUI_SAML_ENTITY_ID: 'browser-auto-webui',
	WEBUI_SAML_CERT_FINGERPRINT: 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
	WEBUI_SAML_USER_ATTRIBUTE: 'uid',
	WEBUI_SAML_TENANT_ATTRIBUTE: 'tenant',
	WEBUI_SAML_ROLE_ATTRIBUTE: 'role',
};
const duplicateSamlClaimEnv = {
	...validSamlEnv,
	WEBUI_SAML_ROLE_ATTRIBUTE: 'tenant',
};
const validProxyEnv = {
	...authUsersEnv,
	WEBUI_AUTH_PROVIDER: 'auth-proxy',
	WEBUI_AUTH_PROXY_ISSUER: 'corp-sso-proxy',
	WEBUI_AUTH_PROXY_HEADER_USER: 'x-sso-user',
	WEBUI_AUTH_PROXY_HEADER_TENANT: 'x-sso-tenant',
	WEBUI_AUTH_PROXY_HEADER_ROLE: 'x-sso-role',
	WEBUI_AUTH_PROXY_TRUSTED: '1',
};
const duplicateProxyHeaderEnv = {
	...validProxyEnv,
	WEBUI_AUTH_PROXY_HEADER_ROLE: 'x-sso-tenant',
};

assert.equal(secretPathBlocked('/fixtures/auth/playwright/app.state.json'), true, 'auth state path is blocked');
assert.equal(secretPathBlocked('/flows/demo.values.json'), true, 'values sidecar path is blocked');
assert.equal(secretPathBlocked('/data/approvals.db'), true, 'local DB path is blocked');
assert.equal(secretPathBlocked('/api/auth'), false, 'auth API route is not mistaken for an auth-state file path');
assert.equal(secretPathBlocked('/artifacts/20990101-000000-1/report.json'), false, 'normal report path is allowed by path gate');
// The route gate now delegates to the canonical classifier, so it blocks the same superset as the
// static-file gate (these were previously blocked only by staticFilePolicy, not the URL route).
assert.equal(secretPathBlocked('/browser-profiles/p1/cookies'), true, 'browser-profiles path is blocked at the route gate');
assert.equal(secretPathBlocked('/runner-work/job1'), true, 'runner-work path is blocked at the route gate');
assert.equal(secretPathBlocked('/data/webui-jobs.jsonl'), true, 'durable jobs journal is blocked at the route gate');
assert.equal(secretPathBlocked('/exports/storage-state.json'), true, 'storage-state file is blocked at the route gate');

assert.equal(authorizeHttpRequest(req('GET'), '/api/runs', { allowedHosts }).ok, true, 'local mode allows existing localhost behavior');
assert.equal(authorizeHttpRequest(req('POST'), '/api/auth', { allowedHosts }).ok, true, 'local mode allows auth API route through HTTP gate');
assert.equal(sessionCookieOptions({ WEBUI_EXTERNAL_MODE: '1', WEBUI_SESSION_SECURE: '0' }).secure, true, 'external cookies stay Secure even if env tries to disable it');
let cookiePreflight = sessionCookieDeploymentPreflight(authUsersEnv);
assert.equal(cookiePreflight.ok, true, 'external cookie sessions pass with an HTTPS public URL');
assert.equal(cookiePreflight.publicOrigin, 'https://console.example.test', 'cookie preflight reports only the public origin');
assert.equal(sessionCookieDeploymentPreflight({ WEBUI_EXTERNAL_MODE: '1', WEBUI_PUBLIC_URL: 'http://console.example.test' }).ok, false, 'external cookie preflight requires HTTPS');
assert.equal(sessionCookieDeploymentPreflight({}).ok, true, 'local-pilot cookie preflight remains compatible without HTTPS config');

let summary = securityModeSummary(externalEnv);
assert.equal(summary.mode, 'external', 'external mode is detected');
assert.equal(summary.configured, true, 'external mode is configured with token and tenant');
assert.equal(summary.tenantId, 'tenant_a', 'tenant id is exposed as metadata');
assert.equal(summary.authProvider.type, 'static', 'legacy token mode maps to the static provider');

let provider = authProviderConfig(validOidcEnv);
assert.equal(provider.valid, true, 'valid OIDC metadata passes deterministic config validation');
assert.equal(provider.integrated, false, 'OIDC provider is not treated as a live integrated IdP');
assert.equal(provider.details.issuerOrigin, 'https://idp.example.test', 'OIDC summary exposes issuer origin only');
assert.equal(provider.details.claimMapping.fields.tenant, 'tenant_id', 'OIDC tenant claim mapping is recorded');
let capabilities = authProviderCapabilitySummary(validOidcEnv);
assert.equal(capabilities.validatesClaimMapping, true, 'OIDC capability summary declares claim-map validation');
assert.equal(capabilities.claimMapping.fields.role, 'roles', 'OIDC capability summary exposes role claim metadata only');
assert.equal(capabilities.supports.fixtureOidcJwtVerification, true, 'OIDC capability summary declares fixture JWT verification support');
assert.equal(capabilities.supports.liveOidcJwtVerification, false, 'OIDC capability summary does not claim live JWT verification');
summary = securityModeSummary(validOidcEnv);
assert.equal(summary.configured, true, 'valid OIDC metadata plus deterministic auth material is configured');
assert.equal(summary.authProvider.type, 'oidc', 'summary reports OIDC provider type');
assert.equal(summary.authProvider.capabilities.claimMapping.fields.user, 'sub', 'summary includes deterministic claim mapping metadata');

provider = authProviderConfig(invalidOidcEnv);
assert.equal(provider.valid, false, 'invalid OIDC metadata fails validation');
assert(provider.errors.some((e) => /https/.test(e)), 'OIDC validation requires HTTPS');
let authDecision = authenticateRequestContext(req('GET', { authorization: 'Bearer viewer0000000001' }), { env: invalidOidcEnv });
assert.equal(authDecision.code, 503, 'invalid production IdP config fails closed before auth material is trusted');
provider = authProviderConfig(missingClaimOidcEnv);
assert.equal(provider.valid, false, 'OIDC without required claim mappings fails validation');
assert(provider.errors.some((e) => /WEBUI_OIDC_TENANT_CLAIM/.test(e)), 'OIDC validation names the missing tenant claim mapping');
authDecision = authenticateRequestContext(req('GET', { authorization: 'Bearer viewer0000000001' }), { env: missingClaimOidcEnv });
assert.equal(authDecision.code, 503, 'OIDC missing tenant/role mapping fails closed before auth material is trusted');
assert.equal(authProviderConfig(validSamlEnv).valid, true, 'SAML SSO metadata can be validated deterministically');
assert.equal(authProviderCapabilitySummary(validSamlEnv).supports.fixtureSamlAssertionVerification, true, 'SAML capability summary declares fixture assertion verification support');
provider = authProviderConfig(duplicateSamlClaimEnv);
assert.equal(provider.valid, false, 'SAML duplicate tenant/role attributes fail validation');
assert(provider.errors.some((e) => /tenant and role/.test(e)), 'SAML duplicate mapping denial names tenant and role');
provider = authProviderConfig(validProxyEnv);
assert.equal(provider.valid, true, 'authenticated proxy boundary metadata can be validated deterministically');
assert.equal(provider.integrated, false, 'auth proxy headers are not trusted directly by this build');
assert.equal(authProviderCapabilitySummary(validProxyEnv).supports.fixtureAuthProxyHeaderVerification, true, 'auth-proxy capability summary declares fixture header verification support');
provider = authProviderConfig(duplicateProxyHeaderEnv);
assert.equal(provider.valid, false, 'auth-proxy duplicate tenant/role headers fail validation');
assert(provider.errors.some((e) => /tenant and role/.test(e)), 'auth-proxy duplicate mapping denial names tenant and role');

let cors = configuredCorsPolicy(trustedCorsEnv);
assert.equal(cors.ok, true, 'trusted CORS origin policy parses');
assert.deepEqual(cors.allowedOrigins, ['https://console.example.test'], 'CORS policy stores normalized explicit origins');
assert.equal(configuredCorsPolicy({ WEBUI_EXTERNAL_MODE: '1', WEBUI_ALLOWED_ORIGINS: '*' }).ok, false, 'wildcard CORS is refused');
let preflight = authorizeCorsPreflight(req('OPTIONS', { origin: 'https://console.example.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, x-aqa-csrf' }), { env: trustedCorsEnv });
assert.equal(preflight.ok, true, 'trusted CORS preflight is allowed');
assert.equal(preflight.headers['Access-Control-Allow-Origin'], 'https://console.example.test', 'preflight echoes the trusted origin');
preflight = authorizeCorsPreflight(req('OPTIONS', { origin: 'https://console.example.test', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-secret' }), { env: trustedCorsEnv });
assert.equal(preflight.code, 403, 'unexpected preflight headers are refused');
assert.equal(Object.keys(corsResponseHeaders('https://evil.test', { env: trustedCorsEnv })).length, 0, 'untrusted CORS origin receives no allow headers');

let decision = authorizeHttpRequest(req('POST', {}), '/api/run', { allowedHosts, env: externalEnv });
assert.equal(decision.code, 401, 'missing bearer token is unauthorized before mutation can run');

decision = authorizeHttpRequest(req('POST', { authorization: 'Bearer wrongwrongwrongwrong' }), '/api/run', { allowedHosts, env: externalEnv });
assert.equal(decision.code, 401, 'wrong bearer token is unauthorized');

decision = authorizeHttpRequest(req('POST', { authorization: `Bearer ${externalEnv.WEBUI_AUTH_TOKEN}` }), '/api/run', { allowedHosts, env: externalEnv });
assert.equal(decision.ok, true, 'bearer machine mutation without browser origin is accepted by the HTTP gate');

decision = authorizeHttpRequest(req('POST', { authorization: `Bearer ${externalEnv.WEBUI_AUTH_TOKEN}`, origin: 'http://evil.test' }), '/api/run', { allowedHosts, env: externalEnv });
assert.equal(decision.code, 403, 'wrong origin is refused even with bearer token');

decision = authorizeHttpRequest(req('POST', { authorization: `Bearer ${externalEnv.WEBUI_AUTH_TOKEN}`, origin: 'http://127.0.0.1:4310' }), '/api/run', { allowedHosts, env: externalEnv });
assert.equal(decision.ok, true, 'valid bearer token plus same-origin is accepted by the HTTP gate');
assert.equal(decision.tenantId, 'tenant_a', 'request context carries tenant id');

decision = authorizeHttpRequest(req('POST', { cookie: 'aqa_webui_token=sessviewer000001' }), '/api/run', { allowedHosts, env: authUsersEnv });
assert.equal(decision.code, 403, 'cookie-authenticated mutation requires origin/referer');

decision = authorizeHttpRequest(req('POST', { cookie: 'aqa_webui_token=sessviewer000001', origin: 'http://127.0.0.1:4310' }), '/api/run', { allowedHosts, env: authUsersEnv });
assert.equal(decision.code, 403, 'cookie-authenticated mutation requires CSRF token');

decision = authorizeHttpRequest(req('POST', { cookie: 'aqa_webui_token=sessviewer000001', origin: 'http://127.0.0.1:4310', 'x-aqa-csrf': 'wrong-csrf-token' }), '/api/run', { allowedHosts, env: authUsersEnv });
assert.equal(decision.code, 403, 'wrong CSRF token is rejected');

decision = authorizeHttpRequest(req('POST', { cookie: 'aqa_webui_token=sessviewer000001', origin: 'http://127.0.0.1:4310', referer: 'http://evil.test/page', 'x-aqa-csrf': 'csrf-viewer-0001' }), '/api/run', { allowedHosts, env: authUsersEnv });
assert.equal(decision.code, 403, 'ambiguous origin/referer with one foreign value is rejected');

decision = authorizeHttpRequest(req('POST', { cookie: 'aqa_webui_token=sessviewer000001', origin: 'http://127.0.0.1:4310', 'x-aqa-csrf': 'csrf-viewer-0001' }), '/api/run', { allowedHosts, env: authUsersEnv });
assert.equal(decision.ok, true, 'valid cookie session plus same-origin CSRF is accepted');

decision = authorizeHttpRequest(req('GET', { cookie: 'aqa_webui_token=sessviewer000001' }), '/api/runs', { allowedHosts, env: { ...authUsersEnv, WEBUI_PUBLIC_URL: '' } });
assert.equal(decision.code, 503, 'configured cookie sessions without HTTPS deployment preflight fail closed');

decision = authorizeHttpRequest(req('POST', { authorization: 'Bearer operator00000001', origin: 'https://console.example.test' }), '/api/run', { allowedHosts, env: trustedCorsEnv });
assert.equal(decision.ok, true, 'explicit trusted CORS origin can pass the HTTP gate');

decision = authorizeHttpRequest(req('POST', { authorization: 'Bearer operator00000001', origin: 'https://other.example.test' }), '/api/run', { allowedHosts, env: trustedCorsEnv });
assert.equal(decision.code, 403, 'non-allowlisted CORS origin remains refused');

summary = securityModeSummary(authUsersEnv);
assert.equal(summary.configured, true, 'external auth users configure external mode');
assert.equal(summary.authPrincipals, 4, 'auth users are counted without exposing tokens');
assert.equal(summary.authSessions, 2, 'auth sessions are counted without exposing session ids');

decision = authorizeHttpRequest(req('GET', { authorization: 'Bearer operator00000001' }), '/api/runs', { allowedHosts, env: authUsersEnv });
assert.equal(decision.ok, true, 'auth users token authenticates');
assert.equal(decision.context.actor.id, 'operator1', 'request context carries actor id');
assert.equal(decision.context.actor.role, 'operator', 'request context carries role');
assert.equal(decision.context.tenant.id, 'tenant_a', 'request context carries tenant object');

decision = authorizeHttpRequest(req('GET', { authorization: 'Bearer viewer0000000001', 'x-aqa-tenant': 'tenant_b' }), '/api/runs', { allowedHosts, env: authUsersEnv });
assert.equal(decision.code, 403, 'tenant header mismatch is denied');

decision = authenticateRequestContext(req('GET', { cookie: 'aqa_webui_token=sessowner0000001' }), { env: authUsersEnv });
assert.equal(decision.ok, true, 'deterministic session cookie authenticates');
assert.equal(decision.context.actor.role, 'owner', 'session cookie maps to owner context');

console.log('  webui-security-unit: pure security gate checks passed');
NODE
)

( cd "$DIR" && exec env AQA_DB_PATH="$TMP/t.db" WEBUI_PORT="$PORT" WEBUI_KEEP_RUNS=999999 WEBUI_EXTERNAL_MODE=1 WEBUI_PUBLIC_URL="$TRUSTED_ORIGIN" WEBUI_TENANT_ID=tenant_a WEBUI_AUTH_USERS="$AUTH_USERS" WEBUI_AUTH_SESSIONS="$AUTH_SESSIONS" WEBUI_ALLOWED_ORIGINS="$TRUSTED_ORIGIN" node webui/server.js >"$TMP/server.log" 2>&1 ) &
SRV=$!

PORT="$PORT" VIEWER_TOKEN="$VIEWER_TOKEN" OPERATOR_TOKEN="$OPERATOR_TOKEN" ADMIN_TOKEN="$ADMIN_TOKEN" VIEWER_SESSION="$VIEWER_SESSION" VIEWER_CSRF="$VIEWER_CSRF" TRUSTED_ORIGIN="$TRUSTED_ORIGIN" node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';

const port = process.env.PORT;
const viewerToken = process.env.VIEWER_TOKEN;
const operatorToken = process.env.OPERATOR_TOKEN;
const adminToken = process.env.ADMIN_TOKEN;
const viewerSession = process.env.VIEWER_SESSION;
const viewerCsrf = process.env.VIEWER_CSRF;
const trustedOrigin = process.env.TRUSTED_ORIGIN;
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

let r = await fetch(base + '/');
assert.equal(r.status, 401, 'external-mode page rejects unauthenticated request');

r = await fetch(base + '/artifacts/missing/report.json');
assert.equal(r.status, 401, 'external-mode artifact route rejects unauthenticated request before file lookup');

r = await fetch(base + '/api/jobs/nope/stream');
assert.equal(r.status, 401, 'external-mode SSE route rejects unauthenticated request before job lookup');

async function post(path, token, body, headers = {}) {
	const auth = token ? { Authorization: `Bearer ${token}` } : {};
	return fetch(base + path, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...auth, ...headers },
		body: JSON.stringify(body || {}),
	});
}

r = await post('/api/run', null, { glob: 'login' });
assert.equal(r.status, 401, 'external-mode mutating route rejects unauthenticated request');

r = await fetch(base + '/api/run', {
	method: 'OPTIONS',
	headers: {
		Origin: trustedOrigin,
		'Access-Control-Request-Method': 'POST',
		'Access-Control-Request-Headers': 'authorization, content-type',
	},
});
assert.equal(r.status, 204, 'trusted CORS preflight succeeds without starting route logic');
assert.equal(r.headers.get('access-control-allow-origin'), trustedOrigin, 'trusted preflight receives explicit allow-origin');

r = await fetch(base + '/api/run', {
	method: 'OPTIONS',
	headers: {
		Origin: 'https://evil.example.test',
		'Access-Control-Request-Method': 'POST',
	},
});
assert.equal(r.status, 403, 'untrusted CORS preflight is refused');

r = await post('/api/run', null, { glob: 'login' }, { Cookie: `aqa_webui_token=${viewerSession}` });
assert.equal(r.status, 403, 'external-mode cookie mutation rejects missing origin/referer');

r = await post('/api/run', viewerToken, { glob: 'login' }, { Origin: base });
assert.equal(r.status, 403, 'authenticated viewer still cannot enqueue a run');
let body = await r.json();
assert.match(body.reason || '', /lacks permission/, 'RBAC denial is reported');

r = await post('/api/run', null, { glob: 'login' }, { Cookie: `aqa_webui_token=${viewerSession}`, Origin: base });
assert.equal(r.status, 403, 'authenticated cookie mutation rejects missing CSRF');

r = await post('/api/run', null, { glob: 'login' }, { Cookie: `aqa_webui_token=${viewerSession}`, Origin: base, 'X-AQA-CSRF': viewerCsrf });
assert.equal(r.status, 403, 'cookie session with valid CSRF reaches RBAC and denies viewer run');
body = await r.json();
assert.match(body.reason || '', /lacks permission/, 'cookie-session RBAC denial is reported');

r = await post('/api/approve/run', operatorToken, { app: 'demo', docs: ['doc1'], dryRun: false, reviewed: true, max: 1 }, { Origin: base });
assert.equal(r.status, 403, 'operator cannot start live/effectful approve route');
body = await r.json();
assert.match(body.reason || '', /live-action|approve/, 'operator live/effectful denial names required permission');

r = await fetch(base + '/api/readiness', { headers: { Authorization: `Bearer ${viewerToken}` } });
assert.equal(r.status, 200, 'viewer can read redacted readiness summary');

r = await fetch(base + '/api/secret-migration/status?tenantId=tenant_a', { headers: { Authorization: `Bearer ${viewerToken}` } });
assert.equal(r.status, 403, 'viewer cannot read secret migration metadata');
body = await r.json();
assert.match(body.reason || '', /run/, 'secret migration denial names operator-level permission');

r = await fetch(base + '/api/secret-migration/status?tenantId=tenant_a', { headers: { Authorization: `Bearer ${operatorToken}` } });
assert.equal(r.status, 200, 'operator can read secret migration metadata');
body = await r.json();
assert.equal(body.metadataOnly, true, 'secret migration read remains metadata-only');

r = await fetch(base + '/api/tenant/deletion/req_1/status?tenantId=tenant_a', { headers: { Authorization: `Bearer ${viewerToken}` } });
assert.equal(r.status, 403, 'viewer cannot read tenant deletion metadata');

r = await fetch(base + '/api/release-checklist', { headers: { Authorization: `Bearer ${viewerToken}` } });
assert.equal(r.status, 403, 'viewer cannot read release checklist metadata');

r = await fetch(base + '/api/release-checklist', { headers: { Authorization: `Bearer ${adminToken}` } });
assert.equal(r.status, 200, 'admin can read release checklist metadata');
body = await r.json();
assert.equal(body.artifactHandling?.mode, 'metadata-only', 'release checklist read remains metadata-only');

r = await fetch(base + '/api/approve/audit?limit=10', { headers: { Authorization: `Bearer ${viewerToken}` } });
assert.equal(r.status, 403, 'viewer cannot read audit detail');

r = await fetch(base + '/api/approve/audit?limit=10', { headers: { Authorization: `Bearer ${adminToken}` } });
assert.equal(r.status, 200, 'admin can read audit detail');
body = await r.json();
assert.equal(body.redactionPolicy?.applied, true, 'audit detail still declares redaction');

r = await fetch(base + '/api/rbac', { headers: { Authorization: `Bearer ${viewerToken}` } });
assert.equal(r.status, 200, 'authenticated external read can inspect RBAC');
const rbac = await r.json();
assert.equal(rbac.tenantId, 'tenant_a', 'RBAC readback includes tenant metadata');
assert.equal(rbac.actor.role, 'viewer', 'RBAC readback is based on request token role');

r = await fetch(base + '/api/rbac', { headers: { Authorization: `Bearer ${viewerToken}`, Origin: trustedOrigin } });
assert.equal(r.status, 200, 'authenticated trusted CORS read can inspect RBAC');
assert.equal(r.headers.get('access-control-allow-origin'), trustedOrigin, 'trusted CORS read response carries allow-origin');

r = await fetch(base + '/api/rbac', { headers: { Cookie: `aqa_webui_token=${viewerSession}` } });
assert.equal(r.status, 200, 'authenticated external session cookie can inspect RBAC');
body = await r.json();
assert.equal(body.security.auth, 'cookie', 'session readback records cookie auth scheme');

r = await fetch(base + '/artifacts/missing/report.json', { headers: { Authorization: `Bearer ${viewerToken}` } });
assert.equal(r.status, 404, 'authenticated artifact read reaches artifact route after RBAC');

r = await post('/api/session/logout', null, {}, { Cookie: `aqa_webui_token=${viewerSession}`, Origin: base, 'X-AQA-CSRF': viewerCsrf });
assert.equal(r.status, 200, 'session logout succeeds with same-origin CSRF');
assert.match(r.headers.get('set-cookie') || '', /Max-Age=0/, 'logout clears the session cookie');

r = await fetch(base + '/api/rbac', { headers: { Cookie: `aqa_webui_token=${viewerSession}` } });
assert.equal(r.status, 401, 'logged-out session cookie is rejected before route logic');

r = await fetch(base + '/api/rbac', { headers: { Authorization: `Bearer ${viewerToken}` } });
assert.equal(r.status, 200, 'logout does not revoke bearer machine token');

console.log('  webui-security-unit: external-mode server route checks passed');
NODE
