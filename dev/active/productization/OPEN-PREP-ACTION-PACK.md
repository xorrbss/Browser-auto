# Open Prep Action Pack

Status: prep checklist, external-service no-go
Date: 2026-06-11
Scope: concrete owner/operator inputs needed to move Browser-auto from local readiness toward an
operator-approved staging or live-readonly opening.

This pack is the working "what do we do next" sheet. It does not replace `P0-SERVICE-OPEN.md`,
`OPERATOR-HANDOFF-PACK.md`, `PRODUCTION-CONFIG-TEMPLATES.md`, or `STAGING-ACCEPTANCE-LANE.md`.

## Current Decision

`node bin/release-checklist.mjs --markdown --artifacts-dir artifacts` still reports `Decision: No-Go`.
That is expected. The repo has strong fixture gates and handoff templates, but external opening still
needs operator-owned evidence for real infrastructure.

The safe opening path is:

1. Open only an operator-approved staging or live-readonly pilot first.
2. Keep live-action, destructive, and unattended approval flows out of scope.
3. Attach evidence for IdP, KMS/secret broker, noVNC, egress, external runner, audit webhook, and
   staging acceptance before asking for a broader external-service Go decision.

## Recommended First Opening Scope

Use this as the default unless an owner explicitly narrows or broadens it:

```text
opening_mode: staging-readonly-pilot
allowed_flow_scope: read-only flows only
excluded_scope: live-action, destructive, unattended approval, OTP automation, account recovery
initial_flows:
  - approval_office_hiworks_com_ibizsoftware_net_approval
  - nav-roundtrip
  - ianatour
blocked_flows:
  - guest_samsungdisplay_com_argos_main_do
  - hiworks01
```

Why:

- `approval_office_hiworks_com_ibizsoftware_net_approval`, `nav-roundtrip`, and `ianatour` are
  operator-only/non-local, not CI failures.
- `guest_samsungdisplay_com_argos_main_do` and `hiworks01` still have `needs_review` and live-action
  gates. They should not be part of the first opening.

## What The Owner Must Provide

The owner/operator should fill this section. Do not put real secret values here.

```yaml
opening:
  mode: staging-readonly-pilot
  target_date:
  go_reviewer:
  stop_contact:
  evidence_ticket:

tenant:
  tenant_id:
  operator_account:
  owner_account:
  viewer_account:

webui:
  public_url:
  allowed_origins:
  allowed_hosts:
  deployment_mode: production

idp:
  provider: oidc # oidc | saml | auth-proxy
  issuer_or_sso_url:
  client_id_or_entity_id:
  jwks_or_cert_fingerprint:
  user_claim_or_header:
  tenant_claim_or_header:
  role_claim_or_header:
  auth_users_json_ref: aqa-secret://tenant_a/webui/auth-users-json
  auth_sessions_json_ref: aqa-secret://tenant_a/webui/auth-sessions-json

secret_broker:
  provider:
  connector_id:
  kms_key_id:
  workload_identity_ref: aqa-secret://tenant_a/secret-broker/workload-identity
  decrypt_grant_ref: aqa-secret://tenant_a/kms/decrypt-grant
  tenant_scoped: true
  encrypted_at_rest: true
  rotation_supported: true
  delete_supported: true

novnc:
  mode: disabled # disabled | authenticated-proxy
  proxy_url:
  browser_root:
  tls_required: true
  auth_boundary: tenant-session

egress:
  target_allowlist:
  resolver_evidence_source:
  connection_ip_evidence_source:
  on_prem_profile_required: false

external_runner:
  runner_id:
  deployment_id:
  runner_token_ref: aqa-secret://tenant_a/runners/runner-tenant-a-01/token
  runner_api_url:
  runner_api_auth_token_ref: aqa-secret://tenant_a/webui/runner-api-bearer
  host_identity:

audit_webhook:
  sink_url:
  connector_id:
  token_ref: aqa-secret://tenant_a/audit-webhook/bearer-token
  outbox_worker_token_ref: aqa-secret://tenant_a/audit-webhook/outbox-worker-token
  receiver_owner:
```

## What Codex Can Do Before The Owner Replies

These are local-only and safe to run without live target access:

```bash
git status --short --branch
node bin/release-checklist.mjs --markdown --artifacts-dir artifacts
node bin/blocked-flow-report.mjs --flows flows --format markdown
bash tests/security-p0-gate.test.sh
```

Expected result:

- Fixture gate passes.
- Release checklist remains No-Go.
- Blocked-flow report shows read-only operator-only flows plus blocked live-action flows.

## What The Operator Runs After Inputs Exist

Use the exact flow name and target origin approved by the owner.

Validate the static flow inventory:

```bash
node bin/blocked-flow-report.mjs --flows flows --format markdown
```

Validate the read-only replay envelope:

```bash
AQA_RUN_MODE=staging \
AQA_TARGET_ALLOWLIST=https://staging.example.com \
AQA_EGRESS_RESOLVER_EVIDENCE='<fresh resolver evidence JSON>' \
AQA_EGRESS_REQUIRE_FRESH_RESOLVER_EVIDENCE=1 \
AQA_EGRESS_REQUIRE_CONNECTION_IP_EVIDENCE=1 \
bash bin/operator-staging-readonly.sh --validate-only <flow-name>
```

Run the staging read-only acceptance:

```bash
AQA_RUN_MODE=staging \
AQA_TARGET_ALLOWLIST=https://staging.example.com \
AQA_EGRESS_RESOLVER_EVIDENCE='<fresh resolver evidence JSON>' \
AQA_EGRESS_REQUIRE_FRESH_RESOLVER_EVIDENCE=1 \
AQA_EGRESS_REQUIRE_CONNECTION_IP_EVIDENCE=1 \
bash bin/operator-staging-readonly.sh <flow-name>
```

For production read-only acceptance, switch only the approved mode and origin:

```bash
AQA_RUN_MODE=live-readonly \
AQA_TARGET_ALLOWLIST=https://app.example.com \
AQA_EGRESS_RESOLVER_EVIDENCE='<fresh resolver evidence JSON>' \
AQA_EGRESS_REQUIRE_FRESH_RESOLVER_EVIDENCE=1 \
AQA_EGRESS_REQUIRE_CONNECTION_IP_EVIDENCE=1 \
bash bin/operator-staging-readonly.sh <flow-name>
```

## Evidence To Attach

Attach redacted evidence only:

- Commit hash and clean worktree status.
- `security-p0-gate` pass transcript.
- Release checklist markdown showing No-Go plus required evidence.
- Blocked-flow report markdown.
- IdP metadata validation and real login/session evidence with token bodies redacted.
- Secret broker connector descriptor and rotation/delete smoke evidence using `aqa-secret://...` refs.
- noVNC disabled evidence or authenticated TLS proxy evidence.
- Egress allowlist, resolver freshness, and connection-IP evidence for each target host.
- External runner identity/preflight output with token refs only.
- Audit webhook outbox delivery evidence with hash-only/redacted payloads.
- Staging/live-readonly acceptance artifacts for each approved flow.

## Immediate Owner Questions

Answer these first. They determine the work order.

1. Is the first opening `staging-readonly-pilot`, `live-readonly-pilot`, or broader external-service?
2. Which tenant ID and operator/owner/viewer accounts should be used?
3. Which exact flow should be the first acceptance run?
4. Which exact target origin is approved for that flow?
5. Is noVNC disabled for the first opening, or is an authenticated TLS proxy required?
6. Which IdP mode is approved: OIDC, SAML, or auth-proxy?
7. Which production secret broker/KMS will own `aqa-secret://tenant/...` refs?
8. Which host or deployment will run the external runner?
9. Which audit webhook receiver will store delivery evidence?
10. Who can stop the pilot immediately if egress, auth, audit, or tenant-boundary evidence is wrong?

## Hard Stops

Stop the opening attempt if any of these are true:

- The owner asks to include `guest_samsungdisplay_com_argos_main_do` or `hiworks01` before repairing
  `needs_review`, irreversible gates, dry-run evidence, and owner approval.
- Any secret value, cookie, OTP seed, auth-state JSON, `.values.json`, bearer token, or raw business
  payload is required for evidence.
- The target allowlist is broad, missing, or includes redirects not approved by the owner.
- Resolver or connection-IP evidence is missing or stale.
- noVNC is exposed without `NOVNC_DISABLE=1` or an authenticated TLS tenant-session proxy.
- The audit webhook uses plaintext token env vars instead of `*_TOKEN_REF`.
- External runner identity lacks tenant ID, deployment ID, or token ref.
- Release checklist is treated as Go while any P0 item is still contract-only or external-blocked.
