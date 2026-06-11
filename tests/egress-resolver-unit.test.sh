#!/usr/bin/env bash
# Browser-free resolver adapter contract tests. Uses fake resolver only; no OS DNS or network.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
	createEgressResolver,
	createFakeResolver,
	resolverEvidenceForUrl,
} = require('./lib/egress-resolver.js');
const {
	validateUrlEgress,
} = require('./lib/egress-policy.js');

const fixedNow = Date.parse('2026-06-10T12:00:00Z');

assert.throws(
	() => createEgressResolver(),
	/explicit deterministic provider|OS DNS fallback is not available/,
	'resolver adapter refuses implicit OS DNS fallback',
);

const asyncResolver = createEgressResolver({ resolveA: () => Promise.resolve(['93.184.216.34']) });
assert.throws(
	() => asyncResolver.resolveHost('async.example.test'),
	/synchronous and deterministic/,
	'resolver adapter refuses async providers in deterministic replay',
);

const fake = createFakeResolver({
	'alias.example.test': { CNAME: 'edge.example.test', ttlSeconds: 120 },
	'edge.example.test': {
		A: ['93.184.216.34'],
		AAAA: ['2606:2800:220:1:248:1893:25c8:1946'],
		connectionIp: '93.184.216.34',
		ttlSeconds: 120,
	},
}, { nowMs: fixedNow });

const evidence = fake.resolveHost('ALIAS.EXAMPLE.TEST.');
assert.equal(evidence.host, 'alias.example.test', 'requested host is canonicalized');
assert.equal(evidence.canonicalName, 'edge.example.test', 'canonical host follows CNAME target');
assert.deepEqual(evidence.cnameChain, ['alias.example.test', 'edge.example.test'], 'CNAME chain is deterministic evidence');
assert.deepEqual(evidence.aRecords, ['93.184.216.34'], 'A records are preserved');
assert.deepEqual(evidence.aaaaRecords, ['2606:2800:220:1:248:1893:25c8:1946'], 'AAAA records are preserved');
assert.deepEqual(evidence.addresses, ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'], 'A and AAAA records combine into policy addresses');
assert.equal(evidence.ttlMs, 120000, 'TTL is normalized to milliseconds');
assert.equal(evidence.expiresAtMs, fixedNow + 120000, 'TTL expiry timestamp is deterministic');
assert.equal(evidence.stale, false, 'fresh evidence is not marked stale');

let evidenceMap = resolverEvidenceForUrl('https://alias.example.test/path?token=redacted-by-policy', fake);
assert.deepEqual(Object.keys(evidenceMap), ['alias.example.test'], 'URL helper returns host-keyed resolver evidence');
assert.equal(evidenceMap['alias.example.test'].canonicalName, 'edge.example.test', 'URL helper preserves canonical host');

let r = validateUrlEgress('https://alias.example.test/path', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: 'https://alias.example.test',
	resolver: fake,
	requireFreshResolverEvidence: true,
	requireConnectionIp: true,
	nowMs: fixedNow,
});
assert.equal(r.ok, true, 'fake resolver evidence satisfies public allowlisted egress policy');
assert.deepEqual(r.resolvedIps, ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'], 'policy receives combined A/AAAA evidence');
assert.deepEqual(r.connectionIps, ['93.184.216.34'], 'policy receives connection-IP evidence');
assert.equal(r.canonicalName, 'edge.example.test', 'policy reports canonical host evidence');

const expiredResolver = createFakeResolver({
	'expired.example.test': {
		A: ['93.184.216.34'],
		ttlSeconds: 60,
		resolvedAtMs: fixedNow - (10 * 60 * 1000),
	},
}, { nowMs: fixedNow });
const expiredEvidence = expiredResolver.resolveHost('expired.example.test');
assert.equal(expiredEvidence.stale, true, 'adapter marks TTL-expired evidence stale');
assert.equal(expiredEvidence.expiresAtMs, fixedNow - (9 * 60 * 1000), 'expired evidence carries deterministic expiry');

r = validateUrlEgress('https://expired.example.test/app', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: 'https://expired.example.test',
	resolver: expiredResolver,
	requireFreshResolverEvidence: true,
	nowMs: fixedNow,
});
assert.equal(r.ok, false, 'policy rejects stale resolver evidence');
assert.match(r.reason, /stale|older than/, 'stale evidence refusal is explicit');

const privateResolver = createFakeResolver({
	'private.example.test': { A: ['10.20.30.40'], ttlSeconds: 60 },
}, { nowMs: fixedNow });
r = validateUrlEgress('https://private.example.test/app?token=top-secret', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: 'https://private.example.test',
	resolver: privateResolver,
	requireFreshResolverEvidence: true,
	nowMs: fixedNow,
});
assert.equal(r.ok, false, 'public profile rejects fake resolver private IP evidence');
assert.match(r.reason, /10\.20\.30\.40|private/, 'private IP refusal names the deterministic answer');
assert.equal(JSON.stringify(r).includes('top-secret'), false, 'private IP denial does not leak URL query secrets');

const metadataResolver = createFakeResolver({
	'meta-alias.example.test': { CNAME: 'metadata.google.internal', ttlSeconds: 60 },
	'metadata.google.internal': { A: ['169.254.169.254'], ttlSeconds: 60 },
}, { nowMs: fixedNow });
const metadataEvidence = metadataResolver.resolveHost('meta-alias.example.test');
assert.equal(metadataEvidence.canonicalName, 'metadata.google.internal', 'metadata CNAME canonical host is preserved');
assert.deepEqual(metadataEvidence.cnameChain, ['meta-alias.example.test', 'metadata.google.internal'], 'metadata CNAME chain is preserved');

r = validateUrlEgress('https://meta-alias.example.test/latest/meta-data/?password=hunter2', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: 'https://meta-alias.example.test',
	resolver: metadataResolver,
	requireFreshResolverEvidence: true,
	nowMs: fixedNow,
});
assert.equal(r.ok, false, 'metadata CNAME/IP evidence is refused');
assert.match(r.reason, /metadata|169\.254\.169\.254/, 'metadata denial explains the blocked evidence');
assert.equal(JSON.stringify(r).includes('hunter2'), false, 'metadata denial does not leak URL query secrets');

const mismatchResolver = createFakeResolver({
	'mismatch.example.test': {
		A: ['93.184.216.34'],
		connectionIp: '93.184.216.35',
		ttlSeconds: 60,
	},
}, { nowMs: fixedNow });

r = validateUrlEgress('https://mismatch.example.test/app?token=top-secret&password=hunter2#frag', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: 'https://mismatch.example.test',
	resolver: mismatchResolver,
	requireConnectionIp: true,
	requireFreshResolverEvidence: true,
	nowMs: fixedNow,
});
assert.equal(r.ok, false, 'connection-IP mismatch is refused');
assert.match(r.reason, /connection IP 93\.184\.216\.35.*does not match/, 'connection mismatch denial names observed IP');
assert.equal(JSON.stringify(r).includes('top-secret'), false, 'connection mismatch denial redacts token query');
assert.equal(JSON.stringify(r).includes('hunter2'), false, 'connection mismatch denial redacts password query');
assert.equal(r.audit.url, 'https://mismatch.example.test/app', 'denied audit URL is sanitized');

console.log('  egress-resolver-unit: fake resolver evidence contract passes');
NODE
)
