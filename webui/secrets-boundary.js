// webui/secrets-boundary.js - secret-bearing path classification for artifact/static
// serving plus the export bundle secret-scan gate.

import fs from 'node:fs';
import path from 'node:path';

import { normalizePath, normalizedStatus, finding, cleanOptionalTenant } from './secrets-core.js';

const SECRET_COMPONENT_RE = /^(?:fixtures|auth|playwright|\.auth|\.git|node_modules|browser-profile|browser-profiles|profile|profiles|user-data-dir|runner-work|workdir|local storage|session storage)$/i;
const SECRET_PATH_RE = /(^|\/)(?:fixtures\/auth|approve\/[^/]+\.pw-state\.json|flows\/[^/]+\.values\.json|data(?:\/|$)|browser-profiles?(?:\/|$)|runner-work(?:\/|$)|user-data-dir(?:\/|$)|\.git(?:\/|$)|node_modules(?:\/|$))/i;
const SECRET_FILE_RE = /(?:^|\/)(?:[^/]*\.(?:state\.json|pw-state\.json|values\.json|db|sqlite|sqlite3|cookie|cookies|env)|\.env|cookies(?:\.json)?|storage-state\.json|storagestate\.json|login data|local state|webui-jobs\.jsonl|approve-audit\.jsonl|scheduler\.log)$/i;
const TEXT_ARTIFACT_RE = /\.(?:json|jsonl|xml|tsv|txt|log|csv)$/i;
const SAFE_REDACTION_STATES = new Set(['redacted', 'not-required', 'not_applicable', 'none', 'applied']);
const SAFE_SCAN_STATES = new Set(['clean', 'passed', 'complete', 'completed']);
const RAW_SECRET_TEXT_RE = [
	/\b(set-cookie|cookie)\s*:/i,
	/\bauthorization\s*:\s*(bearer|basic)\b/i,
	/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/i,
	/\b(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|password|passwd|pwd|secret|jwt|csrf[_-]?token|session[_-]?id)\s*[:=]\s*["']?[^"',&\s;}{]{4,}/i,
	/["'](?:access_token|refresh_token|id_token|token|cookie|password|secret)["']\s*:\s*["'][^"']{4,}["']/i,
];

function insideRoot(filePath, root) {
	const base = path.resolve(root);
	const full = path.resolve(filePath);
	const rel = path.relative(base, full);
	if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
	try {
		const realBase = fs.realpathSync.native(base);
		const realFull = fs.realpathSync.native(full);
		const realRel = path.relative(realBase, realFull);
		return !(realRel.startsWith('..') || path.isAbsolute(realRel));
	} catch {
		return true;
	}
}

export function classifySecretPath(value) {
	const p = normalizePath(value);
	if (!p) return { blocked: false, reason: '' };
	if (p.includes('\0')) return { blocked: true, reason: 'nul-byte' };
	if (SECRET_PATH_RE.test(p)) return { blocked: true, reason: 'secret-directory' };
	if (SECRET_FILE_RE.test(p)) return { blocked: true, reason: 'secret-file' };
	for (const part of p.split('/')) {
		if (SECRET_COMPONENT_RE.test(part)) return { blocked: true, reason: 'secret-component' };
	}
	return { blocked: false, reason: '' };
}

export function isSecretBearingPath(value) {
	return classifySecretPath(value).blocked;
}

export function staticFilePolicy(filePath, { root, artifact = false } = {}) {
	if (root && !insideRoot(filePath, root)) return { allowed: false, reason: 'path-escape', redact: false };
	const classified = classifySecretPath(root ? path.relative(root, filePath) : filePath);
	if (classified.blocked) return { allowed: false, reason: classified.reason, redact: false };
	return {
		allowed: true,
		reason: '',
		redact: artifact && TEXT_ARTIFACT_RE.test(String(filePath || '')),
	};
}

export function scanExportBundle(bundle = {}, opts = {}) {
	const entries = Array.isArray(bundle) ? bundle : Array.isArray(bundle?.files) ? bundle.files : Array.isArray(bundle?.entries) ? bundle.entries : [];
	const findings = [];
	if (!entries.length) {
		findings.push(finding('empty-bundle', '', 'export bundle has no declared files'));
	}
	for (const [index, entry] of entries.entries()) {
		const label = exportEntryLabel(entry, index);
		const pathValue = entry?.path || entry?.file || entry?.name || '';
		const classified = classifySecretPath(pathValue);
		if (classified.blocked) findings.push(finding(classified.reason, label, 'secret-bearing file path is blocked from export'));

		const redactionStatus = normalizedStatus(entry?.redactionStatus || entry?.redaction?.status || entry?.metadata?.redactionStatus);
		if (!SAFE_REDACTION_STATES.has(redactionStatus)) {
			findings.push(finding('unknown-redaction-status', label, 'export requires known redaction status'));
		}

		const scanStatus = normalizedStatus(entry?.scanStatus || entry?.secretScanStatus || entry?.scan?.status);
		if (!SAFE_SCAN_STATES.has(scanStatus)) {
			findings.push(finding('unknown-scan-status', label, 'export requires completed secret scan status'));
		}

		const text = exportEntryText(entry);
		if (text && RAW_SECRET_TEXT_RE.some((re) => re.test(text))) {
			findings.push(finding('raw-secret-pattern', label, 'raw cookie/token/credential pattern detected'));
		}
	}
	const allowed = findings.length === 0;
	return {
		ok: allowed,
		allowed,
		blocked: !allowed,
		decision: allowed ? 'allowed' : 'blocked',
		tenantId: cleanOptionalTenant(bundle?.tenantId || opts.tenantId),
		scanner: 'webui-secret-export-gate/v1',
		findings,
	};
}

export function assertExportBundleAllowed(bundle = {}, opts = {}) {
	const result = scanExportBundle(bundle, opts);
	if (!result.allowed) {
		const reasons = [...new Set(result.findings.map((f) => f.reason))].join(', ') || 'blocked';
		const err = new Error(`export bundle blocked: ${reasons}`);
		err.result = result;
		throw err;
	}
	return result;
}

function exportEntryLabel(entry, index) {
	const raw = String(entry?.path || entry?.file || entry?.name || `entry-${index + 1}`);
	return raw.replace(/\\/g, '/').split('/').filter(Boolean).slice(-3).join('/') || `entry-${index + 1}`;
}

function exportEntryText(entry) {
	const value = entry?.text ?? entry?.content ?? entry?.sample ?? '';
	if (Buffer.isBuffer(value)) return value.toString('utf8');
	if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
	return typeof value === 'string' ? value : '';
}
