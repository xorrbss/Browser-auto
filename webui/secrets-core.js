// webui/secrets-core.js - secret identifier constants, env/backend config helpers,
// the aqa-secret ref codec, and low-level shared helpers used by every secret module.

import fs from 'node:fs';
import path from 'node:path';

const TENANT_RE = /^[A-Za-z0-9_-]{1,80}$/;
const KIND_RE = /^(auth-state|flow-values|credential|cookie-jar|otp-seed|token|browser-profile)$/;
const NAME_RE = /^[A-Za-z0-9_.:-]{1,160}$/;
const SECRET_SCHEME = 'aqa-secret:';
export const TRUE_RE = /^(1|true|yes|on)$/i;
export const FALSE_RE = /^(0|false|no|off)$/i;
export const LOCAL_PILOT_BACKEND = 'local-pilot-file';
export const FORBIDDEN_PLAINTEXT_BACKEND = 'forbidden-plaintext';
export const ENCRYPTED_BACKEND = 'encrypted-local';
export const EXTERNAL_BROKER_BACKEND = 'external-broker';
export const DEFAULT_SECRET_STORE_DIR = path.join(path.resolve(import.meta.dirname, '..'), 'data', 'webui-secrets');
export const PROBE_ROOT = path.resolve(import.meta.dirname, '..');
export const RUNNER_SECRET_BROKER_PURPOSE = 'runner-secret-broker';

export function normalizePath(value) {
	return String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

export function cleanName(value, label) {
	const s = String(value || '').trim();
	if (!NAME_RE.test(s) || s.includes('..')) throw new Error(`invalid secret ${label}`);
	return s;
}

export function cleanTenant(value) {
	const s = String(value || 'local').trim() || 'local';
	if (!TENANT_RE.test(s)) throw new Error('invalid secret tenant');
	return s;
}

export function cleanKind(value) {
	const s = String(value || '').trim();
	if (!KIND_RE.test(s)) throw new Error('invalid secret kind');
	return s;
}

function envBool(env, ...names) {
	for (const name of names) {
		if (TRUE_RE.test(String(env?.[name] || ''))) return true;
	}
	return false;
}

export function envFlag(env, ...names) {
	for (const name of names) {
		const value = String(env?.[name] || '').trim();
		if (!value) continue;
		if (TRUE_RE.test(value)) return true;
		if (FALSE_RE.test(value)) return false;
	}
	return null;
}

export function envValue(env, ...names) {
	for (const name of names) {
		const value = String(env?.[name] || '').trim();
		if (value) return value;
	}
	return '';
}

export function externalMode(env = process.env) {
	return envBool(env, 'WEBUI_EXTERNAL_MODE', 'AQA_EXTERNAL_MODE');
}

export function normalizeBackend(value) {
	const raw = String(value || '').trim().toLowerCase();
	if (!raw) return '';
	if (raw === LOCAL_PILOT_BACKEND || raw === 'local-pilot' || raw === 'local') return LOCAL_PILOT_BACKEND;
	if (raw === FORBIDDEN_PLAINTEXT_BACKEND || raw === 'plaintext-forbidden') return FORBIDDEN_PLAINTEXT_BACKEND;
	if (raw === ENCRYPTED_BACKEND || raw === 'local-encrypted') return ENCRYPTED_BACKEND;
	if (raw === EXTERNAL_BROKER_BACKEND || raw === 'external-kms' || raw === 'broker-kms' || raw === 'kms' || raw === 'broker') return EXTERNAL_BROKER_BACKEND;
	return raw;
}

export function requestedSecretBackend(env = process.env) {
	const backend = normalizeBackend(envValue(env, 'WEBUI_SECRET_STORE_BACKEND', 'AQA_SECRET_STORE_BACKEND'));
	if (backend) return backend;
	if (envBool(env, 'WEBUI_ENCRYPTED_SECRET_STORE', 'AQA_ENCRYPTED_SECRET_STORE')) return ENCRYPTED_BACKEND;
	return '';
}

export function localPlaintextBypass(env = process.env) {
	return envBool(env, 'WEBUI_LOCAL_PILOT_PLAINTEXT_SECRETS', 'AQA_LOCAL_PILOT_PLAINTEXT_SECRETS');
}

export function configuredKeyMaterial(env = process.env, fallback = '') {
	return String(fallback || '').trim() || envValue(env, 'WEBUI_SECRET_STORE_KEY', 'AQA_SECRET_STORE_KEY');
}

export function secretStoreDir(env = process.env) {
	return envValue(env, 'WEBUI_SECRET_STORE_DIR', 'AQA_SECRET_STORE_DIR') || DEFAULT_SECRET_STORE_DIR;
}

export function makeSecretRef({ tenantId = 'local', kind, name }) {
	const tenant = cleanTenant(tenantId);
	const k = cleanKind(kind);
	const n = cleanName(name, 'name');
	return `${SECRET_SCHEME}//${tenant}/${k}/${encodeURIComponent(n)}`;
}

export function parseSecretRef(ref) {
	let u;
	try {
		u = new URL(String(ref || ''));
	} catch {
		return null;
	}
	if (u.protocol !== SECRET_SCHEME) return null;
	const tenantId = u.hostname;
	const parts = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
	if (parts.length !== 2) return null;
	const [kind, name] = parts;
	try {
		return {
			tenantId: cleanTenant(tenantId),
			kind: cleanKind(kind),
			name: cleanName(name, 'name'),
			ref: makeSecretRef({ tenantId, kind, name }),
		};
	} catch {
		return null;
	}
}

export function normalizeSecretKey(refOrKey, defaultTenant = 'local') {
	if (typeof refOrKey === 'string') {
		const parsed = parseSecretRef(refOrKey);
		if (!parsed) throw new Error('invalid secret ref');
		return { tenantId: parsed.tenantId, kind: parsed.kind, name: parsed.name };
	}
	return {
		tenantId: cleanTenant(refOrKey?.tenantId || defaultTenant),
		kind: cleanKind(refOrKey?.kind),
		name: cleanName(refOrKey?.name, 'name'),
	};
}

export function cleanOptionalTenant(value) {
	if (value == null || value === '') return null;
	try {
		return cleanTenant(value);
	} catch {
		return null;
	}
}

export function toBuffer(value) {
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof Uint8Array) return Buffer.from(value);
	return Buffer.from(String(value == null ? '' : value), 'utf8');
}

export function normalizedStatus(value) {
	return String(value || '').trim().toLowerCase();
}

export function finding(reason, entry, message) {
	return { reason, entry, message };
}

export function rawReadAllowed(opts = {}) {
	return opts?.purpose === RUNNER_SECRET_BROKER_PURPOSE;
}

export function cleanJsonObjectFields(values) {
	if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('invalid JSON secret fields');
	const out = {};
	for (const [key, value] of Object.entries(values)) {
		if (!key || key.length > 200 || key.includes('\0')) throw new Error('invalid JSON secret field');
		if (typeof value !== 'string') throw new Error('JSON secret field values must be strings');
		out[key] = value;
	}
	return out;
}

export function cleanMetadataText(value) {
	return String(value || '').replace(/[\r\n\t]/g, ' ').slice(0, 160);
}

export function safeNonNegativeNumber(value) {
	const n = Number(value || 0);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

export function safeStat(filePath) {
	try {
		return fs.statSync(filePath);
	} catch {
		return null;
	}
}

export function increment(target, key) {
	target[key] = (target[key] || 0) + 1;
}

export function uniqueCleanStrings(values) {
	return [...new Set((Array.isArray(values) ? values : []).map(cleanMetadataText).filter(Boolean))].sort();
}
