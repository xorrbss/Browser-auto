#!/usr/bin/env bash
# Browser-free coverage for target egress policy and WebUI system registration gates.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

( cd "$DIR" && AQA_DB_PATH="$TMP/t.db" node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
	validateFlowEgressPolicy,
	validateSystemEgressPolicy,
	validateUrlEgress,
	parseAllowlistRegistry,
	parseResolvedIpMap,
	parseResolverEvidenceMap,
	hostKind,
} = require('./lib/egress-policy.js');
const {
	validateFlowRunPolicy,
} = require('./lib/flow-policy.js');
const {
	FIXED_NOW,
	actors,
	externalModeEnv,
	flowForTarget,
	registryWithTarget,
	resolverEvidenceForTargets,
	systemForTarget,
	targets,
	tenantAllowlistRegistry,
	tenants,
} = require('./tests/fixtures/p0-external-fixtures.cjs');

const readStep = { kind: 'find', by: 'text', value: 'Open', action: 'hover' };
const fixedNow = Date.parse('2026-06-10T12:00:00Z');
const flow = (startUrl, extra = {}) => ({
	name: 'egress_unit',
	engine: 'playwright',
	environment: 'local',
	riskClass: 'read',
	startUrl,
	steps: [readStep],
	asserts: [],
	...extra,
});

assert.equal(hostKind('169.254.169.254'), 'metadata', 'metadata IPv4 classified');
assert.equal(hostKind('127.0.0.1'), 'loopback', 'loopback classified');
assert.equal(hostKind('10.1.2.3'), 'private', 'RFC1918 classified');
assert.equal(actors.tenantA.owner.role, 'owner', 'fixture actors include owner role');
assert.equal(actors.tenantA.admin.role, 'admin', 'fixture actors include admin role');
assert.equal(actors.tenantA.operator.role, 'operator', 'fixture actors include operator role');
assert.equal(actors.tenantA.viewer.role, 'viewer', 'fixture actors include viewer role');
assert.equal(tenants.a.id, 'tenant-a', 'fixture tenant A is deterministic');
assert.equal(tenants.b.id, 'tenant-b', 'fixture tenant B is deterministic');

let registry = parseAllowlistRegistry(tenantAllowlistRegistry);
assert.equal(registry.configured, true, 'tenant allowlist registry fixture parses');
assert.equal(registry.tenants.get(tenants.a.id).length, 1, 'tenant A registry has one allowed origin');

let r = validateFlowEgressPolicy(flowForTarget(targets.tenantA.allowed, { tenant: tenants.a }), {
	phase: 'run',
	tenantId: tenants.a.id,
	env: externalModeEnv(),
	allowlistRegistry: tenantAllowlistRegistry,
	resolverEvidence: resolverEvidenceForTargets(targets.tenantA.allowed),
	requireFreshResolverEvidence: true,
	nowMs: FIXED_NOW,
});
assert.equal(r.ok, true, 'external-mode fixture target passes through tenant allowlist registry');

r = validateSystemEgressPolicy(systemForTarget(targets.tenantA.allowed, { tenant: tenants.a }), {
	phase: 'register',
	tenantId: tenants.a.id,
	env: externalModeEnv(),
	allowlistRegistry: tenantAllowlistRegistry,
	resolverEvidence: resolverEvidenceForTargets(targets.tenantA.allowed),
	requireFreshResolverEvidence: true,
	nowMs: FIXED_NOW,
});
assert.equal(r.ok, true, 'system registration fixture target passes through tenant allowlist registry');

r = validateFlowEgressPolicy(flowForTarget(targets.tenantB.allowed, { tenant: tenants.a }), {
	phase: 'run',
	tenantId: tenants.a.id,
	env: externalModeEnv(),
	allowlistRegistry: tenantAllowlistRegistry,
	resolverEvidence: resolverEvidenceForTargets(targets.tenantB.allowed),
	requireFreshResolverEvidence: true,
	nowMs: FIXED_NOW,
});
assert.equal(r.ok, false, 'tenant A cannot use tenant B target registry entry');
assert.match(r.reason, /tenant allowlist registry/, 'cross-tenant target refusal names registry');

r = validateFlowEgressPolicy(flowForTarget(targets.tenantA.blocked, { tenant: tenants.a }), {
	phase: 'run',
	tenantId: tenants.a.id,
	env: externalModeEnv({ AQA_TARGET_ALLOWLIST: targets.tenantA.blocked.origin }),
	allowlistRegistry: tenantAllowlistRegistry,
	resolverEvidence: resolverEvidenceForTargets(targets.tenantA.blocked),
	requireFreshResolverEvidence: true,
	nowMs: FIXED_NOW,
});
assert.equal(r.ok, false, 'operator env allowlist cannot bypass tenant registry conflict');
assert.match(r.reason, /operator target allowlist conflicts with tenant allowlist registry/, 'operator override conflict is explicit');
assert.equal(JSON.stringify(r).includes('blocked-secret'), false, 'registry conflict denial redacts URL query material');

r = validateFlowEgressPolicy(flowForTarget(targets.tenantA.private, { tenant: tenants.a }), {
	phase: 'run',
	tenantId: tenants.a.id,
	env: externalModeEnv(),
	allowlistRegistry: registryWithTarget(tenants.a, targets.tenantA.private),
	resolverEvidence: resolverEvidenceForTargets(targets.tenantA.private),
	requireFreshResolverEvidence: true,
	nowMs: FIXED_NOW,
});
assert.equal(r.ok, false, 'registry-allowed public hostname resolving to private IP is still refused');
assert.match(r.reason, /private|10\.20\.30\.40/, 'private target refusal names deterministic evidence');
assert.equal(JSON.stringify(r).includes('private-secret'), false, 'private target denial redacts URL query material');

r = validateFlowEgressPolicy(flowForTarget(targets.metadata, { tenant: tenants.a }), {
	phase: 'run',
	tenantId: tenants.a.id,
	env: externalModeEnv(),
	allowlistRegistry: registryWithTarget(tenants.a, targets.metadata),
});
assert.equal(r.ok, false, 'metadata fixture target is refused before browser launch');
assert.match(r.reason, /metadata|cloud metadata/, 'metadata fixture refusal explains why');
assert.equal(JSON.stringify(r).includes('metadata-secret'), false, 'metadata fixture denial redacts URL query material');

r = validateFlowEgressPolicy(flowForTarget(targets.controlPlane, { tenant: tenants.a }), {
	phase: 'run',
	tenantId: tenants.a.id,
	env: externalModeEnv(),
	allowlistRegistry: registryWithTarget(tenants.a, targets.controlPlane),
});
assert.equal(r.ok, false, 'control-plane fixture target is refused even when registered');
assert.match(r.reason, /control-plane|service-control/, 'control-plane fixture refusal explains why');
assert.equal(JSON.stringify(r).includes('control-secret'), false, 'control-plane denial redacts URL query material');

r = validateFlowEgressPolicy(flow('http://169.254.169.254/latest/meta-data/'), { phase: 'validate' });
assert.equal(r.ok, false, 'direct metadata startUrl refused before browser');
assert.match(r.reason, /metadata|cloud metadata/, 'metadata refusal explains why');

r = validateFlowEgressPolicy(flow('http://127.0.0.1:43210/fixture'), { phase: 'run' });
assert.equal(r.ok, true, 'local localhost fixture is allowed without target allowlist');

r = validateUrlEgress('http://127.0.0.1:43210/fixture', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: 'http://127.0.0.1:43210',
});
assert.equal(r.ok, false, 'loopback/control-plane address is blocked by default public profile');
assert.match(r.reason, /localhost|loopback/, 'loopback refusal explains why');

r = validateUrlEgress('http://127.0.0.1:4310/api/run?token=top-secret', {
	profile: 'local',
	enforceAllowlist: false,
});
assert.equal(r.ok, false, 'WebUI control-plane target is blocked even in local profile');
assert.match(r.reason, /control-plane|service-control/, 'control-plane refusal explains why');
assert.equal(JSON.stringify(r).includes('top-secret'), false, 'control-plane refusal redacts query values');

r = validateUrlEgress('http://127.0.0.1:6080/vnc.html', {
	profile: 'on-prem',
	enforceAllowlist: true,
	allowlist: 'http://127.0.0.1:6080',
});
assert.equal(r.ok, false, 'noVNC control-plane target remains blocked even when allowlisted');

r = validateFlowEgressPolicy(flow('file:///C:/tmp/fixture.html'), { phase: 'run' });
assert.equal(r.ok, true, 'local file fixture is allowed without target allowlist');

r = validateFlowEgressPolicy(flow('https://example.test/app'), { phase: 'run' });
assert.equal(r.ok, false, 'public local flow still needs an explicit target allowlist');
assert.match(r.reason, /AQA_TARGET_ALLOWLIST/, 'public refusal names target allowlist');

r = validateFlowEgressPolicy(flow('https://example.test/app'), { phase: 'run', allowlist: 'https://example.test' });
assert.equal(r.ok, true, 'public target passes when origin is allowlisted');

r = validateFlowRunPolicy(flow('https://import.example.test/app', { environment: 'staging' }), { phase: 'import' });
assert.equal(r.ok, false, 'flow import rejects non-local targets outside the tenant allowlist');
assert.match(r.reason, /AQA_TARGET_ALLOWLIST/, 'flow import refusal names target allowlist');

r = validateFlowRunPolicy(flow('https://import.example.test/app', { environment: 'staging' }), { phase: 'import', allowlist: 'https://import.example.test' });
assert.equal(r.ok, true, 'flow import accepts tenant-allowlisted target origins');

r = validateUrlEgress('https://example.test/app', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: 'https://example.test',
	resolveHost: (host) => host === 'example.test' ? ['169.254.169.254'] : [],
});
assert.equal(r.ok, false, 'allowlisted hostname resolving to metadata is refused');
assert.match(r.reason, /resolved IP 169\.254\.169\.254|cloud metadata/, 'resolved metadata refusal names the resolved IP');

r = validateUrlEgress('https://private.example.test/app', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: 'https://private.example.test',
	resolvedHosts: { 'private.example.test': ['10.1.2.3'] },
});
assert.equal(r.ok, false, 'allowlisted hostname resolving to RFC1918 is refused in public profile');
assert.match(r.reason, /resolved IP 10\.1\.2\.3|private/, 'resolved private refusal explains why');

r = validateUrlEgress('https://mixed.example.test/app', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: 'https://mixed.example.test',
	resolvedHosts: { 'mixed.example.test': ['93.184.216.34', '10.9.8.7'] },
});
assert.equal(r.ok, false, 'DNS/IP mismatch fails closed when any deterministic answer is private');
assert.match(r.reason, /10\.9\.8\.7/, 'DNS/IP mismatch refusal names the blocked answer');

r = validateUrlEgress('https://public.example.test/app', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: 'https://public.example.test',
	resolvedHosts: { 'public.example.test': [{ address: '93.184.216.34' }] },
});
assert.equal(r.ok, true, 'allowlisted hostname resolving to public IP is allowed');
assert.deepEqual(r.resolvedIps, ['93.184.216.34'], 'resolved public IP is reported');

r = validateUrlEgress('https://alias.example.test/app', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: 'https://alias.example.test',
	resolverEvidence: {
		'alias.example.test': {
			cnameChain: ['alias.example.test', 'edge.example.test'],
			canonicalName: 'edge.example.test',
			addresses: ['93.184.216.34'],
			resolvedAt: '2026-06-10T11:59:30Z',
			ttlSeconds: 120,
		},
	},
	requireFreshResolverEvidence: true,
	nowMs: fixedNow,
});
assert.equal(r.ok, true, 'fresh CNAME/resolved chain evidence is accepted');
assert.deepEqual(r.cnameChain, ['alias.example.test', 'edge.example.test'], 'CNAME chain metadata is reported');
assert.equal(r.canonicalName, 'edge.example.test', 'canonical resolver metadata is reported');

r = validateUrlEgress('https://stale.example.test/app', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: 'https://stale.example.test',
	resolverEvidence: {
		'stale.example.test': {
			addresses: ['93.184.216.34'],
			resolvedAt: '2026-06-10T11:00:00Z',
			ttlSeconds: 60,
		},
	},
	requireFreshResolverEvidence: true,
	nowMs: fixedNow,
});
assert.equal(r.ok, false, 'stale resolver evidence is rejected when freshness is required');
assert.match(r.reason, /stale|older than/, 'stale resolver refusal is explicit');

r = validateUrlEgress('https://missing-freshness.example.test/app', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: 'https://missing-freshness.example.test',
	resolverEvidence: { 'missing-freshness.example.test': { addresses: ['93.184.216.34'] } },
	requireFreshResolverEvidence: true,
	nowMs: fixedNow,
});
assert.equal(r.ok, false, 'resolver evidence without freshness metadata is rejected when required');
assert.match(r.reason, /missing freshness metadata/, 'missing freshness refusal is explicit');

r = validateUrlEgress('https://bad-chain.example.test/app', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: 'https://bad-chain.example.test',
	resolverEvidence: {
		'bad-chain.example.test': {
			cnameChain: ['other.example.test', 'bad-chain.example.test'],
			canonicalName: 'bad-chain.example.test',
			addresses: ['93.184.216.34'],
		},
	},
});
assert.equal(r.ok, false, 'CNAME chain must bind to the requested hostname');
assert.match(r.reason, /CNAME chain/, 'bad CNAME chain refusal is explicit');

r = validateUrlEgress('https://chain-metadata.example.test/app', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: 'https://chain-metadata.example.test',
	resolverEvidence: {
		'chain-metadata.example.test': {
			cnameChain: ['chain-metadata.example.test', 'metadata.google.internal'],
			canonicalName: 'metadata.google.internal',
			addresses: ['93.184.216.34'],
		},
	},
});
assert.equal(r.ok, false, 'CNAME chain to metadata host is refused');
assert.match(r.reason, /CNAME\/resolved chain|metadata/, 'metadata CNAME refusal explains why');

r = validateUrlEgress('https://connection-mismatch.example.test/app?token=top-secret', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: 'https://connection-mismatch.example.test',
	resolverEvidence: {
		'connection-mismatch.example.test': {
			addresses: ['93.184.216.34'],
			connectionIp: '93.184.216.35',
		},
	},
});
assert.equal(r.ok, false, 'DNS rebinding evidence mismatch is refused');
assert.match(r.reason, /connection IP 93\.184\.216\.35.*does not match/, 'connection mismatch refusal names the observed IP');
assert.equal(JSON.stringify(r).includes('top-secret'), false, 'connection mismatch denial audit details redact URL secrets');
assert.equal(r.audit.url, 'https://connection-mismatch.example.test/app', 'denied URL audit detail is sanitized');

r = validateUrlEgress('https://missing-connection.example.test/app', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: 'https://missing-connection.example.test',
	resolverEvidence: { 'missing-connection.example.test': { addresses: ['93.184.216.34'] } },
	requireConnectionIp: true,
});
assert.equal(r.ok, false, 'missing connection IP evidence is rejected when required');
assert.match(r.reason, /no connection IP evidence/, 'missing connection evidence refusal is explicit');

r = validateUrlEgress('https://parsed-evidence.example.test/app', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: 'https://parsed-evidence.example.test',
	resolverEvidence: parseResolverEvidenceMap('{"parsed-evidence.example.test":{"addresses":["93.184.216.34"],"connectionIp":"93.184.216.34"}}'),
	requireConnectionIp: true,
});
assert.equal(r.ok, true, 'parsed resolver/connection evidence can satisfy required connection metadata');
assert.deepEqual(r.connectionIps, ['93.184.216.34'], 'connection IP evidence is reported on allowed verdicts');

r = validateUrlEgress('http://localhost:43210/fixture', {
	profile: 'local',
	enforceAllowlist: true,
	resolvedHosts: { localhost: ['127.0.0.1'] },
});
assert.equal(r.ok, true, 'localhost fixture resolving to loopback is allowed under local profile');

r = validateUrlEgress('https://intranet.example.test/app', {
	profile: 'on-prem',
	enforceAllowlist: true,
	allowlist: 'https://intranet.example.test',
	resolvedHosts: parseResolvedIpMap('intranet.example.test=10.2.3.4'),
});
assert.equal(r.ok, true, 'on-prem profile allows an allowlisted hostname resolving to private IP');

r = validateUrlEgress('https://needs-resolution.example.test/app', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: 'https://needs-resolution.example.test',
	requireResolvedIps: true,
});
assert.equal(r.ok, false, 'requireResolvedIps fails closed without deterministic resolver data');
assert.match(r.reason, /no resolved IPs/, 'missing resolver refusal is explicit');

r = validateFlowEgressPolicy(flow('http://10.2.3.4/app', { environment: 'live-readonly' }), { phase: 'run', allowlist: 'http://10.2.3.4' });
assert.equal(r.ok, false, 'RFC1918 target remains blocked in the default public profile');

r = validateFlowEgressPolicy(flow('http://10.2.3.4/app', { environment: 'live-readonly', egress: { profile: 'on-prem' } }), { phase: 'run', allowlist: 'http://10.2.3.4' });
assert.equal(r.ok, true, 'RFC1918 target requires explicit on-prem profile plus allowlist');

r = validateUrlEgress('http://224.0.0.1/', { profile: 'on-prem', enforceAllowlist: true, allowlist: 'http://224.0.0.1', label: 'target_url' });
assert.equal(r.ok, false, 'multicast stays fail-closed');

r = validateUrlEgress('http://0.0.0.0:4310/', { profile: 'on-prem', enforceAllowlist: true, allowlist: 'http://0.0.0.0:4310', label: 'target_url' });
assert.equal(r.ok, false, 'unspecified bind/control-plane address stays fail-closed');

r = validateUrlEgress('https://user:top-secret@example.test/app?token=top-secret#frag', {
	profile: 'public',
	enforceAllowlist: true,
	allowlist: '',
	label: 'target_url',
});
assert.equal(r.ok, false, 'non-allowlisted URL with credentials is refused');
assert.equal(JSON.stringify(r).includes('top-secret'), false, 'denial details redact credentials, query, and fragment');

const recipe = {
	collection: { name: 'Rows' },
	key: 'id',
	columns: { id: 'ID' },
};
const { saveSystem } = await import('./webui/systems.js');
const { rpaPost } = await import('./webui/routes-rpa.js');

r = saveSystem({ name: 'meta_blocked', target_url: 'http://169.254.169.254/latest/meta-data/', recipe });
assert.equal(r.ok, false, 'WebUI registration refuses metadata target');
assert.match(r.error, /metadata|cloud metadata/, 'registration metadata error is clear');

r = saveSystem({ name: 'public_blocked', target_url: 'https://example.test/list', recipe });
assert.equal(r.ok, false, 'WebUI registration requires target allowlist for public origins');

r = saveSystem({ name: 'local_allowed', target_url: 'http://127.0.0.1:43210/list', recipe });
assert.equal(r.ok, true, 'WebUI registration permits local fixture target in local profile');

process.env.AQA_TARGET_ALLOWLIST = 'https://example.test';
r = saveSystem({ name: 'public_allowed', login_url: 'https://example.test/login', success_url: '**/ok', target_url: 'https://example.test/list', recipe });
assert.equal(r.ok, true, 'WebUI registration accepts allowlisted public login/target URLs');

r = validateSystemEgressPolicy({ name: 'sys', target_url: 'http://192.168.10.20/list', recipe: { egress: { profile: 'on-prem', allowlist: ['http://192.168.10.20'] } } }, { phase: 'enqueue', fields: ['target_url'] });
assert.equal(r.ok, true, 'system recipe can carry an on-prem target allowlist');

delete process.env.AQA_TARGET_ALLOWLIST;
process.env.AQA_TARGET_ALLOWLIST_REGISTRY = JSON.stringify(tenantAllowlistRegistry);
r = saveSystem(systemForTarget(targets.tenantA.allowed, { tenant: tenants.a, name: 'tenant_registry_allowed' }), {
	tenantId: tenants.a.id,
	actor: actors.tenantA.operator,
});
assert.equal(r.ok, true, 'WebUI registration accepts a target covered by the tenant allowlist registry');

process.env.AQA_TARGET_ALLOWLIST = targets.tenantA.blocked.origin;
r = saveSystem(systemForTarget(targets.tenantA.allowed, { tenant: tenants.a, name: 'tenant_registry_conflict' }), {
	tenantId: tenants.a.id,
	actor: actors.tenantA.operator,
});
assert.equal(r.ok, false, 'WebUI registration refuses operator env allowlist conflicts with registry');
assert.match(r.error, /operator target allowlist conflicts with tenant allowlist registry/, 'WebUI registration conflict names registry');
delete process.env.AQA_TARGET_ALLOWLIST;
delete process.env.AQA_TARGET_ALLOWLIST_REGISTRY;
let sent = null;
const sendJson = (_res, code, obj) => { sent = { code, obj }; };
const noJob = () => { throw new Error('enqueue should not run during registration'); };
await rpaPost('/api/systems', {
	name: 'tenant_route',
	label: 'Tenant Route',
	engine: 'playwright',
	target_url: 'https://tenant-route.example.test/list',
	egress: { allowlist: ['https://tenant-route.example.test'], profile: 'public' },
	recipe,
}, {}, { sendJson, enqueue: noJob, authSpawn: noJob, nodeLeaf: noJob, context: { tenantId: 'tenant-a', actor: { id: 'operator-a' } } });
assert.equal(sent.code, 200, 'system route accepts tenant allowlist administration input');
assert.equal(sent.obj.ok, true, 'system route saved allowlisted target');
assert.deepEqual(sent.obj.system.recipe.egress.allowlist, ['https://tenant-route.example.test'], 'route persisted egress allowlist in the system recipe');

sent = null;
await rpaPost('/api/systems/tenant_route/sync', {}, {}, { sendJson, enqueue: (job) => ({ id: 'job-1', kind: job.kind, label: job.label, commandSpec: job.commandSpec }), authSpawn: noJob, nodeLeaf: () => ({}), context: { tenantId: 'tenant-a', actor: { id: 'operator-a' } } });
assert.equal(sent.code, 202, 'enqueue accepts a target covered by the stored tenant allowlist');
assert.equal(sent.obj.job.kind, 'sync', 'enqueue created the expected sync job');

sent = null;
await rpaPost('/api/systems', {
	name: 'tenant_egress_only',
	target_url: 'https://egress-only.example.test/list',
	targetAllowlist: 'https://egress-only.example.test',
}, {}, { sendJson, enqueue: noJob, authSpawn: noJob, nodeLeaf: noJob, context: { tenantId: 'tenant-a', actor: { id: 'operator-a' } } });
assert.equal(sent.code, 200, 'system route can persist an egress-only onboarding record before recipe capture');
assert.equal(sent.obj.system.recipe.egress.allowlist, 'https://egress-only.example.test', 'egress-only record keeps target allowlist');

console.log('  egress-policy-unit: target allowlist and blocked-network policy pass');
NODE
)
