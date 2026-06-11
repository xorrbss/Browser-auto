// lib/egress-runtime.js - runtime bridge from deterministic resolver evidence to URL egress policy.
// Pure CommonJS leaf: no OS DNS lookup, no network access, no secret reads.
'use strict';

const crypto = require('node:crypto');
const {
	hostKind,
	normalizeProfile,
	sanitizedAuditText,
	sanitizedUrl,
	validateUrlEgress,
} = require('./egress-policy.js');
const {
	normalizeHost,
	normalizeResolverEvidence,
	resolverEvidenceForUrl,
} = require('./egress-resolver.js');

function isPromiseLike(value) {
	return value && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
}

function callSync(fn, args, label) {
	const value = fn(...args);
	if (isPromiseLike(value)) throw new Error(`${label} must be synchronous and deterministic`);
	return value;
}

function parseHttpUrl(rawUrl) {
	try {
		const url = new URL(String(rawUrl || '').trim());
		const protocol = url.protocol.toLowerCase();
		if (protocol !== 'http:' && protocol !== 'https:') return { url, host: '', http: false };
		return { url, host: normalizeHost(url.hostname), http: true };
	} catch {
		return { url: null, host: '', http: false };
	}
}

function sanitizedResolverUrl(url) {
	const copy = new URL(url.toString());
	copy.username = '';
	copy.password = '';
	copy.search = '';
	copy.hash = '';
	return copy.toString();
}

function evidenceEntryLike(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Map) return false;
	return [
		'host', 'hostname', 'name', 'address', 'addresses', 'ip', 'ips', 'resolvedIps',
		'A', 'AAAA', 'aRecords', 'aaaaRecords', 'cname', 'cnames', 'cnameChain',
		'canonicalName', 'finalHostname', 'finalName', 'resolvedAt', 'resolvedAtMs',
		'expiresAt', 'expiresAtMs', 'ttl', 'ttlSeconds', 'ttlMs', 'connectionIp',
		'connectionIps', 'connectedIp', 'remoteAddress', 'evidenceVersion',
	].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function addEvidence(out, host, value, opts = {}) {
	const fallbackHost = normalizeHost(host || value?.host || value?.hostname || value?.name || '');
	if (!fallbackHost) return;
	out[fallbackHost] = normalizeResolverEvidence(value, fallbackHost, opts);
}

function normalizeEvidenceMap(value, fallbackHost = '', opts = {}) {
	const out = {};
	if (value == null || value === '') return out;
	if (value instanceof Map) {
		for (const [host, entry] of value.entries()) addEvidence(out, host, entry, opts);
		return out;
	}
	if (Array.isArray(value)) {
		for (const entry of value) {
			const nested = normalizeEvidenceMap(entry, fallbackHost, opts);
			for (const [host, evidence] of Object.entries(nested)) out[host] = evidence;
		}
		return out;
	}
	if (typeof value !== 'object') {
		addEvidence(out, fallbackHost, value, opts);
		return out;
	}
	if (evidenceEntryLike(value)) {
		addEvidence(out, value.host || value.hostname || value.name || fallbackHost, value, opts);
		return out;
	}
	for (const [host, entry] of Object.entries(value)) addEvidence(out, host, entry, opts);
	return out;
}

function mergePolicyEvidence(existing, evidence) {
	if (!evidence || !Object.keys(evidence).length) return existing;
	if (existing == null || existing === '') return evidence;
	return Array.isArray(existing) ? existing.concat([evidence]) : [existing, evidence];
}

const NON_LOCAL_ENVIRONMENTS = new Set(['staging', 'live-readonly', 'live-action']);
const NON_LOCAL_RUN_MODES = new Set(['public', 'staging', 'live-readonly', 'live-action', 'live']);

function runtimeEvidenceRequiredForUrl(rawUrl, policyOptions = {}) {
	if (policyOptions.requireRuntimeEvidence === true) return true;
	if (policyOptions.requireRuntimeEvidence === false) return false;
	const parsed = parseHttpUrl(rawUrl);
	if (!parsed.http || !parsed.host) return false;
	const environment = String(policyOptions.environment || '').trim().toLowerCase();
	const runMode = String(policyOptions.runMode || '').trim().toLowerCase();
	if (NON_LOCAL_ENVIRONMENTS.has(environment) || NON_LOCAL_RUN_MODES.has(runMode)) return true;
	const profile = normalizeProfile(policyOptions.profile, 'public');
	if (profile === 'public') return true;
	const kind = hostKind(parsed.host);
	return kind === 'public' && profile !== 'local' && profile !== 'on-prem';
}

function applyRuntimeEvidenceRequirements(rawUrl, policyOptions = {}) {
	const out = { ...policyOptions };
	if (!runtimeEvidenceRequiredForUrl(rawUrl, out)) return out;
	out.runtimeEvidenceRequired = true;
	out.requireResolvedIps = true;
	out.requireFreshResolverEvidence = true;
	out.requireConnectionIp = true;
	return out;
}

function runtimeConfig(opts = {}) {
	const source = opts.policyOptions || opts.policy || opts;
	const policyOptions = { ...source };
	const env = policyOptions.env || opts.env || null;
	if (env && typeof env === 'object') {
		const envAllowlist = [
			env.AQA_TARGET_ALLOWLIST,
			env.AQA_EGRESS_ALLOWLIST,
			env.WEBUI_TARGET_ALLOWLIST,
		].filter((value) => value != null && value !== '');
		if (envAllowlist.length) {
			policyOptions.allowlist = [policyOptions.allowlist, ...envAllowlist].filter((value) => value != null && value !== '');
			policyOptions.operatorAllowlist = [policyOptions.operatorAllowlist, ...envAllowlist].filter((value) => value != null && value !== '');
		}
		const envRegistry = [
			env.AQA_TARGET_ALLOWLIST_REGISTRY,
			env.WEBUI_TARGET_ALLOWLIST_REGISTRY,
		].filter((value) => value != null && value !== '');
		if (envRegistry.length) {
			policyOptions.allowlistRegistry = [policyOptions.allowlistRegistry, ...envRegistry].filter((value) => value != null && value !== '');
		}
		if (policyOptions.enforceAllowlist == null && (envAllowlist.length || envRegistry.length)) {
			policyOptions.enforceAllowlist = true;
		}
	}
	const resolver = opts.resolver || opts.egressResolver || opts.dnsResolver
		|| policyOptions.resolver || policyOptions.egressResolver || policyOptions.dnsResolver || null;
	const connectionIpsForUrl = opts.connectionIpsForUrl || opts.connectionIpForUrl
		|| policyOptions.connectionIpsForUrl || policyOptions.connectionIpForUrl || null;
	for (const key of [
		'policy', 'policyOptions', 'resolver', 'egressResolver', 'dnsResolver',
		'connectionIpsForUrl', 'connectionIpForUrl',
	]) {
		delete policyOptions[key];
	}
	for (const key of ['nowMs', 'now', 'env']) {
		if (opts[key] != null && policyOptions[key] == null) policyOptions[key] = opts[key];
	}
	return { policyOptions, resolver, connectionIpsForUrl };
}

function resolverEvidenceMapForUrl(rawUrl, resolver, opts = {}) {
	const parsed = parseHttpUrl(rawUrl);
	if (!parsed.http || !parsed.host || !resolver) return {};
	const resolverOpts = { ...opts, host: parsed.host };
	let raw;
	if (resolver && typeof resolver.evidenceForUrl === 'function') {
		raw = callSync(resolver.evidenceForUrl.bind(resolver), [sanitizedResolverUrl(parsed.url), resolverOpts], 'egress resolver URL evidence');
	} else {
		raw = resolverEvidenceForUrl(sanitizedResolverUrl(parsed.url), resolver, resolverOpts);
	}
	return normalizeEvidenceMap(raw, parsed.host, resolverOpts);
}

function connectionIpMapForUrl(rawUrl, provider, host, evidence, opts = {}) {
	if (!provider || !host) return null;
	const parsed = parseHttpUrl(rawUrl);
	const callbackUrl = parsed.url ? sanitizedResolverUrl(parsed.url) : String(rawUrl || '').split('?')[0].split('#')[0];
	const value = callSync(provider, [callbackUrl, { host, evidence, policyOptions: opts }], 'egress connection IP evidence');
	if (value == null || value === '') return null;
	return { [host]: value };
}

function prepareRuntimeEgressPolicyOptions(rawUrl, opts = {}) {
	const { policyOptions, resolver, connectionIpsForUrl } = runtimeConfig(opts);
	const parsed = parseHttpUrl(rawUrl);
	const prepared = applyRuntimeEvidenceRequirements(rawUrl, policyOptions);
	const detail = {
		host: parsed.host,
		resolverEvidence: {},
		connectionIps: null,
		policyOptions: prepared,
	};
	if (!parsed.http || !parsed.host) return detail;
	try {
		const evidenceMap = resolver
			? resolverEvidenceMapForUrl(rawUrl, resolver, prepared)
			: normalizeEvidenceMap(prepared.resolverEvidence || prepared.dnsEvidence || prepared.resolvedEvidence, parsed.host, prepared);
		const hostEvidence = evidenceMap[parsed.host] || null;
		if (resolver) prepared.resolverEvidence = mergePolicyEvidence(prepared.resolverEvidence, evidenceMap);
		const connectionMap = connectionIpMapForUrl(rawUrl, connectionIpsForUrl, parsed.host, hostEvidence, prepared);
		if (connectionMap) prepared.connectionIps = mergePolicyEvidence(prepared.connectionIps, connectionMap);
		detail.resolverEvidence = evidenceMap;
		detail.connectionIps = connectionMap;
		return detail;
	} catch (e) {
		const error = e instanceof Error ? e : new Error(String(e));
		prepared.resolveHost = () => { throw error; };
		detail.resolverError = error;
		return detail;
	}
}

function runtimeEgressPolicyOptionsForUrl(rawUrl, opts = {}) {
	return prepareRuntimeEgressPolicyOptions(rawUrl, opts).policyOptions;
}

function resolveRuntimeEgressEvidence(rawUrl, opts = {}) {
	const { policyOptions, resolver } = runtimeConfig(opts);
	return resolverEvidenceMapForUrl(rawUrl, resolver, policyOptions);
}

function validateRuntimeUrlEgress(rawUrl, opts = {}) {
	const prepared = prepareRuntimeEgressPolicyOptions(rawUrl, opts);
	return validateUrlEgress(rawUrl, prepared.policyOptions);
}

function boundedArray(value) {
	return Array.isArray(value) ? value.slice(0, 16).map((item) => String(item)) : [];
}

function stableValue(value, seen = new Set()) {
	if (value == null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
	if (Array.isArray(value)) return value.map((item) => stableValue(item, seen));
	if (typeof value === 'object') {
		if (seen.has(value)) return '[circular]';
		seen.add(value);
		const out = {};
		for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key], seen);
		seen.delete(value);
		return out;
	}
	return String(value);
}

function sha256Tag(value) {
	const text = typeof value === 'string' ? value : JSON.stringify(stableValue(value));
	return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

function isSensitiveContextKey(key) {
	return /\b(password|passwd|pwd|secret|client[_-]?secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|jwt|credential|otp|mfa|totp|cookie|set-cookie|authorization|auth[_-]?state|storage[_-]?state|values[_-]?json|flow[_-]?values)\b/i
		.test(String(key || ''));
}

function sanitizeAuditContext(value, depth = 0, seen = new Set(), key = '') {
	if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
	if (isSensitiveContextKey(key) && String(value).trim() !== '') return '[redacted]';
	if (typeof value === 'string') return sanitizedAuditText(value);
	if (depth >= 6) return '[truncated]';
	if (Array.isArray(value)) return value.slice(0, 16).map((item) => sanitizeAuditContext(item, depth + 1, seen));
	if (typeof value === 'object') {
		if (seen.has(value)) return '[circular]';
		seen.add(value);
		const out = {};
		for (const childKey of Object.keys(value).sort()) out[childKey] = sanitizeAuditContext(value[childKey], depth + 1, seen, childKey);
		seen.delete(value);
		return out;
	}
	return sanitizedAuditText(value);
}

function runtimeEgressDenyEvent(verdict = {}, extra = {}) {
	const audit = verdict && verdict.audit && typeof verdict.audit === 'object' ? verdict.audit : {};
	const out = {
		schemaVersion: 1,
		event: extra.event || 'egress-denied',
		denied: true,
		reason: sanitizedAuditText(verdict.reason || ''),
		label: audit.label || extra.label || '',
		path: audit.path || extra.path || '',
		phase: audit.phase || extra.phase || '',
		subjectKind: audit.subjectKind || extra.subjectKind || '',
		subjectName: audit.subjectName || extra.subjectName || '',
		tenantId: audit.tenantId || extra.tenantId || '',
		url: audit.url || sanitizedUrl(extra.url || ''),
		origin: audit.origin || '',
		scheme: audit.scheme || '',
		host: audit.host || '',
		kind: audit.kind || '',
		profile: audit.profile || '',
		resolvedIps: boundedArray(audit.resolvedIps),
		connectionIps: boundedArray(audit.connectionIps),
		address: audit.address || '',
	};
	for (const key of ['at', 'flow', 'system', 'jobId', 'runId', 'actorId', 'flowHash']) {
		if (extra[key]) out[key] = String(extra[key]);
	}
	if (out.flow && !out.flowHash) out.flowHash = sha256Tag(out.flow);
	out.targetHash = extra.targetHash ? String(extra.targetHash) : sha256Tag(out.url || out.origin || out.host || '');
	const context = extra.context ?? extra.auditContext;
	if (context != null) {
		out.context = sanitizeAuditContext(context);
		out.contextHash = sha256Tag(out.context);
	}
	out.evidenceHash = sha256Tag(out);
	return out;
}

function createRuntimeEgressChecker(opts = {}) {
	const { policyOptions, resolver, connectionIpsForUrl } = runtimeConfig(opts);
	const withLabel = (label, extra = {}) => ({
		policyOptions: { ...policyOptions, ...extra, label },
		resolver,
		connectionIpsForUrl,
	});
	return {
		kind: 'egress-runtime-checker',
		context: policyOptions,
		checkUrl(url, label = 'request', extra = {}) {
			return validateRuntimeUrlEgress(url, withLabel(label, extra));
		},
		assertUrl(url, label = 'request', extra = {}) {
			const verdict = validateRuntimeUrlEgress(url, withLabel(label, extra));
			if (!verdict.ok) throw new Error(verdict.reason);
			return verdict;
		},
		policyOptionsForUrl(url, label = 'request', extra = {}) {
			return runtimeEgressPolicyOptionsForUrl(url, withLabel(label, extra));
		},
		evidenceForUrl(url, extra = {}) {
			return resolveRuntimeEgressEvidence(url, { policyOptions: { ...policyOptions, ...extra }, resolver });
		},
	};
}

module.exports = {
	createRuntimeEgressChecker,
	prepareRuntimeEgressPolicyOptions,
	resolveRuntimeEgressEvidence,
	runtimeEgressPolicyOptionsForUrl,
	runtimeEgressDenyEvent,
	runtimeEvidenceRequiredForUrl,
	validateRuntimeUrlEgress,
};
