#!/usr/bin/env bash
# Browser-free tests for deterministic fixture IdP verifiers.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

(
	cd "$DIR"
	node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import {
	FIXTURE_IDP_SECRET,
	createFixtureAuthProxyHeaders,
	createFixtureJwt,
	createFixtureSamlAssertion,
	verifyAuthProxyFixtureHeaders,
	verifyOidcFixtureJwt,
	verifySamlFixtureAssertion,
} from './webui/idp-verifier.js';

const now = Date.parse('2026-06-10T00:00:00.000Z');
const nowSeconds = Math.floor(now / 1000);
const issuer = 'https://idp.example.test/tenant-a';
const audience = 'browser-auto-webui';
const tenantId = 'tenant_a';
const secretUser = 'fixture-secret-user@example.test';
const oidcMapping = Object.freeze({ user: 'sub', tenant: 'tenant_id', role: 'role' });
const samlMapping = Object.freeze({ user: 'uid', tenant: 'tenant', role: 'role' });
const proxyMapping = Object.freeze({ user: 'x-sso-user', tenant: 'x-sso-tenant', role: 'x-sso-role' });

function assertRefused(result, reason) {
	assert.equal(result.ok, false, `${reason} must fail closed`);
	assert.match(result.reason, new RegExp(reason), `${reason} returns a sanitized reason`);
	const json = JSON.stringify(result);
	assert.equal(json.includes(FIXTURE_IDP_SECRET), false, `${reason} does not expose fixture signing material`);
	assert.equal(json.includes(secretUser), false, `${reason} does not expose mapped user claim`);
	return result;
}

const oidcToken = createFixtureJwt({
	sub: secretUser,
	tenant_id: tenantId,
	role: 'operator',
}, { issuer, audience, now, expiresInSeconds: 300 });
let verified = verifyOidcFixtureJwt(oidcToken, {
	issuer,
	audience,
	claimMapping: oidcMapping,
	tenantId,
	now,
});
assert.equal(verified.ok, true, 'valid OIDC fixture JWT verifies');
assert.equal(verified.principal.id, secretUser, 'OIDC mapped subject becomes principal id');
assert.equal(verified.principal.role, 'operator', 'OIDC mapped role becomes principal role');

const adminOidcToken = createFixtureJwt({ sub: secretUser, tenant_id: tenantId, role: 'admin' }, { issuer, audience, now });
verified = verifyOidcFixtureJwt(adminOidcToken, {
	issuer,
	audience,
	claimMapping: oidcMapping,
	tenantId,
	now,
});
assert.equal(verified.ok, true, 'admin is an allowed fixture IdP role');
assert.equal(verified.principal.role, 'admin', 'OIDC mapped admin role becomes principal role');

assertRefused(verifyOidcFixtureJwt(oidcToken, { issuer: 'https://other-idp.example.test', audience, claimMapping: oidcMapping, tenantId, now }), 'issuer mismatch');
assertRefused(verifyOidcFixtureJwt(oidcToken, { issuer, audience: 'other-audience', claimMapping: oidcMapping, tenantId, now }), 'audience mismatch');
const expiredOidcToken = createFixtureJwt({ sub: secretUser, tenant_id: tenantId, role: 'viewer' }, { issuer, audience, now, expiresInSeconds: -1 });
assertRefused(verifyOidcFixtureJwt(expiredOidcToken, { issuer, audience, claimMapping: oidcMapping, tenantId, now }), 'token expired');
const tamperedOidcToken = `${oidcToken.slice(0, -2)}aa`;
assertRefused(verifyOidcFixtureJwt(tamperedOidcToken, { issuer, audience, claimMapping: oidcMapping, tenantId, now }), 'signature invalid');
assertRefused(verifyOidcFixtureJwt(oidcToken, { issuer, audience, claimMapping: { user: 'sub', tenant: 'sub', role: 'role' }, tenantId, now }), 'claim mapping invalid');
assertRefused(verifyOidcFixtureJwt(oidcToken, { issuer, audience, claimMapping: oidcMapping, tenantId: 'tenant_b', now }), 'tenant mismatch');
const badRoleOidcToken = createFixtureJwt({ sub: secretUser, tenant_id: tenantId, role: 'superadmin' }, { issuer, audience, now });
assertRefused(verifyOidcFixtureJwt(badRoleOidcToken, { issuer, audience, claimMapping: oidcMapping, tenantId, now }), 'role is not allowed');
assert.equal(JSON.stringify(assertRefused(verifyOidcFixtureJwt(oidcToken, { issuer: 'https://other-idp.example.test', audience, claimMapping: oidcMapping, tenantId, now }), 'issuer mismatch')).includes(oidcToken), false, 'OIDC refusal does not expose raw token');

const samlAssertion = createFixtureSamlAssertion({
	issuer,
	audience,
	subject: secretUser,
	tenantId,
	role: 'owner',
	now,
	expiresAt: nowSeconds + 300,
});
verified = verifySamlFixtureAssertion(samlAssertion, {
	issuer,
	audience,
	claimMapping: samlMapping,
	tenantId,
	now,
});
assert.equal(verified.ok, true, 'valid SAML fixture assertion verifies');
assert.equal(verified.principal.role, 'owner', 'SAML mapped role becomes principal role');

assertRefused(verifySamlFixtureAssertion(samlAssertion, { issuer: 'https://other-idp.example.test', audience, claimMapping: samlMapping, tenantId, now }), 'issuer mismatch');
assertRefused(verifySamlFixtureAssertion(samlAssertion, { issuer, audience: 'other-audience', claimMapping: samlMapping, tenantId, now }), 'audience mismatch');
const expiredSamlAssertion = createFixtureSamlAssertion({ issuer, audience, subject: secretUser, tenantId, role: 'viewer', now, expiresAt: nowSeconds - 1 });
assertRefused(verifySamlFixtureAssertion(expiredSamlAssertion, { issuer, audience, claimMapping: samlMapping, tenantId, now }), 'assertion expired');
const tamperedSamlAssertion = { ...samlAssertion, attributes: { ...samlAssertion.attributes, tenant: 'tenant_b' } };
assertRefused(verifySamlFixtureAssertion(tamperedSamlAssertion, { issuer, audience, claimMapping: samlMapping, tenantId, now }), 'signature invalid');
assertRefused(verifySamlFixtureAssertion(samlAssertion, { issuer, audience, claimMapping: { user: 'uid', tenant: 'uid', role: 'role' }, tenantId, now }), 'claim mapping invalid');
assertRefused(verifySamlFixtureAssertion(samlAssertion, { issuer, audience, claimMapping: samlMapping, tenantId: 'tenant_b', now }), 'tenant mismatch');
const badRoleSamlAssertion = createFixtureSamlAssertion({ issuer, audience, subject: secretUser, tenantId, role: 'superadmin', now });
assertRefused(verifySamlFixtureAssertion(badRoleSamlAssertion, { issuer, audience, claimMapping: samlMapping, tenantId, now }), 'role is not allowed');

const proxyHeaders = createFixtureAuthProxyHeaders({
	issuer,
	audience,
	user: secretUser,
	tenantId,
	role: 'viewer',
}, { claimMapping: proxyMapping, now });
verified = verifyAuthProxyFixtureHeaders(proxyHeaders, {
	issuer,
	audience,
	claimMapping: proxyMapping,
	tenantId,
	trusted: true,
	now,
});
assert.equal(verified.ok, true, 'valid auth-proxy fixture headers verify');
assert.equal(verified.principal.role, 'viewer', 'auth-proxy mapped role becomes principal role');

assertRefused(verifyAuthProxyFixtureHeaders(proxyHeaders, { issuer, audience, claimMapping: proxyMapping, tenantId, trusted: false, now }), 'proxy boundary is not trusted');
assertRefused(verifyAuthProxyFixtureHeaders(proxyHeaders, { issuer: 'https://other-idp.example.test', audience, claimMapping: proxyMapping, tenantId, trusted: true, now }), 'issuer mismatch');
assertRefused(verifyAuthProxyFixtureHeaders(proxyHeaders, { issuer, audience: 'other-audience', claimMapping: proxyMapping, tenantId, trusted: true, now }), 'audience mismatch');
const expiredProxyHeaders = createFixtureAuthProxyHeaders({ issuer, audience, user: secretUser, tenantId, role: 'viewer' }, { claimMapping: proxyMapping, now, expiresInSeconds: -1 });
assertRefused(verifyAuthProxyFixtureHeaders(expiredProxyHeaders, { issuer, audience, claimMapping: proxyMapping, tenantId, trusted: true, now }), 'header assertion expired');
const tamperedProxyHeaders = { ...proxyHeaders, 'x-sso-tenant': 'tenant_b' };
assertRefused(verifyAuthProxyFixtureHeaders(tamperedProxyHeaders, { issuer, audience, claimMapping: proxyMapping, tenantId, trusted: true, now }), 'signature invalid');
assertRefused(verifyAuthProxyFixtureHeaders(proxyHeaders, { issuer, audience, claimMapping: { user: 'x-sso-user', tenant: 'x-sso-user', role: 'x-sso-role' }, tenantId, trusted: true, now }), 'claim mapping invalid');
assertRefused(verifyAuthProxyFixtureHeaders(proxyHeaders, { issuer, audience, claimMapping: proxyMapping, tenantId: 'tenant_b', trusted: true, now }), 'tenant mismatch');
const badRoleProxyHeaders = createFixtureAuthProxyHeaders({ issuer, audience, user: secretUser, tenantId, role: 'superadmin' }, { claimMapping: proxyMapping, now });
assertRefused(verifyAuthProxyFixtureHeaders(badRoleProxyHeaders, { issuer, audience, claimMapping: proxyMapping, tenantId, trusted: true, now }), 'role is not allowed');

console.log('  webui-idp-verifier-unit: all checks passed');
NODE
)
