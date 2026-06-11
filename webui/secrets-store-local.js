// webui/secrets-store-local.js - local-pilot secret store: gitignored plaintext file
// metadata only; never exposes secret bytes or writes through the WebUI API.

import {
	LOCAL_PILOT_BACKEND,
	FORBIDDEN_PLAINTEXT_BACKEND,
	cleanTenant,
	cleanKind,
	cleanName,
	makeSecretRef,
	normalizeSecretKey,
	safeStat,
} from './secrets-core.js';
import { secretRuntimePolicy } from './secrets-policy.js';

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
