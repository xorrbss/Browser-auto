#!/usr/bin/env bash
# Browser-free unit tests for WebUI authenticated request context.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

(
	cd "$DIR"
	node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import {
	authProviderCapabilitySummary,
	authProviderConfig,
	authenticateRequestContext,
	authorizeHttpRequest,
	clearSessionCookieHeader,
	configuredCorsPolicy,
	createSessionRecord,
	logoutSessionId,
	resetLoggedOutSessionsForTests,
	sessionCookieDeploymentPreflight,
	sessionCookieHeader,
	sessionCookieOptions,
	sessionExpired,
	securityModeSummary,
	validateSessionRecord,
} from './webui/security.js';
import { actorAccessView, authorizeWebuiRequest, routeFamilyForPath } from './webui/access.js';

const allowedHosts = new Set(['127.0.0.1:4310', 'localhost:4310']);
const req = (method, headers = {}) => ({ method, headers });
const now = Date.parse('2026-06-10T00:00:00.000Z');
const env = {
	WEBUI_EXTERNAL_MODE: '1',
	WEBUI_PUBLIC_URL: 'https://console.example.test',
	WEBUI_AUTH_USERS: JSON.stringify([
		{ token: 'viewer0000000001', id: 'viewer1', role: 'viewer', tenantId: 'tenant_a' },
		{ token: 'operator00000001', id: 'operator1', role: 'operator', tenantId: 'tenant_a' },
		{ token: 'owner00000000001', id: 'owner1', role: 'owner', tenantId: 'tenant_b' },
		{ token: 'admin00000000001', id: 'admin1', role: 'admin', tenantId: 'tenant_a' },
	]),
	WEBUI_AUTH_SESSIONS: JSON.stringify([
		{ sessionId: 'sessoperator00001', actorId: 'operator1', role: 'operator', tenantId: 'tenant_a', createdAt: now - 1000, expiresAt: now + 60000, csrfToken: 'csrf-operator-0001' },
		{ sessionId: 'sessexpired00001', actorId: 'viewer1', role: 'viewer', tenantId: 'tenant_a', createdAt: now - 120000, expiresAt: now - 1000, csrfToken: 'csrf-expired-0001' },
	]),
};
const oidcEnv = {
	...env,
	WEBUI_AUTH_PROVIDER: 'oidc',
	WEBUI_OIDC_ISSUER: 'https://idp.example.test/tenant-a',
	WEBUI_OIDC_CLIENT_ID: 'browser-auto-webui',
	WEBUI_OIDC_USER_CLAIM: 'sub',
	WEBUI_OIDC_TENANT_CLAIM: 'tenant_id',
	WEBUI_OIDC_ROLE_CLAIM: 'roles',
	WEBUI_ALLOWED_ORIGINS: 'https://console.example.test',
};
resetLoggedOutSessionsForTests();

const created = createSessionRecord({ sessionId: 'createdsession001', actorId: 'created1', role: 'viewer', tenantId: 'tenant_a' }, { now, ttlMs: 1000 });
assert.equal(created.expiresAt, '2026-06-10T00:00:01.000Z', 'created session has deterministic expiry');
assert.equal(sessionExpired(created, now + 999), false, 'session is valid before expiry');
assert.equal(sessionExpired(created, now + 1000), true, 'session expires at the expiry instant');
assert.equal(validateSessionRecord(created, { now: now + 999 }).ok, true, 'validate accepts current session');
assert.equal(validateSessionRecord(created, { now: now + 1000 }).code, 401, 'validate rejects expired session');

let cookie = sessionCookieHeader('createdsession001', { env });
assert.match(cookie, /HttpOnly/, 'session cookie is http only');
assert.match(cookie, /SameSite=Strict/, 'session cookie defaults to SameSite Strict');
assert.match(cookie, /Secure/, 'external-mode session cookie is Secure');
assert.match(clearSessionCookieHeader(env), /Max-Age=0/, 'clear cookie expires the browser cookie');
assert.equal(sessionCookieOptions({ WEBUI_EXTERNAL_MODE: '0' }).secure, false, 'local-pilot cookie helper stays compatible with plain HTTP');
assert.equal(sessionCookieDeploymentPreflight(env).ok, true, 'external cookie session deployment preflight passes with HTTPS public URL');
assert.equal(sessionCookieDeploymentPreflight({ WEBUI_EXTERNAL_MODE: '1' }).ok, false, 'external cookie session deployment preflight requires public HTTPS URL');
assert.equal(sessionCookieDeploymentPreflight({}).ok, true, 'local-pilot cookie session preflight does not require deployment metadata');

let summary = securityModeSummary(env);
assert.equal(summary.mode, 'external', 'external mode is active');
assert.equal(summary.configured, true, 'auth users configure external auth');
assert.deepEqual(summary.tenants.sort(), ['tenant_a', 'tenant_b'], 'summary exposes tenant ids, not tokens');
assert.equal(summary.authSessions, 2, 'summary counts configured sessions without exposing ids');
assert.equal(summary.authProvider.type, 'static', 'default external provider is deterministic static auth');
assert.equal(summary.sessionCookie.preflight.ok, true, 'summary includes passing cookie deployment preflight');
assert.equal(securityModeSummary({ ...env, WEBUI_PUBLIC_URL: '' }).configured, false, 'summary fails closed when cookie session deployment preflight is missing');

let provider = authProviderConfig(oidcEnv);
assert.equal(provider.valid, true, 'OIDC provider metadata is validated without live IdP calls');
assert.equal(provider.integrated, false, 'OIDC provider is not marked integrated until live verification exists');
assert.equal(provider.details.claimMapping.fields.tenant, 'tenant_id', 'OIDC tenant claim mapping is validated');
let capabilities = authProviderCapabilitySummary(oidcEnv);
assert.equal(capabilities.validatesProviderMetadata, true, 'capability summary records provider metadata validation');
assert.equal(capabilities.claimMapping.fields.role, 'roles', 'capability summary records role claim mapping');
assert.equal(capabilities.liveIdpIntegrated, false, 'capability summary stays honest about live IdP integration');
summary = securityModeSummary(oidcEnv);
assert.equal(summary.authProvider.type, 'oidc', 'summary reports declared provider');
assert.equal(summary.authProvider.details.issuerOrigin, 'https://idp.example.test', 'summary limits OIDC metadata to origin');
assert.equal(summary.authProvider.capabilities.claimMapping.fields.tenant, 'tenant_id', 'summary reports tenant claim mapping');
assert.equal(summary.cors.mode, 'explicit-allowlist', 'summary reports explicit CORS allowlist mode');
assert.deepEqual(configuredCorsPolicy(oidcEnv).allowedOrigins, ['https://console.example.test'], 'CORS helper exposes explicit trusted origin');

let auth = authenticateRequestContext(req('GET', { authorization: 'Bearer viewer0000000001' }), { env });
assert.equal(auth.ok, true, 'viewer token authenticates');
assert.equal(auth.context.authenticated, true, 'external context is authenticated');
assert.equal(auth.context.actor.id, 'viewer1', 'actor id comes from token principal');
assert.equal(auth.context.actor.role, 'viewer', 'actor role comes from token principal');
assert.equal(auth.context.tenant.id, 'tenant_a', 'tenant id comes from token principal');

let access = actorAccessView(auth.context);
assert.equal(access.actor.id, 'viewer1', 'access view reads request actor');
assert.equal(access.tenantId, 'tenant_a', 'access view reads request tenant');
assert.equal(access.capabilities.read.allowed, true, 'viewer can read');
assert.equal(access.capabilities.run.allowed, false, 'viewer cannot mutate');

assert.equal(authorizeWebuiRequest('GET', '/api/runs', {}, auth.context).ok, true, 'viewer read is allowed');
assert.equal(authorizeWebuiRequest('POST', '/api/run', {}, auth.context).ok, false, 'viewer mutation is denied');

auth = authenticateRequestContext(req('GET', { cookie: 'aqa_webui_token=sessoperator00001' }), { env, now });
assert.equal(auth.ok, true, 'deterministic session cookie authenticates');
assert.equal(authorizeWebuiRequest('POST', '/api/run', {}, auth.context).ok, true, 'operator can run local/fixture jobs');
assert.equal(authorizeWebuiRequest('POST', '/api/approve/run', { dryRun: false }, auth.context).ok, false, 'operator cannot approve live/effectful work');

auth = authenticateRequestContext(req('GET', { cookie: 'aqa_webui_token=sessexpired00001' }), { env, now });
assert.equal(auth.code, 401, 'expired session cookie is unauthorized');
assert.match(auth.reason, /expired/, 'expired session denial is explicit');

auth = authenticateRequestContext(req('GET', { cookie: 'aqa_webui_token=sessoperator00001' }), { env: { ...env, WEBUI_PUBLIC_URL: '' }, now });
assert.equal(auth.code, 503, 'cookie sessions fail closed when HTTPS deployment preflight is malformed');
assert.match(auth.reason, /WEBUI_PUBLIC_URL/, 'cookie preflight denial names public URL configuration');

assert.equal(logoutSessionId('sessoperator00001'), true, 'logout helper records session logout');
auth = authenticateRequestContext(req('GET', { cookie: 'aqa_webui_token=sessoperator00001' }), { env, now });
assert.equal(auth.code, 401, 'logged-out session cookie is unauthorized');
assert.match(auth.reason, /logged out/, 'logged-out session denial is explicit');
auth = authenticateRequestContext(req('GET', { authorization: 'Bearer operator00000001' }), { env, now });
assert.equal(auth.ok, true, 'bearer machine token still works after cookie session logout');
resetLoggedOutSessionsForTests();

auth = authenticateRequestContext(req('GET', { authorization: 'Bearer owner00000000001' }), { env });
assert.equal(auth.context.tenant.id, 'tenant_b', 'owner token carries its tenant');
assert.equal(authorizeWebuiRequest('POST', '/api/approve/run', { dryRun: false }, auth.context).ok, true, 'owner can approve live/effectful work');

let decision = authorizeHttpRequest(req('GET', { authorization: 'Bearer viewer0000000001', 'x-aqa-tenant': 'tenant_b' }), '/api/runs', { allowedHosts, env });
assert.equal(decision.code, 403, 'cross-tenant request header is denied');

decision = authorizeHttpRequest(req('POST', { authorization: 'Bearer operator00000001', origin: 'https://console.example.test' }), '/api/run', { allowedHosts, env: oidcEnv });
assert.equal(decision.ok, true, 'trusted CORS origin can pass HTTP gate when provider config is valid');

auth = authenticateRequestContext(req('GET', { authorization: 'Bearer admin00000000001' }), { env });
assert.equal(auth.ok, true, 'admin role can authenticate');
decision = authorizeWebuiRequest('GET', '/api/runs', {}, auth.context);
assert.equal(decision.ok, true, 'admin role can read route summaries');
decision = authorizeWebuiRequest('GET', '/api/release-checklist', {}, auth.context);
assert.equal(decision.ok, true, 'admin role can read sensitive release metadata');
decision = authorizeWebuiRequest('GET', '/api/release-checklist', {}, { mode: 'external', tenant: { id: 'tenant_a' }, actor: { id: 'auditor1', role: 'auditor', tenantId: 'tenant_a' } });
assert.equal(decision.ok, false, 'unknown role is denied at route authorization');
assert.match(decision.reason, /unknown role/, 'unknown role denial is explicit');

auth = authenticateRequestContext(req('GET'), { env: {} });
assert.equal(auth.ok, true, 'local pilot builds a context without external auth');
assert.equal(auth.context.localBypass, true, 'local pilot context marks explicit bypass');
assert.equal(auth.context.tenant.id, 'local', 'local pilot tenant is local');
assert.equal(authorizeWebuiRequest('POST', '/api/run', {}, auth.context).ok, true, 'local pilot keeps operator behavior');

assert.equal(routeFamilyForPath('/'), 'page', 'route family covers pages');
assert.equal(routeFamilyForPath('/api/runs'), 'api', 'route family covers APIs');
assert.equal(routeFamilyForPath('/artifacts/r/report.json'), 'artifact', 'route family covers artifacts');
assert.equal(routeFamilyForPath('/api/jobs/j1/stream'), 'sse', 'route family covers SSE');
assert.equal(routeFamilyForPath('/vnc.html'), 'novnc', 'route family covers noVNC');

console.log('  webui-auth-context-unit: all checks passed');
NODE
)
