// webui/secret-migration-api.js - route-independent metadata-only secret migration API helper.
//
// This module intentionally has no server dependency. It accepts request-like
// objects and returns JSON-ready response envelopes so webui/server.js can wire
// it later without changing the workflow contract. The fake broker below is
// metadata-only: it satisfies the external broker method surface, but any byte
// accessor or mutating secret method records the call and throws.

import crypto from 'node:crypto';
import {
	advanceSecretMigrationWorkflow,
	createSecretMigrationWorkflow,
} from './secret-migration.js';
import {
	createSecretStore,
	makeSecretRef,
	parseSecretRef,
} from './secrets.js';

const API_CONTRACT = 'webui-secret-migration-api/v1';
const BROKER_CONTRACT_VERSION = 1;
const TENANT_RE = /^[A-Za-z0-9_-]{1,80}$/;
const SAFE_TOKEN_RE = /[^A-Za-z0-9_.:-]/g;
const SAFE_TEXT_RE = /[^A-Za-z0-9_.:/@* -]/g;
const ROUTE_RE = /^\/api\/secret-migration(?:\/([^/?#]+))?\/?$/;
const ROUTELESS_ACTIONS = new Set(['dry-run', 'plan', 'approve', 'stage', 'commit', 'rollback', 'status']);
const MUTATING_ACTIONS = new Set(['plan', 'approve', 'stage', 'commit', 'rollback']);
const SECRET_METHODS = [
	'getBytes',
	'getJson',
	'putBytes',
	'putJsonObjectFields',
	'rotate',
	'delete',
];
const METADATA_ONLY_FLAGS = {
	failClosed: true,
	sanitized: true,
	metadataOnly: true,
	secretContentsInspected: false,
	readsSecretBytes: false,
	writesSecretBytes: false,
	deletesPlaintext: false,
	migratesSecrets: false,
	sideEffects: false,
	secretByteAccessorCalled: false,
};

export function createSecretMigrationApi(opts = {}) {
	const state = opts.state || new Map();
	const idempotencyStore = opts.idempotencyStore || new Map();
	return {
		async handle(request = {}) {
			return handleSecretMigrationApi(request, { ...opts, state, idempotencyStore });
		},
		status(tenantId = 'local') {
			const tenant = cleanTenant(tenantId) || 'local';
			return statusBody(tenantRecord(state, tenant), { tenantId: tenant });
		},
		state,
		idempotencyStore,
	};
}

export async function handleSecretMigrationApi(request = {}, opts = {}) {
	const state = opts.state || new Map();
	const idempotencyStore = opts.idempotencyStore || new Map();
	const parsed = parseRequest(request);
	const bodyResult = normalizeBody(request);
	if (!bodyResult.ok) {
		return jsonResponse(400, failureBody({
			action: parsed.action || 'unknown',
			tenantId: 'local',
			reason: 'invalid-json-body',
			message: 'secret migration API requires a JSON object body',
		}));
	}
	const body = bodyResult.body;
	const action = normalizeAction(parsed.action || body.action);
	if (!action || !ROUTELESS_ACTIONS.has(action)) {
		return jsonResponse(parsed.handled ? 404 : 404, failureBody({
			action: action || 'unknown',
			tenantId: 'local',
			reason: parsed.handled ? 'unknown-secret-migration-action' : 'not-secret-migration-route',
			message: parsed.handled ? 'secret migration API action is not supported' : 'request is not a secret migration API route',
		}), { handled: parsed.handled });
	}
	if (!parsed.handled && !body.action) {
		return jsonResponse(404, failureBody({
			action,
			tenantId: 'local',
			reason: 'not-secret-migration-route',
			message: 'request is not a secret migration API route',
		}), { handled: false });
	}

	const tenantResult = resolveTenant({ body, context: request.context, url: parsed.url, opts });
	const tenantId = tenantResult.tenantId || 'local';
	if (!tenantResult.ok) {
		return jsonResponse(400, failureBody({
			action,
			tenantId,
			reason: tenantResult.reason,
			message: tenantResult.message,
		}));
	}

	if (action === 'status') {
		if (!['GET', 'POST'].includes(parsed.method)) {
			return methodNotAllowed(action, tenantId);
		}
		return jsonResponse(200, statusBody(tenantRecord(state, tenantId), { tenantId }));
	}
	if (parsed.method !== 'POST') {
		return methodNotAllowed(action, tenantId);
	}

	const idempotency = resolveIdempotency(request, body, { action, tenantId });
	if (MUTATING_ACTIONS.has(action) && !idempotency.key) {
		return jsonResponse(428, failureBody({
			action,
			tenantId,
			reason: 'missing-idempotency-key',
			message: 'secret migration mutations require an idempotency key',
			idempotency,
		}));
	}
	const replay = idempotencyLookup(idempotencyStore, idempotency);
	if (replay.conflict) {
		return jsonResponse(409, failureBody({
			action,
			tenantId,
			reason: 'idempotency-key-conflict',
			message: 'idempotency key was already used for a different secret migration request',
			idempotency: { ...idempotency, conflict: true },
		}));
	}
	if (replay.response) {
		const replayBody = cloneJson(replay.response.body);
		replayBody.idempotency = { ...(replayBody.idempotency || {}), replay: true };
		return jsonResponse(replay.response.status, replayBody);
	}

	const result = await executeAction(action, body, { tenantId, state, opts });
	result.body.idempotency = { ...(result.body.idempotency || {}), ...idempotency, replay: false };
	if (idempotency.key) {
		idempotencyStore.set(idempotency.scope, {
			fingerprint: idempotency.fingerprint,
			response: cloneJson(result),
		});
	}
	return result;
}

export function createMetadataOnlySecretBrokerAdapter(opts = {}) {
	const tenantId = cleanTenant(opts.tenantId) || 'local';
	const keyId = cleanToken(opts.keyId || opts.kmsKeyId || 'metadata-only-kms-key');
	const provider = cleanToken(opts.provider || 'metadata-only-fake-broker');
	const connectorId = cleanToken(opts.connectorId || 'metadata-only-fake-secret-broker');
	const calls = Object.fromEntries([
		'describeConnector',
		'describeSecret',
		'list',
		'describeJsonObjectKeys',
		...SECRET_METHODS,
	].map((name) => [name, 0]));
	const records = new Map();

	for (const ref of normalizeSecretRefs(opts.secretRefs || opts.requiredSecretRefs || [], tenantId)) {
		setMetadataRecord(records, ref, { tenantId, keyId });
	}
	for (const meta of Array.isArray(opts.metadata || opts.brokerMetadata || opts.secretMetadata) ? (opts.metadata || opts.brokerMetadata || opts.secretMetadata) : []) {
		const ref = metadataRef(meta, tenantId);
		if (ref) setMetadataRecord(records, ref, { ...meta, tenantId, keyId });
	}

	const connector = {
		contractVersion: BROKER_CONTRACT_VERSION,
		provider,
		connectorId,
		kmsKeyId: keyId,
		tenantScoped: opts.tenantScoped !== false,
		encryptedAtRest: opts.encryptedAtRest !== false,
		rotationSupported: opts.rotationSupported !== false,
		deleteSupported: opts.deleteSupported !== false,
		testOnly: false,
		productionReady: opts.productionReady !== false,
		metadataOnly: true,
	};
	const broker = {
		connector,
		describeConnector() {
			calls.describeConnector += 1;
			return { ...connector };
		},
		async describeSecret(refOrKey) {
			calls.describeSecret += 1;
			const ref = metadataRef(refOrKey, tenantId);
			return records.get(ref) || missingMetadata(refOrKey, { tenantId, keyId });
		},
		async list({ tenantId: requestedTenant = tenantId, kind = '' } = {}) {
			calls.list += 1;
			const tenant = cleanTenant(requestedTenant) || tenantId;
			const cleanKind = cleanToken(kind);
			return [...records.values()]
				.filter((entry) => entry.tenantId === tenant && (!cleanKind || entry.kind === cleanKind))
				.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
		},
		async describeJsonObjectKeys(refOrKey) {
			calls.describeJsonObjectKeys += 1;
			const ref = metadataRef(refOrKey, tenantId);
			const meta = records.get(ref) || missingMetadata(refOrKey, { tenantId, keyId });
			return { ...meta, jsonObjectKeys: [], keyCount: 0, parseStatus: meta.present ? 'metadata-only' : 'missing' };
		},
		async getBytes() {
			calls.getBytes += 1;
			throw new Error('metadata-only secret broker must not read secret bytes');
		},
		async getJson() {
			calls.getJson += 1;
			throw new Error('metadata-only secret broker must not read secret JSON');
		},
		async putBytes() {
			calls.putBytes += 1;
			throw new Error('metadata-only secret broker must not write secret bytes');
		},
		async putJsonObjectFields() {
			calls.putJsonObjectFields += 1;
			throw new Error('metadata-only secret broker must not write secret JSON');
		},
		async rotate() {
			calls.rotate += 1;
			throw new Error('metadata-only secret broker must not rotate secret bytes');
		},
		async delete() {
			calls.delete += 1;
			throw new Error('metadata-only secret broker must not delete secrets');
		},
	};
	return {
		broker,
		calls,
		metadataOnly: true,
		secretByteAccessorCalled() {
			return SECRET_METHODS.some((name) => calls[name] > 0);
		},
		summary() {
			return {
				provider,
				connectorId,
				metadataOnly: true,
				recordCount: records.size,
				describeSecretCalls: calls.describeSecret,
				secretByteAccessorCalls: SECRET_METHODS.reduce((total, name) => total + calls[name], 0),
			};
		},
	};
}

async function executeAction(action, body, { tenantId, state, opts }) {
	const record = tenantRecord(state, tenantId);
	const requiredSecretRefs = normalizeSecretRefs(
		body.requiredSecretRefs || body.secretRefs || record.requiredSecretRefs || [],
		tenantId,
	);

	if (action === 'dry-run' || action === 'plan') {
		const workflow = createSecretMigrationWorkflow({
			tenantId,
			plan: body.plan,
			requiredSecretRefs,
		});
		if (action === 'plan' && !workflow.blocked) {
			record.workflow = workflow;
			record.plan = workflow.plan;
			record.requiredSecretRefs = requiredSecretRefs;
			record.approvalManifest = null;
			record.rollbackEvidence = null;
			record.brokerMetadata = normalizeBrokerMetadata(body.brokerMetadata || body.secretMetadata || [], tenantId);
			record.updatedAt = nowIso(opts);
		}
		return workflowResult(action, workflow, { tenantId, persisted: action === 'plan' && !workflow.blocked });
	}

	if (!record.workflow) {
		return jsonResponse(409, failureBody({
			action,
			tenantId,
			reason: 'secret-migration-plan-required',
			message: 'secret migration workflow must be planned before this action',
		}));
	}

	if (action === 'approve') {
		const approvalManifest = body.operatorApprovalManifest || body.approvalManifest || body.manifest;
		const workflow = await advanceSecretMigrationWorkflow(record.workflow, {
			action: 'approve',
			tenantId,
			plan: record.plan,
			requiredSecretRefs,
			approvalManifest,
		});
		if (!workflow.blocked) {
			record.workflow = workflow;
			record.approvalManifest = approvalManifest;
			record.requiredSecretRefs = requiredSecretRefs;
			record.updatedAt = nowIso(opts);
		}
		return workflowResult(action, workflow, { tenantId, persisted: !workflow.blocked });
	}

	if (action === 'stage') {
		const approvalManifest = body.operatorApprovalManifest || body.approvalManifest || body.manifest || record.approvalManifest;
		const adapter = createMetadataOnlySecretBrokerAdapter({
			tenantId,
			secretRefs: requiredSecretRefs,
			metadata: body.brokerMetadata || body.secretMetadata || record.brokerMetadata || [],
			keyId: body.kmsKeyId || body.keyId,
			provider: body.provider,
			connectorId: body.connectorId,
			tenantScoped: body.tenantScoped,
			encryptedAtRest: body.encryptedAtRest,
			rotationSupported: body.rotationSupported,
			deleteSupported: body.deleteSupported,
			productionReady: body.productionReady,
		});
		const secretStore = createSecretStore({
			backend: 'external-broker',
			tenantId,
			broker: adapter.broker,
			env: opts.env || {},
		});
		const workflow = await advanceSecretMigrationWorkflow(record.workflow, {
			action: 'stage',
			tenantId,
			plan: record.plan,
			requiredSecretRefs,
			approvalManifest,
			secretStore,
			broker: adapter.broker,
			env: opts.env || {},
			dryRun: true,
		});
		if (!workflow.blocked) {
			record.workflow = workflow;
			record.approvalManifest = approvalManifest;
			record.brokerMetadata = normalizeBrokerMetadata(body.brokerMetadata || body.secretMetadata || record.brokerMetadata || [], tenantId);
			record.updatedAt = nowIso(opts);
		}
		return workflowResult(action, workflow, {
			tenantId,
			persisted: !workflow.blocked,
			brokerAdapter: adapter.summary(),
			secretByteAccessorCalled: adapter.secretByteAccessorCalled(),
		});
	}

	const rollbackEvidence = body.rollbackEvidence || body.evidence || record.rollbackEvidence;
	const workflow = await advanceSecretMigrationWorkflow(record.workflow, {
		action,
		tenantId,
		plan: record.plan,
		requiredSecretRefs,
		rollbackEvidence,
	});
	if (!workflow.blocked) {
		record.workflow = workflow;
		record.rollbackEvidence = rollbackEvidence;
		record.updatedAt = nowIso(opts);
	}
	return workflowResult(action, workflow, { tenantId, persisted: !workflow.blocked });
}

function workflowResult(action, workflow, extras = {}) {
	const blocked = !!workflow.blocked;
	const status = blocked ? workflowStatusCode(workflow) : 200;
	return jsonResponse(status, {
		ok: !blocked,
		api: API_CONTRACT,
		action,
		tenantId: extras.tenantId || workflow.tenantId,
		state: workflow.state,
		decision: workflow.decision,
		blocked,
		requiresOperator: !!workflow.requiresOperator,
		persisted: !!extras.persisted,
		...METADATA_ONLY_FLAGS,
		secretByteAccessorCalled: !!extras.secretByteAccessorCalled,
		workflow,
		brokerAdapter: extras.brokerAdapter,
	});
}

function statusBody(record, { tenantId }) {
	const workflow = record?.workflow || null;
	return {
		ok: true,
		api: API_CONTRACT,
		action: 'status',
		tenantId,
		state: workflow?.state || 'not_planned',
		hasWorkflow: !!workflow,
		updatedAt: cleanText(record?.updatedAt),
		blocked: !!workflow?.blocked,
		requiresOperator: !!workflow?.requiresOperator,
		...METADATA_ONLY_FLAGS,
		workflow,
		summary: workflow?.summary || {
			state: 'not_planned',
			totalOperations: 0,
			requiredSecretRefCount: 0,
			findings: 0,
			secretContentsInspected: false,
			sideEffects: false,
		},
	};
}

function failureBody({ action, tenantId, reason, message, idempotency = null }) {
	const body = {
		ok: false,
		api: API_CONTRACT,
		action: normalizeAction(action) || cleanToken(action || 'unknown'),
		tenantId: cleanTenant(tenantId) || 'local',
		state: 'blocked',
		decision: 'blocked',
		blocked: true,
		requiresOperator: /approval|operator|rollback/.test(String(reason || '')),
		...METADATA_ONLY_FLAGS,
		error: cleanToken(reason),
		findings: [finding(reason, '', message)],
	};
	if (idempotency) body.idempotency = idempotency;
	return body;
}

function workflowStatusCode(workflow) {
	const reasons = new Set((workflow.findings || []).map((item) => item.reason));
	if (reasons.has('secret-migration-transition-not-allowed') || reasons.has('invalid-secret-migration-transition')) return 409;
	if ([...reasons].some((reason) => /approval|operator|rollback-evidence|rollback/.test(reason))) return 403;
	return 400;
}

function methodNotAllowed(action, tenantId) {
	return jsonResponse(405, failureBody({
		action,
		tenantId,
		reason: 'method-not-allowed',
		message: 'secret migration API action does not support this method',
	}));
}

function jsonResponse(status, body, extra = {}) {
	return {
		handled: extra.handled !== false,
		status,
		headers: { 'content-type': 'application/json; charset=utf-8' },
		body: scrubUndefined(body),
	};
}

function parseRequest(request = {}) {
	const method = cleanToken(String(request.method || 'POST').toUpperCase());
	const url = parseUrl(request.url || request.path || '/api/secret-migration');
	const path = url.pathname || '/api/secret-migration';
	const match = ROUTE_RE.exec(path);
	return {
		method,
		url,
		path,
		handled: !!match || !!request.action || !!request.body?.action || !!request.bodyJson?.action,
		action: normalizeAction(match?.[1] || request.action),
	};
}

function parseUrl(value) {
	try {
		return new URL(String(value || ''), 'http://127.0.0.1');
	} catch {
		return new URL('http://127.0.0.1/api/secret-migration');
	}
}

function normalizeBody(request = {}) {
	const body = request.bodyJson ?? request.body ?? {};
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		return { ok: false, body: {} };
	}
	return { ok: true, body };
}

function resolveTenant({ body, context, url, opts }) {
	const contextTenant = cleanOptionalTenant(context?.tenantId || context?.tenant?.id || opts.tenantId);
	const queryTenant = cleanOptionalTenant(url?.searchParams?.get('tenantId'));
	const bodyTenant = cleanOptionalTenant(body.tenantId || body.tenant?.id || body.plan?.tenantId);
	const invalidTenant = invalidTenantValue(context?.tenantId || context?.tenant?.id || opts.tenantId)
		|| invalidTenantValue(url?.searchParams?.get('tenantId'))
		|| invalidTenantValue(body.tenantId || body.tenant?.id || body.plan?.tenantId);
	if (invalidTenant) {
		return {
			ok: false,
			tenantId: contextTenant || queryTenant || bodyTenant || 'local',
			reason: 'invalid-tenant-id',
			message: 'secret migration API requires a valid tenant id',
		};
	}
	const values = [contextTenant, queryTenant, bodyTenant].filter(Boolean);
	const tenantId = values[0] || 'local';
	if (values.some((value) => value !== tenantId)) {
		return {
			ok: false,
			tenantId,
			reason: 'secret-migration-api-tenant-mismatch',
			message: 'secret migration request tenant must match the authenticated tenant scope',
		};
	}
	return { ok: true, tenantId };
}

function invalidTenantValue(value) {
	if (value == null || value === '') return false;
	return !TENANT_RE.test(String(value).trim());
}

function cleanOptionalTenant(value) {
	if (value == null || value === '') return '';
	return cleanTenant(value);
}

function resolveIdempotency(request, body, { action, tenantId }) {
	const key = cleanToken(
		headerValue(request.headers, 'idempotency-key')
		|| body.idempotencyKey
		|| body.idempotency?.key
	);
	const fingerprint = hashJson({
		action,
		tenantId,
		body: scrubIdempotencyFields(body),
	});
	return {
		required: MUTATING_ACTIONS.has(action),
		keyPresent: !!key,
		key,
		scope: key ? `${tenantId}\0${action}\0${key}` : '',
		fingerprint,
	};
}

function idempotencyLookup(store, idempotency) {
	if (!idempotency.key) return {};
	const previous = store.get(idempotency.scope);
	if (!previous) return {};
	if (previous.fingerprint !== idempotency.fingerprint) return { conflict: true };
	return { response: previous.response };
}

function scrubIdempotencyFields(value) {
	if (Array.isArray(value)) return value.map(scrubIdempotencyFields);
	if (!value || typeof value !== 'object') return value;
	const out = {};
	for (const [key, item] of Object.entries(value)) {
		if (key === 'idempotencyKey' || key === 'idempotency') continue;
		out[key] = scrubIdempotencyFields(item);
	}
	return sortJson(out);
}

function tenantRecord(state, tenantId) {
	if (!state.has(tenantId)) {
		state.set(tenantId, {
			workflow: null,
			plan: null,
			requiredSecretRefs: [],
			approvalManifest: null,
			rollbackEvidence: null,
			brokerMetadata: [],
			updatedAt: '',
		});
	}
	return state.get(tenantId);
}

function normalizeAction(value) {
	const raw = cleanToken(String(value || '').toLowerCase().replace(/_/g, '-'));
	if (raw === 'dryrun') return 'dry-run';
	if (raw === 'approved') return 'approve';
	if (raw === 'staged') return 'stage';
	if (raw === 'committed') return 'commit';
	if (raw === 'rolled-back') return 'rollback';
	return raw;
}

function normalizeSecretRefs(refs, tenantId) {
	return uniqueStrings((Array.isArray(refs) ? refs : []).map((ref) => {
		const parsed = parseSecretRef(ref);
		if (!parsed || parsed.tenantId !== tenantId) return String(ref || '').trim();
		return parsed.ref;
	}).filter(Boolean));
}

function normalizeBrokerMetadata(metadata, tenantId) {
	return (Array.isArray(metadata) ? metadata : []).map((entry) => {
		const ref = metadataRef(entry, tenantId);
		const parsed = parseSecretRef(ref);
		return {
			ref: parsed?.ref || cleanText(entry?.ref),
			present: entry?.present !== false,
			usable: entry?.usable !== false,
			managedByBroker: entry?.managedByBroker !== false,
			version: safeNumber(entry?.version) || 1,
			keyId: cleanToken(entry?.keyId || entry?.kmsKeyId || 'metadata-only-kms-key'),
			rotationSupported: entry?.rotationSupported !== false,
			deleteSupported: entry?.deleteSupported !== false,
		};
	});
}

function setMetadataRecord(records, ref, meta = {}) {
	const parsed = parseSecretRef(ref);
	if (!parsed) return;
	const record = {
		ref: parsed.ref,
		tenantId: parsed.tenantId,
		kind: parsed.kind,
		name: parsed.name,
		present: meta.present !== false,
		size: 0,
		modifiedAt: safeNumber(meta.modifiedAt || meta.updatedAt),
		createdAt: safeNumber(meta.createdAt),
		updatedAt: safeNumber(meta.updatedAt || meta.modifiedAt),
		version: safeNumber(meta.version) || 1,
		keyId: cleanToken(meta.keyId || meta.kmsKeyId || 'metadata-only-kms-key'),
		plaintextLocal: false,
		encrypted: true,
		externalBroker: true,
		managedByBroker: meta.managedByBroker !== false,
		rotationSupported: meta.rotationSupported !== false,
		deleteSupported: meta.deleteSupported !== false,
		pathExposed: false,
		usable: meta.usable !== false && meta.present !== false,
		blocked: !!meta.blocked,
		blockReason: cleanText(meta.blockReason),
	};
	records.set(parsed.ref, record);
}

function missingMetadata(refOrKey, { tenantId, keyId }) {
	const ref = metadataRef(refOrKey, tenantId);
	const parsed = parseSecretRef(ref);
	return {
		ref: parsed?.ref || cleanText(ref),
		tenantId: parsed?.tenantId || tenantId,
		kind: parsed?.kind || cleanToken(refOrKey?.kind),
		name: parsed?.name || cleanToken(refOrKey?.name),
		present: false,
		size: 0,
		modifiedAt: 0,
		createdAt: 0,
		updatedAt: 0,
		version: 0,
		keyId,
		plaintextLocal: false,
		encrypted: true,
		externalBroker: true,
		managedByBroker: false,
		rotationSupported: false,
		deleteSupported: false,
		pathExposed: false,
		usable: false,
		blocked: true,
		blockReason: 'secret metadata is not present in metadata-only broker',
	};
}

function metadataRef(value, defaultTenant) {
	if (typeof value === 'string') {
		const parsed = parseSecretRef(value);
		return parsed?.ref || '';
	}
	const direct = parseSecretRef(value?.ref);
	if (direct) return direct.ref;
	try {
		return makeSecretRef({
			tenantId: value?.tenantId || defaultTenant,
			kind: value?.kind,
			name: value?.name,
		});
	} catch {
		return '';
	}
}

function headerValue(headers = {}, name) {
	const wanted = String(name || '').toLowerCase();
	for (const [key, value] of Object.entries(headers || {})) {
		if (String(key).toLowerCase() === wanted) return String(Array.isArray(value) ? value[0] : value || '');
	}
	return '';
}

function scrubUndefined(value) {
	if (Array.isArray(value)) return value.map(scrubUndefined);
	if (!value || typeof value !== 'object') return value;
	const out = {};
	for (const [key, item] of Object.entries(value)) {
		if (item === undefined) continue;
		out[key] = scrubUndefined(item);
	}
	return out;
}

function sortJson(value) {
	if (Array.isArray(value)) return value.map(sortJson);
	if (!value || typeof value !== 'object') return value;
	const out = {};
	for (const key of Object.keys(value).sort()) out[key] = sortJson(value[key]);
	return out;
}

function cloneJson(value) {
	return JSON.parse(JSON.stringify(value));
}

function hashJson(value) {
	return `sha256:${crypto.createHash('sha256').update(JSON.stringify(sortJson(value))).digest('hex')}`;
}

function finding(reason, entry, message) {
	return {
		reason: cleanToken(reason || 'blocked'),
		entry: cleanToken(entry),
		message: cleanText(message),
	};
}

function uniqueStrings(values = []) {
	return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].sort();
}

function cleanTenant(value) {
	const s = String(value || '').trim();
	return TENANT_RE.test(s) ? s : '';
}

function cleanToken(value) {
	return String(value || '').trim().replace(SAFE_TOKEN_RE, '').slice(0, 160);
}

function cleanText(value) {
	return String(value || '').trim().replace(SAFE_TEXT_RE, '').slice(0, 240);
}

function safeNumber(value) {
	const n = Number(value || 0);
	return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function nowIso(opts = {}) {
	if (typeof opts.now === 'function') return cleanText(opts.now());
	return new Date().toISOString();
}
