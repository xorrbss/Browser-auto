# Operator Handoff Pack

Status: operator-owned production evidence checklist
Date: 2026-06-11
Scope: production/external-service evidence for the Browser-auto WebUI, runner, headed browser/noVNC
boundary, secret storage, and audit delivery.

This pack is for the real operator handoff after the local deterministic gates are green. It does not
grant service-open approval by itself. `P0-SERVICE-OPEN.md` remains the acceptance checklist, and this
file names the evidence operators must attach before an external-service Go decision can be reviewed.

## Ground Rules

- Local fixture evidence is required, but it is not production evidence. Passing
  `bash tests/security-p0-gate.test.sh`, `bash run.sh`, local external runner smoke tests, encrypted-local
  checks, and fake webhook connector tests proves only deterministic repo contracts.
- Production evidence must come from operator-owned infrastructure: the real IdP/SSO boundary, real
  KMS or secret broker, real TLS noVNC boundary or confirmed disablement, deployed external runner
  hosts, and a deployed audit webhook receiver.
- Agents may prepare flows, docs, static reports, and fixture gates. Agents must not complete SSO, OTP,
  MFA, account recovery, live target selection, live approval, secret rotation, artifact release, or
  irreversible actions.
- Do not include real secrets in this pack, logs, screenshots, tickets, or exported artifacts. Use
  opaque references such as `aqa-secret://tenant_a/auth-state/canonical:myapp`,
  `aqa-secret://tenant_a/credential/myapp`, `aqa-secret://tenant_a/token/runner-a`, and
  `aqa-secret://tenant_a/token/audit-webhook`.
- Run commands from the repository root with Git Bash on Windows unless the command explicitly belongs
  to a Linux/Docker deployment host.
- Evidence must be redacted before attachment: no raw auth state, cookies, bearer tokens, `.values.json`,
  OTP seeds, passwords, customer data, browser profiles, screenshots, downloads, or raw webhook payloads.

## Baseline Fixture Gate

Who runs it: release operator or repo maintainer on a clean checkout, before any production handoff.

Commands:

```bash
cd approve
npm ci
npx playwright install chrome
cd ..

bash tests/security-p0-gate.test.sh
bash run.sh
node bin/release-checklist.mjs --markdown --artifacts-dir artifacts
node bin/blocked-flow-report.mjs --flows flows --format markdown
```

Expected pass criteria:

- `security-p0-gate` passes without live auth, non-local target replay, live-action execution, or a real
  audit webhook.
- `bash run.sh` passes the deterministic suite; operator-only/app-bound flows may be skipped by default.
- The release checklist still reports `Decision: No-Go` until the operator evidence below is attached.
- The blocked-flow report is metadata-only and does not read auth-state contents, `.values.json`, raw
  cookies, or artifacts.

Artifacts to attach:

- Command transcript with timestamps and commit hash.
- `artifacts/<RUN_ID>/report.json`, `artifacts/<RUN_ID>/report.junit.xml`, and `results.tsv` when
  generated, after secret/artifact review.
- Markdown output from `node bin/release-checklist.mjs --markdown --artifacts-dir artifacts`.
- Markdown output from `node bin/blocked-flow-report.mjs --flows flows --format markdown`.

No-Go conditions:

- Any fixture gate fails and is not explained by an owner-approved exception.
- The fixture lane contacts a real target, uses SSO/OTP, reads live auth-state contents, or executes a
  live-action flow.
- The release decision is treated as Go because local tests are green.

## IdP / SSO Production Evidence

Who runs it:

- IdP owner or platform identity administrator configures the provider.
- Browser-auto owner/admin validates role mapping and session behavior.
- Operator captures redacted evidence. Agents do not sign in, handle OTP/MFA, or inspect sessions.

Required env/config shape:

Choose exactly one production auth boundary. `static` and `local-pilot` are fixture/local modes, not
production IdP evidence.

OIDC shape:

```bash
WEBUI_EXTERNAL_MODE=1
WEBUI_PUBLIC_URL=https://console.example.test
WEBUI_AUTH_PROVIDER=oidc
WEBUI_OIDC_ISSUER=https://idp.example.test/tenant_a
WEBUI_OIDC_DISCOVERY_URL=https://idp.example.test/tenant_a/.well-known/openid-configuration
WEBUI_OIDC_JWKS_URI=https://idp.example.test/tenant_a/keys
WEBUI_OIDC_CLIENT_ID=<redacted-client-id-or-config-id>
WEBUI_OIDC_USER_CLAIM=sub
WEBUI_OIDC_TENANT_CLAIM=tenant
WEBUI_OIDC_ROLE_CLAIM=role
WEBUI_ALLOWED_ORIGINS=https://console.example.test
WEBUI_SESSION_SAMESITE=Strict
WEBUI_SESSION_TTL_SECONDS=<positive-number>
```

SAML shape:

```bash
WEBUI_EXTERNAL_MODE=1
WEBUI_PUBLIC_URL=https://console.example.test
WEBUI_AUTH_PROVIDER=saml
WEBUI_SAML_SSO_URL=https://idp.example.test/sso
WEBUI_SAML_ENTITY_ID=<redacted-entity-id>
WEBUI_SAML_CERT_FINGERPRINT=<certificate-fingerprint-only>
WEBUI_SAML_USER_ATTRIBUTE=user
WEBUI_SAML_TENANT_ATTRIBUTE=tenant
WEBUI_SAML_ROLE_ATTRIBUTE=role
WEBUI_ALLOWED_ORIGINS=https://console.example.test
WEBUI_SESSION_SAMESITE=Strict
WEBUI_SESSION_TTL_SECONDS=<positive-number>
```

Authenticated proxy shape:

```bash
WEBUI_EXTERNAL_MODE=1
WEBUI_PUBLIC_URL=https://console.example.test
WEBUI_AUTH_PROVIDER=auth-proxy
WEBUI_AUTH_PROXY_ISSUER=<redacted-proxy-issuer>
WEBUI_AUTH_PROXY_TRUSTED=1
WEBUI_AUTH_PROXY_HEADER_USER=x-aqa-user
WEBUI_AUTH_PROXY_HEADER_TENANT=x-aqa-tenant
WEBUI_AUTH_PROXY_HEADER_ROLE=x-aqa-role
WEBUI_ALLOWED_ORIGINS=https://console.example.test
WEBUI_SESSION_SAMESITE=Strict
WEBUI_SESSION_TTL_SECONDS=<positive-number>
```

Commands or evidence to collect:

- Keep the local contract commands with the pack, clearly marked fixture-only:

```bash
bash tests/webui-auth-context-unit.test.sh
bash tests/webui-idp-verifier-unit.test.sh
bash tests/webui-rbac-unit.test.sh
bash tests/webui-security-unit.test.sh
```

- From the production deployment, collect redacted startup/config evidence showing external mode,
  provider type, public HTTPS URL, allowed origins, distinct user/tenant/role mappings, session TTL,
  cookie settings, and no local-pilot bypass.
- Sign in as at least `viewer`, `operator`, and `owner` or `admin` users in `tenant_a`. Attach redacted
  claim/assertion/token metadata proving user, tenant, and role values are present and mapped.
- Verify unauthenticated access to pages, API routes, artifact routes, release-checklist routes, job
  streams, and noVNC entry points returns 401 or redirects to the IdP.
- Verify a `viewer` can read only redacted status/report surfaces and receives 403 for run, record,
  approve, cancel, secret migration, tenant deletion, release-checklist handoff, audit detail, and admin
  metadata routes.
- Verify an `operator` can run permitted fixture/local jobs and read operator-gated metadata, but cannot
  manage tenant users or approve owner-only live-action scope.
- Verify session logout and expiry invalidate API access, page access, event streams, artifact access,
  and noVNC access.
- Verify cookie-authenticated mutations require same-origin `Origin` or `Referer` and a valid
  `X-AQA-CSRF` token. Verify foreign origins fail closed even with a valid session.
- Capture browser devtools or proxy evidence that session cookies are `Secure`, `HttpOnly`, and
  `SameSite` as configured. Do not attach cookie values.

Expected pass criteria:

- Every externally reachable route is behind authenticated tenant-scoped identity.
- User, tenant, and role mappings are distinct and deterministic.
- Role denials match the local RBAC model: viewer read-only, operator supervised work, owner/admin
  owner-level approval and administration.
- HTTPS public URL, deny-by-default CORS, CSRF, session expiry, logout, and secure cookies are proven in
  the production deployment.
- noVNC and artifact/event routes are covered by the same identity boundary or are disabled.

Artifacts/evidence to attach:

- Redacted IdP app/client configuration export or screenshots.
- Redacted claim/assertion/token metadata for each role, with issuer, audience/entity, expiry, tenant,
  and role visible but no token body or signature material.
- HTTP transcript or test report for unauthenticated, viewer, operator, owner/admin, logout, expiry,
  CSRF, and foreign-origin checks.
- Cookie flag screenshot or proxy transcript with values redacted.
- Operator signoff naming the IdP owner, tenant, tested roles, tested URL, and test timestamp.

No-Go/fail-closed conditions:

- `WEBUI_AUTH_PROVIDER=local-pilot` or `static` is the only evidence for an external deployment.
- `WEBUI_PUBLIC_URL` is not HTTPS for cookie-session deployment.
- User, tenant, or role mapping is missing, duplicated, or ambiguous.
- Wildcard CORS is accepted, CSRF is missing for cookie-authenticated mutations, or foreign-origin
  mutation succeeds.
- A viewer can start jobs, run/record/approve/cancel, read secret-bearing metadata, or access another
  tenant.
- Unauthenticated page/API/artifact/SSE/noVNC access succeeds.
- Session logout or expiry does not revoke access.
- Real token, assertion, cookie, OTP, or auth-state content appears in evidence.

## KMS / Secret Broker Production Evidence

Who runs it:

- Security/platform owner provisions the KMS key or secret broker.
- Browser-auto owner/admin approves the migration plan and rollback evidence.
- Operator runs the migration workflow and captures metadata-only evidence. Agents must not read, paste,
  rotate, delete, or export secrets.

Required env/config shape:

```bash
WEBUI_EXTERNAL_MODE=1
WEBUI_TENANT_ID=tenant_a
WEBUI_SECRET_STORE_BACKEND=external-broker
WEBUI_SECRET_BROKER_PROVIDER=<provider-id>
WEBUI_SECRET_BROKER_ID=<connector-id>
WEBUI_SECRET_BROKER_KMS_KEY_ID=<tenant-a-key-id-or-alias>
WEBUI_SECRET_BROKER_TENANT_SCOPED=1
WEBUI_SECRET_BROKER_ENCRYPTED_AT_REST=1
WEBUI_SECRET_BROKER_ROTATION_SUPPORTED=1
WEBUI_SECRET_BROKER_DELETE_SUPPORTED=1
```

Required reference classes:

```text
aqa-secret://tenant_a/auth-state/canonical:myapp
aqa-secret://tenant_a/flow-values/checkout
aqa-secret://tenant_a/credential/myapp
aqa-secret://tenant_a/cookie-jar/myapp
aqa-secret://tenant_a/otp-seed/myapp
aqa-secret://tenant_a/token/runner-a
aqa-secret://tenant_a/token/audit-webhook
aqa-secret://tenant_a/browser-profile/session-root
```

Commands or evidence to collect:

- Keep the local contract commands with the pack, clearly marked fixture-only:

```bash
bash tests/webui-secret-store-unit.test.sh
bash tests/webui-secret-broker-unit.test.sh
bash tests/webui-secret-migration-workflow-unit.test.sh
bash tests/webui-secret-migration-route-unit.test.sh
bash tests/webui-secret-migration-api-unit.test.sh
bash tests/webui-external-secret-mode-unit.test.sh
```

- In production or an owner-approved staging deployment with the real broker, collect broker metadata
  proving tenant scoping, encrypted at-rest storage, KMS key identity, rotation support, deletion
  support, access policy, and audit logging. Attach metadata only.
- Run headed auth only as the operator who owns the account, with external-broker mode enabled, and
  verify the temporary storageState is imported into an `aqa-secret://...` auth-state ref and removed:

```bash
WEBUI_EXTERNAL_MODE=1 \
WEBUI_SECRET_STORE_BACKEND=external-broker \
bash setup/auth.sh <app> <login-url> '<success-url>'
```

- Run the WebUI secret migration workflow through dry-run, plan, owner approve, stage, commit, and
  status using operator/owner sessions and idempotency keys. Capture only sanitized response metadata:
  required ref count, present count, missing count, broker scope, rollback checkpoint count, rotation
  readiness, deletion readiness, state transitions, and approval manifest hash.
- Rotate a non-production smoke secret under `aqa-secret://tenant_a/credential/handoff-smoke`, prove a
  subsequent metadata read sees the new version, and prove the retired version cannot be used.
- Delete a non-production smoke secret under `aqa-secret://tenant_a/credential/handoff-delete`, prove
  future use fails closed, and attach broker audit metadata for delete.
- Scan repo, deployment config, logs, job rows, artifacts, and export bundles for plaintext auth states,
  cookies, passwords, OTPs, bearer tokens, `.values.json`, and KMS credentials.

Expected pass criteria:

- External/service mode refuses plaintext local auth state and `.values.json` storage.
- Secret refs are tenant-scoped and use the expected kind/name shape.
- Broker/KMS evidence proves encryption at rest, tenant-scoped access, rotation, deletion, and audit.
- Migration workflow is metadata-only and has owner approval plus rollback evidence before commit.
- Auth state captured by `setup/auth.sh` lands behind `aqa-secret://tenant_a/auth-state/...`; raw
  temporary plaintext is removed.
- No child-process command line, stored job record, WebUI response, report, log, artifact, or export
  leaks secret bytes.

Artifacts/evidence to attach:

- Broker/KMS configuration export with key IDs, policy IDs, tenant scope, and connector ID redacted as
  needed.
- Sanitized secret migration dry-run, plan, approval, stage, commit, rollback/status evidence.
- Rotation and deletion smoke evidence for non-production smoke refs.
- Auth-state import evidence showing the `aqa-secret://...` ref and cleanup status, not file contents.
- Secret scan report across repo/deployment/log/artifact/export locations.
- Operator and owner approval manifest hashes with timestamps.

No-Go/fail-closed conditions:

- `WEBUI_SECRET_STORE_BACKEND=encrypted-local`, `local-pilot-file`, or a gitignored plaintext file is
  presented as production KMS/broker evidence.
- `WEBUI_LOCAL_PILOT_PLAINTEXT_SECRETS=1` is enabled outside a documented local pilot.
- Any plaintext credential env var is used for the broker or KMS, including `WEBUI_SECRET_BROKER_TOKEN`,
  `WEBUI_SECRET_BROKER_API_KEY`, `WEBUI_SECRET_BROKER_CLIENT_SECRET`, `WEBUI_KMS_ACCESS_TOKEN`, or
  related `AQA_*` variants.
- Broker metadata does not prove tenant scoping, encryption at rest, rotation, or deletion.
- Secret migration commit is attempted without owner approval, idempotency, or rollback evidence.
- A `fixtures/auth/**/*.state.json`, `flows/*.values.json`, cookie jar, OTP seed, browser profile, or
  credential remains repo-adjacent plaintext in external/service mode.
- Evidence contains secret bytes, cookies, token bodies, auth-state JSON, OTP seeds, or raw form values.

## noVNC / TLS / Browser Isolation Production Evidence

Who runs it:

- Platform/network owner deploys the TLS proxy or confirms noVNC is disabled.
- Browser-auto operator validates headed browser session isolation, cancellation, timeout, cleanup, and
  route authorization.
- Owner/admin signs off before noVNC is exposed beyond loopback. Agents must not expose WebUI/noVNC or
  drive operator-owned headed auth.

Required env/config shape:

Preferred external/service mode shape, no exposed noVNC:

```bash
WEBUI_EXTERNAL_MODE=1
NOVNC_DISABLE=1
```

If headed browser/noVNC must be exposed, it must be behind an authenticated TLS boundary:

```bash
WEBUI_EXTERNAL_MODE=1
NOVNC_AUTH_BOUNDARY=authenticated-proxy
NOVNC_PROXY_TLS=1
NOVNC_PROXY_AUTH=tenant-session
NOVNC_PROXY_URL=https://novnc.example.test
WEBUI_NOVNC_BROWSER_ROOT=/srv/aqa/browser-sessions
```

Do not set shared profile or download roots in external mode. Browser profile and download paths must
be derived per tenant/job/session under `WEBUI_NOVNC_BROWSER_ROOT`.

Commands or evidence to collect:

- Keep the local contract commands with the pack, clearly marked fixture-only:

```bash
bash tests/docker-entrypoint-unit.test.sh
bash tests/novnc-boundary-unit.test.sh
bash tests/novnc-cleanup-unit.test.sh
WEBUI_EXTERNAL_MODE=1 bash docker/entrypoint.sh --check-config
WEBUI_EXTERNAL_MODE=1 NOVNC_DISABLE=1 bash docker/entrypoint.sh --check-config
```

- If using authenticated proxy mode, run the deployment config check on the deployment host:

```bash
WEBUI_EXTERNAL_MODE=1 \
NOVNC_AUTH_BOUNDARY=authenticated-proxy \
NOVNC_PROXY_TLS=1 \
NOVNC_PROXY_AUTH=tenant-session \
NOVNC_PROXY_URL=https://novnc.example.test \
WEBUI_NOVNC_BROWSER_ROOT=/srv/aqa/browser-sessions \
bash docker/entrypoint.sh --check-config
```

- Collect TLS certificate chain, proxy routing, authentication policy, websocket upgrade policy, and
  network ACL evidence. Redact private keys and session tokens.
- Verify raw VNC (`5900`) is not exposed outside the container/host boundary and raw noVNC (`6080`) is
  not publicly reachable unless it is reachable only through the authenticated TLS proxy.
- Verify unauthenticated noVNC HTTP and websocket requests fail before any browser pixels or session
  metadata are returned.
- Verify a `tenant_b` user cannot connect to a `tenant_a` noVNC session by guessing session ID, job ID,
  websocket path, or URL.
- Start two sessions for different tenants or jobs and prove profile, storage state, downloads, and
  browser state are isolated. Use synthetic fixture pages, not live business data.
- Cancel a job, let a session idle-expire, and finish a job; prove browser context teardown and derived
  profile/download cleanup each occur.
- Restart the service and prove stale sessions are closed or reconciled to a safe terminal state.

Expected pass criteria:

- External/service startup refuses passwordless exposed noVNC unless `NOVNC_DISABLE=1` or the
  authenticated TLS proxy boundary is configured.
- TLS is valid, noVNC websocket upgrade requires tenant/session auth, and no unauthenticated browser
  access is possible.
- Session IDs are unguessable and tenant/job/session scoped.
- Profile, storage, downloads, screenshots/video if enabled, and browser state do not cross tenants or
  jobs.
- Cancel, timeout, completion, and restart all close browser contexts and record teardown metadata.

Artifacts/evidence to attach:

- Redacted deployment env/config summary and `docker/entrypoint.sh --check-config` transcript.
- TLS/proxy configuration summary and certificate chain metadata.
- HTTP/websocket denial transcripts for unauthenticated, wrong-tenant, expired, canceled, and guessed
  session access.
- Session allocation and cleanup manifests with tenant/job/session IDs and sanitized paths.
- File listing or cleanup audit showing profile/download/session roots removed or tombstoned after
  cancel/timeout/completion.
- Network scan or firewall evidence showing raw VNC/noVNC ports are not directly exposed.

No-Go/fail-closed conditions:

- Passwordless noVNC is exposed outside loopback.
- `NOVNC_PROXY_URL` is HTTP or TLS/auth is missing.
- `NOVNC_PROXY_AUTH` is not `tenant-session`.
- `WEBUI_NOVNC_BROWSER_ROOT` is missing, relative, too broad, shared across sessions, or paired with
  shared profile/download roots.
- A wrong-tenant or unauthenticated websocket upgrade succeeds.
- Browser profile, cookies, local storage, downloads, screenshots, video, or page state crosses tenants
  or jobs.
- Cancel/timeout/completion/restart leaves a reachable browser session or recoverable sensitive files.

## External Runner Deployment Production Evidence

Who runs it:

- Platform/operator team deploys runner hosts.
- Browser-auto operator enqueues supervised jobs and captures runner/job/audit metadata.
- Owner approves any non-local target and any live-action scope. Agents must not choose live targets,
  use auth state, or run live-action lanes.

Required env/config shape:

Control plane must run in external/service posture with durable jobs and audit enabled. Runner hosts use
outbound polling only.

```bash
WEBUI_RUNNER_MODE=production
WEBUI_RUNNER_ID=runner-a
WEBUI_RUNNER_TENANT_ID=tenant_a
WEBUI_RUNNER_DEPLOYMENT_ID=prod-a
WEBUI_RUNNER_TOKEN_REF=aqa-secret://tenant_a/token/runner-a
WEBUI_RUNNER_API_URL=https://console.example.test/api/runner
WEBUI_RUNNER_API_AUTH_TOKEN_REF=aqa-secret://tenant_a/token/webui-runner-api
WEBUI_RUNNER_POLL_MS=3000
WEBUI_RUNNER_HEARTBEAT_MS=5000
WEBUI_RUNNER_LEASE_MS=60000
AQA_GIT_BASH=C:/Program Files/Git/bin/bash.exe
```

`WEBUI_RUNNER_API_AUTH_TOKEN_REF` is the deployment-renderer source ref for the process-only
`WEBUI_RUNNER_API_AUTH_TOKEN` expected by `bin/runner-worker.mjs`. The actual bearer value must be
injected by the operator's secret mechanism and must not be written to docs, logs, shell history,
screenshots, or tickets. Evidence should name only the secret ref and a redacted hash/fingerprint.

Commands or evidence to collect:

- Keep the local contract commands with the pack, clearly marked fixture-only:

```bash
node bin/local-external-runner-smoke.mjs
bash tests/local-external-runner-e2e.test.sh
bash tests/runner-worker-unit.test.sh
bash tests/runner-contract-unit.test.sh
bash tests/runner-api-unit.test.sh
bash tests/runner-api-route-unit.test.sh
bash tests/jobs-durable-unit.test.sh
```

- On each production runner host, collect runtime readiness:

```bash
node --version
"$AQA_GIT_BASH" --version
node bin/runner-worker.mjs --help
```

- Start the runner as a managed service or supervised process with the production env above. Capture
  service definition metadata with secrets redacted.
- Enqueue a benign fixture or owner-approved staging-readonly job and run one worker poll:

```bash
node bin/runner-worker.mjs --api https://console.example.test/api/runner --once
```

- Prove a queued durable job is persisted before claim, claimed only by the expected runner identity,
  heartbeated while running, and completed with `succeeded`, `failed`, or `canceled`.
- Prove cancellation stops a running child process and records a durable terminal state.
- Restart the control plane during a claimed/running test job and prove reconciliation marks unknown
  work safe (`interrupted`, `expired`, `failed`, or verified terminal result), never silently green.
- Prove runner logs sent to the control plane are redacted and bounded by `WEBUI_RUNNER_MAX_LOG_LINES`.
- Prove runner hosts have no inbound control-plane exposure; runner communication is outbound to
  `/api/runner/*`.
- For non-local read lanes, use only explicit operator commands with exact allowlists:

```bash
AQA_RUN_MODE=staging \
AQA_TARGET_ALLOWLIST=https://host.example.test \
bash bin/operator-staging-readonly.sh --validate-only <flow-name>

AQA_RUN_MODE=staging \
AQA_TARGET_ALLOWLIST=https://host.example.test \
bash bin/operator-staging-readonly.sh <flow-name>
```

Expected pass criteria:

- Runner identity includes runner ID, tenant ID, deployment ID, and tenant-scoped token ref.
- Jobs are durable before claim and state transitions survive restart.
- Runner claims only authorized tenant/deployment jobs and cannot claim another tenant's work.
- Heartbeat, lease, cancellation, bounded logs, and terminal reporting work in the deployed topology.
- Job audit append failure blocks spawn or interrupts pre-spawn work in external/service mode.
- No job commandSpec, argv, env, stored row, result, or log exposes auth state, cookies, `.values.json`,
  bearer tokens, form values, or raw customer data.

Artifacts/evidence to attach:

- Redacted runner service config, deployment manifest, version, host identity, and network policy.
- Runner identity validation output with token ref only.
- Durable job records showing queued, claimed, running, heartbeat, cancel, and terminal states.
- Redacted runner logs and control-plane job event stream.
- Restart reconciliation evidence.
- Audit events for enqueue, claim, heartbeat, cancel, completion, and artifact metadata.
- Operator approval for any staging/live-readonly target origin and exact `AQA_TARGET_ALLOWLIST`.

No-Go/fail-closed conditions:

- Local `node bin/local-external-runner-smoke.mjs` is presented as deployed production runner evidence.
- Runner uses in-memory-only jobs, lacks restart reconciliation, or can mark unknown in-flight work
  succeeded after restart.
- Runner identity is missing tenant, deployment, or token ref.
- Runner API token or runner token appears as plaintext in env dumps, logs, screenshots, process lists,
  command lines, tickets, or artifacts.
- A runner can claim another tenant's job.
- Cancellation does not stop the child process or terminal state is ambiguous.
- A runner executes non-local or live-action work without explicit operator allowlist/run mode and owner
  approval.
- Scheduler or CI can execute live-action work.

## Audit Webhook Delivery Production Evidence

Who runs it:

- Security/audit owner provisions the webhook receiver and retention policy.
- Platform/operator team configures Browser-auto audit sink and outbox scheduler.
- Browser-auto operator generates test audit events and captures delivery metadata. Agents must not
  configure real webhook secrets or inspect raw audit payloads.

Required env/config shape:

```bash
WEBUI_EXTERNAL_MODE=1
WEBUI_TENANT_ID=tenant_a
WEBUI_AUDIT_SINK=webhook
WEBUI_AUDIT_SINK_TENANT_ID=tenant_a
WEBUI_AUDIT_SINK_URL=https://audit.example.test/hook
WEBUI_AUDIT_SINK_TOKEN_REF=aqa-secret://tenant_a/token/audit-webhook
WEBUI_AUDIT_OUTBOX_INTERVAL_MS=30000
WEBUI_AUDIT_OUTBOX_BACKOFF_MS=30000
WEBUI_AUDIT_OUTBOX_MAX_BACKOFF_MS=300000
```

If a separate outbox worker process is used, it must use the same tenant-scoped token ref. Do not use
`WEBUI_AUDIT_SINK_TOKEN`, `AQA_AUDIT_SINK_TOKEN`, `WEBUI_AUDIT_OUTBOX_TOKEN`, or related plaintext
token env vars.

Commands or evidence to collect:

- Keep the local contract commands with the pack, clearly marked fixture-only:

```bash
bash tests/audit-outbox-worker-unit.test.sh
bash tests/audit-outbox-scheduler-unit.test.sh
bash tests/runner-contract-unit.test.sh
bash tests/jobs-durable-unit.test.sh
bash tests/release-checklist-unit.test.sh
```

- In production or owner-approved staging with the real webhook receiver, validate webhook config before
  generating delivery evidence. Attach config summary with target URL origin, tenant ID, token ref, retry
  policy, and connector ID only.
- Generate at least these audit events in the deployed system: login/session creation, unauthorized
  access denial, job enqueue, job claim, heartbeat, cancellation, successful fixture/staging job
  completion, artifact metadata read, egress denial, noVNC access denial or noVNC disabled event, secret
  migration dry-run/status read.
- Prove outbox rows are created with hash-only/redacted envelopes and no raw business payload.
- Prove the scheduler or worker delivers due rows to the real webhook endpoint, records delivery status,
  and does not mutate rows when config is unsafe.
- Prove retry and dead-letter classification by using an owner-approved receiver failure mode or test
  endpoint. Do not use a fake connector for production evidence.
- Prove the audit receiver can search by tenant, actor, route/event, job ID, flow/recipe hash, runner ID,
  and timestamp.
- Prove webhook token rotation with `aqa-secret://tenant_a/token/audit-webhook` or a smoke token ref, and
  prove the old credential is refused.

Expected pass criteria:

- Audit sink config requires HTTPS URL and a tenant-scoped secret reference.
- Plaintext audit token env vars are refused.
- Audit events are append-only locally and delivered externally with stable hash/envelope metadata.
- Delivery status transitions are persisted (`pending`, retrying/failed as applicable, delivered, or
  dead-lettered) and survive restart.
- Receiver evidence proves the deployed endpoint received the expected events and no raw secrets or raw
  business payloads.
- Delivery failures are fail-closed for required audit paths: unsafe config or audit append failure
  prevents process spawn or keeps work in a safe interrupted state.

Artifacts/evidence to attach:

- Redacted webhook receiver configuration, URL origin, tenant mapping, retention policy, and access
  policy.
- Redacted Browser-auto audit sink/outbox env summary.
- Outbox row metadata: audit ID, tenant, sink ID, payload hash, status, attempt count, timestamps, and
  error class. No payload body.
- Receiver-side delivery evidence with request ID, event hash, tenant, actor, route/event, job ID, and
  timestamp. No bearer token, raw body, cookies, or target business data.
- Retry/dead-letter evidence and recovery evidence.
- Rotation evidence for the audit webhook token ref.

No-Go/fail-closed conditions:

- Fake connector delivery, JSONL-only local sink, or local temp-DB smoke is presented as production
  webhook delivery evidence.
- `WEBUI_AUDIT_SINK_URL` is HTTP or points to an unapproved receiver.
- Webhook credential is plaintext in env, logs, process list, stored job row, screenshot, ticket, or
  artifact.
- Token ref is not tenant-scoped or belongs to another tenant.
- Outbox envelope includes raw secret bytes, cookies, bearer tokens, form values, screenshots, downloads,
  or raw business payload.
- Delivery failure is silently marked successful.
- Required audit append failure still allows a queued/claimed job to spawn in external/service mode.
- Receiver cannot prove event receipt, retention, searchability, or tamper resistance.

## Final Handoff Decision Checklist

Operator and owner must attach one evidence bundle per section above. The release review remains No-Go
until every answer below is yes.

- [ ] Baseline fixture gate is green and marked local/contract-only.
- [ ] IdP/SSO production evidence proves real authentication, tenant identity, role authorization,
  secure sessions, CSRF/origin controls, and logout/expiry.
- [ ] KMS/secret broker evidence proves external-broker storage, tenant scoping, encryption, rotation,
  deletion, migration approval, rollback evidence, and no plaintext local secret state.
- [ ] noVNC is disabled or protected by authenticated TLS tenant/session proxy, with per-session browser
  isolation and cleanup evidence.
- [ ] External runner deployment evidence proves outbound-only workers, durable jobs, heartbeat,
  cancellation, restart reconciliation, redacted logs, tenant-scoped identity, and exact allowlists for
  any non-local run.
- [ ] Audit webhook delivery evidence proves real receiver delivery, retry/dead-letter behavior,
  required audit fail-closed behavior, and tenant-scoped token refs.
- [ ] No evidence bundle contains real secrets, raw auth state, cookies, OTP/MFA material, bearer tokens,
  `.values.json`, browser profiles, downloads, screenshots, or raw business data.
- [ ] `node bin/release-checklist.mjs --markdown --artifacts-dir artifacts` is rerun after evidence is
  attached, and any remaining No-Go item has an owner decision recorded as No-Go or deferred scope.

Final No-Go conditions:

- Any section above is missing production/operator evidence.
- Any production claim relies only on local fixtures, fake connectors, encrypted-local storage,
  `local-pilot`, loopback WebUI, or localhost noVNC.
- Any operator-only lane was run by CI or an agent.
- Any live-action/effectful flow crosses `irreversibleAt` without dry-run evidence, explicit run mode,
  exact allowlist, owner approval, audit append success, and a stop/rollback owner.
- Any secret, auth material, raw tenant data, or unreviewed artifact leaks into the evidence pack.
