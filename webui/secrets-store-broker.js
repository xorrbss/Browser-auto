// webui/secrets-store-broker.js - external broker/KMS secret store, the deterministic
// fake broker for tests, sanitized broker metadata, and the secret store factory.

import {
	ENCRYPTED_BACKEND,
	EXTERNAL_BROKER_BACKEND,
	RUNNER_SECRET_BROKER_PURPOSE,
	cleanTenant,
	cleanKind,
	cleanName,
	makeSecretRef,
	normalizeSecretKey,
	toBuffer,
	rawReadAllowed,
	cleanJsonObjectFields,
	cleanMetadataText,
	safeNonNegativeNumber,
	envValue,
	normalizeBackend,
	requestedSecretBackend,
	configuredKeyMaterial,
	secretStoreDir,
} from './secrets-core.js';
import { SECRET_BROKER_CONTRACT_VERSION, secretRuntimePolicy, validateSecretBrokerAdapter } from './secrets-policy.js';
import { LocalPilotSecretStore } from './secrets-store-local.js';
import { EncryptedLocalSecretStore } from './secrets-store-encrypted.js';

export function createSecretStore(opts = {}) {
	const env = opts.env || process.env;
	const tenantId = opts.tenantId || envValue(env, 'WEBUI_TENANT_ID', 'AQA_TENANT_ID') || 'local';
	const backend = normalizeBackend(opts.backend) || requestedSecretBackend(env);
	if (backend === ENCRYPTED_BACKEND) {
		return new EncryptedLocalSecretStore({
			tenantId,
			rootDir: opts.rootDir || secretStoreDir(env),
			keyMaterial: opts.keyMaterial || opts.masterKey || configuredKeyMaterial(env),
			keyId: opts.keyId || envValue(env, 'WEBUI_SECRET_STORE_KEY_ID', 'AQA_SECRET_STORE_KEY_ID') || 'local-test-key',
			env,
		});
	}
	if (backend === EXTERNAL_BROKER_BACKEND) {
		return new ExternalBrokerSecretStore({
			tenantId,
			broker: opts.broker,
			brokerId: opts.brokerId || envValue(env, 'WEBUI_SECRET_BROKER_ID', 'AQA_SECRET_BROKER_ID') || 'external-broker',
			env,
		});
	}
	return new LocalPilotSecretStore({ ...opts, tenantId, env });
}

export class ExternalBrokerSecretStore {
	constructor({ tenantId = 'local', broker = null, brokerId = 'external-broker', env = process.env } = {}) {
		this.tenantId = cleanTenant(tenantId);
		this.backend = EXTERNAL_BROKER_BACKEND;
		this.secureBackend = true;
		this.broker = broker;
		this.brokerId = cleanName(brokerId || 'external-broker', 'broker id');
		this.validation = validateSecretBrokerAdapter(broker, { env });
		this.connector = this.validation.connector;
		this.configured = this.validation.ok;
		this.env = env;
		this.policy = {
			...secretRuntimePolicy(env, { backend: EXTERNAL_BROKER_BACKEND, broker }),
			backend: EXTERNAL_BROKER_BACKEND,
			secureBackend: true,
			externalBrokerRequested: true,
			externalBrokerConfigured: this.configured,
			configured: this.configured,
		};
	}

	ref(kind, name) {
		return makeSecretRef({ tenantId: this.tenantId, kind, name });
	}

	describeLocalFile({ kind, name, filePath, stat = null }) {
		const local = new LocalPilotSecretStore({ tenantId: this.tenantId, env: this.env });
		const meta = local.describeLocalFile({ kind, name, filePath, stat });
		return {
			...meta,
			backend: this.backend,
			externalBroker: true,
			managedByBroker: false,
			usable: false,
			blocked: true,
			blockReason: this.policy.plaintextBlockReason || 'local plaintext secret is not managed by the external broker',
		};
	}

	async describeSecret(refOrKey) {
		const key = normalizeSecretKey(refOrKey, this.tenantId);
		if (!this.configured) return this.missingBrokerMetadata(key);
		return sanitizeBrokerMetadata(await this.broker.describeSecret(key), key, this);
	}

	async list({ kind } = {}) {
		this.ensureConfigured();
		const entries = await this.broker.list({ tenantId: this.tenantId, kind: kind ? cleanKind(kind) : '' });
		return (Array.isArray(entries) ? entries : [])
			.map((entry) => sanitizeBrokerMetadata(entry, entry || {}, this))
			.filter((entry) => entry.tenantId === this.tenantId && (!kind || entry.kind === cleanKind(kind)) && entry.present)
			.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
	}

	async putBytes({ kind, name, bytes }) {
		this.ensureConfigured();
		const key = normalizeSecretKey({ tenantId: this.tenantId, kind, name }, this.tenantId);
		return sanitizeBrokerMetadata(await this.broker.putBytes(key, toBuffer(bytes)), key, this);
	}

	async rotate(refOrKey, bytes) {
		this.ensureConfigured();
		let key;
		let nextBytes = bytes;
		if (arguments.length === 1 && refOrKey && typeof refOrKey === 'object' && Object.prototype.hasOwnProperty.call(refOrKey, 'bytes')) {
			key = normalizeSecretKey(refOrKey, this.tenantId);
			nextBytes = refOrKey.bytes;
		} else {
			key = normalizeSecretKey(refOrKey, this.tenantId);
		}
		return sanitizeBrokerMetadata(await this.broker.rotate(key, toBuffer(nextBytes)), key, this);
	}

	async delete(refOrKey) {
		this.ensureConfigured();
		const key = normalizeSecretKey(refOrKey, this.tenantId);
		const result = await this.broker.delete(key);
		return {
			ok: result?.ok !== false,
			deleted: !!result?.deleted,
			ref: makeSecretRef(key),
			backend: this.backend,
			externalBroker: true,
		};
	}

	async getBytes(refOrKey, opts = {}) {
		if (!rawReadAllowed(opts)) throw new Error('secret bytes are not exposed through WebUI; runner secret broker purpose is required');
		this.ensureConfigured();
		const key = normalizeSecretKey(refOrKey, this.tenantId);
		return toBuffer(await this.broker.getBytes(key, { purpose: RUNNER_SECRET_BROKER_PURPOSE }));
	}

	async getJson(refOrKey, opts = {}) {
		const bytes = await this.getBytes(refOrKey, opts);
		return JSON.parse(bytes.toString('utf8'));
	}

	async describeJsonObjectKeys(refOrKey) {
		this.ensureConfigured();
		const key = normalizeSecretKey(refOrKey, this.tenantId);
		const result = await this.broker.describeJsonObjectKeys(key);
		const meta = sanitizeBrokerMetadata(result, key, this);
		const keys = Array.isArray(result?.jsonObjectKeys) ? result.jsonObjectKeys.filter((k) => typeof k === 'string').sort() : [];
		return {
			...meta,
			jsonObjectKeys: keys,
			keyCount: keys.length,
			parseStatus: result?.parseStatus || (meta.present ? 'unknown' : 'missing'),
		};
	}

	async putJsonObjectFields({ kind, name, values }) {
		this.ensureConfigured();
		const key = normalizeSecretKey({ tenantId: this.tenantId, kind, name }, this.tenantId);
		return sanitizeBrokerMetadata(await this.broker.putJsonObjectFields(key, cleanJsonObjectFields(values)), key, this);
	}

	missingBrokerMetadata(refOrKey) {
		const key = normalizeSecretKey(refOrKey, this.tenantId);
		const ref = makeSecretRef(key);
		return {
			ref,
			backend: this.backend,
			tenantId: key.tenantId,
			kind: key.kind,
			name: key.name,
			present: false,
			size: 0,
			modifiedAt: 0,
			createdAt: 0,
			updatedAt: 0,
			version: 0,
			keyId: this.brokerId,
			plaintextLocal: false,
			encrypted: true,
			externalBroker: true,
			managedByBroker: false,
			rotationSupported: false,
			deleteSupported: false,
			pathExposed: false,
			usable: false,
			blocked: true,
			externalMode: this.policy.external,
			localPilotBypass: this.policy.plaintextBypass,
			encryptedBackendConfigured: false,
			externalBrokerConfigured: false,
			blockReason: this.validation.errors.join('; ') || 'external secret broker adapter is not configured',
		};
	}

	ensureConfigured() {
		if (!this.configured) throw new Error(this.validation.errors.join('; ') || 'external secret broker adapter is not configured');
	}
}

export class FakeExternalSecretBroker {
	constructor({ keyId = 'fake-kms-test-key', now = null, provider = 'deterministic-test-broker', testOnly = true, productionReady = false } = {}) {
		this.keyId = cleanName(keyId, 'key id');
		this.now = typeof now === 'function' ? now : () => Date.now();
		this.records = new Map();
		this.connector = {
			contractVersion: SECRET_BROKER_CONTRACT_VERSION,
			provider,
			connectorId: 'fake-external-secret-broker',
			kmsKeyId: this.keyId,
			tenantScoped: true,
			encryptedAtRest: true,
			rotationSupported: true,
			deleteSupported: true,
			testOnly,
			productionReady,
		};
	}

	describeConnector() {
		return { ...this.connector };
	}

	async describeSecret(refOrKey) {
		const key = normalizeSecretKey(refOrKey, 'local');
		const record = this.records.get(fakeBrokerMapKey(key));
		return this.metaFor(key, record);
	}

	async list({ tenantId = 'local', kind = '' } = {}) {
		const tenant = cleanTenant(tenantId);
		const k = kind ? cleanKind(kind) : '';
		const out = [];
		for (const record of this.records.values()) {
			if (record.tenantId !== tenant) continue;
			if (k && record.kind !== k) continue;
			out.push(this.metaFor(record, record));
		}
		return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
	}

	async putBytes(refOrKey, bytes) {
		const key = normalizeSecretKey(refOrKey, 'local');
		const now = this.now();
		const record = {
			tenantId: key.tenantId,
			kind: key.kind,
			name: key.name,
			bytes: toBuffer(bytes),
			version: 1,
			createdAt: now,
			updatedAt: now,
			keyId: this.keyId,
		};
		this.records.set(fakeBrokerMapKey(key), record);
		return this.metaFor(key, record);
	}

	async rotate(refOrKey, bytes) {
		const key = normalizeSecretKey(refOrKey, 'local');
		const current = this.records.get(fakeBrokerMapKey(key));
		if (!current) throw new Error('cannot rotate missing secret');
		const now = this.now();
		const record = {
			...current,
			bytes: toBuffer(bytes),
			version: Number(current.version || 0) + 1,
			updatedAt: now,
		};
		this.records.set(fakeBrokerMapKey(key), record);
		return this.metaFor(key, record);
	}

	async delete(refOrKey) {
		const key = normalizeSecretKey(refOrKey, 'local');
		const deleted = this.records.delete(fakeBrokerMapKey(key));
		return { ok: true, deleted, ref: makeSecretRef(key), backend: EXTERNAL_BROKER_BACKEND };
	}

	async getBytes(refOrKey, opts = {}) {
		if (!rawReadAllowed(opts)) throw new Error('secret bytes are not exposed through WebUI; runner secret broker purpose is required');
		const key = normalizeSecretKey(refOrKey, 'local');
		const record = this.records.get(fakeBrokerMapKey(key));
		if (!record) throw new Error('secret not found');
		return Buffer.from(record.bytes);
	}

	async describeJsonObjectKeys(refOrKey) {
		const key = normalizeSecretKey(refOrKey, 'local');
		const record = this.records.get(fakeBrokerMapKey(key));
		const meta = this.metaFor(key, record);
		if (!record) return { ...meta, jsonObjectKeys: [], keyCount: 0, parseStatus: 'missing' };
		try {
			const parsed = JSON.parse(Buffer.from(record.bytes).toString('utf8'));
			const keys = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? Object.keys(parsed).filter((k) => typeof k === 'string').sort()
				: [];
			return {
				...meta,
				jsonObjectKeys: keys,
				keyCount: keys.length,
				parseStatus: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? 'object' : 'not-object',
			};
		} catch {
			return {
				...meta,
				usable: false,
				blocked: true,
				blockReason: 'broker JSON metadata is unreadable',
				jsonObjectKeys: [],
				keyCount: 0,
				parseStatus: 'unreadable',
			};
		}
	}

	async putJsonObjectFields(refOrKey, values) {
		const key = normalizeSecretKey(refOrKey, 'local');
		const patch = cleanJsonObjectFields(values);
		const current = this.records.get(fakeBrokerMapKey(key));
		let existing = {};
		if (current) {
			try {
				const parsed = JSON.parse(Buffer.from(current.bytes).toString('utf8'));
				if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
				existing = parsed;
			} catch {
				throw new Error('broker JSON secret is unreadable');
			}
			return this.rotate(key, Buffer.from(JSON.stringify({ ...existing, ...patch }, null, 2) + '\n', 'utf8'));
		}
		return this.putBytes(key, Buffer.from(JSON.stringify(patch, null, 2) + '\n', 'utf8'));
	}

	metaFor(refOrKey, record) {
		const key = normalizeSecretKey(refOrKey, 'local');
		return {
			ref: makeSecretRef(key),
			backend: EXTERNAL_BROKER_BACKEND,
			tenantId: key.tenantId,
			kind: key.kind,
			name: key.name,
			present: !!record,
			size: record ? record.bytes.length : 0,
			modifiedAt: Number(record?.updatedAt || 0),
			createdAt: Number(record?.createdAt || 0),
			updatedAt: Number(record?.updatedAt || 0),
			version: Number(record?.version || 0),
			keyId: record?.keyId || this.keyId,
			plaintextLocal: false,
			encrypted: true,
			externalBroker: true,
			managedByBroker: !!record,
			rotationSupported: true,
			deleteSupported: true,
			pathExposed: false,
			usable: !!record,
			blocked: false,
			blockReason: '',
		};
	}
}

export function createFakeSecretBrokerForTests(opts = {}) {
	return new FakeExternalSecretBroker(opts);
}

function sanitizeBrokerMetadata(meta, keyHint, store) {
	const key = normalizeSecretKey({
		tenantId: meta?.tenantId || keyHint?.tenantId || store.tenantId,
		kind: meta?.kind || keyHint?.kind,
		name: meta?.name || keyHint?.name,
	}, store.tenantId);
	const present = !!meta?.present;
	const blocked = !store.configured || !!meta?.blocked;
	return {
		ref: makeSecretRef(key),
		backend: EXTERNAL_BROKER_BACKEND,
		tenantId: key.tenantId,
		kind: key.kind,
		name: key.name,
		present,
		size: safeNonNegativeNumber(meta?.size),
		modifiedAt: safeNonNegativeNumber(meta?.modifiedAt || meta?.updatedAt),
		createdAt: safeNonNegativeNumber(meta?.createdAt),
		updatedAt: safeNonNegativeNumber(meta?.updatedAt || meta?.modifiedAt),
		version: safeNonNegativeNumber(meta?.version),
		keyId: cleanMetadataText(meta?.keyId || store.brokerId),
		plaintextLocal: false,
		encrypted: true,
		externalBroker: true,
		managedByBroker: present,
		rotationSupported: store.configured && meta?.rotationSupported !== false,
		deleteSupported: store.configured && meta?.deleteSupported !== false,
		pathExposed: false,
		usable: store.configured && present && meta?.usable !== false && !blocked,
		blocked,
		externalMode: store.policy.external,
		localPilotBypass: store.policy.plaintextBypass,
		encryptedBackendConfigured: false,
		externalBrokerConfigured: store.configured,
		blockReason: !store.configured ? 'external secret broker adapter is not configured' : cleanMetadataText(meta?.blockReason || ''),
	};
}

function fakeBrokerMapKey(refOrKey) {
	const key = normalizeSecretKey(refOrKey, 'local');
	return `${key.tenantId}\0${key.kind}\0${key.name}`;
}
