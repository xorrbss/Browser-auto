// lib/egress-evidence.js - resolver/connection evidence parsing and resolved-host egress validation.
// Pure CommonJS leaf: no Playwright import, no DNS/network lookup, no secret reads.
'use strict';

const net = require('node:net');
const {
	DEFAULT_RESOLVER_EVIDENCE_MAX_AGE_MS,
	DEFAULT_RESOLVER_EVIDENCE_CLOCK_SKEW_MS,
	semiList,
	normalizeProfile,
	millisOption,
	secondsToMillisOption,
	nowMs,
	parseTimestampMs,
	normalizeHost,
	normalizeResolvedAddresses,
	normalizeHostList,
	hostKind,
	specialAllowed,
	specialDescription,
	ok,
} = require('./egress-net.js');

function looksLikeResolverEvidenceEntry(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value) || value instanceof Map) return false;
	return [
		'host', 'hostname', 'name', 'address', 'addresses', 'ip', 'ips', 'resolvedIps',
		'cname', 'cnames', 'cnameChain', 'chain', 'resolvedChain', 'canonicalName',
		'finalHostname', 'finalName', 'resolvedAt', 'observedAt', 'createdAt', 'timestamp',
		'expiresAt', 'validUntil', 'ttlMs', 'ttlSeconds', 'connectionIp', 'connectionIps',
		'connectedIp', 'remoteAddress',
	].some((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function evidenceEntryFromValue(value, fallbackHost = '') {
	const entry = {
		host: normalizeHost(fallbackHost),
		addresses: [],
		invalid: [],
		cnameChain: [],
		invalidCnames: [],
		canonicalName: '',
		resolvedAtMs: null,
		expiresAtMs: null,
		ttlMs: null,
		connectionIps: [],
		invalidConnectionIps: [],
	};
	if (value == null || value === '') return entry;
	if (Array.isArray(value) || typeof value !== 'object' || value instanceof Map) {
		const normalized = normalizeResolvedAddresses(value);
		entry.addresses = normalized.addresses;
		entry.invalid = normalized.invalid;
		return entry;
	}
	entry.host = normalizeHost(value.host ?? value.hostname ?? value.name ?? fallbackHost);
	const rawAddresses = value.addresses ?? value.resolvedIps ?? value.ips ?? value.address ?? value.ip;
	const normalized = normalizeResolvedAddresses(rawAddresses);
	entry.addresses = normalized.addresses;
	entry.invalid = normalized.invalid.concat(Array.isArray(value.invalid) ? value.invalid : []);
	const chain = normalizeHostList(value.cnameChain ?? value.cnames ?? value.chain ?? value.resolvedChain);
	entry.cnameChain = chain.hosts;
	entry.invalidCnames = chain.invalid.concat(Array.isArray(value.invalidCnames) ? value.invalidCnames : []);
	entry.canonicalName = normalizeHost(value.canonicalName ?? value.finalHostname ?? value.finalName ?? value.cname ?? '');
	entry.resolvedAtMs = parseTimestampMs(value.resolvedAtMs ?? value.resolvedAt ?? value.observedAt ?? value.createdAt ?? value.timestamp);
	entry.expiresAtMs = parseTimestampMs(value.expiresAtMs ?? value.expiresAt ?? value.validUntil);
	entry.ttlMs = millisOption(value.ttlMs ?? value.ttlMillis ?? '', 0) || secondsToMillisOption(value.ttlSeconds ?? value.ttl ?? '', 0);
	const connection = normalizeResolvedAddresses(value.connectionIps ?? value.connectionIp ?? value.connectedIp ?? value.remoteAddress);
	entry.connectionIps = connection.addresses;
	entry.invalidConnectionIps = connection.invalid.concat(Array.isArray(value.invalidConnectionIps) ? value.invalidConnectionIps : []);
	return entry;
}

function mergeEvidenceEntry(base, next) {
	const out = base || evidenceEntryFromValue(null, next && next.host);
	const addUnique = (field, values) => {
		const seen = new Set(out[field]);
		for (const value of values || []) {
			if (!seen.has(value)) {
				seen.add(value);
				out[field].push(value);
			}
		}
	};
	if (!out.host && next.host) out.host = next.host;
	addUnique('addresses', next.addresses);
	addUnique('invalid', next.invalid);
	addUnique('cnameChain', next.cnameChain);
	addUnique('invalidCnames', next.invalidCnames);
	addUnique('connectionIps', next.connectionIps);
	addUnique('invalidConnectionIps', next.invalidConnectionIps);
	if (!out.canonicalName && next.canonicalName) out.canonicalName = next.canonicalName;
	out.resolvedAtMs = out.resolvedAtMs == null ? next.resolvedAtMs : (next.resolvedAtMs == null ? out.resolvedAtMs : Math.max(out.resolvedAtMs, next.resolvedAtMs));
	out.expiresAtMs = out.expiresAtMs == null ? next.expiresAtMs : (next.expiresAtMs == null ? out.expiresAtMs : Math.max(out.expiresAtMs, next.expiresAtMs));
	out.ttlMs = out.ttlMs == null ? next.ttlMs : (next.ttlMs == null ? out.ttlMs : Math.max(out.ttlMs, next.ttlMs));
	return out;
}

function parseResolverEvidenceMap(value) {
	const out = new Map();
	const merge = (host, rawEntry) => {
		const entry = evidenceEntryFromValue(rawEntry, host);
		const h = normalizeHost(entry.host || host);
		if (!h) return;
		entry.host = h;
		out.set(h, mergeEvidenceEntry(out.get(h), entry));
	};
	const parseObject = (obj) => {
		if (!obj || typeof obj !== 'object') return;
		if (obj instanceof Map) {
			for (const [host, evidence] of obj.entries()) merge(host, evidence);
			return;
		}
		if (looksLikeResolverEvidenceEntry(obj)) {
			merge(obj.host ?? obj.hostname ?? obj.name, obj);
			return;
		}
		for (const [host, evidence] of Object.entries(obj)) merge(host, evidence);
	};
	if (Array.isArray(value)) {
		for (const entry of value) {
			const parsed = parseResolverEvidenceMap(entry);
			for (const [host, evidence] of parsed.entries()) merge(host, evidence);
		}
		return out;
	}
	if (value && typeof value === 'object') {
		parseObject(value);
		return out;
	}
	const raw = String(value || '').trim();
	if (!raw) return out;
	if (raw.startsWith('{') || raw.startsWith('[')) {
		try {
			const parsed = parseResolverEvidenceMap(JSON.parse(raw));
			for (const [host, evidence] of parsed.entries()) merge(host, evidence);
			return out;
		} catch {
			return out;
		}
	}
	for (const item of semiList(raw)) {
		const i = item.indexOf('=');
		if (i > 0) merge(item.slice(0, i), item.slice(i + 1));
	}
	return out;
}

function parseResolvedIpMap(value) {
	const out = new Map();
	const merge = (host, addresses) => {
		const h = normalizeHost(host);
		if (!h) return;
		const current = out.get(h) || [];
		const normalized = normalizeResolvedAddresses([current, addresses]);
		out.set(h, normalized.addresses.concat(normalized.invalid));
	};
	const parseObject = (obj) => {
		if (!obj || typeof obj !== 'object') return;
		if (obj instanceof Map) {
			for (const [host, addresses] of obj.entries()) merge(host, addresses);
			return;
		}
		for (const [host, addresses] of Object.entries(obj)) merge(host, addresses);
	};
	if (Array.isArray(value)) {
		for (const entry of value) {
			const parsed = parseResolvedIpMap(entry);
			for (const [host, addresses] of parsed.entries()) {
				merge(host, addresses);
			}
		}
		return out;
	}
	if (value && typeof value === 'object') {
		parseObject(value);
		return out;
	}
	const raw = String(value || '').trim();
	if (!raw) return out;
	if (raw.startsWith('{')) {
		try {
			parseObject(JSON.parse(raw));
			return out;
		} catch {
			return out;
		}
	}
	for (const item of semiList(raw)) {
		const i = item.indexOf('=');
		if (i > 0) merge(item.slice(0, i), item.slice(i + 1));
	}
	return out;
}

function resolverEvidenceSourceForHost(host, opts = {}) {
	const h = normalizeHost(host);
	let raw;
	let hasSource = false;
	const resolver = typeof opts.resolveHost === 'function' ? opts.resolveHost
		: (typeof opts.resolver === 'function' ? opts.resolver
			: (opts.resolver && typeof opts.resolver.resolveHost === 'function' ? opts.resolver.resolveHost.bind(opts.resolver) : null));
	if (resolver) {
		hasSource = true;
		try {
			raw = resolver(h);
		} catch (e) {
			return { hasSource, error: e && e.message ? e.message : String(e), addresses: [], invalid: [], source: 'resolver' };
		}
		if (raw && typeof raw.then === 'function') {
			return { hasSource, asyncUnsupported: true, addresses: [], invalid: [], source: 'resolver' };
		}
	}
	if (raw == null) {
		const evidenceMaps = [
			opts.resolverEvidence,
			opts.dnsEvidence,
			opts.resolvedEvidence,
		];
		for (const evidenceLike of evidenceMaps) {
			const parsed = parseResolverEvidenceMap(evidenceLike);
			if (!parsed.size) continue;
			hasSource = true;
			if (parsed.has(h)) {
				raw = parsed.get(h);
				break;
			}
		}
	}
	if (raw == null) {
		const maps = [
			opts.resolvedHosts,
			opts.resolvedIps,
			opts.resolvedIpMap,
		];
		for (const mapLike of maps) {
			const parsed = parseResolvedIpMap(mapLike);
			if (!parsed.size) continue;
			hasSource = true;
			if (parsed.has(h)) {
				raw = parsed.get(h);
				break;
			}
		}
	}
	if (raw == null) return { hasSource, addresses: [], invalid: [], source: hasSource ? 'resolver' : '' };
	return { hasSource: true, ...evidenceEntryFromValue(raw, h), source: 'resolver' };
}

function connectionIpSourceForHost(host, opts = {}) {
	const h = normalizeHost(host);
	let hasSource = false;
	const out = { addresses: [], invalid: [] };
	const merge = (value) => {
		const normalized = normalizeResolvedAddresses(value);
		out.addresses = normalizeResolvedAddresses([out.addresses, normalized.addresses]).addresses;
		out.invalid = out.invalid.concat(normalized.invalid);
	};
	for (const mapLike of [opts.connectionIps, opts.connectionIp, opts.connectedIps, opts.connectedIp, opts.connectionIpMap, opts.requestIpMap]) {
		if (mapLike == null || mapLike === '') continue;
		const parsed = parseResolvedIpMap(mapLike);
		if (parsed.size) {
			hasSource = true;
			if (parsed.has(h)) merge(parsed.get(h));
			continue;
		}
		if (typeof mapLike !== 'object' || Array.isArray(mapLike)) {
			hasSource = true;
			merge(mapLike);
		}
	}
	return { hasSource, ...out };
}

function validateResolverEvidenceFreshness(host, evidence, opts = {}) {
	const h = normalizeHost(host);
	const requireFresh = !!opts.requireFreshResolverEvidence;
	const maxAgeMs = millisOption(opts.resolverEvidenceMaxAgeMs, DEFAULT_RESOLVER_EVIDENCE_MAX_AGE_MS);
	const skewMs = millisOption(opts.resolverEvidenceClockSkewMs, DEFAULT_RESOLVER_EVIDENCE_CLOCK_SKEW_MS);
	const resolvedAt = evidence.resolvedAtMs;
	const expiresAt = evidence.expiresAtMs;
	const ttlMs = evidence.ttlMs;
	if (requireFresh && resolvedAt == null && expiresAt == null) {
		return { ok: false, reason: `resolver evidence for hostname "${h}" is missing freshness metadata`, host: h };
	}
	if (resolvedAt == null && expiresAt == null && ttlMs == null) return ok({ host: h, freshnessSkipped: true });
	const n = nowMs(opts);
	if (resolvedAt != null && resolvedAt > n + skewMs) {
		return { ok: false, reason: `resolver evidence for hostname "${h}" is from the future`, host: h, resolvedAtMs: resolvedAt };
	}
	if (expiresAt != null && n > expiresAt + skewMs) {
		return { ok: false, reason: `resolver evidence for hostname "${h}" is stale`, host: h, resolvedAtMs: resolvedAt, expiresAtMs: expiresAt };
	}
	if (resolvedAt != null && ttlMs != null && n > resolvedAt + ttlMs + skewMs) {
		return { ok: false, reason: `resolver evidence for hostname "${h}" is stale`, host: h, resolvedAtMs: resolvedAt, ttlMs };
	}
	if ((requireFresh || opts.resolverEvidenceMaxAgeMs != null || opts.dnsEvidenceMaxAgeMs != null) && resolvedAt != null && n > resolvedAt + maxAgeMs + skewMs) {
		return { ok: false, reason: `resolver evidence for hostname "${h}" is older than ${maxAgeMs}ms`, host: h, resolvedAtMs: resolvedAt, maxAgeMs };
	}
	return ok({ host: h, resolvedAtMs: resolvedAt, expiresAtMs: expiresAt, ttlMs });
}

function validateResolvedChainPolicy(host, evidence, opts = {}) {
	const profile = normalizeProfile(opts.profile, 'public');
	const h = normalizeHost(host);
	const chain = Array.isArray(evidence.cnameChain) ? evidence.cnameChain.filter(Boolean) : [];
	const canonicalName = normalizeHost(evidence.canonicalName || '');
	if (evidence.invalidCnames && evidence.invalidCnames.length) {
		return { ok: false, reason: `resolver evidence for hostname "${h}" includes invalid CNAME "${evidence.invalidCnames[0]}"`, host: h, profile };
	}
	if (chain.length) {
		if (chain[0] !== h) {
			return { ok: false, reason: `CNAME chain for hostname "${h}" must start with "${h}"`, host: h, profile, cnameChain: chain };
		}
		if (canonicalName && chain[chain.length - 1] !== canonicalName) {
			return { ok: false, reason: `CNAME chain for hostname "${h}" does not end at canonical name "${canonicalName}"`, host: h, profile, cnameChain: chain, canonicalName };
		}
	}
	const names = [...chain];
	if (canonicalName && !names.includes(canonicalName)) names.push(canonicalName);
	for (const name of names) {
		const kind = hostKind(name);
		if (kind !== 'public' && !specialAllowed(kind, profile)) {
			return { ok: false, reason: `CNAME/resolved chain for hostname "${h}" includes ${specialDescription(kind)} "${name}" blocked by egress profile "${profile}"`, host: h, kind, profile, cnameChain: chain, canonicalName };
		}
	}
	return ok({ host: h, profile, ...(chain.length ? { cnameChain: chain } : {}), ...(canonicalName ? { canonicalName } : {}) });
}

function validateConnectionIpEvidence(host, resolvedAddresses, evidence, opts = {}) {
	const profile = normalizeProfile(opts.profile, 'public');
	const h = normalizeHost(host);
	const fromOpts = connectionIpSourceForHost(h, opts);
	const normalized = normalizeResolvedAddresses([evidence.connectionIps, fromOpts.addresses]);
	const invalid = [].concat(evidence.invalidConnectionIps || [], fromOpts.invalid || [], normalized.invalid || []);
	if (invalid.length) {
		return { ok: false, reason: `connection evidence for hostname "${h}" includes non-IP address "${invalid[0]}"`, host: h, invalid, profile };
	}
	if (!normalized.addresses.length) {
		if (opts.requireConnectionIp) return { ok: false, reason: `no connection IP evidence provided for hostname "${h}"`, host: h, profile };
		return ok({ host: h, profile, connectionIps: [], skipped: true });
	}
	const resolvedSet = new Set(resolvedAddresses || []);
	for (const address of normalized.addresses) {
		const kind = hostKind(address);
		if (kind !== 'public' && !specialAllowed(kind, profile)) {
			return {
				ok: false,
				reason: `connection IP ${address} for hostname "${h}" is a ${specialDescription(kind)} blocked by egress profile "${profile}"`,
				host: h,
				address,
				kind,
				profile,
				connectionIps: normalized.addresses,
			};
		}
		if (resolvedSet.size && !resolvedSet.has(address)) {
			return {
				ok: false,
				reason: `connection IP ${address} for hostname "${h}" does not match resolver evidence`,
				host: h,
				address,
				profile,
				resolvedIps: Array.from(resolvedSet),
				connectionIps: normalized.addresses,
			};
		}
	}
	return ok({ host: h, profile, connectionIps: normalized.addresses });
}

function validateResolvedIpPolicy(host, addresses, opts = {}) {
	const profile = normalizeProfile(opts.profile, 'public');
	const h = normalizeHost(host);
	const normalized = normalizeResolvedAddresses(addresses);
	if (normalized.invalid.length) {
		return { ok: false, reason: `resolver returned non-IP address "${normalized.invalid[0]}" for hostname "${h}"`, host: h, invalid: normalized.invalid, profile };
	}
	if (!normalized.addresses.length) {
		if (opts.requireResolvedIps) return { ok: false, reason: `no resolved IPs provided for hostname "${h}"`, host: h, profile };
		return ok({ host: h, profile, resolvedIps: [], skipped: true });
	}
	for (const address of normalized.addresses) {
		const kind = hostKind(address);
		if (kind !== 'public' && !specialAllowed(kind, profile)) {
			return {
				ok: false,
				reason: `resolved IP ${address} for hostname "${h}" is a ${specialDescription(kind)} blocked by egress profile "${profile}"`,
				host: h,
				address,
				kind,
				profile,
				resolvedIps: normalized.addresses,
			};
		}
	}
	return ok({ host: h, profile, resolvedIps: normalized.addresses });
}

function validateResolvedHostEgress(host, opts = {}) {
	const h = normalizeHost(host);
	if (!h || net.isIP(h)) return ok({ host: h, skipped: true });
	const source = resolverEvidenceSourceForHost(h, opts);
	if (source.error) {
		return { ok: false, reason: `resolver failed for hostname "${h}": ${source.error}`, host: h, profile: normalizeProfile(opts.profile, 'public') };
	}
	if (source.asyncUnsupported) {
		return { ok: false, reason: `resolver for hostname "${h}" must return deterministic IPs synchronously`, host: h, profile: normalizeProfile(opts.profile, 'public') };
	}
	const chain = validateResolvedChainPolicy(h, source, opts);
	if (!chain.ok) return chain;
	const fresh = validateResolverEvidenceFreshness(h, source, opts);
	if (!fresh.ok) return fresh;
	const ipPolicy = validateResolvedIpPolicy(h, source.addresses.concat(source.invalid), {
		profile: opts.profile,
		requireResolvedIps: opts.requireResolvedIps,
	});
	if (!ipPolicy.ok) return ipPolicy;
	const connection = validateConnectionIpEvidence(h, ipPolicy.resolvedIps || [], source, opts);
	if (!connection.ok) return connection;
	return ok({
		host: h,
		profile: normalizeProfile(opts.profile, 'public'),
		resolvedIps: ipPolicy.resolvedIps || [],
		...(chain.cnameChain ? { cnameChain: chain.cnameChain } : {}),
		...(chain.canonicalName ? { canonicalName: chain.canonicalName } : {}),
		...(fresh.resolvedAtMs != null ? { resolvedAtMs: fresh.resolvedAtMs } : {}),
		...(fresh.expiresAtMs != null ? { expiresAtMs: fresh.expiresAtMs } : {}),
		...(fresh.ttlMs != null ? { ttlMs: fresh.ttlMs } : {}),
		...(connection.connectionIps && connection.connectionIps.length ? { connectionIps: connection.connectionIps } : {}),
	});
}

module.exports = {
	parseResolverEvidenceMap,
	parseResolvedIpMap,
	validateConnectionIpEvidence,
	validateResolvedIpPolicy,
	validateResolvedHostEgress,
};
