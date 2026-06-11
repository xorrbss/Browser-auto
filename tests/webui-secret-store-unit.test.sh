#!/usr/bin/env bash
# Browser-free checks for encrypted tenant-scoped WebUI secret storage.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

( cd "$DIR" && TMP="$TMP" node --input-type=module - <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createSecretStore, makeSecretRef, parseSecretRef } from './webui/secrets.js';

const rootDir = process.env.TMP;
const store = createSecretStore({
	backend: 'encrypted-local',
	rootDir,
	tenantId: 'tenant_a',
	keyMaterial: 'deterministic-local-test-key',
	keyId: 'unit-key',
});

const key = { kind: 'credential', name: 'system:login' };
const ref = makeSecretRef({ tenantId: 'tenant_a', ...key });
assert.deepEqual(parseSecretRef(ref), { tenantId: 'tenant_a', kind: key.kind, name: key.name, ref }, 'secret refs are tenant/kind/name scoped');

let meta = await store.putBytes({ ...key, bytes: 'alpha-secret-value' });
assert.equal(meta.ref, ref, 'put returns the opaque secret ref');
assert.equal(meta.backend, 'encrypted-local', 'encrypted backend is reported');
assert.equal(meta.tenantId, 'tenant_a', 'tenant id is preserved');
assert.equal(meta.encrypted, true, 'record is encrypted');
assert.equal(meta.plaintextLocal, false, 'encrypted records are not local plaintext');
assert.equal(meta.present, true, 'record is present');
assert.equal(meta.usable, true, 'configured encrypted record is usable');
assert.equal(meta.pathExposed, false, 'metadata does not expose a local path');
assert.equal(meta.rotationSupported, true, 'rotation is supported');
assert.equal(meta.deleteSupported, true, 'delete is supported');

await assert.rejects(() => store.getBytes(ref), /runner secret broker/, 'raw bytes require an explicit broker purpose');
await assert.rejects(() => store.getJson(ref), /runner secret broker/, 'raw JSON reads also require the runner broker purpose');
let clear = await store.getBytes(ref, { purpose: 'runner-secret-broker' });
assert.equal(clear.toString('utf8'), 'alpha-secret-value', 'broker-only read returns original bytes');

const filePath = store.secretFilePath({ tenantId: 'tenant_a', ...key });
const rawRecord = fs.readFileSync(filePath, 'utf8');
assert(!rawRecord.includes('alpha-secret-value'), 'encrypted file does not contain plaintext secret');
assert(!JSON.stringify(meta).includes('alpha-secret-value'), 'metadata does not contain plaintext secret');

const otherTenant = createSecretStore({
	backend: 'encrypted-local',
	rootDir,
	tenantId: 'tenant_b',
	keyMaterial: 'deterministic-local-test-key',
});
const missingOtherTenant = await otherTenant.describeSecret(key);
assert.equal(missingOtherTenant.present, false, 'same kind/name in another tenant is isolated');

meta = await store.rotate({ ...key, bytes: 'beta-secret-value' });
assert.equal(meta.version, 2, 'rotation increments the version');
clear = await store.getBytes(ref, { purpose: 'runner-secret-broker' });
assert.equal(clear.toString('utf8'), 'beta-secret-value', 'rotation replaces bytes');
const rotatedRecord = fs.readFileSync(filePath, 'utf8');
assert(!rotatedRecord.includes('alpha-secret-value') && !rotatedRecord.includes('beta-secret-value'), 'rotated file still has no plaintext');

const listed = await store.list({ kind: 'credential' });
assert.equal(listed.length, 1, 'list returns tenant credential metadata');
assert.equal(listed[0].ref, ref, 'list uses refs, not file paths');

const valuesMeta = await store.putJsonObjectFields({
	kind: 'flow-values',
	name: 'checkout',
	values: { input_1: 'json-secret-one', input_2: 'json-secret-two' },
});
assert.equal(valuesMeta.encrypted, true, 'JSON field merge writes encrypted metadata');
const keyMeta = await store.describeJsonObjectKeys({ kind: 'flow-values', name: 'checkout' });
assert.deepEqual(keyMeta.jsonObjectKeys, ['input_1', 'input_2'], 'JSON metadata exposes keys only');
assert(!JSON.stringify(keyMeta).includes('json-secret-one'), 'JSON metadata does not expose values');

let deleted = await store.delete(ref);
assert.equal(deleted.ok, true, 'delete reports ok');
assert.equal(deleted.deleted, true, 'delete reports an existing record was removed');
meta = await store.describeSecret(key);
assert.equal(meta.present, false, 'deleted secret is absent');
deleted = await store.delete(ref);
assert.equal(deleted.deleted, false, 'second delete is idempotent');

console.log('  webui-secret-store-unit: encrypted tenant secret store checks passed');
NODE
)
