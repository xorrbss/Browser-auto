'use strict';

const crypto = require('node:crypto');

const FIXED_NOW = Date.parse('2026-06-10T12:00:00Z');

const tenants = Object.freeze({
	a: Object.freeze({ id: 'tenant-a', label: 'Tenant A' }),
	b: Object.freeze({ id: 'tenant-b', label: 'Tenant B' }),
});

function actor(role, tenant, suffix = role) {
	return Object.freeze({
		id: `${tenant.id}-${suffix}`,
		role,
		roles: Object.freeze([role]),
		tenantId: tenant.id,
	});
}

function actorsForTenant(tenant) {
	return Object.freeze({
		owner: actor('owner', tenant),
		admin: actor('admin', tenant),
		operator: actor('operator', tenant),
		viewer: actor('viewer', tenant),
	});
}

const actors = Object.freeze({
	tenantA: actorsForTenant(tenants.a),
	tenantB: actorsForTenant(tenants.b),
});

function stableValue(value) {
	if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
	if (Array.isArray(value)) return value.map(stableValue);
	if (typeof value === 'object') {
		const out = {};
		for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
		return out;
	}
	return String(value);
}

function stableHash(value) {
	const text = typeof value === 'string' ? value : JSON.stringify(stableValue(value));
	return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

function makeTarget(name, url, evidence = null) {
	const parsed = new URL(url);
	return Object.freeze({
		name,
		url,
		origin: parsed.origin,
		host: parsed.hostname.toLowerCase(),
		evidence: evidence ? Object.freeze({ ...evidence }) : null,
	});
}

const targets = Object.freeze({
	tenantA: Object.freeze({
		allowed: makeTarget('tenant-a-allowed', 'https://allowed-a.example.test/app', {
			addresses: Object.freeze(['93.184.216.34']),
			connectionIp: '93.184.216.34',
			resolvedAtMs: FIXED_NOW,
			ttlSeconds: 120,
		}),
		blocked: makeTarget('tenant-a-blocked', 'https://blocked-a.example.test/app?token=blocked-secret', {
			addresses: Object.freeze(['93.184.216.35']),
			connectionIp: '93.184.216.35',
			resolvedAtMs: FIXED_NOW,
			ttlSeconds: 120,
		}),
		private: makeTarget('tenant-a-private', 'https://private-a.example.test/app?password=private-secret', {
			addresses: Object.freeze(['10.20.30.40']),
			connectionIp: '10.20.30.40',
			resolvedAtMs: FIXED_NOW,
			ttlSeconds: 120,
		}),
	}),
	tenantB: Object.freeze({
		allowed: makeTarget('tenant-b-allowed', 'https://allowed-b.example.test/app', {
			addresses: Object.freeze(['93.184.216.36']),
			connectionIp: '93.184.216.36',
			resolvedAtMs: FIXED_NOW,
			ttlSeconds: 120,
		}),
	}),
	metadata: makeTarget('metadata', 'http://169.254.169.254/latest/meta-data/?token=metadata-secret'),
	controlPlane: makeTarget('control-plane', 'http://127.0.0.1:4310/api/run?token=control-secret'),
	localFixture: makeTarget('local-fixture', 'http://127.0.0.1:43210/fixture'),
});

const tenantAllowlistRegistry = Object.freeze({
	tenants: Object.freeze({
		[tenants.a.id]: Object.freeze([targets.tenantA.allowed.origin]),
		[tenants.b.id]: Object.freeze([targets.tenantB.allowed.origin]),
	}),
});

function registryWithTarget(tenant, target, base = tenantAllowlistRegistry) {
	const out = { tenants: {} };
	for (const [tenantId, entries] of Object.entries(base.tenants || {})) out.tenants[tenantId] = Array.from(entries);
	const id = tenant.id || tenant;
	out.tenants[id] = Array.from(new Set([...(out.tenants[id] || []), target.origin]));
	return out;
}

function resolverEvidenceForTargets(...items) {
	const out = {};
	const flat = items.flat();
	for (const target of flat) {
		if (!target || !target.evidence) continue;
		out[target.host] = {
			...target.evidence,
			addresses: Array.from(target.evidence.addresses || []),
		};
	}
	return out;
}

function externalModeEnv(overrides = {}) {
	return {
		WEBUI_EXTERNAL_MODE: '1',
		AQA_EXTERNAL_MODE: '1',
		AQA_RUN_MODE: 'staging',
		...overrides,
	};
}

function flowForTarget(target, opts = {}) {
	const tenant = opts.tenant || tenants.a;
	return {
		name: opts.name || target.name.replace(/[^A-Za-z0-9_-]/g, '_'),
		engine: 'playwright',
		environment: opts.environment || 'staging',
		riskClass: 'read',
		tenantId: tenant.id,
		startUrl: target.url,
		steps: [{ kind: 'wait', until: 'load' }],
		asserts: [],
		egress: { profile: opts.profile || 'public', ...(opts.egress || {}) },
	};
}

function systemForTarget(target, opts = {}) {
	const tenant = opts.tenant || tenants.a;
	return {
		name: opts.name || target.name.replace(/[^A-Za-z0-9_-]/g, '_'),
		engine: 'playwright',
		tenantId: tenant.id,
		target_url: target.url,
		recipe: {
			collection: { name: 'Rows' },
			key: 'id',
			columns: { id: 'ID' },
			egress: { profile: opts.profile || 'public', ...(opts.egress || {}) },
		},
	};
}

const SECRET_FINDERS = Object.freeze([
	['authorization-header', /\bauthorization\s*:(?!\s*\[redacted\])/i],
	['cookie-header', /\b(?:cookie|set-cookie)\s*:(?!\s*\[redacted\])/i],
	['bearer-token', /\bbearer\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{6,}/i],
	['otp-code', /\b(?:otp|mfa|totp|2fa|one[-_ ]?time(?:[-_ ]?code)?|verification(?:[-_ ]?code)?|authenticator[-_ ]?code)\s*(?:is|:|=)?\s*["']?\d{4,10}["']?/i],
	['sensitive-assignment', /\b(?:password|passwd|pwd|secret|client[_-]?secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|jwt|credential|otp|mfa|totp|cookie|authorization)\s*[:=](?!\s*\[redacted\])\s*[^"',&\s;}{]+/i],
	['secret-path', /(?:fixtures[\\/]auth|flows[\\/][^\\/\s"'<>)]*\.values\.json|[^\\/\s"'<>)]*\.state\.json|\.env\b)/i],
]);

function scanFixtureArtifact(value, label = 'fixture-artifact') {
	const text = typeof value === 'string' ? value : JSON.stringify(stableValue(value));
	const findings = [];
	for (const [kind, pattern] of SECRET_FINDERS) {
		if (pattern.test(text)) findings.push({ kind, label });
	}
	return { ok: findings.length === 0, findings };
}

function assertFixtureArtifactClean(value, label = 'fixture-artifact') {
	const scan = scanFixtureArtifact(value, label);
	if (!scan.ok) {
		const kinds = scan.findings.map((finding) => finding.kind).join(', ');
		throw new Error(`${label} failed fixture secret scan: ${kinds}`);
	}
	return scan;
}

module.exports = {
	FIXED_NOW,
	actors,
	assertFixtureArtifactClean,
	externalModeEnv,
	flowForTarget,
	registryWithTarget,
	resolverEvidenceForTargets,
	scanFixtureArtifact,
	stableHash,
	systemForTarget,
	targets,
	tenantAllowlistRegistry,
	tenants,
};
