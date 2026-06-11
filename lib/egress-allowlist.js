// lib/egress-allowlist.js - target allowlist parsing/matching and control-plane target detection.
// Pure CommonJS leaf: no Playwright import, no DNS/network lookup, no secret reads.
'use strict';

const net = require('node:net');
const {
	csvList,
	semiList,
	normalizeHost,
	splitHostPort,
	hostKind,
	sanitizedAuditText,
} = require('./egress-net.js');

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

function controlPlaneBindsAllInterfaces(opts = {}) {
	const env = opts.env || process.env;
	const h = normalizeHost(env.WEBUI_HOST || env.AQA_WEBUI_HOST || '');
	return h === '0.0.0.0' || h === '::';
}

function isControlPlaneTarget(url, opts = {}) {
	if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:')) return false;
	if (isAllowlisted(url, controlPlaneOrigins(opts))) return true;
	const host = normalizeHost(url.hostname);
	const kind = hostKind(host);
	// Loopback/unspecified always reach the control plane. When it binds all interfaces (Docker
	// WEBUI_HOST=0.0.0.0), it is also reachable on the host's own private/link-local IPs, so an
	// SSRF to those on a control-plane port targets our own service.
	const reachable = kind === 'loopback' || kind === 'unspecified'
		|| ((kind === 'private' || kind === 'link-local') && controlPlaneBindsAllInterfaces(opts));
	if (!reachable) return false;
	const port = normalizePort(url.port || (url.protocol === 'https:' ? '443' : '80'));
	return !!port && controlPlanePorts(opts).has(port);
}

module.exports = {
	entryLooksLikeUrlOrHost,
	parseAllowlist,
	normalizeAllowEntries,
	mergeAllowEntries,
	describeAllowEntry,
	tenantIdFromValue,
	parseAllowlistRegistry,
	allowlistRegistryForTenant,
	allowlistConflictsWithRegistry,
	isAllowlisted,
	isControlPlaneTarget,
};
