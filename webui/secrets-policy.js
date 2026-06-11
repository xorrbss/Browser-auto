// webui/secrets-policy.js - secret backend runtime policy, backend configuration
// assertion, and the external secret broker adapter/connector validation contract.

import {
	TRUE_RE,
	FALSE_RE,
	LOCAL_PILOT_BACKEND,
	FORBIDDEN_PLAINTEXT_BACKEND,
	ENCRYPTED_BACKEND,
	EXTERNAL_BROKER_BACKEND,
	envFlag,
	envValue,
	externalMode,
	normalizeBackend,
	requestedSecretBackend,
	localPlaintextBypass,
	configuredKeyMaterial,
} from './secrets-core.js';

export const SECRET_BROKER_CONTRACT_VERSION = 1;
const SECRET_BROKER_PROVIDER_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
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

// Shared predicates over a secret store's runtime policy. Centralized here (where the policy
// object is built) so the flows and auth views interrogate it through one source and cannot drift.
export function secretBackendSecureOnly(store) {
	return !!(store?.secureBackend && store?.configured && !store?.policy?.plaintextAllowed);
}

export function secretBackendPlaintextBlocked(store) {
	return !!(store?.policy?.external && !store?.policy?.plaintextAllowed);
}

export function secretBackendConfigBlockedReason(store) {
	if (!store?.secureBackend || store?.policy?.configOk) return '';
	const errors = Array.isArray(store?.policy?.configErrors) ? store.policy.configErrors.filter(Boolean) : [];
	return `secret backend configuration is not ready: ${errors.join('; ') || 'secure secret backend is unavailable'}`;
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
