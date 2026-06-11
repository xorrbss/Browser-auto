// lib/egress-policy.js - deterministic target egress policy for browser-driving code.
// Pure CommonJS leaf: no Playwright import, no DNS/network lookup, no secret reads.
'use strict';

const net = require('node:net');

const PROFILES = new Set(['public', 'local', 'on-prem']);
const ENFORCE_PHASES = new Set(['register', 'import', 'enqueue', 'run', 'verify']);
const URLISH_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const TRUE_RE = /^(1|true|yes|on)$/i;
const DEFAULT_RESOLVER_EVIDENCE_MAX_AGE_MS = 5 * 60 * 1000;
const DEFAULT_RESOLVER_EVIDENCE_CLOCK_SKEW_MS = 30 * 1000;
const METADATA_HOSTS = new Set([
	'169.254.169.254',
	'169.254.170.2',
	'100.100.100.200',
	'168.63.129.16',
	'fd00:ec2::254',
	'metadata.google.internal',
	'metadata.google.internal.',
]);

function csvList(value) {
	if (Array.isArray(value)) return value.flatMap(csvList);
	return String(value || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function semiList(value) {
	if (Array.isArray(value)) return value.flatMap(semiList);
	return String(value || '').split(';').map((s) => s.trim()).filter(Boolean);
}

function isExternalMode(env = process.env) {
	return TRUE_RE.test(String(env.WEBUI_EXTERNAL_MODE || env.AQA_EXTERNAL_MODE || ''));
}

function normalizeProfile(value, fallback = 'public') {
	const s = String(value || '').trim().toLowerCase();
	return PROFILES.has(s) ? s : fallback;
}

function numberOption(value, fallback = 0) {
	if (value == null || value === '') return fallback;
	const n = Number(value);
	return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function millisOption(value, fallback = 0) {
	const n = numberOption(value, fallback);
	return n || fallback;
}

function secondsToMillisOption(value, fallback = 0) {
	const n = numberOption(value, 0);
	return n ? n * 1000 : fallback;
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

function envProfile(env = process.env) {
	const raw = env.AQA_EGRESS_PROFILE || env.WEBUI_EGRESS_PROFILE || '';
	return raw ? normalizeProfile(raw, '') : '';
}

function defaultFlowProfile(flow, opts = {}) {
	return String(flow?.environment || '') === 'local' ? 'local' : (isExternalMode(opts.env) ? 'public' : 'public');
}

function defaultSystemProfile(opts = {}) {
	const env = opts.env || process.env;
	if (isExternalMode(env)) return 'public';
	return String(env.AQA_RUN_MODE || 'local') === 'local' ? 'local' : 'public';
}

function profileFromSubject(subject, opts = {}, fallback = 'public') {
	const explicit = opts.profile || subject?.egress?.profile || subject?.egressProfile || subject?.recipe?.egress?.profile || '';
	return normalizeProfile(explicit || envProfile(opts.env || process.env) || fallback, fallback);
}

function normalizeHost(host) {
	let h = String(host || '').trim().toLowerCase();
	if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
	const pct = h.indexOf('%');
	if (pct >= 0) h = h.slice(0, pct);
	return h.replace(/\.$/, '');
}

function splitHostPort(value) {
	const s = String(value || '').trim();
	if (!s) return { host: '', port: '' };
	if (s.startsWith('[')) {
		const end = s.indexOf(']');
		if (end >= 0) {
			const host = s.slice(1, end);
			const rest = s.slice(end + 1);
			return { host, port: rest.startsWith(':') ? rest.slice(1) : '' };
		}
	}
	const i = s.lastIndexOf(':');
	if (i > 0 && s.indexOf(':') === i && /^\d+$/.test(s.slice(i + 1))) return { host: s.slice(0, i), port: s.slice(i + 1) };
	return { host: s, port: '' };
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

function normalizeResolvedAddresses(value) {
	const addresses = [];
	const invalid = [];
	const seen = new Set();
	const add = (item) => {
		if (item == null || item === '') return;
		if (Array.isArray(item)) {
			for (const v of item) add(v);
			return;
		}
		if (typeof item === 'object') {
			add(item.address ?? item.ip ?? item.host);
			return;
		}
		const parts = String(item).includes(',') ? String(item).split(',') : [String(item)];
		for (const part of parts) {
			const raw = part.trim();
			if (!raw) continue;
			const ip = normalizeIpLiteral(raw);
			if (!ip) {
				invalid.push(raw);
				continue;
			}
			if (!seen.has(ip)) {
				seen.add(ip);
				addresses.push(ip);
			}
		}
	};
	add(value);
	return { addresses, invalid };
}

function normalizeHostList(value) {
	const out = [];
	const invalid = [];
	const seen = new Set();
	const add = (item) => {
		if (item == null || item === '') return;
		if (Array.isArray(item)) {
			for (const v of item) add(v);
			return;
		}
		if (typeof item === 'object') {
			add(item.host ?? item.hostname ?? item.name ?? item.canonicalName ?? item.finalHostname);
			return;
		}
		const parts = String(item).includes(',') ? String(item).split(',') : [String(item)];
		for (const part of parts) {
			const raw = String(part || '').trim();
			if (!raw) continue;
			const h = normalizeHost(raw);
			if (!h || net.isIP(h)) {
				invalid.push(raw);
				continue;
			}
			if (!seen.has(h)) {
				seen.add(h);
				out.push(h);
			}
		}
	};
	add(value);
	return { hosts: out, invalid };
}

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

function ipv4Octets(host) {
	if (!/^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
	const parts = host.split('.').map((x) => Number(x));
	if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
	return parts;
}

function ipv4Kind(host) {
	const o = ipv4Octets(host);
	if (!o) return null;
	const s = o.join('.');
	if (METADATA_HOSTS.has(s)) return 'metadata';
	if (o[0] === 127) return 'loopback';
	if (o[0] === 0) return 'unspecified';
	if (o[0] === 10) return 'private';
	if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return 'private';
	if (o[0] === 192 && o[1] === 168) return 'private';
	if (o[0] === 169 && o[1] === 254) return 'link-local';
	if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return 'private';
	if (o[0] === 198 && (o[1] === 18 || o[1] === 19)) return 'private';
	if (o[0] >= 224 && o[0] <= 239) return 'multicast';
	return 'public';
}

function ipv4MappedKind(host) {
	const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(host);
	return m ? ipv4Kind(m[1]) : null;
}

function ipv6Kind(host) {
	const h = normalizeHost(host);
	const mapped = ipv4MappedKind(h);
	if (mapped) return mapped;
	if (METADATA_HOSTS.has(h)) return 'metadata';
	if (h === '::1' || /^0:0:0:0:0:0:0:1$/i.test(h)) return 'loopback';
	if (h === '::' || /^0:0:0:0:0:0:0:0$/i.test(h)) return 'unspecified';
	const first = h.split(':')[0] || '';
	const n = parseInt(first, 16);
	if (!Number.isFinite(n)) return null;
	if ((n & 0xfe00) === 0xfc00) return 'private';
	if ((n & 0xffc0) === 0xfe80) return 'link-local';
	if ((n & 0xff00) === 0xff00) return 'multicast';
	return 'public';
}

function hostKind(host) {
	const h = normalizeHost(host);
	if (!h) return 'none';
	if (METADATA_HOSTS.has(h)) return 'metadata';
	if (h === 'localhost' || h.endsWith('.localhost')) return 'loopback';
	if (h.endsWith('.local')) return 'private-name';
	const ipVer = net.isIP(h);
	if (ipVer === 4) return ipv4Kind(h) || 'public';
	if (ipVer === 6) return ipv6Kind(h) || 'public';
	return 'public';
}

function sanitizedUrl(raw) {
	try {
		const u = new URL(String(raw || ''));
		u.username = '';
		u.password = '';
		u.search = '';
		u.hash = '';
		return u.toString();
	} catch {
		return String(raw || '').split('?')[0].split('#')[0];
	}
}

function sanitizedAuditText(value) {
	let s = String(value == null ? '' : value);
	s = s.replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/g, (m) => sanitizedUrl(m));
	s = s.replace(/\bauthorization\s*:\s*(?:bearer|basic)?\s*["']?[A-Za-z0-9._~+/=-]+["']?/ig, 'authorization: [redacted]');
	s = s.replace(/\b(cookie|set-cookie)\s*:\s*[^,\r\n]*/ig, '$1: [redacted]');
	s = s.replace(/\b(bearer|basic)\s+["']?[A-Za-z0-9._~+/=-]+["']?/ig, '$1 [redacted]');
	s = s.replace(/([?&](?:token|access_token|id_token|code|password|passwd|secret|key|otp|mfa|session|cookie)=)[^&\s]*/gi, '$1[redacted]');
	s = s.replace(/\b(otp|mfa|totp|2fa|one[-_ ]?time(?:[-_ ]?code)?|verification(?:[-_ ]?code)?|authenticator[-_ ]?code)\s*(?:is|:|=)?\s*["']?\d{4,10}["']?/ig, '$1 [redacted]');
	s = s.replace(/\b(password|passwd|pwd|secret|client[_-]?secret|token|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|jwt|credential|otp|mfa|totp|cookie|authorization)\s*[:=]\s*(?!\[redacted\])[^"',&\s;}{]+/ig, '$1=[redacted]');
	s = s.replace(/\b(?:token|access_token|id_token|password|passwd|secret|otp|mfa|cookie|authorization)=\S+/gi, (m) => {
		const i = m.indexOf('=');
		return `${m.slice(0, i + 1)}[redacted]`;
	});
	return s;
}

function deniedUrlAuditDetails(raw, detail = {}) {
	let parsed = null;
	try { parsed = new URL(String(raw || '').trim()); } catch {}
	return {
		denied: true,
		label: detail.label || '',
		path: detail.egressPath || detail.path || '',
		phase: detail.phase || '',
		subjectKind: detail.subjectKind || '',
		subjectName: detail.subjectName || '',
		tenantId: detail.tenantId || '',
		url: sanitizedUrl(raw),
		origin: parsed ? parsed.origin : '',
		scheme: parsed ? parsed.protocol : '',
		host: detail.host || (parsed ? normalizeHost(parsed.hostname) : ''),
		kind: detail.kind || '',
		profile: detail.profile || '',
		resolvedIps: Array.isArray(detail.resolvedIps) ? detail.resolvedIps.slice(0, 16) : [],
		connectionIps: Array.isArray(detail.connectionIps) ? detail.connectionIps.slice(0, 16) : [],
		address: detail.address || '',
	};
}

function entryLooksLikeUrlOrHost(entry) {
	const s = String(entry || '').trim();
	if (!s) return false;
	if (s.includes('://') || s.startsWith('*.') || s.includes('.') || s.includes(':')) return true;
	const h = normalizeHost(s);
	return h === 'localhost' || net.isIP(h) !== 0;
}

function parseAllowEntry(entry) {
	const raw = String(entry || '').trim();
	if (!raw || raw === '*') return null;
	if (raw.includes('://')) {
		try {
			const u = new URL(raw);
			if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
			if (u.hostname.startsWith('*.')) {
				return { kind: 'wildcard-origin', scheme: u.protocol, host: normalizeHost(u.hostname.slice(2)), port: u.port || '' };
			}
			return { kind: 'origin', scheme: u.protocol, host: normalizeHost(u.hostname), port: u.port || '' };
		} catch {
			return null;
		}
	}
	let s = raw;
	let scheme = '';
	const m = /^(https?:)\/\/(.+)$/i.exec(raw);
	if (m) {
		scheme = m[1].toLowerCase();
		s = m[2];
	}
	const wildcard = s.startsWith('*.');
	if (wildcard) s = s.slice(2);
	const hp = splitHostPort(s);
	const host = normalizeHost(hp.host);
	if (!host) return null;
	return { kind: wildcard ? 'wildcard-host' : 'host', scheme, host, port: hp.port || '' };
}

function parseAllowlist(values) {
	const out = [];
	for (const entry of csvList(values)) {
		const parsed = parseAllowEntry(entry);
		if (parsed) out.push(parsed);
	}
	return out;
}

function isParsedAllowEntry(entry) {
	return !!(entry && typeof entry === 'object' && typeof entry.host === 'string');
}

function normalizeAllowEntries(value) {
	if (value == null || value === '') return [];
	if (Array.isArray(value)) {
		const out = [];
		for (const item of value) {
			if (isParsedAllowEntry(item)) out.push(item);
			else out.push(...normalizeAllowEntries(item));
		}
		return out;
	}
	if (isParsedAllowEntry(value)) return [value];
	return parseAllowlist(value);
}

function allowEntryKey(entry) {
	if (!isParsedAllowEntry(entry)) return '';
	return [entry.kind || '', entry.scheme || '', entry.host || '', entry.port || ''].join('|');
}

function mergeAllowEntries(...values) {
	const out = [];
	const seen = new Set();
	for (const value of values) {
		for (const entry of normalizeAllowEntries(value)) {
			const key = allowEntryKey(entry);
			if (!key || seen.has(key)) continue;
			seen.add(key);
			out.push(entry);
		}
	}
	return out;
}

function describeAllowEntry(entry) {
	if (!isParsedAllowEntry(entry)) return '';
	const wildcard = entry.kind === 'wildcard-host' || entry.kind === 'wildcard-origin' ? '*.' : '';
	const scheme = entry.scheme || '*:';
	const port = entry.port ? `:${entry.port}` : '';
	return `${scheme}//${wildcard}${entry.host}${port}`;
}

function tenantIdFromValue(value) {
	return String(value == null ? '' : value).trim();
}

function parseAllowlistRegistry(values) {
	const registry = { configured: false, tenants: new Map(), invalid: [] };
	const addTenant = (tenant, allowlist) => {
		registry.configured = true;
		const tenantId = tenantIdFromValue(tenant);
		if (!tenantId) {
			registry.invalid.push('missing tenant id');
			return;
		}
		const entries = normalizeAllowEntries(allowlist);
		if (!entries.length) {
			registry.invalid.push(`tenant "${tenantId}" has no valid allowlist entries`);
			return;
		}
		registry.tenants.set(tenantId, mergeAllowEntries(registry.tenants.get(tenantId) || [], entries));
	};
	const visit = (value) => {
		if (value == null || value === '') return;
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (value instanceof Map) {
			registry.configured = true;
			for (const [tenant, allowlist] of value.entries()) addTenant(tenant, allowlist);
			return;
		}
		if (typeof value === 'object') {
			registry.configured = true;
			const tenant = value.tenantId ?? value.tenant ?? value.id;
			const allowlist = value.allowlist ?? value.allowedOrigins ?? value.origins ?? value.targets;
			if (tenant != null || allowlist != null) {
				addTenant(tenant, allowlist);
				return;
			}
			const nested = value.tenants ?? value.tenantAllowlists ?? value.allowlists ?? null;
			if (nested && typeof nested === 'object') {
				visit(nested);
				return;
			}
			for (const [tenantId, tenantAllowlist] of Object.entries(value)) addTenant(tenantId, tenantAllowlist);
			return;
		}
		const raw = String(value || '').trim();
		if (!raw) return;
		registry.configured = true;
		if (raw.startsWith('{') || raw.startsWith('[')) {
			try {
				visit(JSON.parse(raw));
				return;
			} catch {
				registry.invalid.push('invalid JSON allowlist registry');
				return;
			}
		}
		for (const item of semiList(raw)) {
			const i = item.indexOf('=');
			if (i <= 0) {
				registry.invalid.push(`invalid registry entry "${sanitizedAuditText(item)}"`);
				continue;
			}
			addTenant(item.slice(0, i), item.slice(i + 1));
		}
	};
	visit(values);
	return registry;
}

function allowlistRegistryForTenant(value, tenantId) {
	const registry = parseAllowlistRegistry(value);
	const id = tenantIdFromValue(tenantId);
	return {
		...registry,
		tenantId: id,
		entries: id ? (registry.tenants.get(id) || []) : [],
	};
}

function allowlistConflictsWithRegistry(entries, registryEntries) {
	if (!registryEntries || !registryEntries.length) return normalizeAllowEntries(entries);
	const registryKeys = new Set(normalizeAllowEntries(registryEntries).map(allowEntryKey));
	return normalizeAllowEntries(entries).filter((entry) => !registryKeys.has(allowEntryKey(entry)));
}

function hostMatchesWildcard(host, suffix) {
	return host === suffix || host.endsWith(`.${suffix}`);
}

function allowEntryMatchesUrl(entry, url) {
	if (!entry || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false;
	const host = normalizeHost(url.hostname);
	const port = url.port || '';
	if (entry.scheme && entry.scheme !== url.protocol) return false;
	if (entry.port && entry.port !== port) return false;
	if (entry.kind === 'origin') return entry.host === host && entry.scheme === url.protocol;
	if (entry.kind === 'wildcard-origin') return hostMatchesWildcard(host, entry.host) && entry.scheme === url.protocol;
	if (entry.kind === 'wildcard-host') return hostMatchesWildcard(host, entry.host);
	return entry.host === host;
}

function isAllowlisted(url, allowlist) {
	const entries = normalizeAllowEntries(allowlist);
	return entries.some((entry) => allowEntryMatchesUrl(entry, url));
}

function normalizePort(value) {
	const s = String(value == null ? '' : value).trim();
	if (!/^\d+$/.test(s)) return '';
	const n = Number(s);
	return Number.isInteger(n) && n > 0 && n <= 65535 ? String(n) : '';
}

function controlPlanePorts(opts = {}) {
	const env = opts.env || process.env;
	const ports = new Set();
	const add = (value) => {
		for (const item of csvList(value)) {
			const port = normalizePort(item);
			if (port) ports.add(port);
		}
	};
	add(opts.controlPlanePorts);
	add(env.AQA_CONTROL_PLANE_PORTS || env.WEBUI_CONTROL_PLANE_PORTS);
	add(env.WEBUI_PORT || '4310');
	add(env.NOVNC_PORT || env.WEBUI_NOVNC_PORT || '6080');
	add(env.VNC_PORT || '5900');
	return ports;
}

function controlPlaneOrigins(opts = {}) {
	const env = opts.env || process.env;
	return parseAllowlist([
		opts.controlPlaneOrigins,
		env.AQA_CONTROL_PLANE_ORIGINS,
		env.WEBUI_CONTROL_PLANE_ORIGINS,
		env.WEBUI_PUBLIC_ORIGIN,
		env.WEBUI_BASE_URL,
	]);
}

function isControlPlaneTarget(url, opts = {}) {
	if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false;
	if (isAllowlisted(url, controlPlaneOrigins(opts))) return true;
	const host = normalizeHost(url.hostname);
	const kind = hostKind(host);
	if (kind !== 'loopback' && kind !== 'unspecified') return false;
	const port = normalizePort(url.port || (url.protocol === 'https:' ? '443' : '80'));
	return !!port && controlPlanePorts(opts).has(port);
}

function collectAllowlist(subject, opts = {}) {
	const env = opts.env || process.env;
	const raw = [
		opts.allowlist,
		env.AQA_TARGET_ALLOWLIST,
		env.AQA_EGRESS_ALLOWLIST,
		env.WEBUI_TARGET_ALLOWLIST,
		subject?.egress?.allowlist,
		subject?.egress?.allowedOrigins,
		subject?.egressAllowlist,
		subject?.targetAllowlist,
		subject?.recipe?.egress?.allowlist,
		subject?.recipe?.egress?.allowedOrigins,
	];
	if (opts.includeLiveOriginAllowlist) {
		raw.push(csvList(env.AQA_LIVE_ALLOWLIST).filter(entryLooksLikeUrlOrHost));
	}
	return parseAllowlist(raw);
}

function collectOperatorAllowlist(opts = {}) {
	const env = opts.env || process.env;
	return parseAllowlist([
		opts.operatorAllowlist,
		env.AQA_TARGET_ALLOWLIST,
		env.AQA_EGRESS_ALLOWLIST,
		env.WEBUI_TARGET_ALLOWLIST,
	]);
}

function collectAllowlistRegistry(subject, opts = {}) {
	const env = opts.env || process.env;
	return [
		opts.allowlistRegistry,
		opts.targetAllowlistRegistry,
		env.AQA_TARGET_ALLOWLIST_REGISTRY,
		env.WEBUI_TARGET_ALLOWLIST_REGISTRY,
		subject?.egress?.allowlistRegistry,
		subject?.egress?.targetAllowlistRegistry,
		subject?.targetAllowlistRegistry,
		subject?.recipe?.egress?.allowlistRegistry,
		subject?.recipe?.egress?.targetAllowlistRegistry,
	].filter((value) => value != null && value !== '');
}

function tenantIdForSubject(subject, opts = {}) {
	const env = opts.env || process.env;
	return tenantIdFromValue(opts.tenantId
		|| subject?.tenantId
		|| subject?.tenant?.id
		|| subject?.actor?.tenantId
		|| env.AQA_TENANT_ID
		|| env.WEBUI_TENANT_ID);
}

function collectResolvedHosts(subject, opts = {}) {
	const env = opts.env || process.env;
	return [
		opts.resolvedHosts,
		opts.resolvedIps,
		opts.resolvedIpMap,
		env.AQA_EGRESS_RESOLVED_IPS,
		env.AQA_TARGET_RESOLVED_IPS,
		env.WEBUI_EGRESS_RESOLVED_IPS,
		subject?.egress?.resolvedHosts,
		subject?.egress?.resolvedIps,
		subject?.egress?.resolvedIpMap,
		subject?.recipe?.egress?.resolvedHosts,
		subject?.recipe?.egress?.resolvedIps,
		subject?.recipe?.egress?.resolvedIpMap,
	].filter((value) => value != null && value !== '');
}

function collectResolverEvidence(subject, opts = {}) {
	const env = opts.env || process.env;
	return [
		opts.resolverEvidence,
		opts.dnsEvidence,
		opts.resolvedEvidence,
		env.AQA_EGRESS_RESOLVER_EVIDENCE,
		env.AQA_EGRESS_DNS_EVIDENCE,
		env.WEBUI_EGRESS_RESOLVER_EVIDENCE,
		subject?.egress?.resolverEvidence,
		subject?.egress?.dnsEvidence,
		subject?.egress?.resolvedEvidence,
		subject?.recipe?.egress?.resolverEvidence,
		subject?.recipe?.egress?.dnsEvidence,
		subject?.recipe?.egress?.resolvedEvidence,
	].filter((value) => value != null && value !== '');
}

function collectConnectionEvidence(subject, opts = {}) {
	const env = opts.env || process.env;
	return [
		opts.connectionIps,
		opts.connectionIp,
		opts.connectedIps,
		opts.connectedIp,
		opts.connectionIpMap,
		opts.requestIpMap,
		env.AQA_EGRESS_CONNECTION_IPS,
		env.AQA_EGRESS_CONNECTION_IP_MAP,
		env.WEBUI_EGRESS_CONNECTION_IPS,
		subject?.egress?.connectionIps,
		subject?.egress?.connectionIpMap,
		subject?.egress?.requestIpMap,
		subject?.recipe?.egress?.connectionIps,
		subject?.recipe?.egress?.connectionIpMap,
		subject?.recipe?.egress?.requestIpMap,
	].filter((value) => value != null && value !== '');
}

function requireResolvedIps(subject, opts = {}) {
	const env = opts.env || process.env;
	if (opts.requireResolvedIps != null) return !!opts.requireResolvedIps;
	const explicit = subject?.egress?.requireResolvedIps ?? subject?.recipe?.egress?.requireResolvedIps;
	if (explicit != null) return !!explicit;
	return TRUE_RE.test(String(env.AQA_EGRESS_REQUIRE_RESOLVED_IPS || env.WEBUI_EGRESS_REQUIRE_RESOLVED_IPS || ''));
}

function requireFreshResolverEvidence(subject, opts = {}) {
	const env = opts.env || process.env;
	if (opts.requireFreshResolverEvidence != null) return !!opts.requireFreshResolverEvidence;
	if (opts.requireFreshDnsEvidence != null) return !!opts.requireFreshDnsEvidence;
	const explicit = subject?.egress?.requireFreshResolverEvidence ?? subject?.egress?.requireFreshDnsEvidence
		?? subject?.recipe?.egress?.requireFreshResolverEvidence ?? subject?.recipe?.egress?.requireFreshDnsEvidence;
	if (explicit != null) return !!explicit;
	return TRUE_RE.test(String(env.AQA_EGRESS_REQUIRE_FRESH_RESOLVER_EVIDENCE || env.AQA_EGRESS_REQUIRE_FRESH_DNS_EVIDENCE || env.WEBUI_EGRESS_REQUIRE_FRESH_RESOLVER_EVIDENCE || ''));
}

function requireConnectionIpEvidence(subject, opts = {}) {
	const env = opts.env || process.env;
	if (opts.requireConnectionIp != null) return !!opts.requireConnectionIp;
	if (opts.requireConnectionIpEvidence != null) return !!opts.requireConnectionIpEvidence;
	const explicit = subject?.egress?.requireConnectionIp ?? subject?.egress?.requireConnectionIpEvidence
		?? subject?.recipe?.egress?.requireConnectionIp ?? subject?.recipe?.egress?.requireConnectionIpEvidence;
	if (explicit != null) return !!explicit;
	return TRUE_RE.test(String(env.AQA_EGRESS_REQUIRE_CONNECTION_IP || env.AQA_EGRESS_REQUIRE_CONNECTION_IP_EVIDENCE || env.WEBUI_EGRESS_REQUIRE_CONNECTION_IP || ''));
}

function resolverEvidenceMaxAgeMs(subject, opts = {}) {
	const env = opts.env || process.env;
	const explicit = opts.resolverEvidenceMaxAgeMs ?? opts.dnsEvidenceMaxAgeMs
		?? subject?.egress?.resolverEvidenceMaxAgeMs ?? subject?.egress?.dnsEvidenceMaxAgeMs
		?? subject?.recipe?.egress?.resolverEvidenceMaxAgeMs ?? subject?.recipe?.egress?.dnsEvidenceMaxAgeMs
		?? env.AQA_EGRESS_RESOLVER_EVIDENCE_MAX_AGE_MS ?? env.AQA_EGRESS_DNS_EVIDENCE_MAX_AGE_MS
		?? env.WEBUI_EGRESS_RESOLVER_EVIDENCE_MAX_AGE_MS;
	return millisOption(explicit, DEFAULT_RESOLVER_EVIDENCE_MAX_AGE_MS);
}

function resolverEvidenceClockSkewMs(subject, opts = {}) {
	const env = opts.env || process.env;
	const explicit = opts.resolverEvidenceClockSkewMs ?? opts.dnsEvidenceClockSkewMs
		?? subject?.egress?.resolverEvidenceClockSkewMs ?? subject?.recipe?.egress?.resolverEvidenceClockSkewMs
		?? env.AQA_EGRESS_RESOLVER_EVIDENCE_CLOCK_SKEW_MS ?? env.WEBUI_EGRESS_RESOLVER_EVIDENCE_CLOCK_SKEW_MS;
	return millisOption(explicit, DEFAULT_RESOLVER_EVIDENCE_CLOCK_SKEW_MS);
}

function specialAllowed(kind, profile) {
	if (kind === 'metadata') return false;
	if (kind === 'loopback') return profile === 'local' || profile === 'on-prem';
	if (kind === 'private' || kind === 'private-name' || kind === 'link-local') return profile === 'on-prem';
	return false;
}

function specialDescription(kind) {
	if (kind === 'metadata') return 'cloud metadata endpoint';
	if (kind === 'loopback') return 'localhost/loopback address';
	if (kind === 'private') return 'private/RFC1918 address';
	if (kind === 'private-name') return 'local/private hostname';
	if (kind === 'link-local') return 'link-local address';
	if (kind === 'multicast') return 'multicast address';
	if (kind === 'unspecified') return 'unspecified address';
	return `${kind} address`;
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

function fail(label, reason, detail = {}) {
	return { ok: false, reason: `egress policy refused ${label}: ${sanitizedAuditText(reason)}`, ...detail };
}

function ok(detail = {}) {
	return { ok: true, ...detail };
}

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
	PROFILES,
	csvList,
	normalizeProfile,
	parseAllowlist,
	parseAllowlistRegistry,
	parseResolvedIpMap,
	parseResolverEvidenceMap,
	hostKind,
	sanitizedUrl,
	sanitizedAuditText,
	deniedUrlAuditDetails,
	validateResolvedIpPolicy,
	validateUrlEgress,
	validateFlowEgressPolicy,
	validateSystemEgressPolicy,
	flowEgressContext,
	systemEgressContext,
	createFlowEgressChecker,
	createSystemEgressChecker,
};
