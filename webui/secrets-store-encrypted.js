// webui/secrets-store-encrypted.js - encrypted local tenant secret store and its
// AES-GCM record helpers (key derivation, AAD binding, record encrypt/decrypt).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
	ENCRYPTED_BACKEND,
	DEFAULT_SECRET_STORE_DIR,
	RUNNER_SECRET_BROKER_PURPOSE,
	cleanTenant,
	cleanKind,
	cleanName,
	makeSecretRef,
	normalizeSecretKey,
	safeStat,
	toBuffer,
	rawReadAllowed,
	cleanJsonObjectFields,
} from './secrets-core.js';
import { secretRuntimePolicy } from './secrets-policy.js';
import { LocalPilotSecretStore } from './secrets-store-local.js';

const ENC_ALG = 'aes-256-gcm';
const ENC_VERSION = 1;

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
