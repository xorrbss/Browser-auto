#!/usr/bin/env bash
# Browser-free checks for the external broker/KMS secret backend contract.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import {
	assertSecretBackendConfigured,
	createFakeSecretBrokerForTests,
	createSecretStore,
	secretRuntimePolicy,
	validateSecretBrokerAdapter,
} from './webui/secrets.js';

let policy = secretRuntimePolicy({ WEBUI_EXTERNAL_MODE: '1' });
assert.equal(policy.backend, 'forbidden-plaintext', 'external mode without a backend is explicit forbidden plaintext');
assert.equal(policy.configOk, false, 'forbidden plaintext is not service-open ready');
assert.throws(() => assertSecretBackendConfigured({ WEBUI_EXTERNAL_MODE: '1' }), /plaintext local secrets are blocked/, 'missing backend fails closed');

policy = secretRuntimePolicy({ WEBUI_EXTERNAL_MODE: '1', WEBUI_SECRET_STORE_BACKEND: 'encrypted-local' });
assert.equal(policy.backend, 'encrypted-local', 'encrypted-local backend is distinguishable');
assert.equal(policy.configOk, false, 'encrypted-local without key fails config validation');
assert(policy.configErrors.some((e) => /WEBUI_SECRET_STORE_KEY/.test(e)), 'missing local KMS key is reported');

policy = secretRuntimePolicy({ WEBUI_EXTERNAL_MODE: '1', WEBUI_SECRET_STORE_BACKEND: 'external-broker' });
assert.equal(policy.backend, 'external-broker', 'external-broker backend is distinguishable when requested from env');
assert.equal(policy.configOk, false, 'external broker without adapter/KMS fails closed');
assert(policy.configErrors.some((e) => /adapter is not configured/.test(e)), 'missing broker adapter is reported');
assert(policy.configErrors.some((e) => /KMS key id is missing/.test(e)), 'missing external KMS key is reported');

const methodOnlyBroker = Object.fromEntries([
	'describeSecret',
	'list',
	'putBytes',
	'rotate',
	'delete',
	'getBytes',
	'describeJsonObjectKeys',
	'putJsonObjectFields',
].map((name) => [name, async () => ({})]));
let validation = validateSecretBrokerAdapter(methodOnlyBroker);
assert.equal(validation.contractOk, true, 'method-only broker satisfies method surface');
assert.equal(validation.ok, false, 'method-only broker still fails connector validation');
assert(validation.errors.some((e) => /contractVersion/.test(e)), 'connector contract version is required');
assert(validation.errors.some((e) => /KMS key id is missing/.test(e)), 'connector KMS key id is required');

policy = assertSecretBackendConfigured({
	WEBUI_EXTERNAL_MODE: '1',
	WEBUI_SECRET_STORE_BACKEND: 'encrypted-local',
	WEBUI_SECRET_STORE_KEY: 'unit-key-material',
});
assert.equal(policy.backend, 'encrypted-local', 'encrypted-local with key validates');

let tick = 1000;
const broker = createFakeSecretBrokerForTests({ now: () => ++tick });
policy = assertSecretBackendConfigured(
	{ WEBUI_EXTERNAL_MODE: '1' },
	{ backend: 'external-broker', broker },
);
assert.equal(policy.backend, 'external-broker', 'external broker backend is distinguishable');
assert.equal(policy.externalBrokerConfigured, true, 'injected broker adapter validates');
assert.equal(policy.externalBrokerConnector.kmsKeyConfigured, true, 'broker connector declares KMS configuration');
assert.equal(policy.externalBrokerConnector.testOnly, true, 'deterministic fake broker is labeled test-only');

assert.throws(
	() => assertSecretBackendConfigured({ WEBUI_EXTERNAL_MODE: '1' }, { backend: 'external-broker', broker, requireProductionConnector: true }),
	/test secret broker/,
	'test-only broker is rejected for production connector validation',
);

const productionShapedBroker = createFakeSecretBrokerForTests({
	keyId: 'unit-production-kms-key',
	provider: 'unit-production-broker',
	testOnly: false,
	productionReady: true,
});
policy = assertSecretBackendConfigured(
	{ WEBUI_EXTERNAL_MODE: '1' },
	{ backend: 'external-broker', broker: productionShapedBroker, requireProductionConnector: true },
);
assert.equal(policy.externalBrokerConnector.provider, 'unit-production-broker', 'production-shaped connector provider is sanitized');
assert.equal(policy.externalBrokerConnector.productionReady, true, 'production connector validation requires productionReady');

validation = validateSecretBrokerAdapter(productionShapedBroker, {
	env: { WEBUI_SECRET_BROKER_TOKEN: 'plain-env-broker-token' },
	requireProductionConnector: true,
});
assert.equal(validation.ok, false, 'plaintext broker token env material is rejected');
assert(validation.errors.some((e) => /WEBUI_SECRET_BROKER_TOKEN/.test(e)), 'plaintext broker token env var name is reported');
assert(!JSON.stringify(validation).includes('plain-env-broker-token'), 'plaintext broker token value is never echoed');

policy = secretRuntimePolicy(
	{
		WEBUI_EXTERNAL_MODE: '1',
		WEBUI_SECRET_STORE_BACKEND: 'external-broker',
		WEBUI_KMS_ACCESS_TOKEN: 'plain-env-kms-token',
	},
	{ broker: productionShapedBroker, requireProductionConnector: true },
);
assert.equal(policy.configOk, false, 'external broker config rejects plaintext KMS env tokens');
assert(policy.configErrors.some((e) => /WEBUI_KMS_ACCESS_TOKEN/.test(e)), 'plaintext KMS token env var name is reported');
assert(!JSON.stringify(policy).includes('plain-env-kms-token'), 'plaintext KMS token value is never echoed');

const tenantA = createSecretStore({ backend: 'external-broker', tenantId: 'tenant_a', broker });
const tenantB = createSecretStore({ backend: 'external-broker', tenantId: 'tenant_b', broker });
const key = { kind: 'credential', name: 'system:login' };
const ref = tenantA.ref(key.kind, key.name);

let meta = await tenantA.putBytes({ ...key, bytes: 'alpha-broker-secret' });
assert.equal(meta.backend, 'external-broker', 'broker metadata reports external backend');
assert.equal(meta.externalBroker, true, 'broker metadata marks external broker');
assert.equal(meta.encrypted, true, 'broker metadata is KMS/encrypted by contract');
assert.equal(meta.pathExposed, false, 'broker metadata exposes no path');
assert.equal(meta.present, true, 'broker secret is present');
assert.equal(meta.usable, true, 'broker secret is usable');
assert(!JSON.stringify(meta).includes('alpha-broker-secret'), 'broker metadata never exposes raw bytes');

await assert.rejects(() => tenantA.getBytes(ref), /runner secret broker/, 'WebUI raw reads are blocked');
await assert.rejects(() => tenantA.getJson(ref), /runner secret broker/, 'WebUI raw JSON reads are blocked');
await assert.rejects(() => broker.getBytes({ tenantId: 'tenant_a', ...key }), /runner secret broker/, 'fake broker also requires runner purpose');

let clear = await tenantA.getBytes(ref, { purpose: 'runner-secret-broker' });
assert.equal(clear.toString('utf8'), 'alpha-broker-secret', 'runner broker purpose can read bytes');

const otherTenant = await tenantB.describeSecret(key);
assert.equal(otherTenant.present, false, 'same kind/name in another tenant is isolated');
await assert.rejects(() => tenantB.getBytes(key, { purpose: 'runner-secret-broker' }), /not found/, 'cross-tenant raw read fails');

meta = await tenantA.rotate({ ...key, bytes: 'beta-broker-secret' });
assert.equal(meta.version, 2, 'broker rotate increments version');
clear = await tenantA.getBytes(ref, { purpose: 'runner-secret-broker' });
assert.equal(clear.toString('utf8'), 'beta-broker-secret', 'broker rotate replaces bytes');

await tenantA.putJsonObjectFields({
	kind: 'flow-values',
	name: 'checkout',
	values: { input_1: 'broker-json-one', input_2: 'broker-json-two' },
});
await tenantA.putJsonObjectFields({
	kind: 'flow-values',
	name: 'checkout',
	values: { input_3: 'broker-json-three' },
});
const keys = await tenantA.describeJsonObjectKeys({ kind: 'flow-values', name: 'checkout' });
assert.deepEqual(keys.jsonObjectKeys, ['input_1', 'input_2', 'input_3'], 'broker exposes JSON keys as metadata');
assert.equal(keys.parseStatus, 'object', 'broker reports JSON object status');
const keySummary = JSON.stringify(keys);
for (const raw of ['broker-json-one', 'broker-json-two', 'broker-json-three']) {
	assert(!keySummary.includes(raw), `JSON key metadata must not expose ${raw}`);
}
const json = await tenantA.getJson({ kind: 'flow-values', name: 'checkout' }, { purpose: 'runner-secret-broker' });
assert.equal(json.input_3, 'broker-json-three', 'runner broker purpose can read JSON when needed');

let deleted = await tenantA.delete(ref);
assert.equal(deleted.ok, true, 'broker delete reports ok');
assert.equal(deleted.deleted, true, 'broker delete removes existing record');
meta = await tenantA.describeSecret(key);
assert.equal(meta.present, false, 'deleted broker secret is absent');
deleted = await tenantA.delete(ref);
assert.equal(deleted.deleted, false, 'broker delete is idempotent');

console.log('  webui-secret-broker-unit: external broker/KMS contract checks passed');
NODE
)
