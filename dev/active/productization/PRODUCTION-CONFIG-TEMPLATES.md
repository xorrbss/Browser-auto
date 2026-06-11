# Production Config Templates

These are copy-adaptable operator templates for production connector and deployment configuration.
They are not directly executable as-is: every placeholder must be reviewed, rendered by the deployment
system, and validated before the service starts. Keep these examples in source control only as
templates; do not commit rendered files, real bearer tokens, cookies, passwords, OTP seeds, auth-state
JSON, or provider credentials.

The examples use `tenant_a` and `prod-a` placeholders. Secret references intentionally use
`aqa-secret://tenant_a/...` style refs; provider-native `kms://`, `vault://`,
`aws-secretsmanager:`, `azure-keyvault://`, or `gcp-secretmanager://` refs are also supported by the
runtime validators where a `*_REF` variable is expected. Plaintext secret env values are not allowed
for production connector identities.

Validation commands below are configuration-only checks for Windows + Git Bash. They must not run live
auth, OTP, target-owned browser actions, or operator-owned target execution.

## Shared Placeholder Rules

- Replace `tenant_a`, `runner-tenant-a-01`, `prod-a`, hostnames, paths, and connector IDs with the
  operator-approved deployment values.
- Values named `*_REF` must be opaque secret references, not the secret material itself.
- Source-controlled templates carry only `aqa-secret://tenant_a/...` references. If the deployment
  platform renders those refs into runtime env vars, the rendered values are process-only material:
  do not write them to a checked-in file, evidence bundle, shell history, or ticket.
- URLs used by production WebUI, audit, and noVNC boundaries must be `https://` and must not contain
  credentials, query strings, fragments, or tokens.
- These templates do not approve service-open by themselves. They only document the contract that a
  production operator must adapt and validate.

## Audit Webhook Connector

Template:

```bash
# audit-webhook.env.template
export WEBUI_TENANT_ID="tenant_a"
export WEBUI_AUDIT_SINK_TENANT_ID="tenant_a"
export WEBUI_AUDIT_SINK="webhook"
export WEBUI_AUDIT_SINK_URL="https://audit.tenant-a.example.test/agent-qa/webhook"
export WEBUI_AUDIT_SINK_TOKEN_REF="aqa-secret://tenant_a/audit-webhook/bearer-token"
export WEBUI_AUDIT_SINK_CONNECTOR="tenant-a-prod-audit-webhook-v1"

# Optional scheduler tuning for the audit outbox drain worker.
export WEBUI_AUDIT_OUTBOX_SCHEDULER="enabled"
export WEBUI_AUDIT_OUTBOX_INTERVAL_MS="30000"
export WEBUI_AUDIT_OUTBOX_BACKOFF_MS="30000"
export WEBUI_AUDIT_OUTBOX_MAX_BACKOFF_MS="300000"

# Optional separate worker credential reference. This is still a ref, never a plaintext token.
export WEBUI_AUDIT_OUTBOX_TOKEN_REF="aqa-secret://tenant_a/audit-webhook/outbox-worker-token"
```

Connector boundary:

```text
connector.deliverAuditOutbox(envelope, context)

context keys: auditId, outboxId, sinkId, tenantId, now
envelope kind: webui-audit-outbox
target: metadata only, including host/origin/hash fields
payload: hash, byte count, redacted=true, body=null
credential lookup: resolve WEBUI_AUDIT_SINK_TOKEN_REF through the production secret broker
```

Validation:

```bash
node - <<'NODE'
const audit = require('./lib/audit-sink.js');
const worker = require('./lib/audit-outbox-worker.js');

const cfg = audit.validateAuditSinkConfig(process.env);
const readiness = audit.auditSinkDeploymentReadiness(process.env, { production: true });
const workerCfg = worker.assertAuditOutboxWorkerConfig({ env: process.env });

console.log(JSON.stringify({ cfg, readiness, workerCfg }, null, 2));
if (!readiness.ok) process.exit(1);
NODE
```

Expected fail-closed behavior:

- `http://` audit URLs, URL credentials, query strings, fragments, missing token refs, unsupported refs,
  and tenant-mismatched refs throw during validation.
- `WEBUI_AUDIT_SINK_TOKEN`, `AQA_AUDIT_SINK_TOKEN`, `WEBUI_AUDIT_OUTBOX_TOKEN`, and equivalent
  plaintext secret env vars are refused before connector delivery.
- A webhook sink without `WEBUI_AUDIT_SINK_CONNECTOR` is not production-ready. Delivery remains
  pending, failed, or dead-lettered through the outbox contract instead of being silently marked
  delivered.

## External Runner Deployment Identity

Template:

```bash
# runner-worker.env.template
export WEBUI_RUNNER_MODE="production"
export WEBUI_RUNNER_ID="runner-tenant-a-01"
export WEBUI_RUNNER_TENANT_ID="tenant_a"
export WEBUI_RUNNER_DEPLOYMENT_ID="prod-a"
export WEBUI_RUNNER_TOKEN_REF="aqa-secret://tenant_a/runners/runner-tenant-a-01/token"

export WEBUI_RUNNER_API_URL="https://console.tenant-a.example.test/api/runner"
export WEBUI_RUNNER_POLL_MS="3000"
export WEBUI_RUNNER_HEARTBEAT_MS="5000"
export WEBUI_RUNNER_LEASE_MS="60000"
export WEBUI_RUNNER_MAX_LOG_LINES="500"

# Optional on Windows if Git Bash is outside the default location.
export AQA_GIT_BASH="C:/Program Files/Git/bin/bash.exe"

# Deployment renderer source ref for the process-only API bearer used by bin/runner-worker.mjs.
# The runtime env name is WEBUI_RUNNER_API_AUTH_TOKEN, but the template records only this ref:
export WEBUI_RUNNER_API_AUTH_TOKEN_REF="aqa-secret://tenant_a/webui/runner-api-bearer"
```

Validation:

```bash
node - <<'NODE'
const runner = require('./lib/runner-contract.js');

const identity = runner.validateRunnerIdentity(process.env);
const contract = runner.buildRunnerContract({ runner: identity });

console.log(JSON.stringify({
  identity: runner.publicRunnerIdentity(identity),
  preflight: contract.preflight,
}, null, 2));
NODE
```

Expected fail-closed behavior:

- `WEBUI_RUNNER_MODE=production` requires `WEBUI_RUNNER_ID`, `WEBUI_RUNNER_TENANT_ID`,
  `WEBUI_RUNNER_DEPLOYMENT_ID`, and `WEBUI_RUNNER_TOKEN_REF`.
- `WEBUI_RUNNER_TOKEN`, `AQA_RUNNER_TOKEN`, request body `token`, and other plaintext runner token
  fields are refused.
- Runner API requests must present a token ref matching the configured runner identity hash; mismatches
  are denied.
- The worker is outbound-only. It does not perform SSO, OTP, target selection, live approval, or
  model-driven decisions; it only executes persisted WebUI-safe command specs.

## KMS And Secret Broker Contract

Production external mode should use an external broker adapter backed by operator-owned KMS or secret
manager infrastructure. Env metadata alone is not enough: the service must also be started with a
broker adapter object that implements the required method contract.

Template:

```bash
# secret-broker.env.template
export WEBUI_EXTERNAL_MODE="1"
export WEBUI_SECRET_STORE_BACKEND="external-broker"

# Connector metadata. Use placeholder IDs here; do not paste real provider credential material.
export WEBUI_SECRET_BROKER_PROVIDER="provider-placeholder"
export WEBUI_SECRET_BROKER_ID="tenant-a-prod-secret-broker"
export WEBUI_SECRET_BROKER_KMS_KEY_ID="kms-key-id-placeholder-tenant-a"
export WEBUI_SECRET_BROKER_TENANT_SCOPED="1"
export WEBUI_SECRET_BROKER_ENCRYPTED_AT_REST="1"
export WEBUI_SECRET_BROKER_ROTATION_SUPPORTED="1"
export WEBUI_SECRET_BROKER_DELETE_SUPPORTED="1"

# Deployment identity and provider credentials are resolved outside this env file, for example:
#   aqa-secret://tenant_a/secret-broker/workload-identity
#   aqa-secret://tenant_a/kms/decrypt-grant
# The app rejects plaintext WEBUI_SECRET_BROKER_*TOKEN, WEBUI_SECRET_BROKER_*KEY,
# WEBUI_KMS_*TOKEN, WEBUI_KMS_*KEY, password, credentials, and client-secret env vars.
```

Required broker method surface:

```text
describeSecret
list
putBytes
rotate
delete
getBytes
describeJsonObjectKeys
putJsonObjectFields
```

Production connector descriptor:

```json
{
  "contractVersion": 1,
  "provider": "provider-placeholder",
  "connectorId": "tenant-a-prod-secret-broker",
  "kmsKeyId": "kms-key-id-placeholder-tenant-a",
  "tenantScoped": true,
  "encryptedAtRest": true,
  "rotationSupported": true,
  "deleteSupported": true,
  "testOnly": false,
  "productionReady": true
}
```

Env-only negative control:

```bash
node --input-type=module - <<'NODE'
import { secretRuntimePolicy } from './webui/secrets.js';

const policy = secretRuntimePolicy(process.env, { requireProductionConnector: true });
console.log(JSON.stringify(policy, null, 2));
if (policy.configOk) {
  console.error('external-broker env unexpectedly passed without a production broker adapter');
  process.exit(1);
}
if (!policy.configErrors.some((error) => /adapter|connector/i.test(error))) process.exit(1);
NODE
```

With the production adapter loaded by the service bootstrap, validate the full contract in that
bootstrap path and require it to pass:

```js
import { assertSecretBackendConfigured } from './webui/secrets.js';

assertSecretBackendConfigured(process.env, {
  backend: 'external-broker',
  broker: productionBrokerAdapter,
  requireProductionConnector: true,
});
```

Expected fail-closed behavior:

- External mode without `WEBUI_SECRET_STORE_BACKEND` blocks plaintext local secrets.
- `WEBUI_SECRET_STORE_BACKEND=external-broker` without an adapter, KMS key ID, tenant scoping,
  encrypted-at-rest declaration, rotation support, deletion support, or `productionReady=true` fails
  validation.
- Test-only brokers are rejected when `requireProductionConnector` is set.
- Raw reads require the runner secret-broker purpose; WebUI metadata paths do not expose raw bytes,
  local paths, cookies, auth state, or flow values.

## External-Mode WebUI Production Env

Template:

```bash
# webui-production.env.template
export WEBUI_EXTERNAL_MODE="1"
export AQA_EXTERNAL_MODE="1"
export WEBUI_SERVICE_MODE="1"
export WEBUI_REQUIRE_DURABLE_JOBS="1"
export WEBUI_DEPLOYMENT_MODE="production"

export WEBUI_HOST="127.0.0.1"
export WEBUI_PORT="4310"
export WEBUI_PUBLIC_URL="https://console.tenant-a.example.test"
export WEBUI_ALLOWED_HOSTS="console.tenant-a.example.test,127.0.0.1:4310,localhost:4310"
export WEBUI_ALLOWED_ORIGINS="https://console.tenant-a.example.test"

export WEBUI_TENANT_ID="tenant_a"
export WEBUI_AUTH_PROVIDER="oidc"
export WEBUI_OIDC_ISSUER="https://idp.tenant-a.example.test/tenant-a"
export WEBUI_OIDC_DISCOVERY_URL="https://idp.tenant-a.example.test/tenant-a/.well-known/openid-configuration"
export WEBUI_OIDC_JWKS_URI="https://idp.tenant-a.example.test/tenant-a/keys"
export WEBUI_OIDC_CLIENT_ID="tenant-a-browser-auto"
export WEBUI_OIDC_USER_CLAIM="sub"
export WEBUI_OIDC_TENANT_CLAIM="tenant"
export WEBUI_OIDC_ROLE_CLAIM="role"

# Current WebUI external mode still needs deterministic bearer/session material after provider
# metadata validation. The source-controlled template records only refs consumed by the deployment
# renderer; it must not contain WEBUI_AUTH_USERS, WEBUI_AUTH_SESSIONS, or WEBUI_AUTH_TOKEN values.
export WEBUI_AUTH_USERS_JSON_REF="aqa-secret://tenant_a/webui/auth-users-json"
export WEBUI_AUTH_SESSIONS_JSON_REF="aqa-secret://tenant_a/webui/auth-sessions-json"

export WEBUI_SESSION_SAMESITE="Strict"
export WEBUI_SESSION_TTL_SECONDS="28800"

export AQA_DB_PATH="C:/ProgramData/agent-qa/tenant_a/webui.sqlite"
export WEBUI_KEEP_RUNS="1000"

# Include the secret-broker env contract above so external mode does not fall back to plaintext local
# secret storage.

# Prefer disabling noVNC in production unless a separate authenticated TLS boundary is configured.
export NOVNC_DISABLE="1"
```

For SAML or auth-proxy deployments, replace the OIDC provider variables with the supported metadata and
claim/header mapping variables from `webui/security.js`. Keep the current integration boundary clear:
OIDC/SAML metadata is validated only, auth-proxy headers are not trusted directly by this build, and
the rendered runtime still needs deterministic bearer/session material. `WEBUI_AUTH_PROVIDER=static`
is allowed for local fixture smoke checks, but it is not production handoff evidence.

Validation:

```bash
node --input-type=module - <<'NODE'
import {
  authProviderConfig,
  configuredCorsPolicy,
  securityModeSummary,
  sessionCookieDeploymentPreflight,
} from './webui/security.js';

const summary = securityModeSummary(process.env);
const provider = authProviderConfig(process.env);
const cors = configuredCorsPolicy(process.env);
const cookie = sessionCookieDeploymentPreflight(process.env);

console.log(JSON.stringify({ summary, provider, cors, cookie }, null, 2));
if (!provider.valid || !cors.ok || !cookie.ok) process.exit(1);
NODE
```

After the deployment renderer injects process-only auth material from the `*_REF` values above, run the
same preflight and require `summary.configured === true`. Do not attach the rendered env or auth JSON as
evidence; attach only the redacted summary, provider metadata origins, tenant ID, role count, and secret
refs.

Expected fail-closed behavior:

- External mode returns `503` before serving protected pages, APIs, artifacts, job streams, or noVNC
  route stubs if auth provider metadata or bearer/session material is missing.
- Cookie-session deployments require an HTTPS `WEBUI_PUBLIC_URL`; disabling secure cookies in external
  mode does not make cookies insecure.
- Wildcard CORS is refused. Mutating browser requests require same-origin or an explicit
  `WEBUI_ALLOWED_ORIGINS` match; cookie-authenticated mutations also require CSRF.
- WebUI middleware does not protect a separately exposed noVNC endpoint. noVNC must be disabled or
  independently fronted by authenticated TLS.

## noVNC TLS/Auth Boundary

Preferred production template:

```bash
# novnc-disabled.env.template
export WEBUI_EXTERNAL_MODE="1"
export WEBUI_SERVICE_MODE="1"
export NOVNC_DISABLE="1"
```

Authenticated proxy exception template:

```bash
# novnc-authenticated-proxy.env.template
export WEBUI_EXTERNAL_MODE="1"
export WEBUI_SERVICE_MODE="1"
export NOVNC_DISABLE="0"
export NOVNC_AUTH_BOUNDARY="authenticated-proxy"
export NOVNC_PROXY_TLS="1"
export NOVNC_PROXY_AUTH="tenant-session"
export NOVNC_PROXY_URL="https://novnc.tenant-a.example.test"
export WEBUI_NOVNC_BROWSER_ROOT="C:/ProgramData/agent-qa/tenant_a/browser-sessions"

# Do not set shared profile/download roots in external mode:
#   WEBUI_NOVNC_PROFILE_ROOT
#   WEBUI_NOVNC_DOWNLOAD_ROOT
#   NOVNC_PROFILE_ROOT
#   NOVNC_DOWNLOAD_ROOT
```

Validation:

```bash
# Preferred disabled boundary.
WEBUI_EXTERNAL_MODE=1 NOVNC_DISABLE=1 bash docker/entrypoint.sh --check-config

# Authenticated proxy boundary.
WEBUI_EXTERNAL_MODE=1 \
NOVNC_AUTH_BOUNDARY=authenticated-proxy \
NOVNC_PROXY_TLS=1 \
NOVNC_PROXY_AUTH=tenant-session \
NOVNC_PROXY_URL=https://novnc.tenant-a.example.test \
WEBUI_NOVNC_BROWSER_ROOT=C:/ProgramData/agent-qa/tenant_a/browser-sessions \
bash docker/entrypoint.sh --check-config

# Negative control: this must fail closed in external mode.
WEBUI_EXTERNAL_MODE=1 bash docker/entrypoint.sh --check-config
```

Optional WebUI-side boundary check:

```bash
node --input-type=module - <<'NODE'
import { noVncRegistryFromEnv, validateNoVncExternalBoundary } from './webui/novnc.js';

const boundary = validateNoVncExternalBoundary(process.env);
const registry = noVncRegistryFromEnv(process.env);

console.log(JSON.stringify({ boundary, registryError: registry.error || '' }, null, 2));
if (!boundary.ok || registry.error) process.exit(1);
NODE
```

Expected fail-closed behavior:

- Production-like modes refuse passwordless noVNC unless `NOVNC_DISABLE=1` or
  `NOVNC_AUTH_BOUNDARY=authenticated-proxy`.
- The authenticated proxy boundary requires `NOVNC_PROXY_TLS=1`, `NOVNC_PROXY_AUTH=tenant-session`,
  an optional `NOVNC_PROXY_URL` that starts with `https://`, and an absolute dedicated
  `WEBUI_NOVNC_BROWSER_ROOT`.
- Shared profile or download roots are refused in external mode; per-tenant/job/session profile and
  download roots are derived from `WEBUI_NOVNC_BROWSER_ROOT`.
- noVNC session route metadata is tenant/job scoped and rejects unauthorized, cross-tenant, expired,
  canceled, closed, finished, or idle sessions before proxying any browser control.
