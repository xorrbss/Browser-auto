// webui/secrets.js - local secret metadata, encrypted tenant storage,
// external broker/KMS contracts, and artifact/static/export boundary helpers.
//
// Local pilot still defaults to gitignored files. External/service-open paths can
// opt into a small encrypted local backend for deterministic tests and runner
// integration without exposing raw secret bytes through WebUI API payloads.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const TENANT_RE = /^[A-Za-z0-9_-]{1,80}$/;
const KIND_RE = /^(auth-state|flow-values|credential|cookie-jar|otp-seed|token|browser-profile)$/;
const NAME_RE = /^[A-Za-z0-9_.:-]{1,160}$/;
const SECRET_SCHEME = 'aqa-secret:';
const TRUE_RE = /^(1|true|yes|on)$/i;
const LOCAL_PILOT_BACKEND = 'local-pilot-file';
const FORBIDDEN_PLAINTEXT_BACKEND = 'forbidden-plaintext';
const ENCRYPTED_BACKEND = 'encrypted-local';
const EXTERNAL_BROKER_BACKEND = 'external-broker';
const DEFAULT_SECRET_STORE_DIR = path.join(path.resolve(import.meta.dirname, '..'), 'data', 'webui-secrets');
const ENC_ALG = 'aes-256-gcm';
const ENC_VERSION = 1;
const PROBE_ROOT = path.resolve(import.meta.dirname, '..');
const RUNNER_SECRET_BROKER_PURPOSE = 'runner-secret-broker';
const SECRET_BROKER_CONTRACT_VERSION = 1;
const SECRET_BROKER_PROVIDER_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const SECRET_MIGRATION_APPROVAL_MANIFEST_KIND = 'aqa.secret-migration-approval-manifest';
const SECRET_MIGRATION_CONTRACT_VERSION = 1;
const SAFE_OPERATOR_APPROVAL_STATES = new Set(['approved', 'allow', 'allowed']);
const FALSE_RE = /^(0|false|no|off)$/i;
const PLAINTEXT_BROKER_ENV_CREDENTIALS = new Set([
	'WEBUI_SECRET_BROKER_TOKEN',
	'AQA_SECRET_BROKER_TOKEN',
	'WEBUI_SECRET_BROKER_AUTH_TOKEN',
	'AQA_SECRET_BROKER_AUTH_TOKEN',
	'WEBUI_SECRET_BROKER_BEARER_TOKEN',
	'AQA_SECRET_BROKER_BEARER_TOKEN',
	'WEBUI_SECRET_BROKER_ACCESS_TOKEN',
	'AQA_SECRET_BROKER_ACCESS_TOKEN',
	'WEBUI_SECRET_BROKER_REFRESH_TOKEN',
	'AQA_SECRET_BROKER_REFRESH_TOKEN',
	'WEBUI_SECRET_BROKER_API_KEY',
	'AQA_SECRET_BROKER_API_KEY',
	'WEBUI_SECRET_BROKER_CLIENT_SECRET',
	'AQA_SECRET_BROKER_CLIENT_SECRET',
	'WEBUI_SECRET_BROKER_PASSWORD',
	'AQA_SECRET_BROKER_PASSWORD',
	'WEBUI_SECRET_BROKER_AUTHORIZATION',
	'AQA_SECRET_BROKER_AUTHORIZATION',
	'WEBUI_SECRET_BROKER_CREDENTIALS',
	'AQA_SECRET_BROKER_CREDENTIALS',
	'WEBUI_KMS_TOKEN',
	'AQA_KMS_TOKEN',
	'WEBUI_KMS_AUTH_TOKEN',
	'AQA_KMS_AUTH_TOKEN',
	'WEBUI_KMS_BEARER_TOKEN',
	'AQA_KMS_BEARER_TOKEN',
	'WEBUI_KMS_ACCESS_TOKEN',
	'AQA_KMS_ACCESS_TOKEN',
	'WEBUI_KMS_API_KEY',
	'AQA_KMS_API_KEY',
	'WEBUI_KMS_CLIENT_SECRET',
	'AQA_KMS_CLIENT_SECRET',
	'WEBUI_KMS_PASSWORD',
	'AQA_KMS_PASSWORD',
	'WEBUI_KMS_SECRET_ACCESS_KEY',
	'AQA_KMS_SECRET_ACCESS_KEY',
	'WEBUI_KMS_CREDENTIALS',
	'AQA_KMS_CREDENTIALS',
]);

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

function normalizePath(value) {
	return String(value || '').replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
}

function cleanName(value, label) {
	const s = String(value || '').trim();
	if (!NAME_RE.test(s) || s.includes('..')) throw new Error(`invalid secret ${label}`);
	return s;
}

function cleanTenant(value) {
	const s = String(value || 'local').trim() || 'local';
	if (!TENANT_RE.test(s)) throw new Error('invalid secret tenant');
	return s;
}

function cleanKind(value) {
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

function envFlag(env, ...names) {
	for (const name of names) {
		const value = String(env?.[name] || '').trim();
		if (!value) continue;
		if (TRUE_RE.test(value)) return true;
		if (FALSE_RE.test(value)) return false;
	}
	return null;
}

function envValue(env, ...names) {
	for (const name of names) {
		const value = String(env?.[name] || '').trim();
		if (value) return value;
	}
	return '';
}

function externalMode(env = process.env) {
	return envBool(env, 'WEBUI_EXTERNAL_MODE', 'AQA_EXTERNAL_MODE');
}

function normalizeBackend(value) {
	const raw = String(value || '').trim().toLowerCase();
	if (!raw) return '';
	if (raw === LOCAL_PILOT_BACKEND || raw === 'local-pilot' || raw === 'local') return LOCAL_PILOT_BACKEND;
	if (raw === FORBIDDEN_PLAINTEXT_BACKEND || raw === 'plaintext-forbidden') return FORBIDDEN_PLAINTEXT_BACKEND;
	if (raw === ENCRYPTED_BACKEND || raw === 'local-encrypted') return ENCRYPTED_BACKEND;
	if (raw === EXTERNAL_BROKER_BACKEND || raw === 'external-kms' || raw === 'broker-kms' || raw === 'kms' || raw === 'broker') return EXTERNAL_BROKER_BACKEND;
	return raw;
}

function requestedSecretBackend(env = process.env) {
	const backend = normalizeBackend(envValue(env, 'WEBUI_SECRET_STORE_BACKEND', 'AQA_SECRET_STORE_BACKEND'));
	if (backend) return backend;
	if (envBool(env, 'WEBUI_ENCRYPTED_SECRET_STORE', 'AQA_ENCRYPTED_SECRET_STORE')) return ENCRYPTED_BACKEND;
	return '';
}

function localPlaintextBypass(env = process.env) {
	return envBool(env, 'WEBUI_LOCAL_PILOT_PLAINTEXT_SECRETS', 'AQA_LOCAL_PILOT_PLAINTEXT_SECRETS');
}

function configuredKeyMaterial(env = process.env, fallback = '') {
	return String(fallback || '').trim() || envValue(env, 'WEBUI_SECRET_STORE_KEY', 'AQA_SECRET_STORE_KEY');
}

function secretStoreDir(env = process.env) {
	return envValue(env, 'WEBUI_SECRET_STORE_DIR', 'AQA_SECRET_STORE_DIR') || DEFAULT_SECRET_STORE_DIR;
}

export function secretRuntimePolicy(env = process.env, opts = {}) {
	const external = externalMode(env);
	const plaintextBypass = localPlaintextBypass(env);
	const requestedBackend = normalizeBackend(opts.backend) || requestedSecretBackend(env);
	const backend = requestedBackend || (external && !plaintextBypass ? FORBIDDEN_PLAINTEXT_BACKEND : LOCAL_PILOT_BACKEND);
	const encryptedRequested = backend === ENCRYPTED_BACKEND;
	const encryptedConfigured = encryptedRequested && !!configuredKeyMaterial(env, opts.keyMaterial);
	const externalBrokerRequested = backend === EXTERNAL_BROKER_BACKEND;
	const externalBrokerValidation = externalBrokerRequested
		? validateSecretBrokerAdapter(opts.broker, { env, requireProductionConnector: opts.requireProductionConnector })
		: null;
	const externalBrokerConfigured = externalBrokerRequested && !!externalBrokerValidation?.ok;
	const secureBackend = backend === ENCRYPTED_BACKEND || backend === EXTERNAL_BROKER_BACKEND;
	const plaintextAllowed = backend === LOCAL_PILOT_BACKEND && (!external || plaintextBypass);
	const plaintextBlockReason = external && !plaintextAllowed
		? 'plaintext local secrets are blocked in external mode; configure WEBUI_SECRET_STORE_BACKEND=encrypted-local with WEBUI_SECRET_STORE_KEY, WEBUI_SECRET_STORE_BACKEND=external-broker with a runner broker adapter, or set WEBUI_LOCAL_PILOT_PLAINTEXT_SECRETS=1 for the documented local-pilot bypass'
		: '';
	const configErrors = [];
	if (backend === FORBIDDEN_PLAINTEXT_BACKEND) configErrors.push(plaintextBlockReason || 'plaintext local secrets are forbidden');
	if (backend === ENCRYPTED_BACKEND && !encryptedConfigured) configErrors.push('encrypted secret backend is missing WEBUI_SECRET_STORE_KEY');
	if (backend === EXTERNAL_BROKER_BACKEND && !externalBrokerConfigured) {
		configErrors.push(...(externalBrokerValidation?.errors?.length ? externalBrokerValidation.errors : ['external secret broker adapter is not configured']));
	}
	if (![LOCAL_PILOT_BACKEND, FORBIDDEN_PLAINTEXT_BACKEND, ENCRYPTED_BACKEND, EXTERNAL_BROKER_BACKEND].includes(backend)) {
		configErrors.push(`unsupported secret backend "${backend}"`);
	}
	return {
		external,
		backend,
		requestedBackend,
		secureBackend,
		encryptedRequested,
		encryptedConfigured,
		externalBrokerRequested,
		externalBrokerConfigured,
		externalBrokerContractOk: !!externalBrokerValidation?.contractOk,
		externalBrokerConnector: externalBrokerValidation?.connector || null,
		plaintextBypass,
		plaintextAllowed,
		plaintextBlockReason,
		configured: plaintextAllowed || encryptedConfigured || externalBrokerConfigured,
		configOk: configErrors.length === 0,
		configErrors,
	};
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

export class LocalPilotSecretStore {
	constructor({ tenantId = 'local', env = process.env } = {}) {
		this.tenantId = cleanTenant(tenantId);
		this.env = env;
		this.policy = secretRuntimePolicy(env);
		this.backend = this.policy.backend === FORBIDDEN_PLAINTEXT_BACKEND ? FORBIDDEN_PLAINTEXT_BACKEND : LOCAL_PILOT_BACKEND;
		this.secureBackend = false;
		this.configured = true;
	}

	ref(kind, name) {
		return makeSecretRef({ tenantId: this.tenantId, kind, name });
	}

	describeLocalFile({ kind, name, filePath, stat = null }) {
		const ref = this.ref(kind, name);
		const st = stat || safeStat(filePath);
		return {
			ref,
			backend: this.backend,
			tenantId: this.tenantId,
			kind: cleanKind(kind),
			name: cleanName(name, 'name'),
			present: !!st,
			size: st ? st.size : 0,
			modifiedAt: st ? st.mtimeMs : 0,
			plaintextLocal: true,
			encrypted: false,
			rotationSupported: false,
			deleteSupported: true,
			pathExposed: false,
			usable: this.policy.plaintextAllowed,
			blocked: !this.policy.plaintextAllowed,
			externalMode: this.policy.external,
			localPilotBypass: this.policy.plaintextBypass,
			encryptedBackendConfigured: this.policy.encryptedConfigured,
			externalBrokerConfigured: this.policy.externalBrokerConfigured,
			blockReason: this.policy.plaintextAllowed ? '' : this.policy.plaintextBlockReason,
		};
	}

	async describeSecret(refOrKey) {
		const key = normalizeSecretKey(refOrKey, this.tenantId);
		return {
			ref: makeSecretRef(key),
			backend: this.backend,
			tenantId: key.tenantId,
			kind: key.kind,
			name: key.name,
			present: false,
			size: 0,
			modifiedAt: 0,
			plaintextLocal: false,
			encrypted: false,
			rotationSupported: false,
			deleteSupported: false,
			pathExposed: false,
			usable: false,
			blocked: this.policy.external && !this.policy.plaintextBypass,
			externalMode: this.policy.external,
			localPilotBypass: this.policy.plaintextBypass,
			encryptedBackendConfigured: false,
			externalBrokerConfigured: false,
			blockReason: this.policy.external && !this.policy.plaintextBypass ? this.policy.plaintextBlockReason : 'secure secret backend is not configured',
		};
	}

	async list() {
		return [];
	}

	async getBytes() {
		throw new Error('secret bytes are not exposed through the WebUI secret store');
	}

	async getJson() {
		throw new Error('secret bytes are not exposed through the WebUI secret store');
	}

	async describeJsonObjectKeys(refOrKey) {
		const meta = await this.describeSecret(refOrKey);
		return {
			...meta,
			jsonObjectKeys: [],
			keyCount: 0,
			parseStatus: meta.present ? 'unavailable' : 'missing',
		};
	}

	async putJsonObjectFields() {
		throw new Error('secret writes are not implemented by the WebUI secret store');
	}

	async putBytes() {
		throw new Error('secret writes are not implemented by the WebUI secret store');
	}

	async rotate() {
		throw new Error('secret rotation requires an encrypted tenant secret store');
	}

	async delete() {
		throw new Error('secret deletion is handled by existing local-pilot file operations');
	}
}

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

export class EncryptedLocalSecretStore {
	constructor({ tenantId = 'local', rootDir = DEFAULT_SECRET_STORE_DIR, keyMaterial = '', keyId = 'local-test-key', env = process.env } = {}) {
		this.tenantId = cleanTenant(tenantId);
		this.rootDir = path.resolve(rootDir);
		this.backend = ENCRYPTED_BACKEND;
		this.secureBackend = true;
		this.keyId = cleanName(keyId || 'local-test-key', 'key id');
		this.keyMaterial = String(keyMaterial || '');
		this.configured = !!this.keyMaterial;
		this.env = env;
		this.policy = {
			...secretRuntimePolicy(env, { backend: ENCRYPTED_BACKEND, keyMaterial: this.keyMaterial }),
			backend: ENCRYPTED_BACKEND,
			secureBackend: true,
			encryptedRequested: true,
			encryptedConfigured: this.configured,
			configured: this.configured,
		};
		this.key = this.configured ? deriveEncryptionKey(this.keyMaterial) : null;
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
			encryptedBackendConfigured: this.configured,
			usable: meta.usable,
			blocked: meta.blocked,
		};
	}

	async describeSecret(refOrKey) {
		const key = normalizeSecretKey(refOrKey, this.tenantId);
		const ref = makeSecretRef(key);
		const full = this.secretFilePath(key);
		const st = safeStat(full);
		let record = null;
		if (st) {
			try {
				record = JSON.parse(await fs.promises.readFile(full, 'utf8'));
			} catch {
				record = null;
			}
		}
		const blocked = !this.configured || (st && !record);
		return {
			ref,
			backend: this.backend,
			tenantId: key.tenantId,
			kind: key.kind,
			name: key.name,
			present: !!st && !!record,
			size: st ? st.size : 0,
			modifiedAt: st ? st.mtimeMs : 0,
			createdAt: Number(record?.createdAt || 0),
			updatedAt: Number(record?.updatedAt || 0),
			version: Number(record?.version || 0),
			keyId: record?.keyId || this.keyId,
			plaintextLocal: false,
			encrypted: true,
			rotationSupported: this.configured,
			deleteSupported: true,
			pathExposed: false,
			usable: this.configured && !!st && !!record,
			blocked,
			externalMode: this.policy.external,
			localPilotBypass: this.policy.plaintextBypass,
			encryptedBackendConfigured: this.configured,
			externalBrokerConfigured: false,
			blockReason: !this.configured ? 'encrypted secret backend is missing WEBUI_SECRET_STORE_KEY' : st && !record ? 'encrypted secret metadata is unreadable' : '',
		};
	}

	async list({ kind } = {}) {
		const k = kind ? cleanKind(kind) : '';
		const tenants = [this.tenantId];
		const out = [];
		for (const tenant of tenants) {
			const tenantDir = path.join(this.rootDir, tenant);
			let kindEntries;
			try {
				kindEntries = k ? [{ name: k, isDirectory: () => true }] : await fs.promises.readdir(tenantDir, { withFileTypes: true });
			} catch {
				continue;
			}
			for (const kindEntry of kindEntries) {
				if (!kindEntry.isDirectory()) continue;
				let safeKind;
				try {
					safeKind = cleanKind(kindEntry.name);
				} catch {
					continue;
				}
				let files;
				try {
					files = await fs.promises.readdir(path.join(tenantDir, safeKind));
				} catch {
					continue;
				}
				for (const file of files.filter((f) => f.endsWith('.secret.json'))) {
					try {
						const record = JSON.parse(await fs.promises.readFile(path.join(tenantDir, safeKind, file), 'utf8'));
						const meta = await this.describeSecret({ tenantId: tenant, kind: safeKind, name: record.name });
						if (meta.present) out.push(meta);
					} catch {
						/* ignore unreadable records */
					}
				}
			}
		}
		out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
		return out;
	}

	async putBytes({ kind, name, bytes }) {
		const key = normalizeSecretKey({ tenantId: this.tenantId, kind, name }, this.tenantId);
		const now = Date.now();
		await this.writeRecord(key, toBuffer(bytes), { createdAt: now, updatedAt: now, version: 1 });
		return this.describeSecret(key);
	}

	async rotate(refOrKey, bytes) {
		let key;
		let nextBytes = bytes;
		if (arguments.length === 1 && refOrKey && typeof refOrKey === 'object' && Object.prototype.hasOwnProperty.call(refOrKey, 'bytes')) {
			key = normalizeSecretKey(refOrKey, this.tenantId);
			nextBytes = refOrKey.bytes;
		} else {
			key = normalizeSecretKey(refOrKey, this.tenantId);
		}
		const current = await this.readRecord(key);
		if (!current) throw new Error('cannot rotate missing secret');
		const now = Date.now();
		await this.writeRecord(key, toBuffer(nextBytes), {
			createdAt: Number(current.createdAt || now),
			updatedAt: now,
			version: Number(current.version || 0) + 1,
		});
		return this.describeSecret(key);
	}

	async delete(refOrKey) {
		const key = normalizeSecretKey(refOrKey, this.tenantId);
		const full = this.secretFilePath(key);
		const existed = !!safeStat(full);
		try {
			await fs.promises.rm(full, { force: true });
		} catch {
			/* force delete is best-effort; non-existence still returns ok */
		}
		return { ok: true, deleted: existed, ref: makeSecretRef(key), backend: this.backend };
	}

	async getBytes(refOrKey, opts = {}) {
		if (!rawReadAllowed(opts)) throw new Error('secret bytes are not exposed through WebUI; runner secret broker purpose is required');
		const key = normalizeSecretKey(refOrKey, this.tenantId);
		const record = await this.readRecord(key);
		if (!record) throw new Error('secret not found');
		return decryptRecord(record, this.key, key);
	}

	async getJson(refOrKey, opts = {}) {
		const bytes = await this.getBytes(refOrKey, opts);
		return JSON.parse(bytes.toString('utf8'));
	}

	async describeJsonObjectKeys(refOrKey) {
		const key = normalizeSecretKey(refOrKey, this.tenantId);
		const meta = await this.describeSecret(key);
		if (!meta.present || !meta.usable) {
			return {
				...meta,
				jsonObjectKeys: [],
				keyCount: 0,
				parseStatus: meta.present ? 'unreadable' : 'missing',
			};
		}
		try {
			const parsed = JSON.parse((await this.getBytes(key, { purpose: RUNNER_SECRET_BROKER_PURPOSE })).toString('utf8'));
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
				blockReason: 'encrypted JSON metadata is unreadable',
				jsonObjectKeys: [],
				keyCount: 0,
				parseStatus: 'unreadable',
			};
		}
	}

	async putJsonObjectFields({ kind, name, values }) {
		const key = normalizeSecretKey({ tenantId: this.tenantId, kind, name }, this.tenantId);
		const patch = cleanJsonObjectFields(values);
		const current = await this.readRecord(key);
		let existing = {};
		let createdAt = Date.now();
		let version = 0;
		if (current) {
			try {
				const parsed = JSON.parse(decryptRecord(current, this.key, key).toString('utf8'));
				if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
				existing = parsed;
				createdAt = Number(current.createdAt || createdAt);
				version = Number(current.version || 0);
			} catch {
				throw new Error('encrypted JSON secret is unreadable');
			}
		}
		const now = Date.now();
		await this.writeRecord(key, Buffer.from(JSON.stringify({ ...existing, ...patch }, null, 2) + '\n', 'utf8'), {
			createdAt,
			updatedAt: now,
			version: version + 1,
		});
		return this.describeSecret(key);
	}

	secretFilePath(refOrKey) {
		const key = normalizeSecretKey(refOrKey, this.tenantId);
		return path.join(this.rootDir, key.tenantId, key.kind, `${encodeName(key.name)}.secret.json`);
	}

	async readRecord(refOrKey) {
		this.ensureConfigured();
		const key = normalizeSecretKey(refOrKey, this.tenantId);
		try {
			return JSON.parse(await fs.promises.readFile(this.secretFilePath(key), 'utf8'));
		} catch {
			return null;
		}
	}

	async writeRecord(key, bytes, { createdAt, updatedAt, version }) {
		this.ensureConfigured();
		const dir = path.dirname(this.secretFilePath(key));
		await fs.promises.mkdir(dir, { recursive: true });
		const record = encryptBytes(bytes, this.key, key, {
			createdAt,
			updatedAt,
			version,
			keyId: this.keyId,
		});
		await fs.promises.writeFile(this.secretFilePath(key), JSON.stringify(record, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
	}

	ensureConfigured() {
		if (!this.configured) throw new Error('encrypted secret backend is missing WEBUI_SECRET_STORE_KEY');
	}
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

export function assertSecretBackendConfigured(env = process.env, opts = {}) {
	const policy = secretRuntimePolicy(env, opts);
	if (!policy.configOk) {
		const err = new Error(`secret backend configuration is not ready: ${policy.configErrors.join('; ') || 'unknown error'}`);
		err.policy = policy;
		throw err;
	}
	return policy;
}

export function validateSecretBrokerAdapter(broker, opts = {}) {
	const env = opts.env || process.env;
	const contractOk = hasSecretBrokerContract(broker);
	const connector = secretBrokerConnectorDescriptor(env, { ...opts, broker });
	const errors = [];
	if (!contractOk) errors.push('external secret broker adapter is not configured');
	errors.push(...connector.errors);
	if (opts.requireProductionConnector) {
		if (connector.testOnly) errors.push('test secret broker is not allowed for production configuration');
		if (!connector.productionReady) errors.push('production secret broker connector must declare productionReady=true');
	}
	return {
		ok: errors.length === 0,
		contractOk,
		connector,
		errors: [...new Set(errors)],
	};
}

function hasSecretBrokerContract(broker) {
	return [
		'describeSecret',
		'list',
		'putBytes',
		'rotate',
		'delete',
		'getBytes',
		'describeJsonObjectKeys',
		'putJsonObjectFields',
	].every((name) => typeof broker?.[name] === 'function');
}

function secretBrokerConnectorDescriptor(env = process.env, opts = {}) {
	const raw = rawConnectorDescriptor(opts.broker, opts.connector || opts.connectorDescriptor);
	const provider = cleanConnectorText(raw.provider || raw.kind || envValue(env, 'WEBUI_SECRET_BROKER_PROVIDER', 'AQA_SECRET_BROKER_PROVIDER'));
	const connectorId = cleanConnectorText(raw.connectorId || raw.id || envValue(env, 'WEBUI_SECRET_BROKER_ID', 'AQA_SECRET_BROKER_ID') || 'external-broker');
	const kmsKeyConfigured = !!String(raw.kmsKeyId || raw.kmsKey || raw.keyId || envValue(env, 'WEBUI_SECRET_BROKER_KMS_KEY_ID', 'AQA_SECRET_BROKER_KMS_KEY_ID', 'WEBUI_KMS_KEY_ID', 'AQA_KMS_KEY_ID')).trim();
	const tenantScoped = configBool(raw.tenantScoped ?? raw.tenantScopedKeys, envFlag(env, 'WEBUI_SECRET_BROKER_TENANT_SCOPED', 'AQA_SECRET_BROKER_TENANT_SCOPED'));
	const encryptedAtRest = configBool(raw.encryptedAtRest ?? raw.encryptionManaged ?? raw.kmsEncrypted, envFlag(env, 'WEBUI_SECRET_BROKER_ENCRYPTED_AT_REST', 'AQA_SECRET_BROKER_ENCRYPTED_AT_REST'));
	const rotationSupported = configBool(raw.rotationSupported ?? raw.rotateSupported, envFlag(env, 'WEBUI_SECRET_BROKER_ROTATION_SUPPORTED', 'AQA_SECRET_BROKER_ROTATION_SUPPORTED'));
	const deleteSupported = configBool(raw.deleteSupported ?? raw.deletionSupported, envFlag(env, 'WEBUI_SECRET_BROKER_DELETE_SUPPORTED', 'AQA_SECRET_BROKER_DELETE_SUPPORTED'));
	const contractVersion = Number(raw.contractVersion || raw.schemaVersion || 0);
	const testOnly = raw.testOnly === true || /^deterministic-test-broker$/i.test(provider);
	const productionReady = raw.productionReady === true;
	const plaintextEnvCredentialNames = plaintextBrokerEnvCredentialNames(env);
	const errors = [];
	if (contractVersion !== SECRET_BROKER_CONTRACT_VERSION) errors.push(`external secret broker connector contractVersion must be ${SECRET_BROKER_CONTRACT_VERSION}`);
	if (!provider) errors.push('external secret broker provider is missing');
	else if (!SECRET_BROKER_PROVIDER_RE.test(provider)) errors.push('external secret broker provider is invalid');
	if (!kmsKeyConfigured) errors.push('external secret broker KMS key id is missing');
	if (tenantScoped !== true) errors.push('external secret broker must declare tenantScoped=true');
	if (encryptedAtRest !== true) errors.push('external secret broker must declare encryptedAtRest=true');
	if (rotationSupported !== true) errors.push('external secret broker must support rotation');
	if (deleteSupported !== true) errors.push('external secret broker must support deletion');
	for (const name of plaintextEnvCredentialNames) {
		errors.push(`external secret broker plaintext credential env var ${name} is forbidden; use managed identity or a secret ref`);
	}
	return {
		contractVersion: Number.isFinite(contractVersion) ? contractVersion : 0,
		provider,
		connectorId,
		kmsKeyConfigured,
		tenantScoped: tenantScoped === true,
		encryptedAtRest: encryptedAtRest === true,
		rotationSupported: rotationSupported === true,
		deleteSupported: deleteSupported === true,
		testOnly,
		productionReady,
		plaintextEnvCredentialNames,
		plaintextEnvCredentialsConfigured: plaintextEnvCredentialNames.length > 0,
		errors,
	};
}

function plaintextBrokerEnvCredentialNames(env = process.env) {
	return Object.keys(env || {})
		.filter((name) => PLAINTEXT_BROKER_ENV_CREDENTIALS.has(name) && String(env?.[name] || '').trim())
		.sort();
}

function rawConnectorDescriptor(broker, override = null) {
	if (override && typeof override === 'object') return override;
	if (!broker || typeof broker !== 'object') return {};
	if (broker.connector && typeof broker.connector === 'object') return broker.connector;
	if (broker.connectorDescriptor && typeof broker.connectorDescriptor === 'object') return broker.connectorDescriptor;
	if (typeof broker.describeConnector === 'function') {
		try {
			const described = broker.describeConnector();
			if (described && typeof described === 'object') return described;
		} catch {
			return {};
		}
	}
	return {};
}

function cleanConnectorText(value) {
	return String(value || '').trim().replace(/[\r\n\t]/g, ' ').slice(0, 160);
}

function configBool(value, fallback = null) {
	if (typeof value === 'boolean') return value;
	if (value == null || value === '') return fallback;
	const s = String(value).trim();
	if (TRUE_RE.test(s)) return true;
	if (FALSE_RE.test(s)) return false;
	return fallback;
}

function rawReadAllowed(opts = {}) {
	return opts?.purpose === RUNNER_SECRET_BROKER_PURPOSE;
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

function safeNonNegativeNumber(value) {
	const n = Number(value || 0);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

function cleanMetadataText(value) {
	return String(value || '').replace(/[\r\n\t]/g, ' ').slice(0, 160);
}

function fakeBrokerMapKey(refOrKey) {
	const key = normalizeSecretKey(refOrKey, 'local');
	return `${key.tenantId}\0${key.kind}\0${key.name}`;
}

function cleanJsonObjectFields(values) {
	if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error('invalid JSON secret fields');
	const out = {};
	for (const [key, value] of Object.entries(values)) {
		if (!key || key.length > 200 || key.includes('\0')) throw new Error('invalid JSON secret field');
		if (typeof value !== 'string') throw new Error('JSON secret field values must be strings');
		out[key] = value;
	}
	return out;
}

function safeStat(filePath) {
	try {
		return fs.statSync(filePath);
	} catch {
		return null;
	}
}

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

const MIGRATION_NAME_RE = /^[A-Za-z0-9_-]+$/;
const PLAINTEXT_MIGRATION_SOURCES = Object.freeze([
	{
		kind: 'auth-state',
		source: 'canonical',
		dir: ['fixtures', 'auth', 'playwright'],
		suffix: '.state.json',
		pathClass: 'fixtures/auth/playwright/*.state.json',
		secretName: (name) => `canonical:${name}`,
	},
	{
		kind: 'auth-state',
		source: 'legacy',
		dir: ['approve'],
		suffix: '.pw-state.json',
		pathClass: 'approve/*.pw-state.json',
		secretName: (name) => `legacy:${name}`,
	},
	{
		kind: 'flow-values',
		source: 'flow-values',
		dir: ['flows'],
		suffix: '.values.json',
		pathClass: 'flows/*.values.json',
		secretName: (name) => name,
	},
]);

export async function inventoryPlaintextSecretMigration(opts = {}) {
	const rootDir = path.resolve(opts.rootDir || PROBE_ROOT);
	const tenantId = cleanTenant(opts.tenantId || 'local');
	const store = opts.secretStore || createSecretStore({ env: opts.env || process.env, tenantId });
	const entries = [];
	for (const source of PLAINTEXT_MIGRATION_SOURCES) {
		const dir = path.join(rootDir, ...source.dir);
		let files;
		try {
			files = await fs.promises.readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.isFile() || !file.name.endsWith(source.suffix)) continue;
			const baseName = file.name.slice(0, -source.suffix.length);
			const validName = MIGRATION_NAME_RE.test(baseName);
			let statOk = false;
			try {
				const st = await fs.promises.stat(path.join(dir, file.name));
				statOk = st.isFile();
			} catch {
				statOk = false;
			}
			if (!statOk) continue;
			let secureStatus = secureMigrationStatus(store);
			if (validName && store?.secureBackend && store?.configured) {
				try {
					const meta = await store.describeSecret({ tenantId, kind: source.kind, name: source.secretName(baseName) });
					secureStatus = meta.present && meta.usable ? 'secure-present' : 'secure-missing';
				} catch {
					secureStatus = 'secure-unreadable';
				}
			}
			const status = !validName
				? 'invalid-name'
				: secureStatus === 'secure-present'
					? 'plaintext-with-secure-copy'
					: 'plaintext-pending-migration';
			entries.push({
				kind: source.kind,
				source: source.source,
				pathClass: source.pathClass,
				status,
				secureStatus,
			});
		}
	}
	return {
		scanner: 'webui-secret-migration-inventory/v1',
		tenantId,
		root: 'repository',
		entries,
		summary: summarizeMigrationInventory(entries),
	};
}

export async function planPlaintextSecretMigration(opts = {}) {
	const inventory = opts.inventory || await inventoryPlaintextSecretMigration(opts);
	const operations = inventory.entries.map((entry) => migrationPlanOperation(entry));
	return {
		planner: 'webui-secret-migration-plan/v1',
		tenantId: cleanTenant(inventory.tenantId || opts.tenantId || 'local'),
		root: 'repository',
		dryRun: true,
		sanitized: true,
		secretContentsInspected: false,
		migratesSecrets: false,
		operations,
		summary: summarizeMigrationPlan(inventory.summary, operations),
	};
}

export function buildSecretMigrationApprovalManifest({
	tenantId,
	requester,
	purpose,
	secretRefs = [],
	pathClasses = [],
	status,
	approvalId,
	approvedBy,
	approvedAt,
	reason,
	expiresAt,
	createdAt = new Date().toISOString(),
} = {}) {
	const approvedByValue = cleanMetadataText(approvedBy);
	const approvedAtValue = cleanMetadataText(approvedAt);
	const statusValue = normalizedStatus(status) || (approvedByValue && approvedAtValue ? 'approved' : 'missing');
	const manifest = {
		schemaVersion: SECRET_MIGRATION_CONTRACT_VERSION,
		manifestKind: SECRET_MIGRATION_APPROVAL_MANIFEST_KIND,
		tenantId: cleanMetadataText(tenantId),
		status: statusValue,
		approvalId: '',
		approvedBy: approvedByValue,
		approvedAt: approvedAtValue,
		requester: cleanMetadataText(requester),
		purpose: cleanMetadataText(purpose),
		reason: cleanMetadataText(reason),
		createdAt: cleanMetadataText(createdAt),
		expiresAt: cleanMetadataText(expiresAt),
		scope: {
			secretRefs: uniqueCleanStrings(secretRefs),
			pathClasses: uniqueCleanStrings(pathClasses),
		},
	};
	const approvalSeed = { ...manifest, approvalId: '' };
	manifest.approvalId = cleanMetadataText(approvalId) || `secret-migration:${crypto.createHash('sha256').update(JSON.stringify(approvalSeed)).digest('hex').slice(0, 16)}`;
	manifest.manifestHash = secretMigrationManifestHash(manifest);
	return manifest;
}

export function validateSecretMigrationApprovalManifest(manifest, opts = {}) {
	const tenantId = cleanOptionalTenant(opts.tenantId);
	const requiredRefs = Array.isArray(opts.requiredSecretRefs || opts.requiredRefs)
		? (opts.requiredSecretRefs || opts.requiredRefs)
		: [];
	if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
		return {
			present: false,
			ok: false,
			refCount: 0,
			validRefCount: 0,
			invalidRefCount: 0,
			requiredRefCount: requiredRefs.length,
			missingRequiredRefCount: requiredRefs.length,
			findings: [finding('missing-operator-approval-manifest', '', 'production secret migration requires an operator approval manifest')],
		};
	}
	const meta = {
		present: true,
		kind: cleanMetadataText(manifest.manifestKind || manifest.kind),
		status: normalizedStatus(manifest.status || manifest.decision || (manifest.approved === true ? 'approved' : '')),
		tenantId: cleanOptionalTenant(manifest.tenantId || manifest.tenant?.id),
		approvalIdPresent: !!cleanMetadataText(manifest.approvalId || manifest.id),
		approvedByPresent: !!cleanMetadataText(manifest.approvedBy || manifest.actorId || manifest.approver),
		approvedAtPresent: !!cleanMetadataText(manifest.approvedAt),
		manifestHashPresent: !!cleanMetadataText(manifest.manifestHash),
		expectedHash: secretMigrationManifestHash(manifest),
		refCount: 0,
		validRefCount: 0,
		invalidRefCount: 0,
		requiredRefCount: requiredRefs.length,
		missingRequiredRefCount: 0,
		pathClassCount: 0,
		findings: [],
	};
	if (meta.kind && meta.kind !== SECRET_MIGRATION_APPROVAL_MANIFEST_KIND) {
		meta.findings.push(finding('invalid-secret-migration-manifest-kind', '', 'operator approval manifest has an unexpected kind'));
	}
	if (!SAFE_OPERATOR_APPROVAL_STATES.has(meta.status)) {
		meta.findings.push(finding('missing-secret-migration-approval', '', 'operator approval manifest must be approved'));
	}
	if (!meta.tenantId) {
		meta.findings.push(finding('missing-secret-migration-tenant', '', 'operator approval manifest requires tenant metadata'));
	} else if (tenantId && meta.tenantId !== tenantId) {
		meta.findings.push(finding('secret-migration-tenant-mismatch', '', 'operator approval manifest tenant must match migration tenant'));
	}
	if (!meta.approvalIdPresent) meta.findings.push(finding('missing-secret-migration-approval-id', '', 'operator approval manifest requires an approval id'));
	if (!meta.approvedByPresent) meta.findings.push(finding('missing-secret-migration-approver', '', 'operator approval manifest requires an approver'));
	if (!meta.approvedAtPresent) meta.findings.push(finding('missing-secret-migration-approved-at', '', 'operator approval manifest requires an approval time'));
	const manifestHash = cleanMetadataText(manifest.manifestHash);
	if (!manifestHash) {
		meta.findings.push(finding('missing-secret-migration-manifest-hash', '', 'operator approval manifest requires an integrity hash'));
	} else if (manifestHash !== meta.expectedHash) {
		meta.findings.push(finding('secret-migration-manifest-hash-mismatch', '', 'operator approval manifest hash must match its contents'));
	}

	const refs = approvalManifestSecretRefs(manifest);
	const validRefs = new Set();
	meta.refCount = refs.length;
	for (const [index, ref] of refs.entries()) {
		const parsed = parseSecretRef(ref);
		if (!parsed) {
			meta.invalidRefCount += 1;
			meta.findings.push(finding('invalid-secret-migration-ref', `ref-${index + 1}`, 'operator approval manifest contains an invalid secret ref'));
			continue;
		}
		if (tenantId && parsed.tenantId !== tenantId) {
			meta.invalidRefCount += 1;
			meta.findings.push(finding('secret-migration-ref-tenant-mismatch', `ref-${index + 1}`, 'operator approval manifest secret ref tenant must match migration tenant'));
			continue;
		}
		validRefs.add(parsed.ref);
	}
	meta.validRefCount = validRefs.size;
	if (opts.requireSecretRefs !== false && refs.length === 0) {
		meta.findings.push(finding('missing-secret-migration-refs', '', 'operator approval manifest must reference approved secret refs'));
	}
	for (const [index, ref] of requiredRefs.entries()) {
		const parsed = parseSecretRef(ref);
		if (!parsed) {
			meta.findings.push(finding('invalid-required-secret-migration-ref', `required-ref-${index + 1}`, 'required secret migration ref is invalid'));
			continue;
		}
		if (!validRefs.has(parsed.ref)) {
			meta.missingRequiredRefCount += 1;
			meta.findings.push(finding('missing-approved-secret-migration-ref', `required-ref-${index + 1}`, 'operator approval manifest does not cover a required secret ref'));
		}
	}
	meta.pathClassCount = uniqueCleanStrings(manifest?.scope?.pathClasses || manifest?.pathClasses || []).length;
	meta.ok = meta.findings.length === 0;
	return meta;
}

export async function productionSecretMigrationExecutionContract(opts = {}) {
	const env = opts.env || process.env;
	const tenantId = cleanTenant(opts.tenantId || envValue(env, 'WEBUI_TENANT_ID', 'AQA_TENANT_ID') || 'local');
	const dryRun = opts.dryRun !== false;
	const store = opts.secretStore || createSecretStore({
		env,
		tenantId,
		backend: EXTERNAL_BROKER_BACKEND,
		broker: opts.broker,
	});
	const inventory = opts.inventory || (opts.plan ? null : await inventoryPlaintextSecretMigration({ ...opts, tenantId, secretStore: store }));
	const plan = opts.plan || await planPlaintextSecretMigration({ ...opts, tenantId, secretStore: store, inventory });
	const operations = Array.isArray(plan?.operations) ? plan.operations : [];
	const requiredRefs = Array.isArray(opts.requiredSecretRefs || opts.secretRefs)
		? (opts.requiredSecretRefs || opts.secretRefs)
		: [];
	const requireOperatorApproval = opts.requireOperatorApproval !== false && (operations.length > 0 || requiredRefs.length > 0);
	const approvalManifest = validateSecretMigrationApprovalManifest(opts.approvalManifest || opts.operatorApprovalManifest || opts.manifest, {
		tenantId,
		requiredSecretRefs: requiredRefs,
		requireSecretRefs: requireOperatorApproval,
	});
	const brokerReadiness = productionBrokerReadiness(store, env);
	const findings = [...brokerReadiness.findings];
	if (requireOperatorApproval) findings.push(...approvalManifest.findings);
	if (!dryRun) {
		findings.push(finding('production-secret-migration-non-dry-run-refused', '', 'local production migration contract is dry-run only and does not execute secret bytes'));
	}
	const approvalOk = !requireOperatorApproval || approvalManifest.ok;
	const readinessByClass = migrationReadinessByClass(operations, {
		dryRun,
		brokerOk: brokerReadiness.ok,
		approvalOk,
		rotationSupported: brokerReadiness.broker.rotationSupported,
		deleteSupported: brokerReadiness.broker.deleteSupported,
	});
	const allowed = findings.length === 0 && readinessByClass.every((entry) => entry.ready);
	return {
		contract: 'webui-secret-production-migration-execution/v1',
		schemaVersion: SECRET_MIGRATION_CONTRACT_VERSION,
		tenantId,
		root: 'repository',
		dryRun,
		failClosed: true,
		sanitized: true,
		secretContentsInspected: false,
		readsSecretBytes: false,
		writesSecretBytes: false,
		deletesPlaintext: false,
		migratesSecrets: false,
		sideEffects: false,
		decision: allowed ? 'dry-run-ready' : 'blocked',
		allowed,
		blocked: !allowed,
		broker: brokerReadiness.broker,
		approvalManifest: sanitizeApprovalManifestMeta(approvalManifest),
		readinessByClass,
		summary: summarizeMigrationExecution(readinessByClass, operations, findings),
		findings,
	};
}

function uniqueCleanStrings(values) {
	return [...new Set((Array.isArray(values) ? values : []).map(cleanMetadataText).filter(Boolean))].sort();
}

function secretMigrationManifestHash(manifest = {}) {
	const copy = { ...manifest };
	delete copy.manifestHash;
	return `sha256:${crypto.createHash('sha256').update(JSON.stringify(copy)).digest('hex')}`;
}

function approvalManifestSecretRefs(manifest = {}) {
	const scope = manifest?.scope && typeof manifest.scope === 'object' ? manifest.scope : {};
	const refs = Array.isArray(scope.secretRefs)
		? scope.secretRefs
		: Array.isArray(manifest.secretRefs)
			? manifest.secretRefs
			: Array.isArray(manifest.refs)
				? manifest.refs
				: [];
	return refs.map((ref) => String(ref || '').trim()).filter(Boolean);
}

function sanitizeApprovalManifestMeta(meta = {}) {
	return {
		present: !!meta.present,
		ok: !!meta.ok,
		kind: meta.kind || '',
		status: meta.status || '',
		tenantId: meta.tenantId || null,
		approvalIdPresent: !!meta.approvalIdPresent,
		approvedByPresent: !!meta.approvedByPresent,
		approvedAtPresent: !!meta.approvedAtPresent,
		manifestHashPresent: !!meta.manifestHashPresent,
		refCount: safeNonNegativeNumber(meta.refCount),
		validRefCount: safeNonNegativeNumber(meta.validRefCount),
		invalidRefCount: safeNonNegativeNumber(meta.invalidRefCount),
		requiredRefCount: safeNonNegativeNumber(meta.requiredRefCount),
		missingRequiredRefCount: safeNonNegativeNumber(meta.missingRequiredRefCount),
		pathClassCount: safeNonNegativeNumber(meta.pathClassCount),
		findings: Array.isArray(meta.findings) ? meta.findings : [],
	};
}

function productionBrokerReadiness(store, env = process.env) {
	const findings = [];
	const backend = store?.backend || '';
	let validation = null;
	let connector = store?.connector || null;
	if (backend !== EXTERNAL_BROKER_BACKEND) {
		findings.push(finding('production-secret-broker-required', 'broker', 'production secret migration requires WEBUI_SECRET_STORE_BACKEND=external-broker'));
	} else {
		validation = validateSecretBrokerAdapter(store?.broker, { env: store?.env || env, requireProductionConnector: true });
		connector = validation.connector || {};
		for (const error of validation.errors || []) {
			findings.push(finding('production-secret-broker-contract-invalid', 'broker', error));
		}
		if (!validation.contractOk) {
			findings.push(finding('production-secret-broker-adapter-missing', 'broker', 'production secret migration requires a broker adapter method contract'));
		}
		if (!connector.kmsKeyConfigured) {
			findings.push(finding('production-secret-broker-kms-key-missing', 'broker', 'production secret migration requires a configured KMS key id'));
		}
		if (!connector.tenantScoped) {
			findings.push(finding('production-secret-broker-tenant-scope-missing', 'broker', 'production secret migration requires tenant-scoped broker keys'));
		}
		if (!connector.encryptedAtRest) {
			findings.push(finding('production-secret-broker-encryption-missing', 'broker', 'production secret migration requires encrypted-at-rest broker storage'));
		}
		if (!connector.rotationSupported) {
			findings.push(finding('production-secret-broker-rotation-unsupported', 'broker', 'production secret migration requires key rotation support'));
		}
		if (!connector.deleteSupported) {
			findings.push(finding('production-secret-broker-delete-unsupported', 'broker', 'production secret migration requires deletion support'));
		}
		if (connector.testOnly) {
			findings.push(finding('production-secret-broker-test-only', 'broker', 'test secret broker is not allowed for production migration execution'));
		}
		if (!connector.productionReady) {
			findings.push(finding('production-secret-broker-not-production-ready', 'broker', 'production secret broker connector must declare productionReady=true'));
		}
		if (connector.plaintextEnvCredentialsConfigured) {
			findings.push(finding('production-secret-broker-plaintext-env-credential', 'broker', 'production secret broker configuration must not use plaintext env credential material'));
		}
	}
	return {
		ok: findings.length === 0,
		findings: uniqueFindings(findings),
		broker: {
			backend,
			configured: backend === EXTERNAL_BROKER_BACKEND && !!validation?.ok,
			contractOk: !!validation?.contractOk,
			provider: cleanMetadataText(connector?.provider),
			connectorId: cleanMetadataText(connector?.connectorId),
			kmsKeyConfigured: !!connector?.kmsKeyConfigured,
			tenantScoped: !!connector?.tenantScoped,
			encryptedAtRest: !!connector?.encryptedAtRest,
			rotationSupported: !!connector?.rotationSupported,
			deleteSupported: !!connector?.deleteSupported,
			testOnly: !!connector?.testOnly,
			productionReady: !!connector?.productionReady,
			plaintextEnvCredentialsConfigured: !!connector?.plaintextEnvCredentialsConfigured,
			plaintextEnvCredentialCount: safeNonNegativeNumber(connector?.plaintextEnvCredentialNames?.length),
		},
	};
}

function migrationReadinessByClass(operations = [], context = {}) {
	const classes = new Map();
	for (const op of operations) {
		const key = `${op.kind}\0${op.source}\0${op.pathClass}`;
		if (!classes.has(key)) {
			classes.set(key, {
				kind: op.kind,
				source: op.source,
				pathClass: op.pathClass,
				total: 0,
				pendingMigration: 0,
				withSecureCopy: 0,
				invalidName: 0,
				blockedOperations: 0,
				readyForRetirePlaintext: 0,
				byStatus: {},
				bySecureStatus: {},
				byAction: {},
				blockReasons: new Set(),
			});
		}
		const entry = classes.get(key);
		entry.total += 1;
		increment(entry.byStatus, op.status);
		increment(entry.bySecureStatus, op.secureStatus);
		increment(entry.byAction, op.action);
		if (op.status === 'plaintext-pending-migration') entry.pendingMigration += 1;
		if (op.status === 'plaintext-with-secure-copy') entry.withSecureCopy += 1;
		if (op.status === 'invalid-name') entry.invalidName += 1;
		if (op.readyForRetirePlaintext) entry.readyForRetirePlaintext += 1;
		if (op.blocked) {
			entry.blockedOperations += 1;
			entry.blockReasons.add(cleanMetadataText(op.blockedReason || 'operation blocked'));
		}
	}
	const out = [];
	for (const entry of classes.values()) {
		if (!context.brokerOk) entry.blockReasons.add('production-broker-not-ready');
		if (!context.rotationSupported) entry.blockReasons.add('production-broker-rotation-unsupported');
		if (!context.deleteSupported) entry.blockReasons.add('production-broker-delete-unsupported');
		if (!context.approvalOk) entry.blockReasons.add('operator-approval-not-ready');
		if (!context.dryRun) entry.blockReasons.add('non-dry-run-refused');
		if (entry.invalidName > 0) entry.blockReasons.add('invalid-plaintext-name');
		if (entry.pendingMigration > 0) entry.blockReasons.add('secure-copy-missing');
		const blockReasons = [...entry.blockReasons].filter(Boolean).sort();
		const ready = blockReasons.length === 0 && entry.total > 0 && entry.readyForRetirePlaintext === entry.total;
		out.push({
			kind: entry.kind,
			source: entry.source,
			pathClass: entry.pathClass,
			total: entry.total,
			pendingMigration: entry.pendingMigration,
			withSecureCopy: entry.withSecureCopy,
			invalidName: entry.invalidName,
			blockedOperations: entry.blockedOperations,
			readyForRetirePlaintext: entry.readyForRetirePlaintext,
			operatorApprovalRequired: entry.total > 0,
			approvalRefsValidated: !!context.approvalOk,
			rotationSupported: !!context.rotationSupported,
			deleteSupported: !!context.deleteSupported,
			dryRunOnly: true,
			ready,
			readiness: ready ? 'ready-for-operator-retirement-dry-run' : 'blocked',
			blocked: !ready,
			blockReasons,
			byStatus: entry.byStatus,
			bySecureStatus: entry.bySecureStatus,
			byAction: entry.byAction,
		});
	}
	return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.source.localeCompare(b.source) || a.pathClass.localeCompare(b.pathClass));
}

function summarizeMigrationExecution(readinessByClass = [], operations = [], findings = []) {
	const byReadiness = {};
	const byPathClass = {};
	const byFinding = {};
	let readyClasses = 0;
	let blockedClasses = 0;
	let pendingMigration = 0;
	let withSecureCopy = 0;
	let invalidName = 0;
	for (const entry of readinessByClass) {
		increment(byReadiness, entry.readiness);
		increment(byPathClass, entry.pathClass);
		if (entry.ready) readyClasses += 1;
		if (entry.blocked) blockedClasses += 1;
		pendingMigration += entry.pendingMigration;
		withSecureCopy += entry.withSecureCopy;
		invalidName += entry.invalidName;
	}
	for (const item of findings) {
		increment(byFinding, item.reason || 'blocked');
	}
	return {
		totalOperations: operations.length,
		totalClasses: readinessByClass.length,
		readyClasses,
		blockedClasses,
		pendingMigration,
		withSecureCopy,
		invalidName,
		findings: findings.length,
		byReadiness,
		byPathClass,
		byFinding,
		secretContentsInspected: false,
		migratesSecrets: false,
		dryRunOnly: true,
	};
}

function uniqueFindings(findings) {
	const seen = new Set();
	const out = [];
	for (const item of findings) {
		const key = `${item.reason}\0${item.entry}\0${item.message}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(item);
	}
	return out;
}

function secureMigrationStatus(store) {
	if (!store?.secureBackend) return 'secure-backend-not-configured';
	if (!store?.configured) return 'secure-backend-unavailable';
	return 'secure-missing';
}

function summarizeMigrationInventory(entries) {
	const summary = {
		total: entries.length,
		byKind: {},
		byPathClass: {},
		byStatus: {},
		bySecureStatus: {},
		pendingMigration: 0,
		withSecureCopy: 0,
		invalidName: 0,
	};
	for (const entry of entries) {
		increment(summary.byKind, entry.kind);
		increment(summary.byPathClass, entry.pathClass);
		increment(summary.byStatus, entry.status);
		increment(summary.bySecureStatus, entry.secureStatus);
		if (entry.status === 'plaintext-pending-migration') summary.pendingMigration += 1;
		if (entry.status === 'plaintext-with-secure-copy') summary.withSecureCopy += 1;
		if (entry.status === 'invalid-name') summary.invalidName += 1;
	}
	return summary;
}

function migrationPlanOperation(entry) {
	let action = 'operator-migrate-to-secure-store';
	let blockedReason = '';
	let readyForRetirePlaintext = false;
	if (entry.status === 'invalid-name') {
		action = 'manual-review-invalid-name';
		blockedReason = 'plaintext candidate name is not safe for automated planning';
	} else if (entry.status === 'plaintext-with-secure-copy') {
		action = 'operator-verify-secure-copy-then-retire-plaintext';
		readyForRetirePlaintext = true;
	} else if (entry.secureStatus === 'secure-backend-not-configured') {
		action = 'configure-secure-secret-backend';
		blockedReason = 'secure secret backend is not configured';
	} else if (entry.secureStatus === 'secure-backend-unavailable') {
		action = 'repair-secure-secret-backend';
		blockedReason = 'secure secret backend is unavailable';
	} else if (entry.secureStatus === 'secure-unreadable') {
		action = 'manual-review-secure-secret';
		blockedReason = 'secure secret metadata is unreadable';
	}
	return {
		kind: entry.kind,
		source: entry.source,
		pathClass: entry.pathClass,
		status: entry.status,
		secureStatus: entry.secureStatus,
		action,
		blocked: !!blockedReason,
		blockedReason,
		operatorApprovalRequired: true,
		readyForRetirePlaintext,
		readsSecretBytes: false,
		writesSecretBytes: false,
		deletesPlaintext: false,
	};
}

function summarizeMigrationPlan(inventorySummary = {}, operations = []) {
	const byAction = {};
	let blocked = 0;
	let readyForRetirePlaintext = 0;
	for (const op of operations) {
		increment(byAction, op.action);
		if (op.blocked) blocked += 1;
		if (op.readyForRetirePlaintext) readyForRetirePlaintext += 1;
	}
	return {
		total: inventorySummary.total || operations.length,
		pendingMigration: inventorySummary.pendingMigration || 0,
		withSecureCopy: inventorySummary.withSecureCopy || 0,
		invalidName: inventorySummary.invalidName || 0,
		blocked,
		readyForRetirePlaintext,
		byAction,
		requiresOperatorApproval: operations.length > 0,
		secretContentsInspected: false,
		migratesSecrets: false,
	};
}

function increment(target, key) {
	target[key] = (target[key] || 0) + 1;
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

function normalizeSecretKey(refOrKey, defaultTenant = 'local') {
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

function cleanOptionalTenant(value) {
	if (value == null || value === '') return null;
	try {
		return cleanTenant(value);
	} catch {
		return null;
	}
}

function toBuffer(value) {
	if (Buffer.isBuffer(value)) return value;
	if (value instanceof Uint8Array) return Buffer.from(value);
	return Buffer.from(String(value == null ? '' : value), 'utf8');
}

function deriveEncryptionKey(material) {
	const raw = String(material || '');
	if (raw.startsWith('base64:')) {
		const decoded = Buffer.from(raw.slice('base64:'.length), 'base64');
		if (decoded.length === 32) return decoded;
	}
	if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
	return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function encodeName(name) {
	return Buffer.from(cleanName(name, 'name'), 'utf8').toString('base64url');
}

function aadFor(key, version) {
	return Buffer.from(`${key.tenantId}\0${key.kind}\0${key.name}\0${version}`, 'utf8');
}

function encryptBytes(bytes, keyBytes, key, { createdAt, updatedAt, version, keyId }) {
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv(ENC_ALG, keyBytes, iv);
	cipher.setAAD(aadFor(key, version));
	const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
	const tag = cipher.getAuthTag();
	return {
		format: 'aqa-secret-store',
		algorithm: ENC_ALG,
		schemaVersion: ENC_VERSION,
		tenantId: key.tenantId,
		kind: key.kind,
		name: key.name,
		keyId,
		version,
		createdAt,
		updatedAt,
		iv: iv.toString('base64'),
		tag: tag.toString('base64'),
		ciphertext: ciphertext.toString('base64'),
	};
}

function decryptRecord(record, keyBytes, expectedKey) {
	if (!record || record.algorithm !== ENC_ALG || record.schemaVersion !== ENC_VERSION) throw new Error('unsupported encrypted secret record');
	const key = normalizeSecretKey({ tenantId: record.tenantId, kind: record.kind, name: record.name }, expectedKey.tenantId);
	if (key.tenantId !== expectedKey.tenantId || key.kind !== expectedKey.kind || key.name !== expectedKey.name) throw new Error('encrypted secret key mismatch');
	const decipher = crypto.createDecipheriv(ENC_ALG, keyBytes, Buffer.from(record.iv, 'base64'));
	decipher.setAAD(aadFor(key, Number(record.version || 0)));
	decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
	return Buffer.concat([decipher.update(Buffer.from(record.ciphertext, 'base64')), decipher.final()]);
}

function normalizedStatus(value) {
	return String(value || '').trim().toLowerCase();
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

function finding(reason, entry, message) {
	return { reason, entry, message };
}
