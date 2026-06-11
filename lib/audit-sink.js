'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DISABLED_MODES = new Set(['', 'none', 'disabled', 'local']);
const SECRET_REF_RE = /^(aqa-secret:|kms:\/\/|vault:\/\/|secret:\/\/|aws-secretsmanager:|azure-keyvault:\/\/|gcp-secretmanager:\/\/)/i;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/i;
const SAFE_TARGET_KEYS = new Set([
	'host',
	'origin',
	'urlHash',
	'pathHash',
	'pathConfigured',
	'credentialRefHash',
	'credentialRefConfigured',
	'connectorConfigured',
	'sinkRefHash',
	'sinkRefConfigured',
]);

function _modeFrom(env) {
	return String(env.WEBUI_AUDIT_SINK || env.AQA_AUDIT_SINK || 'local').trim().toLowerCase();
}

function _bool(value) {
	return /^(1|true|yes)$/i.test(String(value || '').trim());
}

function _sha256(value) {
	return `sha256:${crypto.createHash('sha256').update(String(value || '')).digest('hex')}`;
}

function _tenantFromEnv(env = {}) {
	for (const key of ['WEBUI_AUDIT_SINK_TENANT_ID', 'AQA_AUDIT_SINK_TENANT_ID', 'WEBUI_TENANT_ID', 'AQA_TENANT_ID', 'tenantId', 'tenant_id']) {
		const text = String(env[key] || '').trim();
		if (text) return text;
	}
	return '';
}

function _secretRefScope(ref) {
	const text = String(ref || '').trim();
	const match = text.match(/^([A-Za-z][A-Za-z0-9+.-]*:)(.*)$/);
	if (!match) return { tenantId: '', scoped: false };
	const scheme = match[1].toLowerCase();
	const rest = match[2] || '';
	if (rest.startsWith('//')) {
		try {
			const url = new URL(text);
			const pathSegments = url.pathname.split('/').filter(Boolean);
			return {
				tenantId: url.hostname || '',
				scoped: !!url.hostname && pathSegments.length > 0,
				scheme,
			};
		} catch {
			return { tenantId: '', scoped: false, scheme };
		}
	}
	const segments = rest.split('/').map((part) => part.trim()).filter(Boolean);
	return {
		tenantId: segments[0] || '',
		scoped: segments.length > 1,
		scheme,
	};
}

function assertTenantScopedSecretRef(ref, label, tenantId = '') {
	const scope = _secretRefScope(ref);
	if (!scope.scoped || !scope.tenantId) {
		throw new Error(`${label} must be a tenant-scoped secret reference`);
	}
	const expected = String(tenantId || '').trim();
	if (expected && scope.tenantId !== expected) {
		throw new Error(`${label} tenant scope does not match configured tenant`);
	}
	return { ok: true, tenantId: scope.tenantId };
}

function _statusCodeFrom(error) {
	const n = Number(error && (error.statusCode || error.status || error.httpStatus || error.code));
	return Number.isInteger(n) && n >= 100 && n <= 599 ? n : null;
}

function _redactMessage(value) {
	return String(value || '')
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
		.replace(/\b(password|passwd|pwd|otp|token|secret|api[-_\s]?key|authorization|cookie)\b\s*[:=]\s*([^\s,;]+)/gi, '$1=[redacted]')
		.replace(/(https?:\/\/[^\s?#]+)\?[^)\]\s"'<>]+/ig, '$1?[redacted]');
}

function classifyAuditSinkDeliveryFailure(error) {
	const code = String((error && error.code) || '').trim();
	const statusCode = _statusCodeFrom(error);
	if (code === 'AUDIT_SINK_CONNECTOR_REQUIRED') {
		return { class: 'connector-missing', retryable: true, statusCode: null, code };
	}
	if (statusCode === 401 || statusCode === 403) {
		return { class: 'auth', retryable: false, statusCode, code };
	}
	if (statusCode === 408 || statusCode === 425 || statusCode === 429) {
		return { class: 'throttle', retryable: true, statusCode, code };
	}
	if (statusCode >= 500) {
		return { class: 'server', retryable: true, statusCode, code };
	}
	if (statusCode >= 400) {
		return { class: 'client', retryable: false, statusCode, code };
	}
	if (/^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE)$/i.test(code)) {
		return { class: 'network', retryable: true, statusCode: null, code };
	}
	if (/timeout/i.test(String((error && error.message) || error || ''))) {
		return { class: 'timeout', retryable: true, statusCode: null, code };
	}
	return { class: 'unknown', retryable: true, statusCode, code };
}

function auditSinkBackoffMs(attempts, { baseDelayMs = 30000, maxDelayMs = 60 * 60 * 1000 } = {}) {
	const n = Math.max(1, Math.trunc(Number(attempts) || 1));
	const base = Math.max(1, Math.trunc(Number(baseDelayMs) || 30000));
	const max = Math.max(base, Math.trunc(Number(maxDelayMs) || 60 * 60 * 1000));
	return Math.min(max, base * (2 ** Math.min(n - 1, 12)));
}

function _cleanHost(value) {
	const host = String(value || '').trim().toLowerCase();
	if (!host || host.length > 255 || /[/?#@\\\s]/.test(host)) return null;
	return host;
}

function _cleanOrigin(value) {
	try {
		const url = new URL(String(value || '').trim());
		if (url.username || url.password || url.search || url.hash) return null;
		return url.origin;
	} catch {
		return null;
	}
}

function _metadataValue(key, value) {
	if (value == null) return undefined;
	if (/hash$/i.test(key)) {
		const hash = String(value || '').trim().toLowerCase();
		return SHA256_RE.test(hash) ? hash : undefined;
	}
	if (/configured$/i.test(key) || /present$/i.test(key)) return Boolean(value);
	if (key === 'host') return _cleanHost(value) || undefined;
	if (key === 'origin') return _cleanOrigin(value) || undefined;
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
	if (typeof value === 'boolean') return value;
	return undefined;
}

function auditSinkMetadataOnlyTarget(target = {}) {
	const raw = target && typeof target === 'object' && !Array.isArray(target) ? target : {};
	const out = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!SAFE_TARGET_KEYS.has(key) && !(/hash$/i.test(key) || /configured$/i.test(key) || /present$/i.test(key))) {
			continue;
		}
		const clean = _metadataValue(key, value);
		if (clean !== undefined) out[key] = clean;
	}
	return out;
}

function auditOutboxConnectorEnvelope(rec) {
	if (!rec || !rec.auditId || !rec.sinkId || !rec.payloadHash) {
		throw new Error('audit outbox connector envelope requires auditId, sinkId, and payloadHash');
	}
	return {
		schemaVersion: 1,
		kind: 'webui-audit-outbox',
		auditId: rec.auditId,
		outboxId: rec.id || null,
		at: rec.at || null,
		tenantId: rec.tenantId || 'local',
		jobId: rec.jobId || null,
		sink: {
			mode: rec.sinkMode || 'webhook',
			id: rec.sinkId,
			target: auditSinkMetadataOnlyTarget(rec.target),
		},
		payload: {
			hash: rec.payloadHash,
			bytes: rec.payloadBytes || 0,
			redacted: true,
			body: null,
		},
		delivery: {
			attempts: rec.attempts || 0,
			nextAttemptAt: rec.nextAttemptAt || null,
			lastAttemptAt: rec.lastAttemptAt || null,
			lastErrorClass: rec.lastErrorClass || null,
		},
	};
}

function _cleanSinkPath(value) {
	const p = String(value || '').trim();
	if (!p) throw new Error('audit sink jsonl requires WEBUI_AUDIT_SINK_PATH');
	if (p.includes('\0')) throw new Error('audit sink path is invalid');
	if (/(^|[\\/])(fixtures[\\/]auth|flows[\\/][^\\/]+\.values\.json|data[\\/].*\.(db|sqlite|sqlite3)|\.git)([\\/]|$)/i.test(p)) {
		throw new Error('audit sink path must not target secret-bearing storage');
	}
	return path.resolve(p);
}

function _cleanRef(value, label, tenantId = '') {
	const ref = String(value || '').trim();
	if (!ref) throw new Error(`audit sink webhook requires ${label}`);
	if (ref.includes('\0') || ref.length > 512) throw new Error(`audit sink webhook ${label} is invalid`);
	if (/^(bearer\s+|basic\s+|eyJ[A-Za-z0-9_-]*\.|sk-|ghp_|glpat-)/i.test(ref)) {
		throw new Error(`audit sink webhook ${label} must be a secret reference, not a plaintext token`);
	}
	if (!SECRET_REF_RE.test(ref)) {
		throw new Error(`audit sink webhook ${label} must use a supported secret reference`);
	}
	assertTenantScopedSecretRef(ref, `audit sink webhook ${label}`, tenantId);
	return ref;
}

function validateAuditSinkConfig(env = process.env) {
	const mode = _modeFrom(env);
	if (DISABLED_MODES.has(mode)) {
		return { enabled: false, mode: 'local', required: _bool(env.WEBUI_AUDIT_SINK_REQUIRED || env.AQA_AUDIT_SINK_REQUIRED) };
	}
	if (mode === 'jsonl') {
		return {
			enabled: true,
			mode,
			required: true,
			path: _cleanSinkPath(env.WEBUI_AUDIT_SINK_PATH || env.AQA_AUDIT_SINK_PATH),
		};
	}
	if (mode === 'webhook') {
		const rawUrl = String(env.WEBUI_AUDIT_SINK_URL || env.AQA_AUDIT_SINK_URL || '').trim();
		if (!rawUrl) throw new Error('audit sink webhook requires WEBUI_AUDIT_SINK_URL');
		const url = new URL(rawUrl);
		if (url.protocol !== 'https:') throw new Error('audit sink webhook URL must use https');
		if (url.username || url.password) throw new Error('audit sink webhook URL must not contain credentials');
		if (url.search || url.hash) throw new Error('audit sink webhook URL must not contain query or fragment secrets');
		const tokenRef = _cleanRef(env.WEBUI_AUDIT_SINK_TOKEN_REF || env.AQA_AUDIT_SINK_TOKEN_REF, 'WEBUI_AUDIT_SINK_TOKEN_REF', _tenantFromEnv(env));
		if (env.WEBUI_AUDIT_SINK_TOKEN || env.AQA_AUDIT_SINK_TOKEN) {
			throw new Error('audit sink webhook token must be referenced, not stored in plaintext env');
		}
		const connectorRef = String(env.WEBUI_AUDIT_SINK_CONNECTOR || env.AQA_AUDIT_SINK_CONNECTOR || '').trim();
		if (connectorRef && (connectorRef.includes('\0') || connectorRef.length > 240)) {
			throw new Error('audit sink webhook connector reference is invalid');
		}
		return { enabled: true, mode, required: true, url: url.toString(), tokenRef, connectorRef: connectorRef || null };
	}
	throw new Error(`unsupported audit sink mode: ${mode}`);
}

function auditSinkPublicConfig(env = process.env) {
	const cfg = validateAuditSinkConfig(env);
	if (cfg.mode === 'jsonl') return { enabled: cfg.enabled, mode: cfg.mode, required: cfg.required, pathConfigured: true };
	if (cfg.mode === 'webhook') {
		return {
			enabled: true,
			mode: cfg.mode,
			required: true,
			url: cfg.url,
			tokenRefConfigured: true,
			connectorConfigured: !!cfg.connectorRef,
			outbox: 'pending-until-delivered',
		};
	}
	return cfg;
}

function auditSinkDeploymentReadiness(env = process.env, { production = false } = {}) {
	let cfg;
	try {
		cfg = validateAuditSinkConfig(env);
	} catch (e) {
		return {
			schemaVersion: 1,
			ok: false,
			productionReady: false,
			mode: 'invalid',
			enabled: false,
			connectorRequired: true,
			connectorConfigured: false,
			releaseBlockers: ['audit sink configuration is invalid'],
			error: _redactMessage((e && e.message) || e),
		};
	}
	const out = {
		schemaVersion: 1,
		ok: true,
		productionReady: false,
		mode: cfg.mode,
		enabled: !!cfg.enabled,
		connectorRequired: cfg.mode === 'webhook',
		connectorConfigured: !!cfg.connectorRef,
		deliveryContract: cfg.mode === 'webhook' ? 'outbox-pending-until-connector-delivers' : 'local-only',
		releaseBlockers: [],
	};
	if (cfg.mode === 'webhook') {
		out.productionReady = !!cfg.connectorRef;
		if (!cfg.connectorRef) out.releaseBlockers.push('production audit webhook connector is not configured');
	} else if (production) {
		out.releaseBlockers.push('production audit webhook sink is not enabled');
	}
	out.ok = out.releaseBlockers.length === 0;
	return out;
}

function auditSinkDeliveryMetadata(event, env = process.env) {
	const cfg = validateAuditSinkConfig(env);
	const payload = JSON.stringify(event || {});
	if (!cfg.enabled) {
		return {
			enabled: false,
			mode: cfg.mode,
			status: 'skipped',
			payloadHash: _sha256(payload),
			payloadBytes: Buffer.byteLength(payload),
		};
	}
	if (cfg.mode === 'jsonl') {
		return {
			enabled: true,
			mode: cfg.mode,
			status: 'delivered',
			sinkId: `jsonl:${_sha256(cfg.path)}`,
			target: { pathHash: _sha256(cfg.path), pathConfigured: true },
			payloadHash: _sha256(payload),
			payloadBytes: Buffer.byteLength(payload),
			connectorConfigured: true,
		};
	}
	if (cfg.mode === 'webhook') {
		const url = new URL(cfg.url);
		return {
			enabled: true,
			mode: cfg.mode,
			status: 'pending',
			sinkId: `webhook:${_sha256(cfg.url)}`,
			target: {
				urlHash: _sha256(cfg.url),
				origin: url.origin,
				host: url.host,
				credentialRefHash: _sha256(cfg.tokenRef),
				credentialRefConfigured: true,
				connectorConfigured: !!cfg.connectorRef,
			},
			payloadHash: _sha256(payload),
			payloadBytes: Buffer.byteLength(payload),
			connectorConfigured: !!cfg.connectorRef,
		};
	}
	return {
		enabled: true,
		mode: cfg.mode,
		status: 'pending',
		payloadHash: _sha256(payload),
		payloadBytes: Buffer.byteLength(payload),
	};
}

function writeAuditSinkEvent(event, env = process.env, connector = null) {
	const cfg = validateAuditSinkConfig(env);
	if (!cfg.enabled) return { ok: true, skipped: true, mode: cfg.mode };
	const rec = {
		schemaVersion: 1,
		exportedAt: new Date().toISOString(),
		...event,
	};
	if (cfg.mode === 'jsonl') {
		fs.mkdirSync(path.dirname(cfg.path), { recursive: true });
		fs.appendFileSync(cfg.path, JSON.stringify(rec) + '\n', { mode: 0o600 });
		return { ok: true, mode: cfg.mode };
	}
	if (cfg.mode === 'webhook') {
		if (!connector || typeof connector.deliverAuditEvent !== 'function') {
			const err = new Error('audit sink webhook delivery requires a production connector');
			err.code = 'AUDIT_SINK_CONNECTOR_REQUIRED';
			err.delivery = auditSinkDeliveryMetadata(event, env);
			throw err;
		}
		return connector.deliverAuditEvent({ url: cfg.url, tokenRef: cfg.tokenRef, event: rec });
	}
	throw new Error(`unsupported audit sink mode: ${cfg.mode}`);
}

module.exports = {
	validateAuditSinkConfig,
	auditSinkPublicConfig,
	auditSinkDeploymentReadiness,
	auditSinkDeliveryMetadata,
	writeAuditSinkEvent,
	classifyAuditSinkDeliveryFailure,
	auditSinkBackoffMs,
	auditOutboxConnectorEnvelope,
	auditSinkMetadataOnlyTarget,
	assertTenantScopedSecretRef,
};
