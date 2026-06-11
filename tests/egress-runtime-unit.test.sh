#!/usr/bin/env bash
# Browser-free runtime egress adapter tests. Uses fake resolver only; no OS DNS or network.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createFakeResolver } = require('./lib/egress-resolver.js');
const { validateUrlEgress } = require('./lib/egress-policy.js');
const {
	createRuntimeEgressChecker,
	prepareRuntimeEgressPolicyOptions,
	resolveRuntimeEgressEvidence,
	runtimeEgressDenyEvent,
	runtimeEvidenceRequiredForUrl,
	validateRuntimeUrlEgress,
} = require('./lib/egress-runtime.js');
const {
	FIXED_NOW: FIXTURE_NOW,
	actors,
	assertFixtureArtifactClean,
	externalModeEnv,
	stableHash,
	targets,
	tenantAllowlistRegistry,
	tenants,
} = require('./tests/fixtures/p0-external-fixtures.cjs');

const fixedNow = Date.parse('2026-06-10T12:00:00Z');
const basePolicy = (host, extra = {}) => ({
	profile: 'public',
	enforceAllowlist: true,
	allowlist: `https://${host}`,
	requireFreshResolverEvidence: true,
	nowMs: fixedNow,
	...extra,
});

const runtimePolicy = (host, extra = {}) => ({
	profile: 'public',
	phase: 'run',
	enforceAllowlist: true,
	allowlist: `https://${host}`,
	nowMs: fixedNow,
	...extra,
});

assert.equal(runtimeEvidenceRequiredForUrl('https://strict.example.test/app', runtimePolicy('strict.example.test')), true, 'public runtime URLs require deterministic runtime evidence');
assert.equal(runtimeEvidenceRequiredForUrl('http://127.0.0.1:43210/fixture', { profile: 'local', phase: 'run' }), false, 'local fixture runtime URLs do not require resolver evidence');

let strictResult = validateRuntimeUrlEgress('https://strict.example.test/app', {
	policyOptions: runtimePolicy('strict.example.test'),
});
assert.equal(strictResult.ok, false, 'public runtime fails closed without resolver evidence');
assert.match(strictResult.reason, /resolver evidence|resolved IPs|freshness/, 'missing runtime evidence refusal is explicit');

strictResult = validateRuntimeUrlEgress('http://127.0.0.1:43210/fixture', {
	policyOptions: { profile: 'local', phase: 'run', enforceAllowlist: true },
});
assert.equal(strictResult.ok, true, 'local fixture runtime remains allowed without resolver evidence');

const noConnectionResolver = createFakeResolver({
	'strict.example.test': { A: ['93.184.216.34'], ttlSeconds: 60 },
}, { nowMs: fixedNow });
strictResult = validateRuntimeUrlEgress('https://strict.example.test/app', {
	policyOptions: runtimePolicy('strict.example.test'),
	resolver: noConnectionResolver,
});
assert.equal(strictResult.ok, false, 'public runtime requires connection IP evidence by default');
assert.match(strictResult.reason, /no connection IP evidence/, 'missing connection evidence refusal is explicit');

const strictResolver = createFakeResolver({
	'strict.example.test': { A: ['93.184.216.34'], connectionIp: '93.184.216.34', ttlSeconds: 60 },
}, { nowMs: fixedNow });
strictResult = validateRuntimeUrlEgress('https://strict.example.test/app', {
	policyOptions: runtimePolicy('strict.example.test'),
	resolver: strictResolver,
});
assert.equal(strictResult.ok, true, 'public runtime accepts fresh resolver evidence plus matching connection evidence');

let staticConnectionCallbackUrl = '';
strictResult = validateRuntimeUrlEgress('https://static-evidence.example.test/app?token=top-secret', {
	policyOptions: runtimePolicy('static-evidence.example.test', {
		resolverEvidence: {
			'static-evidence.example.test': {
				addresses: ['93.184.216.34'],
				resolvedAtMs: fixedNow,
				ttlSeconds: 60,
			},
		},
	}),
	connectionIpsForUrl: (url) => {
		staticConnectionCallbackUrl = url;
		return '93.184.216.34';
	},
});
assert.equal(strictResult.ok, true, 'public runtime accepts static resolver evidence plus deterministic connection provider');
assert.equal(staticConnectionCallbackUrl, 'https://static-evidence.example.test/app', 'static-evidence connection callback receives sanitized URL');

const publicResolver = createFakeResolver({
	'alias.example.test': { CNAME: 'edge.example.test', ttlSeconds: 120 },
	'edge.example.test': {
		A: ['93.184.216.34'],
		AAAA: ['2606:2800:220:1:248:1893:25c8:1946'],
		connectionIp: '93.184.216.34',
		ttlSeconds: 120,
	},
}, { nowMs: fixedNow });

let evidence = resolveRuntimeEgressEvidence('https://user:secret@alias.example.test/app?token=top-secret', {
	policyOptions: basePolicy('alias.example.test'),
	resolver: publicResolver,
});
assert.deepEqual(Object.keys(evidence), ['alias.example.test'], 'runtime adapter keys resolver evidence by URL host');
assert.equal(evidence['alias.example.test'].canonicalName, 'edge.example.test', 'runtime evidence preserves canonical name');
assert.deepEqual(evidence['alias.example.test'].cnameChain, ['alias.example.test', 'edge.example.test'], 'runtime evidence preserves CNAME chain');
assert.equal(JSON.stringify(evidence).includes('top-secret'), false, 'runtime resolver evidence does not carry URL query secrets');
assert.equal(JSON.stringify(evidence).includes('secret'), false, 'runtime resolver evidence does not carry URL credentials');

let prepared = prepareRuntimeEgressPolicyOptions('https://alias.example.test/app?token=top-secret', {
	policyOptions: basePolicy('alias.example.test', { requireConnectionIp: true, label: 'request' }),
	resolver: publicResolver,
});
assert.equal(prepared.policyOptions.resolver, undefined, 'adapter feeds evidence instead of exposing resolver fallback to policy options');
assert.equal(prepared.resolverEvidence['alias.example.test'].canonicalName, 'edge.example.test', 'prepared options include resolver metadata');

let r = validateUrlEgress('https://alias.example.test/app?token=top-secret', prepared.policyOptions);
assert.equal(r.ok, true, 'prepared runtime evidence satisfies validateUrlEgress');
assert.deepEqual(r.resolvedIps, ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'], 'validateUrlEgress receives A/AAAA evidence');
assert.deepEqual(r.connectionIps, ['93.184.216.34'], 'validateUrlEgress receives resolver connection-IP evidence');
assert.equal(r.canonicalName, 'edge.example.test', 'validateUrlEgress reports canonical metadata');

const checker = createRuntimeEgressChecker({
	policyOptions: basePolicy('alias.example.test', { requireConnectionIp: true }),
	resolver: publicResolver,
});
r = checker.checkUrl('https://alias.example.test/app', 'request');
assert.equal(r.ok, true, 'runtime checker preserves checkUrl shape for runner guards');
assert.equal(checker.assertUrl('https://alias.example.test/app', 'request').ok, true, 'runtime checker preserves assertUrl shape for runner guards');

const staleResolver = createFakeResolver({
	'stale.example.test': {
		A: ['93.184.216.34'],
		resolvedAtMs: fixedNow - (10 * 60 * 1000),
		ttlSeconds: 60,
	},
}, { nowMs: fixedNow });
r = validateRuntimeUrlEgress('https://stale.example.test/app', {
	policyOptions: basePolicy('stale.example.test'),
	resolver: staleResolver,
});
assert.equal(r.ok, false, 'runtime adapter rejects TTL-stale resolver evidence');
assert.match(r.reason, /stale|older than/, 'stale refusal is explicit');

const privateResolver = createFakeResolver({
	'private.example.test': { A: ['10.20.30.40'], ttlSeconds: 60 },
}, { nowMs: fixedNow });
r = validateRuntimeUrlEgress('https://private.example.test/app?password=hunter2', {
	policyOptions: basePolicy('private.example.test'),
	resolver: privateResolver,
});
assert.equal(r.ok, false, 'runtime adapter blocks private resolved IP evidence in public profile');
assert.match(r.reason, /private|10\.20\.30\.40/, 'private IP refusal names deterministic evidence');
assert.equal(JSON.stringify(r).includes('hunter2'), false, 'private IP refusal redacts URL query secrets');

const metadataResolver = createFakeResolver({
	'meta-alias.example.test': { CNAME: 'metadata.google.internal', ttlSeconds: 60 },
	'metadata.google.internal': { A: ['169.254.169.254'], ttlSeconds: 60 },
}, { nowMs: fixedNow });
r = validateRuntimeUrlEgress('https://meta-alias.example.test/latest/meta-data/?token=top-secret', {
	policyOptions: basePolicy('meta-alias.example.test'),
	resolver: metadataResolver,
});
assert.equal(r.ok, false, 'runtime adapter blocks metadata CNAME/IP evidence');
assert.match(r.reason, /metadata|169\.254\.169\.254/, 'metadata refusal names blocked evidence');
assert.equal(JSON.stringify(r).includes('top-secret'), false, 'metadata refusal redacts URL query secrets');

const mismatchResolver = createFakeResolver({
	'mismatch.example.test': {
		A: ['93.184.216.34'],
		ttlSeconds: 60,
	},
}, { nowMs: fixedNow });
let callbackUrl = '';
r = validateRuntimeUrlEgress('https://mismatch.example.test/app?token=top-secret', {
	policyOptions: basePolicy('mismatch.example.test', { requireConnectionIp: true }),
	resolver: mismatchResolver,
	connectionIpsForUrl: (url) => {
		callbackUrl = url;
		return '93.184.216.35';
	},
});
assert.equal(r.ok, false, 'runtime adapter rejects connection-IP mismatch evidence');
assert.match(r.reason, /connection IP 93\.184\.216\.35.*does not match/, 'connection mismatch refusal names observed IP');
assert.equal(JSON.stringify(r).includes('top-secret'), false, 'connection mismatch refusal redacts URL query secrets');
assert.equal(r.audit.url, 'https://mismatch.example.test/app', 'connection mismatch audit URL is sanitized');
assert.equal(callbackUrl, 'https://mismatch.example.test/app', 'connection-IP callback receives a sanitized URL');

const denyEvent = runtimeEgressDenyEvent(r, { flow: 'unit-flow' });
assert.equal(denyEvent.event, 'egress-denied', 'denial event has stable event name');
assert.equal(denyEvent.flow, 'unit-flow', 'denial event can carry local audit context');
assert.equal(denyEvent.url, 'https://mismatch.example.test/app', 'denial event URL is sanitized');
assert.deepEqual(denyEvent.resolvedIps, ['93.184.216.34'], 'denial event carries bounded resolver metadata');
assert.deepEqual(denyEvent.connectionIps, ['93.184.216.35'], 'denial event carries bounded connection metadata');
assert.match(denyEvent.targetHash, /^sha256:[0-9a-f]{64}$/, 'denial event carries deterministic target hash');
assert.match(denyEvent.evidenceHash, /^sha256:[0-9a-f]{64}$/, 'denial event carries deterministic evidence hash');
assert.equal(JSON.stringify(denyEvent).includes('top-secret'), false, 'denial event does not leak URL secrets');

r = validateRuntimeUrlEgress('https://event-path.example.test/app?token=top-secret', {
	policyOptions: runtimePolicy('event-path.example.test', { label: 'request:iframe', egressPath: 'iframe' }),
});
const pathEvent = runtimeEgressDenyEvent(r);
assert.equal(pathEvent.label, 'request:iframe', 'denial event keeps explicit request path label');
assert.equal(pathEvent.path, 'iframe', 'denial event keeps explicit request path metadata');
assert.equal(JSON.stringify(pathEvent).includes('top-secret'), false, 'path denial event redacts query secrets');

const registryConflict = validateRuntimeUrlEgress(targets.tenantA.blocked.url, {
	policyOptions: {
		profile: 'public',
		phase: 'run',
		tenantId: tenants.a.id,
		env: externalModeEnv({ AQA_TARGET_ALLOWLIST: targets.tenantA.blocked.origin }),
		allowlistRegistry: tenantAllowlistRegistry,
		nowMs: FIXTURE_NOW,
	},
});
assert.equal(registryConflict.ok, false, 'fixture registry conflict produces a denied runtime verdict');
assert.match(registryConflict.reason, /operator target allowlist conflicts with tenant allowlist registry/, 'fixture runtime refusal names registry conflict');
const auditEvent = runtimeEgressDenyEvent(registryConflict, {
	at: '2026-06-10T12:00:00.000Z',
	tenantId: tenants.a.id,
	jobId: 'job-tenant-a-001',
	runId: 'run-tenant-a-001',
	flow: 'tenant-a-blocked-flow',
	actorId: actors.tenantA.operator.id,
	context: {
		requestUrl: targets.tenantA.blocked.url,
		authorization: 'Bearer context_secret',
		cookie: 'sid=context_cookie',
		otp: '123456',
		nested: { password: 'context_password' },
	},
});
assert.equal(auditEvent.tenantId, tenants.a.id, 'audit event carries tenant id');
assert.equal(auditEvent.jobId, 'job-tenant-a-001', 'audit event carries job id');
assert.equal(auditEvent.flow, 'tenant-a-blocked-flow', 'audit event carries flow id');
assert.equal(auditEvent.flowHash, stableHash('tenant-a-blocked-flow'), 'audit event carries deterministic flow hash');
assert.match(auditEvent.contextHash, /^sha256:[0-9a-f]{64}$/, 'audit event carries deterministic context hash');
assert.match(auditEvent.evidenceHash, /^sha256:[0-9a-f]{64}$/, 'audit event carries deterministic evidence hash with context');
assert.equal(JSON.stringify(auditEvent).includes('blocked-secret'), false, 'audit event redacts target query secret');
assert.equal(JSON.stringify(auditEvent).includes('context_secret'), false, 'audit event redacts authorization context');
assert.equal(JSON.stringify(auditEvent).includes('context_cookie'), false, 'audit event redacts cookie context');
assert.equal(JSON.stringify(auditEvent).includes('context_password'), false, 'audit event redacts password context');
assert.equal(JSON.stringify(auditEvent).includes('123456'), false, 'audit event redacts OTP context');
assertFixtureArtifactClean(auditEvent, 'denied-egress-audit-event');

console.log('  egress-runtime-unit: runtime resolver policy adapter passes');
NODE
)
