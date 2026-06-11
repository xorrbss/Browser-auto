'use strict';

const dbm = require('./db.js');
const auditSink = require('./audit-sink.js');

const PLAINTEXT_SECRET_ENV_KEYS = Object.freeze([
	'WEBUI_AUDIT_SINK_TOKEN',
	'AQA_AUDIT_SINK_TOKEN',
	'WEBUI_AUDIT_OUTBOX_TOKEN',
	'AQA_AUDIT_OUTBOX_TOKEN',
	'WEBUI_AUDIT_SINK_SECRET',
	'AQA_AUDIT_SINK_SECRET',
]);

const TOKEN_REF_ENV_KEYS = Object.freeze([
	'WEBUI_AUDIT_SINK_TOKEN_REF',
	'AQA_AUDIT_SINK_TOKEN_REF',
	'WEBUI_AUDIT_OUTBOX_TOKEN_REF',
	'AQA_AUDIT_OUTBOX_TOKEN_REF',
]);

const SECRET_LIKE_REF_RE = /^(bearer\s+|basic\s+|eyJ[A-Za-z0-9_-]*\.|sk-|ghp_|glpat-|tok[_-])/i;
const SECRET_REF_RE = /^(aqa-secret:|kms:\/\/|vault:\/\/|secret:\/\/|aws-secretsmanager:|azure-keyvault:\/\/|gcp-secretmanager:\/\/)/i;

function _envValue(env, key) {
	return env && Object.prototype.hasOwnProperty.call(env, key) ? String(env[key] || '').trim() : '';
}

function _auditMode(env) {
	return String((env && (env.WEBUI_AUDIT_SINK || env.AQA_AUDIT_SINK)) || '').trim().toLowerCase();
}

function _tenantFromOptions(env = {}, tenantId = '') {
	return String(
		tenantId
		|| env.WEBUI_AUDIT_OUTBOX_TENANT_ID
		|| env.AQA_AUDIT_OUTBOX_TENANT_ID
		|| env.WEBUI_AUDIT_SINK_TENANT_ID
		|| env.AQA_AUDIT_SINK_TENANT_ID
		|| env.WEBUI_TENANT_ID
		|| env.AQA_TENANT_ID
		|| env.tenantId
		|| env.tenant_id
		|| '',
	).trim();
}

function assertAuditOutboxWorkerConfig({ env = process.env, validateAuditSinkConfig = auditSink.validateAuditSinkConfig, tenantId = '' } = {}) {
	const scopedTenantId = _tenantFromOptions(env, tenantId);
	for (const key of PLAINTEXT_SECRET_ENV_KEYS) {
		if (_envValue(env, key)) {
			throw new Error(`audit outbox drain worker refuses plaintext secret env ${key}; use a secret reference`);
		}
	}
	for (const key of TOKEN_REF_ENV_KEYS) {
		const value = _envValue(env, key);
		if (value && SECRET_LIKE_REF_RE.test(value)) {
			throw new Error(`audit outbox drain worker ${key} must be a secret reference, not plaintext credential material`);
		}
		if (value && !SECRET_REF_RE.test(value)) {
			throw new Error(`audit outbox drain worker ${key} must use a supported secret reference`);
		}
		if (value) auditSink.assertTenantScopedSecretRef(value, `audit outbox drain worker ${key}`, scopedTenantId);
	}
	const mode = _auditMode(env);
	if (mode && !new Set(['local', 'none', 'disabled']).has(mode)) {
		validateAuditSinkConfig(env);
	}
	return { ok: true, mode: mode || 'local', plaintextEnvRejected: true };
}

function normalizeNow(now = new Date()) {
	const value = typeof now === 'function' ? now() : now;
	const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
	if (!Number.isFinite(date.getTime())) throw new Error('audit outbox drain worker: invalid now');
	return date;
}

function deliveryErrorFromResult(result) {
	if (result === false || (result && result.ok === false)) {
		const err = new Error(String((result && (result.error || result.message)) || 'audit outbox connector refused delivery'));
		if (result && result.statusCode) err.statusCode = result.statusCode;
		if (result && result.status) err.status = result.status;
		if (result && result.code) err.code = result.code;
		return err;
	}
	return null;
}

function metadataOnlyTarget(target = {}) {
	return auditSink.auditSinkMetadataOnlyTarget(target);
}

function buildAuditOutboxEnvelope(rec) {
	if (!rec || rec.sinkMode !== 'webhook') {
		throw new Error('audit outbox drain worker can only build webhook connector envelopes');
	}
	const envelope = auditSink.auditOutboxConnectorEnvelope({
		...rec,
		target: metadataOnlyTarget(rec.target),
	});
	envelope.sink.target = metadataOnlyTarget(envelope.sink.target);
	envelope.payload = {
		hash: rec.payloadHash,
		bytes: rec.payloadBytes || 0,
		redacted: true,
		body: null,
	};
	return envelope;
}

function _connectorMissingError() {
	const err = new Error('audit outbox drain worker requires connector.deliverAuditOutbox(envelope)');
	err.code = 'AUDIT_SINK_CONNECTOR_REQUIRED';
	return err;
}

async function _deliverOne(db, rec, options, nowDate, nowIso) {
	const maxAttempts = Math.max(1, Math.trunc(Number(options.maxAttempts) || 5));
	if (rec.sinkMode !== 'webhook') {
		return { auditId: rec.auditId, sinkId: rec.sinkId, status: rec.status, skipped: true };
	}
	try {
		const connector = options.connector;
		if (!connector || typeof connector.deliverAuditOutbox !== 'function') throw _connectorMissingError();
		const envelope = buildAuditOutboxEnvelope(rec);
		const result = await connector.deliverAuditOutbox(envelope, {
			auditId: rec.auditId,
			outboxId: rec.id || null,
			sinkId: rec.sinkId,
			tenantId: rec.tenantId,
			now: nowIso,
		});
		const refused = deliveryErrorFromResult(result);
		if (refused) throw refused;
		const updated = dbm.markWebuiAuditOutboxDelivery(db, rec.auditId, rec.sinkId, {
			status: 'delivered',
			at: nowIso,
		});
		return {
			auditId: rec.auditId,
			sinkId: rec.sinkId,
			status: updated?.status || 'delivered',
			attempts: updated?.attempts || (rec.attempts || 0) + 1,
			delivered: true,
		};
	} catch (e) {
		const failure = auditSink.classifyAuditSinkDeliveryFailure(e);
		const nextAttempts = (rec.attempts || 0) + 1;
		const terminal = !failure.retryable || nextAttempts >= maxAttempts;
		const nextAttemptAt = terminal
			? null
			: new Date(nowDate.getTime() + auditSink.auditSinkBackoffMs(nextAttempts, options)).toISOString();
		const updated = dbm.markWebuiAuditOutboxDelivery(db, rec.auditId, rec.sinkId, {
			status: terminal ? 'dead-letter' : 'failed',
			at: nowIso,
			error: (e && e.message) || e,
			errorClass: failure.class,
			nextAttemptAt,
			deadLetterAt: terminal ? nowIso : null,
		});
		return {
			auditId: rec.auditId,
			sinkId: rec.sinkId,
			status: updated?.status || (terminal ? 'dead-letter' : 'failed'),
			attempts: updated?.attempts || nextAttempts,
			errorClass: failure.class,
			retryable: failure.retryable,
			nextAttemptAt: updated?.nextAttemptAt || nextAttemptAt,
			deadLetterAt: updated?.deadLetterAt || (terminal ? nowIso : null),
			deadLettered: terminal,
			failed: !terminal,
		};
	}
}

async function drainAuditOutbox(db, options = {}) {
	if (!db) throw new Error('audit outbox drain worker requires an open database handle');
	assertAuditOutboxWorkerConfig({
		env: options.env || process.env,
		validateAuditSinkConfig: options.validateAuditSinkConfig,
		tenantId: options.tenantId,
	});
	const nowDate = normalizeNow(options.now);
	const nowIso = nowDate.toISOString();
	const rows = dbm.listDueWebuiAuditOutbox(db, {
		tenantId: options.tenantId,
		now: nowIso,
		limit: options.limit,
	});
	const out = {
		ok: true,
		now: nowIso,
		checked: rows.length,
		delivered: 0,
		failed: 0,
		deadLettered: 0,
		skipped: 0,
		records: [],
	};
	for (const rec of rows) {
		const item = await _deliverOne(db, rec, options, nowDate, nowIso);
		if (item.delivered) out.delivered += 1;
		else if (item.deadLettered) out.deadLettered += 1;
		else if (item.failed) out.failed += 1;
		else if (item.skipped) out.skipped += 1;
		out.records.push(item);
	}
	out.ok = out.deadLettered === 0;
	return out;
}

function createAuditOutboxDrainWorker(options = {}) {
	return {
		runOnce(db, overrides = {}) {
			return drainAuditOutbox(db, { ...options, ...overrides });
		},
	};
}

module.exports = {
	assertAuditOutboxWorkerConfig,
	normalizeNow,
	deliveryErrorFromResult,
	metadataOnlyTarget,
	buildAuditOutboxEnvelope,
	drainAuditOutbox,
	drainAuditOutboxBatch: drainAuditOutbox,
	deliverAuditOutboxBatch: drainAuditOutbox,
	createAuditOutboxDrainWorker,
	createAuditOutboxDeliveryWorker: createAuditOutboxDrainWorker,
};
