// lib/egress-resolver.js - deterministic egress resolver adapter contract.
// Pure CommonJS leaf: no OS DNS lookup, no network access, no secret reads.
'use strict';

const net = require('node:net');

const RECORD_TYPES = new Set(['A', 'AAAA', 'CNAME']);
const DEFAULT_MAX_CNAME_DEPTH = 16;

function isPromiseLike(value) {
	return value && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
}

function numberOption(value, fallback = 0) {
	if (value == null || value === '') return fallback;
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function nowMs(opts = {}) {
	const n = numberOption(opts.nowMs ?? opts.now, 0);
	return n || Date.now();
}

function parseTimestampMs(value) {
	if (value == null || value === '') return null;
	if (value instanceof Date) {
		const n = value.getTime();
		return Number.isFinite(n) ? n : null;
	}
	if (typeof value === 'number') {
		if (!Number.isFinite(value) || value < 0) return null;
		return value > 0 && value < 1000000000000 ? Math.round(value * 1000) : Math.round(value);
	}
	const s = String(value).trim();
	if (!s) return null;
	if (/^\d+(\.\d+)?$/.test(s)) return parseTimestampMs(Number(s));
	const n = Date.parse(s);
	return Number.isFinite(n) ? n : null;
}

function ttlMsFrom(value) {
	if (value == null || value === '') return null;
	if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

function ttlCandidateFrom(value) {
	if (!value || typeof value !== 'object') return null;
	const ms = ttlMsFrom(value.ttlMs ?? value.ttlMillis);
	if (ms != null) return ms;
	const seconds = ttlMsFrom(value.ttlSeconds ?? value.ttl);
	return seconds == null ? null : seconds * 1000;
}

function minPositive(values) {
	let best = null;
	for (const value of values) {
		const n = ttlMsFrom(value);
		if (n == null) continue;
		if (best == null || n < best) best = n;
	}
	return best;
}

function maxTimestamp(values) {
	let best = null;
	for (const value of values) {
		const n = parseTimestampMs(value);
		if (n == null) continue;
		if (best == null || n > best) best = n;
	}
	return best;
}

function normalizeHost(host) {
	let h = String(host == null ? '' : host).trim().toLowerCase();
	if (!h) return '';
	if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(h)) {
		try {
			h = new URL(h).hostname;
		} catch {
			return '';
		}
	}
	if (h.startsWith('[')) {
		const end = h.indexOf(']');
		if (end > 0) {
			const inside = h.slice(1, end);
			const rest = h.slice(end + 1);
			if (!rest || /^:\d+$/.test(rest)) h = inside;
		}
	}
	const pct = h.indexOf('%');
	if (pct >= 0) h = h.slice(0, pct);
	if (h.includes(':') && net.isIP(h) === 0) {
		const i = h.lastIndexOf(':');
		if (i > 0 && h.indexOf(':') === i && /^\d+$/.test(h.slice(i + 1))) h = h.slice(0, i);
	}
	return h.replace(/\.$/, '');
}

function normalizeIpLiteral(value) {
	let h = String(value == null ? '' : value).trim();
	if (!h) return '';
	if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
	const pct = h.indexOf('%');
	if (pct >= 0) h = h.slice(0, pct);
	h = h.replace(/\.$/, '').toLowerCase();
	return net.isIP(h) ? h : '';
}

function pushUnique(out, value) {
	if (!value || out.includes(value)) return;
	out.push(value);
}

function flattenValues(value, fieldNames) {
	const out = [];
	const visit = (item) => {
		if (item == null || item === '') return;
		if (Array.isArray(item)) {
			for (const v of item) visit(v);
			return;
		}
		if (typeof item === 'object') {
			for (const field of fieldNames) {
				if (Object.prototype.hasOwnProperty.call(item, field)) visit(item[field]);
			}
			return;
		}
		const raw = String(item).trim();
		if (!raw) return;
		if (raw.includes(',')) {
			for (const part of raw.split(',')) visit(part);
			return;
		}
		out.push(raw);
	};
	visit(value);
	return out;
}

function collectMetadata(value, out) {
	if (value == null || value === '') return;
	if (Array.isArray(value)) {
		for (const item of value) collectMetadata(item, out);
		return;
	}
	if (typeof value !== 'object') return;
	const ttlMs = ttlCandidateFrom(value);
	if (ttlMs != null) out.ttlCandidates.push(ttlMs);
	const resolvedAt = parseTimestampMs(value.resolvedAtMs ?? value.resolvedAt ?? value.observedAt ?? value.createdAt ?? value.timestamp);
	if (resolvedAt != null) out.resolvedAtCandidates.push(resolvedAt);
	const expiresAt = parseTimestampMs(value.expiresAtMs ?? value.expiresAt ?? value.validUntil);
	if (expiresAt != null) out.expiresAtCandidates.push(expiresAt);
	for (const field of ['records', 'values', 'answers', 'addresses', 'ips', 'names', 'targets', 'cname', 'cnames']) {
		if (Object.prototype.hasOwnProperty.call(value, field)) collectMetadata(value[field], out);
	}
}

function normalizeAddressRecords(value) {
	const meta = { ttlCandidates: [], resolvedAtCandidates: [], expiresAtCandidates: [] };
	collectMetadata(value, meta);
	const addresses = [];
	const invalid = [];
	for (const raw of flattenValues(value, ['records', 'values', 'answers', 'addresses', 'address', 'ips', 'ip', 'value', 'host'])) {
		const ip = normalizeIpLiteral(raw);
		if (ip) pushUnique(addresses, ip);
		else invalid.push(raw);
	}
	return {
		addresses,
		invalid,
		ttlMs: minPositive(meta.ttlCandidates),
		resolvedAtMs: maxTimestamp(meta.resolvedAtCandidates),
		expiresAtMs: meta.expiresAtCandidates.length ? Math.min(...meta.expiresAtCandidates) : null,
	};
}

function normalizeNameRecords(value) {
	const meta = { ttlCandidates: [], resolvedAtCandidates: [], expiresAtCandidates: [] };
	collectMetadata(value, meta);
	const names = [];
	const invalid = [];
	for (const raw of flattenValues(value, ['records', 'values', 'answers', 'names', 'targets', 'cname', 'cnames', 'canonicalName', 'name', 'value', 'host'])) {
		const h = normalizeHost(raw);
		if (h && net.isIP(h) === 0) pushUnique(names, h);
		else invalid.push(raw);
	}
	return {
		names,
		invalid,
		ttlMs: minPositive(meta.ttlCandidates),
		resolvedAtMs: maxTimestamp(meta.resolvedAtCandidates),
		expiresAtMs: meta.expiresAtCandidates.length ? Math.min(...meta.expiresAtCandidates) : null,
	};
}

function normalizeConnectionIps(value) {
	const addresses = [];
	const invalid = [];
	for (const raw of flattenValues(value, ['records', 'values', 'answers', 'addresses', 'address', 'ips', 'ip', 'connectionIps', 'connectionIp', 'connectedIp', 'remoteAddress', 'value', 'host'])) {
		const ip = normalizeIpLiteral(raw);
		if (ip) pushUnique(addresses, ip);
		else invalid.push(raw);
	}
	return { addresses, invalid };
}

function finishEvidence(entry, opts = {}) {
	const n = nowMs(opts);
	const resolvedAtMs = entry.resolvedAtMs == null ? n : entry.resolvedAtMs;
	let ttlMs = entry.ttlMs;
	if (ttlMs == null && opts.defaultTtlMs != null) ttlMs = ttlMsFrom(opts.defaultTtlMs);
	let expiresAtMs = entry.expiresAtMs;
	if (expiresAtMs == null && ttlMs != null) expiresAtMs = resolvedAtMs + ttlMs;
	const stale = expiresAtMs != null ? n > expiresAtMs : false;
	return {
		host: normalizeHost(entry.host),
		addresses: Array.isArray(entry.addresses) ? entry.addresses.slice() : [],
		invalid: Array.isArray(entry.invalid) ? entry.invalid.slice() : [],
		aRecords: Array.isArray(entry.aRecords) ? entry.aRecords.slice() : [],
		aaaaRecords: Array.isArray(entry.aaaaRecords) ? entry.aaaaRecords.slice() : [],
		cnameChain: Array.isArray(entry.cnameChain) ? entry.cnameChain.slice() : [],
		invalidCnames: Array.isArray(entry.invalidCnames) ? entry.invalidCnames.slice() : [],
		canonicalName: normalizeHost(entry.canonicalName || entry.host),
		resolvedAtMs,
		expiresAtMs,
		ttlMs,
		stale,
		connectionIps: Array.isArray(entry.connectionIps) ? entry.connectionIps.slice() : [],
		invalidConnectionIps: Array.isArray(entry.invalidConnectionIps) ? entry.invalidConnectionIps.slice() : [],
		evidenceVersion: 1,
		provider: entry.provider || opts.providerName || '',
	};
}

function normalizeResolverEvidence(value, fallbackHost = '', opts = {}) {
	const host = normalizeHost(value && typeof value === 'object' && !Array.isArray(value)
		? value.host ?? value.hostname ?? value.name ?? fallbackHost
		: fallbackHost);
	if (value == null || value === '') {
		return finishEvidence({ host, canonicalName: host, provider: opts.providerName }, opts);
	}
	if (Array.isArray(value) || typeof value !== 'object') {
		const normalized = normalizeAddressRecords(value);
		return finishEvidence({
			host,
			addresses: normalized.addresses,
			invalid: normalized.invalid,
			aRecords: normalized.addresses.filter((ip) => net.isIP(ip) === 4),
			aaaaRecords: normalized.addresses.filter((ip) => net.isIP(ip) === 6),
			canonicalName: host,
			ttlMs: normalized.ttlMs,
			resolvedAtMs: normalized.resolvedAtMs,
			expiresAtMs: normalized.expiresAtMs,
			provider: opts.providerName,
		}, opts);
	}
	const a = normalizeAddressRecords(value.A ?? value.a ?? value.aRecords ?? value.ipv4 ?? []);
	const aaaa = normalizeAddressRecords(value.AAAA ?? value.aaaa ?? value.aaaaRecords ?? value.ipv6 ?? []);
	const direct = normalizeAddressRecords(value.addresses ?? value.resolvedIps ?? value.ips ?? value.address ?? value.ip ?? []);
	const connection = normalizeConnectionIps(value.connectionIps ?? value.connectionIp ?? value.connectedIp ?? value.remoteAddress ?? []);
	const chain = normalizeNameRecords(value.cnameChain ?? value.cnames ?? value.chain ?? value.resolvedChain ?? []);
	const canonicalName = normalizeHost(value.canonicalName ?? value.finalHostname ?? value.finalName ?? value.cname ?? chain.names[chain.names.length - 1] ?? host);
	const allAddresses = [];
	for (const ip of a.addresses.concat(aaaa.addresses, direct.addresses)) pushUnique(allAddresses, ip);
	const ttlMs = minPositive([
		ttlCandidateFrom(value),
		a.ttlMs,
		aaaa.ttlMs,
		direct.ttlMs,
		chain.ttlMs,
	]);
	const resolvedAtMs = maxTimestamp([
		value.resolvedAtMs,
		value.resolvedAt,
		value.observedAt,
		value.createdAt,
		value.timestamp,
		a.resolvedAtMs,
		aaaa.resolvedAtMs,
		direct.resolvedAtMs,
		chain.resolvedAtMs,
	]);
	const expires = [
		parseTimestampMs(value.expiresAtMs ?? value.expiresAt ?? value.validUntil),
		a.expiresAtMs,
		aaaa.expiresAtMs,
		direct.expiresAtMs,
		chain.expiresAtMs,
	].filter((v) => v != null);
	return finishEvidence({
		host,
		addresses: allAddresses,
		invalid: [].concat(a.invalid, aaaa.invalid, direct.invalid, Array.isArray(value.invalid) ? value.invalid : []),
		aRecords: a.addresses,
		aaaaRecords: aaaa.addresses,
		cnameChain: chain.names,
		invalidCnames: [].concat(chain.invalid, Array.isArray(value.invalidCnames) ? value.invalidCnames : []),
		canonicalName,
		ttlMs,
		resolvedAtMs,
		expiresAtMs: expires.length ? Math.min(...expires) : null,
		connectionIps: connection.addresses,
		invalidConnectionIps: [].concat(connection.invalid, Array.isArray(value.invalidConnectionIps) ? value.invalidConnectionIps : []),
		provider: value.provider || opts.providerName,
	}, opts);
}

function hasRecordProvider(provider) {
	return !!(provider && (
		typeof provider.resolveRecord === 'function'
		|| typeof provider.resolveA === 'function'
		|| typeof provider.resolveAAAA === 'function'
		|| typeof provider.resolveCNAME === 'function'
	));
}

function callSync(fn, args, label) {
	const value = fn(...args);
	if (isPromiseLike(value)) throw new Error(`${label} must be synchronous and deterministic`);
	return value;
}

function queryRecord(provider, host, type, ctx) {
	if (!RECORD_TYPES.has(type)) throw new Error(`unsupported resolver record type "${type}"`);
	if (typeof provider.resolveRecord === 'function') return callSync(provider.resolveRecord.bind(provider), [host, type, ctx], `resolver ${type} lookup`);
	if (type === 'A' && typeof provider.resolveA === 'function') return callSync(provider.resolveA.bind(provider), [host, ctx], 'resolver A lookup');
	if (type === 'AAAA' && typeof provider.resolveAAAA === 'function') return callSync(provider.resolveAAAA.bind(provider), [host, ctx], 'resolver AAAA lookup');
	if (type === 'CNAME' && typeof provider.resolveCNAME === 'function') return callSync(provider.resolveCNAME.bind(provider), [host, ctx], 'resolver CNAME lookup');
	return [];
}

function queryConnectionIps(provider, hosts, ctx) {
	const out = { addresses: [], invalid: [] };
	const merge = (value) => {
		const normalized = normalizeConnectionIps(value);
		for (const ip of normalized.addresses) pushUnique(out.addresses, ip);
		out.invalid.push(...normalized.invalid);
	};
	for (const mapLike of [ctx.connectionIps, ctx.connectionIpMap, ctx.connectedIps, ctx.connectedIp, ctx.connectionIp]) {
		if (mapLike == null || mapLike === '') continue;
		if (typeof mapLike === 'object' && !Array.isArray(mapLike)) {
			for (const host of hosts) {
				if (Object.prototype.hasOwnProperty.call(mapLike, host)) merge(mapLike[host]);
			}
		} else {
			merge(mapLike);
		}
	}
	if (provider && typeof provider.connectionIps === 'function') {
		for (const host of hosts) merge(callSync(provider.connectionIps.bind(provider), [host, ctx], 'resolver connection IP lookup'));
	} else if (provider && typeof provider.connectionIp === 'function') {
		for (const host of hosts) merge(callSync(provider.connectionIp.bind(provider), [host, ctx], 'resolver connection IP lookup'));
	}
	return out;
}

function resolveViaRecords(provider, host, opts = {}) {
	const h = normalizeHost(host);
	const ctx = { ...opts, host: h, nowMs: nowMs(opts) };
	const maxDepth = Math.max(1, Math.floor(numberOption(opts.maxCnameDepth, DEFAULT_MAX_CNAME_DEPTH)));
	const seen = new Set();
	const chain = [h];
	const invalidCnames = [];
	const ttlCandidates = [];
	const resolvedAtCandidates = [];
	const expiresAtCandidates = [];
	let current = h;
	let followedCname = false;
	for (let depth = 0; depth < maxDepth; depth++) {
		if (seen.has(current)) throw new Error(`CNAME loop detected for hostname "${h}"`);
		seen.add(current);
		const cnames = normalizeNameRecords(queryRecord(provider, current, 'CNAME', ctx));
		ttlCandidates.push(cnames.ttlMs);
		resolvedAtCandidates.push(cnames.resolvedAtMs);
		expiresAtCandidates.push(cnames.expiresAtMs);
		invalidCnames.push(...cnames.invalid);
		if (!cnames.names.length) break;
		current = cnames.names[0];
		pushUnique(chain, current);
		followedCname = true;
		if (depth === maxDepth - 1) throw new Error(`CNAME chain for hostname "${h}" exceeded ${maxDepth} records`);
	}
	const a = normalizeAddressRecords(queryRecord(provider, current, 'A', ctx));
	const aaaa = normalizeAddressRecords(queryRecord(provider, current, 'AAAA', ctx));
	ttlCandidates.push(a.ttlMs, aaaa.ttlMs);
	resolvedAtCandidates.push(a.resolvedAtMs, aaaa.resolvedAtMs);
	expiresAtCandidates.push(a.expiresAtMs, aaaa.expiresAtMs);
	const addresses = [];
	for (const ip of a.addresses.concat(aaaa.addresses)) pushUnique(addresses, ip);
	const connection = queryConnectionIps(provider, [h, current], ctx);
	return finishEvidence({
		host: h,
		addresses,
		invalid: a.invalid.concat(aaaa.invalid),
		aRecords: a.addresses,
		aaaaRecords: aaaa.addresses,
		cnameChain: followedCname ? chain : [],
		invalidCnames,
		canonicalName: current,
		ttlMs: minPositive(ttlCandidates),
		resolvedAtMs: maxTimestamp(resolvedAtCandidates),
		expiresAtMs: expiresAtCandidates.filter((v) => v != null).length ? Math.min(...expiresAtCandidates.filter((v) => v != null)) : null,
		connectionIps: connection.addresses,
		invalidConnectionIps: connection.invalid,
		provider: opts.providerName,
	}, opts);
}

function createEgressResolver(provider, defaults = {}) {
	if (!provider || (typeof provider !== 'function' && typeof provider !== 'object')) {
		throw new Error('egress resolver adapter requires an explicit deterministic provider; OS DNS fallback is not available');
	}
	const providerName = defaults.providerName || provider.providerName || provider.name || 'egress-resolver-provider';
	const adapter = {
		kind: 'egress-resolver-adapter',
		providerName,
		resolveHost(host, opts = {}) {
			const h = normalizeHost(host);
			if (!h) throw new Error('resolver host is required');
			const ctx = { ...defaults, ...opts, providerName };
			if (typeof provider === 'function') {
				const raw = callSync(provider, [h, ctx], 'resolver host lookup');
				return normalizeResolverEvidence(raw, h, ctx);
			}
			if (!hasRecordProvider(provider) && typeof provider.resolveHost === 'function') {
				const raw = callSync(provider.resolveHost.bind(provider), [h, ctx], 'resolver host lookup');
				return normalizeResolverEvidence(raw, h, ctx);
			}
			return resolveViaRecords(provider, h, ctx);
		},
		evidenceForHost(host, opts = {}) {
			return this.resolveHost(host, opts);
		},
		evidenceForUrl(rawUrl, opts = {}) {
			let url;
			try {
				url = new URL(String(rawUrl || ''));
			} catch {
				throw new Error('resolver evidence URL is invalid');
			}
			return this.resolveHost(url.hostname, opts);
		},
	};
	return adapter;
}

function arrayValue(value) {
	if (value == null || value === '') return [];
	return Array.isArray(value) ? value.slice() : [value];
}

function normalizeFakeRecord(record = {}) {
	if (Array.isArray(record) || typeof record !== 'object') return { A: arrayValue(record), AAAA: [], CNAME: [], connectionIps: [] };
	const ttlMs = ttlCandidateFrom(record);
	const resolvedAtMs = parseTimestampMs(record.resolvedAtMs ?? record.resolvedAt ?? record.observedAt ?? record.createdAt ?? record.timestamp);
	const expiresAtMs = parseTimestampMs(record.expiresAtMs ?? record.expiresAt ?? record.validUntil);
	return {
		A: arrayValue(record.A ?? record.a ?? record.addresses ?? record.address ?? record.ipv4 ?? record.ip),
		AAAA: arrayValue(record.AAAA ?? record.aaaa ?? record.ipv6),
		CNAME: arrayValue(record.CNAME ?? record.cname ?? record.cnames ?? record.canonicalTarget),
		connectionIps: arrayValue(record.connectionIps ?? record.connectionIp ?? record.connectedIp ?? record.remoteAddress),
		ttlMs,
		resolvedAtMs,
		expiresAtMs,
	};
}

function fakeAnswers(record, field) {
	const values = arrayValue(record[field]);
	return values.map((value) => ({
		value,
		ttlMs: record.ttlMs,
		resolvedAtMs: record.resolvedAtMs,
		expiresAtMs: record.expiresAtMs,
	}));
}

function createFakeResolver(records = {}, defaults = {}) {
	const table = new Map();
	if (records instanceof Map) {
		for (const [host, record] of records.entries()) {
			const h = normalizeHost(host);
			if (h) table.set(h, normalizeFakeRecord(record));
		}
	} else {
		for (const [host, record] of Object.entries(records || {})) {
			const h = normalizeHost(host);
			if (h) table.set(h, normalizeFakeRecord(record));
		}
	}
	const provider = {
		providerName: defaults.providerName || 'fake-egress-resolver',
		resolveRecord(host, type) {
			const record = table.get(normalizeHost(host));
			if (!record) return [];
			if (type === 'A') return fakeAnswers(record, 'A');
			if (type === 'AAAA') return fakeAnswers(record, 'AAAA');
			if (type === 'CNAME') return fakeAnswers(record, 'CNAME');
			return [];
		},
		connectionIps(host) {
			const record = table.get(normalizeHost(host));
			return record ? fakeAnswers(record, 'connectionIps') : [];
		},
	};
	const adapter = createEgressResolver(provider, { ...defaults, providerName: provider.providerName });
	adapter.fakeRecords = table;
	return adapter;
}

function resolverEvidenceForUrl(rawUrl, resolver, opts = {}) {
	if (!resolver || typeof resolver.resolveHost !== 'function') throw new Error('resolverEvidenceForUrl requires a resolver adapter');
	let url;
	try {
		url = new URL(String(rawUrl || ''));
	} catch {
		throw new Error('resolver evidence URL is invalid');
	}
	const evidence = resolver.resolveHost(url.hostname, opts);
	return { [evidence.host]: evidence };
}

module.exports = {
	RECORD_TYPES,
	normalizeHost,
	normalizeIpLiteral,
	normalizeResolverEvidence,
	createEgressResolver,
	createFakeResolver,
	resolverEvidenceForUrl,
};
