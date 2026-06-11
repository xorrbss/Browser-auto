#!/usr/bin/env bash
# Browser-free checks for external-mode plaintext secret blocking and encrypted backend use.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
APP="_secretapp_$$"
FLOW="_secretflow_$$"
AUTH="$DIR/fixtures/auth/playwright/$APP.state.json"
FLOW_FILE="$DIR/flows/$FLOW.flow.json"
VALUES_FILE="$DIR/flows/$FLOW.values.json"
trap 'rm -rf "$TMP"; rm -f "$AUTH" "$FLOW_FILE" "$VALUES_FILE"' EXIT

mkdir -p "$DIR/fixtures/auth/playwright" "$DIR/flows"
cat > "$AUTH" <<JSON
{
  "cookies": [
    { "name": "session", "value": "LOCAL_AUTH_SECRET_$APP", "domain": ".example.test" }
  ],
  "origins": []
}
JSON
cat > "$FLOW_FILE" <<JSON
{
  "name": "$FLOW",
  "engine": "playwright",
  "environment": "local",
  "riskClass": "read",
  "app": "$APP",
  "startUrl": "http://127.0.0.1/",
  "steps": [
    { "kind": "fill", "by": "label", "value": "Email", "text": "{{input_1}}" }
  ],
  "asserts": []
}
JSON
cat > "$VALUES_FILE" <<JSON
{
  "input_1": "LOCAL_VALUE_SECRET_$FLOW"
}
JSON

set +e
SETUP_OUT="$(cd "$DIR" && WEBUI_EXTERNAL_MODE=1 WEBUI_TENANT_ID=tenant_a bash setup/auth.sh "$APP" http://127.0.0.1/login '**/done' 2>&1)"
SETUP_CODE=$?
set -e
if [ "$SETUP_CODE" -eq 0 ]; then
	echo "  webui-external-secret-mode-unit: setup/auth.sh should fail without a secret backend" >&2
	exit 1
fi
case "$SETUP_OUT" in
	*"opening headed Playwright login"*)
		echo "  webui-external-secret-mode-unit: setup/auth.sh opened browser before secret backend validation" >&2
		exit 1 ;;
esac
case "$SETUP_OUT" in
	*"plaintext local secrets are blocked"*) ;;
	*)
		echo "  webui-external-secret-mode-unit: setup/auth.sh did not report plaintext blocking" >&2
		echo "$SETUP_OUT" >&2
		exit 1 ;;
esac

( cd "$DIR" && env WEBUI_EXTERNAL_MODE=1 WEBUI_TENANT_ID=tenant_a APP="$APP" FLOW="$FLOW" node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { authReadinessForApp } from './webui/auth.js';
import { getFlow, saveValues } from './webui/flows.js';

const auth = await authReadinessForApp(process.env.APP);
assert.equal(auth.ready, false, 'external mode does not use plaintext auth without a backend');
assert.equal(auth.state, 'blocked-plaintext-secret', 'plaintext auth is reported as blocked');
assert.equal(auth.sources.some((s) => s.localPlaintextStorage?.blocked === true), true, 'source metadata marks local plaintext blocked');
assert.equal(auth.sources.some((s) => s.localPlaintextStorage?.backend === 'forbidden-plaintext'), true, 'blocked auth metadata identifies forbidden plaintext backend');

const flow = await getFlow(process.env.FLOW);
assert.equal(flow.valuesStorage.backend, 'forbidden-plaintext', 'blocked values metadata identifies forbidden plaintext backend');
assert.equal(flow.valuesStorage.blocked, true, 'plaintext values metadata is blocked');
assert.equal(flow.valuesStorage.usable, false, 'plaintext values are unusable');
assert.equal(flow.scenarioStatus.state, 'blocked-values', 'flow status fails closed on blocked values');
assert.equal(flow.missingValues.includes('input_1'), true, 'blocked sidecar is not used to satisfy tokens');
assert.match(flow.valuesBlockedReason, /blocked/, 'blocked values reason is explicit');
const saved = await saveValues(process.env.FLOW, { input_1: 'SHOULD_NOT_WRITE' });
assert.equal(saved.ok, false, 'external mode refuses plaintext value writes without encrypted backend');

const serialized = JSON.stringify({ auth, flow, saved });
for (const raw of ['LOCAL_AUTH_SECRET_', 'LOCAL_VALUE_SECRET_', 'SHOULD_NOT_WRITE', 'fixtures/auth', '.values.json']) {
	assert(!serialized.includes(raw), `external blocked summaries must not expose ${raw}`);
}

	console.log('  webui-external-secret-mode-unit: blocked plaintext mode passed');
NODE
)

( cd "$DIR" && env WEBUI_EXTERNAL_MODE=1 WEBUI_TENANT_ID=tenant_a WEBUI_SECRET_STORE_BACKEND=external-broker APP="$APP" FLOW="$FLOW" node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { authReadinessForApp } from './webui/auth.js';
import { getFlow, saveValues } from './webui/flows.js';

const auth = await authReadinessForApp(process.env.APP);
assert.equal(auth.ready, false, 'external broker without KMS/adapter is not ready');
assert.equal(auth.state, 'secret-backend-unavailable', 'auth fails closed on unavailable broker config');
assert.equal(auth.sources.some((s) => (s.backendConfigErrors || []).some((e) => /KMS key id is missing/.test(e))), true, 'auth reports missing broker KMS key');

const flow = await getFlow(process.env.FLOW);
assert.equal(flow.valuesStorage.backend, 'external-broker', 'flow values use external-broker metadata when requested');
assert.equal(flow.valuesStorage.blocked, true, 'unconfigured broker metadata is blocked');
assert.equal(flow.scenarioStatus.state, 'blocked-values', 'flow fails closed on unavailable broker config');
assert.match(flow.valuesBlockedReason, /KMS key id is missing/, 'flow reports missing broker KMS key');
const saved = await saveValues(process.env.FLOW, { input_1: 'SHOULD_NOT_WRITE_KMS' });
assert.equal(saved.ok, false, 'unavailable broker refuses value writes');
assert.match(saved.error, /KMS key id is missing/, 'save reports missing broker KMS key');

const serialized = JSON.stringify({ auth, flow, saved });
for (const raw of ['LOCAL_AUTH_SECRET_', 'LOCAL_VALUE_SECRET_', 'SHOULD_NOT_WRITE_KMS', 'fixtures/auth', '.values.json']) {
	assert(!serialized.includes(raw), `missing-KMS summaries must not expose ${raw}`);
}

console.log('  webui-external-secret-mode-unit: missing external KMS mode passed');
NODE
)

( cd "$DIR" && env WEBUI_EXTERNAL_MODE=1 WEBUI_TENANT_ID=tenant_a WEBUI_SECRET_STORE_BACKEND=encrypted-local WEBUI_SECRET_STORE_KEY=deterministic-local-test-key WEBUI_SECRET_STORE_DIR="$TMP/store" APP="$APP" FLOW="$FLOW" node --input-type=module - <<'NODE'
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createSecretStore } from './webui/secrets.js';

const store = createSecretStore();
await store.putBytes({ kind: 'flow-values', name: process.env.FLOW, bytes: JSON.stringify({ input_1: 'ENCRYPTED_VALUE_SECRET' }) });

const { authReadinessForApp, deleteAuthState, getAuthState, storeAuthState } = await import('./webui/auth.js');
const { getFlow, saveValues } = await import('./webui/flows.js');

const storedAuth = await storeAuthState(process.env.APP, '{"cookies":[{"name":"session","value":"ENCRYPTED_AUTH_SECRET"}],"origins":[]}');
assert.equal(storedAuth.ok, true, 'auth module stores captured state in the encrypted backend');
assert.equal(storedAuth.secretStorage.encrypted, true, 'stored auth state returns encrypted metadata only');
assert.match(storedAuth.secretStorage.ref, /^aqa-secret:\/\/tenant_a\/auth-state\//, 'stored auth state returns an opaque secret ref');

const auth = await authReadinessForApp(process.env.APP);
assert.equal(auth.ready, true, 'encrypted auth state is ready in external mode');
assert.equal(auth.source, 'canonical', 'canonical encrypted auth is selected');
assert.equal(auth.sources.some((s) => s.secretStorage?.encrypted === true && s.secretStorage?.present === true), true, 'encrypted auth metadata is present');
assert.equal(auth.sources.some((s) => /^aqa-secret:\/\/tenant_a\/auth-state\//.test(s.secretStorage?.ref || '')), true, 'encrypted auth metadata uses secret refs');

let rawAuth = await getAuthState(process.env.APP);
assert.equal(rawAuth.ok, false, 'auth state raw get requires runner broker purpose');
rawAuth = await getAuthState(process.env.APP, { purpose: 'runner-secret-broker' });
assert.equal(rawAuth.ok, true, 'runner broker purpose can retrieve encrypted auth state');
assert(rawAuth.bytes.toString('utf8').includes('ENCRYPTED_AUTH_SECRET'), 'encrypted auth get reads backend bytes for the runner broker');

const flow = await getFlow(process.env.FLOW);
assert.equal(flow.valuesStorage.encrypted, true, 'encrypted values metadata is reported');
assert.equal(flow.valuesStorage.present, true, 'encrypted values are present');
assert.match(flow.valuesStorage.ref, /^aqa-secret:\/\/tenant_a\/flow-values\//, 'flow values metadata uses secret refs');
assert.equal(flow.missingValues.length, 0, 'encrypted values satisfy token presence without exposing bytes');
assert.notEqual(flow.scenarioStatus.state, 'blocked-values', 'encrypted values are not blocked');
assert.equal(flow.valueStatus.input_1.state, 'saved', 'token is marked saved from encrypted storage');

const saved = await saveValues(process.env.FLOW, { input_2: 'ROTATED_ENCRYPTED_VALUE_SECRET' });
assert.equal(saved.ok, true, 'external encrypted mode saves values to the encrypted backend');
assert.equal(saved.secretStorage.encrypted, true, 'save returns encrypted metadata only');
const savedJson = await store.getJson({ kind: 'flow-values', name: process.env.FLOW }, { purpose: 'runner-secret-broker' });
assert.equal(savedJson.input_2, 'ROTATED_ENCRYPTED_VALUE_SECRET', 'encrypted value store rotates saved content');
const localSidecar = fs.readFileSync(`flows/${process.env.FLOW}.values.json`, 'utf8');
assert(!localSidecar.includes('ROTATED_ENCRYPTED_VALUE_SECRET'), 'encrypted save does not write the plaintext sidecar');

const deleted = await deleteAuthState(process.env.APP);
assert.equal(deleted.ok, true, 'deleteAuthState deletes encrypted backend auth state');
assert(deleted.backendDeleted >= 1, 'deleteAuthState reports backend deletion');
const afterDeleteMeta = await store.describeSecret({ kind: 'auth-state', name: `canonical:${process.env.APP}` });
assert.equal(afterDeleteMeta.present, false, 'encrypted auth state is gone after delete');
const afterDeleteAuth = await authReadinessForApp(process.env.APP);
assert.equal(afterDeleteAuth.ready, false, 'auth readiness is no longer ready after backend delete');

const serialized = JSON.stringify({ auth, flow, saved });
for (const raw of ['ENCRYPTED_AUTH_SECRET', 'ENCRYPTED_VALUE_SECRET', 'ROTATED_ENCRYPTED_VALUE_SECRET', 'LOCAL_AUTH_SECRET_', 'LOCAL_VALUE_SECRET_']) {
	assert(!serialized.includes(raw), `encrypted summaries must not expose ${raw}`);
}

console.log('  webui-external-secret-mode-unit: encrypted backend mode passed');
NODE
)

cat > "$AUTH" <<JSON
{
  "cookies": [
    { "name": "session", "value": "LOCAL_AUTH_SECRET_$APP", "domain": ".example.test" }
  ],
  "origins": []
}
JSON

( cd "$DIR" && env WEBUI_EXTERNAL_MODE=1 WEBUI_TENANT_ID=tenant_a WEBUI_LOCAL_PILOT_PLAINTEXT_SECRETS=1 APP="$APP" FLOW="$FLOW" node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import { authReadinessForApp } from './webui/auth.js';
import { getFlow } from './webui/flows.js';

const auth = await authReadinessForApp(process.env.APP);
assert.equal(auth.ready, true, 'documented local-pilot bypass keeps plaintext auth usable');
assert.equal(auth.state, 'ready', 'bypass preserves local pilot readiness');
assert.equal(auth.sources.some((s) => s.secretStorage?.localPilotBypass === true), true, 'auth metadata declares bypass');

const flow = await getFlow(process.env.FLOW);
assert.equal(flow.valuesStorage.localPilotBypass, true, 'values metadata declares bypass');
assert.equal(flow.missingValues.length, 0, 'bypass uses local values for pilot compatibility');
assert.equal(flow.valueStatus.input_1.state, 'saved', 'token is marked saved under bypass');

const serialized = JSON.stringify({ auth, flow });
for (const raw of ['LOCAL_AUTH_SECRET_', 'LOCAL_VALUE_SECRET_', 'fixtures/auth']) {
	assert(!serialized.includes(raw), `bypass summaries must not expose ${raw}`);
}

console.log('  webui-external-secret-mode-unit: local-pilot bypass mode passed');
NODE
)
