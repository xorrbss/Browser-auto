// lib/egress-net.js - egress scalar utilities, host normalization, IP classification, and audit sanitization.
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

// Parse any textual IPv6 form into its eight 16-bit groups, handling "::" compression and a
// trailing embedded IPv4 (e.g. ::ffff:1.2.3.4). Returns null for non-IPv6 input. Reducing the
// address to numeric groups makes classification independent of text representation, so a
// compressed, expanded, or mapped-hex form of the same address all classify identically.
function ipv6Groups(host) {
	const h = normalizeHost(host);
	if (net.isIP(h) !== 6) return null;
	let work = h;
	const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(work);
	if (v4) {
		const o = ipv4Octets(v4[1]);
		if (!o) return null;
		work = work.slice(0, v4.index) + (((o[0] << 8) | o[1]).toString(16)) + ':' + (((o[2] << 8) | o[3]).toString(16));
	}
	const hasGap = work.includes('::');
	let head, tail;
	if (hasGap) {
		const idx = work.indexOf('::');
		head = work.slice(0, idx) ? work.slice(0, idx).split(':') : [];
		tail = work.slice(idx + 2) ? work.slice(idx + 2).split(':') : [];
	} else {
		head = work.split(':');
		tail = [];
	}
	const fill = 8 - head.length - tail.length;
	if (hasGap ? fill < 0 : fill !== 0) return null;
	const parts = hasGap ? [...head, ...new Array(fill).fill('0'), ...tail] : head;
	if (parts.length !== 8) return null;
	const groups = parts.map((g) => parseInt(g || '0', 16));
	if (groups.some((n) => !Number.isFinite(n) || n < 0 || n > 0xffff)) return null;
	return groups;
}

function ipv6Canon(groups) {
	return groups.map((n) => n.toString(16)).join(':');
}

// Canonical-group forms of the IPv6 cloud-metadata endpoints, so any text representation matches.
const METADATA_V6_CANON = new Set(
	[...METADATA_HOSTS].filter((h) => net.isIP(h) === 6).map((h) => ipv6Canon(ipv6Groups(h))),
);

// IPv4-mapped (::ffff:0:0/96): classify by the embedded IPv4 address regardless of mapped form.
function ipv6MappedV4Kind(groups) {
	if (groups[0] || groups[1] || groups[2] || groups[3] || groups[4] || groups[5] !== 0xffff) return null;
	const dotted = `${(groups[6] >> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >> 8) & 0xff}.${groups[7] & 0xff}`;
	return ipv4Kind(dotted);
}

function ipv6Kind(host) {
	const g = ipv6Groups(host);
	if (!g) {
		const h = normalizeHost(host);
		return METADATA_HOSTS.has(h) ? 'metadata' : null;
	}
	const mapped = ipv6MappedV4Kind(g);
	if (mapped) return mapped;
	if (METADATA_V6_CANON.has(ipv6Canon(g))) return 'metadata';
	if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1) return 'loopback';
	if (g.every((n) => n === 0)) return 'unspecified';
	const n = g[0];
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
	s = s.replace(/\b(cookie|set-cookie)\s*:\s*(?!\[redacted\])(?:"[^"]*"|'[^']*'|[^,;\s]+)(?:[;,]\s*(?:"[^"]*"|'[^']*'|[^,;\s]+))*/ig, '$1: [redacted]');
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

function fail(label, reason, detail = {}) {
	return { ok: false, reason: `egress policy refused ${label}: ${sanitizedAuditText(reason)}`, ...detail };
}

function ok(detail = {}) {
	return { ok: true, ...detail };
}

module.exports = {
	PROFILES,
	ENFORCE_PHASES,
	URLISH_RE,
	TRUE_RE,
	DEFAULT_RESOLVER_EVIDENCE_MAX_AGE_MS,
	DEFAULT_RESOLVER_EVIDENCE_CLOCK_SKEW_MS,
	csvList,
	semiList,
	isExternalMode,
	normalizeProfile,
	millisOption,
	secondsToMillisOption,
	nowMs,
	parseTimestampMs,
	normalizeHost,
	splitHostPort,
	normalizeResolvedAddresses,
	normalizeHostList,
	hostKind,
	sanitizedUrl,
	sanitizedAuditText,
	deniedUrlAuditDetails,
	specialAllowed,
	specialDescription,
	fail,
	ok,
};
