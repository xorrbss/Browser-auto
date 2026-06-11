// lib/egress-validate.js - URL egress validation, flow/system egress contexts, and checker entry points.
// Pure CommonJS leaf: no Playwright import, no DNS/network lookup, no secret reads.
'use strict';

const net = require('node:net');
const {
	ENFORCE_PHASES,
	URLISH_RE,
	normalizeProfile,
	normalizeHost,
	hostKind,
	sanitizedUrl,
	deniedUrlAuditDetails,
	specialAllowed,
	specialDescription,
	fail,
	ok,
} = require('./egress-net.js');
const {
	normalizeAllowEntries,
	mergeAllowEntries,
	describeAllowEntry,
	allowlistRegistryForTenant,
	allowlistConflictsWithRegistry,
	isAllowlisted,
	isControlPlaneTarget,
} = require('./egress-allowlist.js');
const {
	validateConnectionIpEvidence,
	validateResolvedHostEgress,
} = require('./egress-evidence.js');
const {
	defaultFlowProfile,
	defaultSystemProfile,
	profileFromSubject,
	collectAllowlist,
	collectOperatorAllowlist,
	collectAllowlistRegistry,
	tenantIdForSubject,
	collectResolvedHosts,
	collectResolverEvidence,
	collectConnectionEvidence,
	requireResolvedIps,
	requireFreshResolverEvidence,
	requireConnectionIpEvidence,
	resolverEvidenceMaxAgeMs,
	resolverEvidenceClockSkewMs,
} = require('./egress-subject.js');

function validateUrlEgress(raw, opts = {}) {
	const label = opts.label || 'url';
	const profile = normalizeProfile(opts.profile, 'public');
	const enforceAllowlist = opts.enforceAllowlist === true;
	let allowlist = normalizeAllowEntries(opts.allowlist || []);
	const operatorAllowlist = normalizeAllowEntries(opts.operatorAllowlist || []);
	const refuse = (reason, detail = {}) => fail(label, reason, {
		...detail,
		url: sanitizedUrl(raw),
		audit: deniedUrlAuditDetails(raw, { ...opts, ...detail, label, profile }),
	});
	if (raw == null || String(raw).trim() === '') return ok({ skipped: true, label, profile });
	if (String(raw).includes('\0')) return refuse('URL contains a NUL byte');
	let url;
	try {
		url = new URL(String(raw).trim());
	} catch {
		return refuse('invalid URL');
	}
	const protocol = url.protocol.toLowerCase();
	if (protocol === 'about:') return ok({ url, label, profile, scheme: protocol });
	if (protocol === 'data:' || protocol === 'file:') {
		if (profile !== 'local') return refuse(`${protocol.slice(0, -1)} URLs require egress profile "local"`, { profile });
		return ok({ url, label, profile, scheme: protocol });
	}
	if (protocol !== 'http:' && protocol !== 'https:') {
		return refuse(`unsupported URL scheme "${protocol}"`, { profile });
	}
	const host = normalizeHost(url.hostname);
	if (isControlPlaneTarget(url, opts)) {
		return refuse(`service-control/control-plane target ${url.origin} is blocked`, { host, kind: 'control-plane', profile });
	}
	const kind = hostKind(host);
	if (kind !== 'public') {
		if (!specialAllowed(kind, profile)) {
			return refuse(`${specialDescription(kind)} "${host}" is blocked by default`, { host, kind, profile });
		}
	}
	const registry = allowlistRegistryForTenant(opts.allowlistRegistry || opts.targetAllowlistRegistry, opts.tenantId);
	if (enforceAllowlist && registry.configured) {
		if (registry.invalid.length) {
			return refuse(`tenant allowlist registry is invalid: ${registry.invalid[0]}`, { host, kind, profile, registryInvalid: registry.invalid.slice(0, 8) });
		}
		if (!registry.tenantId) {
			return refuse('tenant id is required for tenant allowlist registry enforcement', { host, kind, profile });
		}
		if (!registry.entries.length) {
			return refuse(`tenant "${registry.tenantId}" has no target allowlist registry entry`, { host, kind, profile, registryTenantId: registry.tenantId });
		}
		const operatorConflicts = allowlistConflictsWithRegistry(operatorAllowlist, registry.entries);
		if (operatorConflicts.length) {
			return refuse(`operator target allowlist conflicts with tenant allowlist registry for tenant "${registry.tenantId}": ${describeAllowEntry(operatorConflicts[0])}`, {
				host,
				kind,
				profile,
				registryTenantId: registry.tenantId,
				registryConflict: describeAllowEntry(operatorConflicts[0]),
			});
		}
		const declaredConflicts = allowlistConflictsWithRegistry(allowlist, registry.entries);
		if (declaredConflicts.length) {
			return refuse(`target allowlist conflicts with tenant allowlist registry for tenant "${registry.tenantId}": ${describeAllowEntry(declaredConflicts[0])}`, {
				host,
				kind,
				profile,
				registryTenantId: registry.tenantId,
				registryConflict: describeAllowEntry(declaredConflicts[0]),
			});
		}
		if (!isAllowlisted(url, registry.entries)) {
			return refuse(`origin ${url.origin} is not in tenant allowlist registry for tenant "${registry.tenantId}"`, { host, kind, profile, registryTenantId: registry.tenantId });
		}
		allowlist = mergeAllowEntries(allowlist, registry.entries);
	}
	const localFixture = profile === 'local' && kind === 'loopback';
	if (enforceAllowlist && !localFixture && !isAllowlisted(url, allowlist)) {
		return refuse(`origin ${url.origin} is not in AQA_TARGET_ALLOWLIST`, { host, kind, profile });
	}
	if (net.isIP(host)) {
		const connection = validateConnectionIpEvidence(host, [host], { connectionIps: [] }, { ...opts, profile });
		if (!connection.ok) {
			return refuse(connection.reason, {
				host,
				kind,
				profile,
				resolvedIps: [host],
				connectionIps: connection.connectionIps,
				address: connection.address,
			});
		}
		return ok({
			url,
			label,
			profile,
			host,
			kind,
			origin: url.origin,
			...(connection.connectionIps && connection.connectionIps.length ? { connectionIps: connection.connectionIps } : {}),
		});
	}
	const resolved = validateResolvedHostEgress(host, { ...opts, profile });
	if (!resolved.ok) {
		return refuse(resolved.reason, { host, kind, profile, resolvedIps: resolved.resolvedIps, connectionIps: resolved.connectionIps, address: resolved.address });
	}
	return ok({
		url,
		label,
		profile,
		host,
		kind,
		origin: url.origin,
		...(resolved.resolvedIps && resolved.resolvedIps.length ? { resolvedIps: resolved.resolvedIps } : {}),
		...(resolved.connectionIps && resolved.connectionIps.length ? { connectionIps: resolved.connectionIps } : {}),
		...(resolved.cnameChain ? { cnameChain: resolved.cnameChain } : {}),
		...(resolved.canonicalName ? { canonicalName: resolved.canonicalName } : {}),
		...(resolved.resolvedAtMs != null ? { resolvedAtMs: resolved.resolvedAtMs } : {}),
		...(resolved.expiresAtMs != null ? { expiresAtMs: resolved.expiresAtMs } : {}),
		...(resolved.ttlMs != null ? { ttlMs: resolved.ttlMs } : {}),
	});
}

function fieldsForSystem(opts = {}) {
	if (Array.isArray(opts.fields) && opts.fields.length) return opts.fields;
	return ['login_url', 'success_url', 'target_url'];
}

function successUrlIsAbsolute(value) {
	const s = String(value || '').trim();
	return URLISH_RE.test(s);
}

function flowEgressContext(flow, opts = {}) {
	const phase = opts.phase || 'validate';
	const profile = profileFromSubject(flow, opts, defaultFlowProfile(flow, opts));
	const env = opts.env || process.env;
	const tenantId = tenantIdForSubject(flow, opts);
	return {
		phase,
		runMode: opts.runMode || env.AQA_RUN_MODE || '',
		environment: flow?.environment || '',
		riskClass: flow?.riskClass || '',
		profile,
		allowlist: collectAllowlist(flow, { ...opts, includeLiveOriginAllowlist: true }),
		operatorAllowlist: collectOperatorAllowlist(opts),
		allowlistRegistry: collectAllowlistRegistry(flow, opts),
		resolvedHosts: collectResolvedHosts(flow, opts),
		resolverEvidence: collectResolverEvidence(flow, opts),
		connectionIps: collectConnectionEvidence(flow, opts),
		resolveHost: opts.resolveHost,
		resolver: opts.resolver,
		requireResolvedIps: requireResolvedIps(flow, opts),
		requireFreshResolverEvidence: requireFreshResolverEvidence(flow, opts),
		requireConnectionIp: requireConnectionIpEvidence(flow, opts),
		resolverEvidenceMaxAgeMs: resolverEvidenceMaxAgeMs(flow, opts),
		resolverEvidenceClockSkewMs: resolverEvidenceClockSkewMs(flow, opts),
		nowMs: opts.nowMs ?? opts.now,
		enforceAllowlist: opts.enforceAllowlist != null ? !!opts.enforceAllowlist : ENFORCE_PHASES.has(phase),
		subjectKind: 'flow',
		subjectName: flow?.name || '',
		tenantId,
	};
}

function systemEgressContext(system, opts = {}) {
	const phase = opts.phase || 'validate';
	const profile = profileFromSubject(system, opts, defaultSystemProfile(opts));
	const env = opts.env || process.env;
	const tenantId = tenantIdForSubject(system, opts);
	return {
		phase,
		runMode: opts.runMode || env.AQA_RUN_MODE || '',
		environment: system?.environment || system?.recipe?.environment || '',
		profile,
		allowlist: collectAllowlist(system, opts),
		operatorAllowlist: collectOperatorAllowlist(opts),
		allowlistRegistry: collectAllowlistRegistry(system, opts),
		resolvedHosts: collectResolvedHosts(system, opts),
		resolverEvidence: collectResolverEvidence(system, opts),
		connectionIps: collectConnectionEvidence(system, opts),
		resolveHost: opts.resolveHost,
		resolver: opts.resolver,
		requireResolvedIps: requireResolvedIps(system, opts),
		requireFreshResolverEvidence: requireFreshResolverEvidence(system, opts),
		requireConnectionIp: requireConnectionIpEvidence(system, opts),
		resolverEvidenceMaxAgeMs: resolverEvidenceMaxAgeMs(system, opts),
		resolverEvidenceClockSkewMs: resolverEvidenceClockSkewMs(system, opts),
		nowMs: opts.nowMs ?? opts.now,
		enforceAllowlist: opts.enforceAllowlist != null ? !!opts.enforceAllowlist : ENFORCE_PHASES.has(phase),
		subjectKind: 'system',
		subjectName: system?.name || '',
		tenantId,
	};
}

function validateFlowEgressPolicy(flow, opts = {}) {
	if (!flow || typeof flow !== 'object' || Array.isArray(flow)) return fail('flow', 'flow must be an object');
	const ctx = flowEgressContext(flow, opts);
	if (!flow.startUrl) return ok({ ...ctx, checked: [] });
	const r = validateUrlEgress(flow.startUrl, { ...ctx, label: 'startUrl' });
	return r.ok ? ok({ ...ctx, checked: ['startUrl'] }) : r;
}

function validateSystemEgressPolicy(system, opts = {}) {
	if (!system || typeof system !== 'object' || Array.isArray(system)) return fail('system', 'system must be an object');
	const ctx = systemEgressContext(system, opts);
	const checked = [];
	for (const field of fieldsForSystem(opts)) {
		const value = system[field];
		if (!value) continue;
		if (field === 'success_url' && !successUrlIsAbsolute(value)) continue;
		const r = validateUrlEgress(value, { ...ctx, label: field });
		if (!r.ok) return r;
		checked.push(field);
	}
	return ok({ ...ctx, checked });
}

function createFlowEgressChecker(flow, opts = {}) {
	const ctx = flowEgressContext(flow, opts);
	return createChecker(ctx);
}

function createSystemEgressChecker(system, opts = {}) {
	const ctx = systemEgressContext(system, opts);
	return createChecker(ctx);
}

function createChecker(ctx) {
	return {
		context: ctx,
		checkUrl(url, label = 'request') {
			return validateUrlEgress(url, { ...ctx, label });
		},
		assertUrl(url, label = 'request') {
			const r = validateUrlEgress(url, { ...ctx, label });
			if (!r.ok) throw new Error(r.reason);
			return r;
		},
	};
}

module.exports = {
	validateUrlEgress,
	flowEgressContext,
	systemEgressContext,
	validateFlowEgressPolicy,
	validateSystemEgressPolicy,
	createFlowEgressChecker,
	createSystemEgressChecker,
};
