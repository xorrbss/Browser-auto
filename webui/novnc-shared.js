// webui/novnc-shared.js - shared noVNC constants, string/env helpers, and time/path/id utilities.
//
// Leaf module of the noVNC split; hosts the single rbac bridge for all noVNC modules.

import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const rbac = require('../lib/rbac.js');

export const TENANT_RE = /^[A-Za-z0-9_-]{1,80}$/;
export const ACTOR_RE = /^[A-Za-z0-9_.@-]{1,120}$/;
const ID_RE = /^[A-Za-z0-9_.:-]{1,160}$/;
const PATH_COMPONENT_RE = /^[A-Za-z0-9_-]{1,120}$/;
export const DEFAULT_SESSION_TTL_MS = 15 * 60 * 1000;
export const DEFAULT_IDLE_TIMEOUT_MS = 0;
export const DEFAULT_BROWSER_ROOT = path.resolve(import.meta.dirname, '..', 'data', 'browser-sessions');
export const TEARDOWN_STATES = new Set(['not-required', 'pending', 'complete', 'failed']);
export const TEARDOWN_REASON_RE = /^[A-Za-z0-9_.:-]{0,80}$/;
export const TEARDOWN_MANIFEST_KIND = 'aqa.novnc-teardown-manifest';
export const ISOLATION_MANIFEST_KIND = 'aqa.novnc-isolation-preflight';
const PRODUCTION_MODE_RE = /^(external|service|prod|production)$/i;
export const TERMINAL_TEARDOWN_REASONS = new Set(['cancel', 'timeout', 'job-complete', 'close', 'server-shutdown', 'server-restart', 'restart', 'reconcile', 'interrupted']);
export const BROWSER_ISOLATION = Object.freeze({
	scope: 'tenant-job-session',
	profile: 'scoped',
	downloads: 'scoped',
	screenshots: 'scoped',
	video: 'scoped',
	storageState: 'scoped',
	pathsExposed: false,
});

export function cleanString(value) {
	return typeof value === 'string' ? value.trim() : '';
}

export function lower(value) {
	return cleanString(value).toLowerCase();
}

export function bool(value) {
	return value === true || value === 1 || /^(1|true|yes|on)$/i.test(String(value || ''));
}

export function envBoolAny(env, names) {
	return names.some((name) => bool(env?.[name]));
}

export function envModeAny(env, names) {
	return names.some((name) => PRODUCTION_MODE_RE.test(cleanString(env?.[name])));
}

export function nowMs(value) {
	if (typeof value === 'function') return Number(value());
	if (value != null) return Number(value);
	return Date.now();
}

export function toTimeMs(value, fallback, label) {
	if (value == null || value === '') return fallback;
	if (value instanceof Date) {
		const t = value.getTime();
		if (Number.isFinite(t)) return t;
	}
	if (typeof value === 'number') {
		if (Number.isFinite(value)) return value;
	}
	if (typeof value === 'string') {
		const n = Number(value);
		if (Number.isFinite(n) && /^\d+$/.test(value.trim())) return n;
		const t = Date.parse(value);
		if (Number.isFinite(t)) return t;
	}
	throw new Error(`${label} must be a finite epoch ms value or ISO timestamp`);
}

export function toDurationMs(value, fallback, label) {
	if (value == null || value === '') return fallback;
	if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
	if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value);
	throw new Error(`${label} must be a non-negative finite millisecond duration`);
}

export function iso(ms) {
	return new Date(ms).toISOString();
}

export function manifestHash(manifest) {
	const copy = { ...manifest };
	delete copy.manifestHash;
	return `sha256:${crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex')}`;
}

export function pathKey(value) {
	const resolved = path.resolve(String(value || ''));
	const trimmed = resolved.replace(/[\\/]+$/, '');
	return process.platform === 'win32' ? trimmed.toLowerCase() : trimmed;
}

export function isInsidePath(parent, candidate) {
	const rel = path.relative(parent, candidate);
	return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

export function optionalPath(input, keys) {
	for (const key of keys) {
		const value = cleanString(input?.[key]);
		if (value) return value;
	}
	const paths = input?.paths && typeof input.paths === 'object' ? input.paths : {};
	for (const key of keys) {
		const value = cleanString(paths?.[key]);
		if (value) return value;
	}
	return '';
}

export function requireId(label, value, re = ID_RE) {
	const text = cleanString(value);
	if (!text || !re.test(text)) throw new Error(`${label} is required and must match ${re}`);
	return text;
}

export function requirePathComponent(label, value) {
	return requireId(label, value, PATH_COMPONENT_RE);
}

export function ensureInside(root, candidate, label) {
	const rel = path.relative(root, candidate);
	if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return candidate;
	throw new Error(`${label} must stay inside ${root}`);
}

export function ensureUnderSession(sessionRoot, candidate, label) {
	const rel = path.relative(sessionRoot, candidate);
	if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return candidate;
	throw new Error(`${label} must be tenant/job/session scoped under ${sessionRoot}`);
}

export function generateNoVncSessionId({ randomBytes = crypto.randomBytes } = {}) {
	const bytes = randomBytes(24);
	const token = Buffer.from(bytes).toString('base64url');
	return `nv_${token}`;
}
