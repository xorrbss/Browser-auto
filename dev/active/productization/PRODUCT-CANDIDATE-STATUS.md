# Browser-auto Product Candidate Status

Status: internal-pilot candidate, external-service no-go
Date: 2026-06-11

This status file summarizes the current productization pass. `P0-SERVICE-OPEN.md` remains the source
of truth for external-service acceptance; this file records what is implemented now and what still
blocks service open.

## Implemented In This Pass

- External mode gate: `WEBUI_EXTERNAL_MODE=1` now requires authenticated tenant context before any
  page, API, artifact, noVNC, or job stream route can proceed.
- External auth provider configuration now validates `static`, `oidc`, `saml`, and `auth-proxy`
  shapes fail-closed without integrating live IdP token/assertion exchange.
- OIDC/SAML/auth-proxy provider contracts now require explicit user, tenant, and role claim/header
  mappings; duplicate or malformed mappings fail closed and provider summaries stay redacted.
- Deterministic session primitives now support configured session tokens, expiration, logout
  revocation, secure/SameSite cookie metadata, and route-family authorization checks for local tests.
- External cookie-session deployment preflight requires HTTPS `WEBUI_PUBLIC_URL` metadata before
  configured cookie sessions are accepted.
- External mutating browser requests require same-origin `Origin` or `Referer`; cookie-authenticated
  mutations require CSRF where configured. Bearer tokens remain available for non-browser machine
  access, while foreign origins fail closed.
- CORS is deny-by-default; only exact `WEBUI_ALLOWED_ORIGINS` entries receive preflight/response
  headers, and wildcards fail configuration validation.
- WebUI responses now set baseline security headers and deny direct secret-bearing path shapes such
  as auth state, values sidecars, DB files, and runtime data paths.
- Local RBAC readback now includes tenant/security-mode metadata; queued jobs expose tenant/actor
  metadata.
- Job API, SSE logs, command-plan readback, audit readback, and run failure summaries use shared
  redaction helpers for tokens, cookies, auth headers, OTP/MFA/code fields, URL query strings, IDs,
  emails, and phone numbers.
- Auth readiness summaries expose state, age, domains, and OTP/MFA challenge signals as metadata
  only; they do not expose cookie values, local storage values, or auth-state file paths.
- Flow values are write-only through the WebUI API. `GET /api/flows/:name` returns token presence
  metadata, not raw `.values.json` content.
- Secret storage now has explicit policy states for forbidden plaintext, encrypted-local, and
  external-broker/KMS mode. Broker contracts validate provider, KMS key, tenant scoping, encrypted
  at-rest, rotation, and deletion declarations; deterministic fake brokers are test-only, raw reads
  require runner-secret-broker purpose, and plaintext migration inventory/plans report only sanitized
  counts/path classes.
- Secret migration execution has a metadata-only dry-run contract with operator approval manifests,
  required `aqa-secret:` refs, per-class readiness, and plaintext broker/KMS credential env rejection.
  WebUI route adapters now expose dry-run, plan, approve, stage, commit, rollback, and status as
  tenant-scoped metadata-only API routes with idempotency and fail-closed transition checks.
- Export and retention helpers block secret-bearing paths, unscanned or unredacted files, raw secret
  patterns, cross-tenant artifact reuse, tombstoned artifacts, and missing hashed policy approval
  manifests without echoing secret values in findings.
- Export manifests now model expiry and deterministic signed references; expired, invalidated,
  mismatched, unsigned, or cross-tenant references fail closed, and tenant deletion preflight blocks on
  legal/incident hold metadata.
  Tenant deletion route adapters now expose dry-run, approve, execute, retry, status, and tombstone
  readback with metadata-only responses and tenant/approval-hash checks.
- WebUI job state has SQLite persistence plus a redacted JSONL journal for queued, claimed, running,
  canceling, canceled, succeeded, failed, interrupted, and expired states, duplicate-cancel
  idempotency, runner identity/deployment preflight, tenant-bound claim/heartbeat leases, retry-aware
  restart reconciliation, worker metadata, retention propagation, artifact hashes, local
  tamper-evident audit-chain verification, deterministic JSONL audit-sink validation, and audit outbox
  metadata for fail-closed webhook delivery.
  The `/api/runner/*` route adapter is now mounted for runner pull, claim, heartbeat, complete, and
  cancel against the durable job store. An audit outbox scheduler is started by the WebUI process and
  remains disabled for local sinks while failing closed for webhook delivery without a connector.
  Runner-facing audit delivery now reuses the same sanitized outbox worker contract, so fake connector
  tests cover hash-only envelopes, metadata-only targets, supported secret-reference preflights,
  classified retry/dead-letter behavior, and no mutation when connector configuration is unsafe.
- Flow policy and local Playwright smoke tests now fail closed for metadata start URLs, live-action
  replay without run mode, allowlist, dry-run evidence, and human approval, plus redirect, iframe, and
  initial-navigation egress attempts that resolve to blocked metadata/private targets. Resolver
  freshness, CNAME/canonical metadata, connection-IP evidence, and DNS rebinding mismatch checks are
  deterministic; local WebUI and noVNC control-plane ports are blocked as browser targets even when
  loopback is otherwise permitted.
  The runtime egress adapter is wired into `play-flow` and `pw-rpa` so explicit deterministic resolver
  evidence can feed the same `validateUrlEgress` checks without OS DNS fallback.
- Docker entrypoint refuses passwordless noVNC in external/service/durable production modes unless
  noVNC is disabled or an explicit authenticated proxy boundary with TLS and tenant-session auth is declared.
- noVNC WebUI route stubs model unguessable tenant/job-scoped sessions, hard/idle expiry,
  cancel/finish/closed/restart states, sanitized teardown manifests, and tenant/job/session-scoped
  browser profile/download paths. External mode rejects shared or missing browser roots; authorized
  routes still return a disabled-stub response and do not proxy to noVNC.
- Fixture-only P0 security gate wrapper `tests/security-p0-gate.test.sh` runs current external-mode,
  auth-context, auth-summary, artifact-boundary, secret-store, secret-broker, migration-inventory,
  external-secret-mode, export/retention gates, egress-policy, noVNC entrypoint/route-stub, runner
  policy, local Playwright egress, job redaction/durability, and adjacent P0 negative coverage without
  live auth, non-local targets, or live-action execution.
- WebUI readiness now returns a machine-readable P0 matrix for `P0-A` through `P0-H`, classifying each
  section as `implemented`, `contract-only`, or `external-blocked`, plus a release checklist and CI lane
  skeleton that blocks operator-only work from CI. Matrix/checklist entries now include required
  command/evidence, current evidence, and blocker reason for contract-only and external-blocked gaps, so
  release review remains No-Go until owner/operator evidence exists.
  The WebUI release checklist API now serves metadata-only JSON/Markdown from `/api/release-checklist`,
  and CI lane wrapper scripts keep fixture lanes separate from the blocked operator-only lane.
- The static blocked-flow report now includes unresolved `needs_review` step indices with candidate
  summaries, auth freshness status (`missing`, `stale`, or `ready`) from metadata only, `irreversibleAt`
  warnings, compile/replay blocked reasons, and operator handoff commands/checklists without running
  replay or exposing auth-state paths, raw cookies, values sidecars, or artifacts.
- `ianatour` and `nav-roundtrip` now declare `engine: "playwright"` explicitly.

## Release Gate Command

Run this before internal release-candidate handoff:

```bash
bash tests/security-p0-gate.test.sh
```

This is a local deterministic gate only. It currently covers runner policy/live-action gate checks,
local Playwright smoke and redirect-to-metadata egress refusal, external-mode
auth-provider/CORS/bearer/tenant/origin/CSRF fail-closed behavior, claim/header mapping and HTTPS
cookie deployment preflights, authenticated request context, session expiry/logout helpers, auth
readiness metadata, artifact/static secret boundaries, encrypted-local and external-broker secret
storage contracts, sanitized migration inventory/planning/execution approval manifests, external
plaintext secret blocking, export/retention approval/expiry/signed-ref gates, target egress allowlist,
resolver freshness, runtime resolver-policy checks, DNS mismatch, and control-plane blocking checks,
noVNC lifecycle route-stub refusal and scoped-root validation, job result/SSE redaction, local durable
runner/audit behavior with hash-chain, runner route dispatch, audit outbox worker/scheduler coverage,
and JSONL sink verification, WebUI RBAC denials, effectful-route session guards, redaction, safe
flow-value metadata, release checklist API metadata handling, CI lane guards, and the readiness API's
No-Go default. It does not prove a
real production IdP/KMS/noVNC proxy, real DNS-at-connection enforcement, external runner deployment,
production audit webhook delivery, or live/non-local acceptance.
The fake connector coverage is a readiness contract only; it is not evidence that a deployed webhook
connector, production secret broker, or external runner topology has delivered an audit event.

Latest clean-checkout fixture evidence: Pass on 2026-06-11. A fresh clone of `origin/master` at
commit `b3ee3b6` was prepared with `cd approve && npm ci`, then verified under
`C:\Program Files\Git\bin\bash.exe`. `bash tests/security-p0-gate.test.sh` passed, and `bash run.sh`
passed with `75/75` deterministic tests green; the full-suite run id was `20260611-121719-64`.
Details are recorded in `dev/active/productization/RELEASE-EVIDENCE-2026-06-11.md`. External service
open remains No-Go because the full P0 acceptance checklist is still open.

Additional local external-runner execution on 2026-06-11 passed from a clean `origin/master` worktree:
`node bin/local-external-runner-smoke.mjs` returned `ok: true`, `status: succeeded`,
`workerId: runner-local`, and `auditSinkWritten: true`; the focused runner/rehearsal tests and
`bash tests/security-p0-gate.test.sh` also passed. This is local deterministic contract evidence only,
not proof of a deployed production external runner or production audit webhook delivery.

Additional local audit-webhook execution on 2026-06-11 passed from a clean `origin/master` worktree:
an inline temp-DB smoke delivered one webhook-mode outbox row through a fake connector with
`finalStatus: delivered`, `payloadBody: null`, `payloadRedacted: true`, and `rawLeak: false`; the
focused audit outbox, scheduler, runner contract/API, durable job, release checklist, and
`bash tests/security-p0-gate.test.sh` checks also passed. This is fake-connector contract evidence
only, not proof of a deployed production webhook endpoint, production connector, or real secret broker
delivery.

The readiness matrix is intentionally conservative: current sections are still release-blocking because
real IdP, KMS, noVNC, DNS-at-connection, runner deployment, webhook audit, export, and live-like
acceptance remain external/operator-owned.

## Flow Inventory

| Flow | Status | Blocker |
| --- | --- | --- |
| `login` | Runnable local data URL test | `local/read` data URL; safe for fixture lane. |
| `nav-roundtrip` | Playwright, operator-only; replay PASS evidence | `live-readonly` non-local target `https://example.com`; recorded pass evidence exists in artifact run `20260610-125235-1542`. Future replay still requires operator-selected allowlist and must not run unattended. |
| `ianatour` | Playwright, operator-only; replay PASS evidence | `live-readonly` non-local target `https://www.iana.org/domains`; recorded pass evidence exists in artifact run `20260610-125235-1542`. Future replay still requires operator-selected allowlist and must not run unattended. |
| `approval_office_hiworks_com_ibizsoftware_net_approval` | Playwright, operator-only; validate-only PASS with explicit evidence | App-bound external business URL. Validate-only passes when supplied with `AQA_TARGET_ALLOWLIST=https://approval.office.hiworks.com` and fresh resolver evidence; actual replay remains operator handoff only and requires ready auth, owner-approved target, and allowlist. |
| `guest_samsungdisplay_com_argos_main_do` | Blocked | `live-action` effectful flow with `needs_review` steps 3 and 4, no captured candidates, and no reviewed `irreversibleAt`; compile/replay are blocked until repair plus dry-run/owner gates. |
| `hiworks01` | Blocked | Playwright-scoped destructive live-action with `needs_review` steps 0 and 2, candidate summaries in the blocked-flow report, and `irreversibleAt:6` warning; compile/replay are blocked until repair, dry-run evidence, and owner approval. |

## P0 Readiness

External service open remains no-go.

Closed or partially closed for pre-serverization:

- P0-A: external mode has a fail-closed auth gate, deterministic provider config validation, tenant
  metadata, required claim/header mapping checks, deterministic session expiry/logout primitives, and
  route-family authorization tests. A real IdP/user-management system is still open.
- P0-B: external mutating routes require bearer auth and same-origin or explicitly allowed-origin
  metadata, with cookie-session CSRF and deny-by-default CORS helpers; a complete production
  cookie/session deployment with real HTTPS origin is still open.
- P0-C: direct secret path serving and WebUI value readback are blocked; encrypted-local and
  production-shaped external-broker contracts exist with sanitized migration inventory/planning and
  approval manifests. A real KMS/broker connector and real secret migration/rotation UX are still open.
- P0-D: noVNC is fail-closed in external/service/durable production modes unless disabled or explicitly fronted by TLS
  tenant-session auth, and WebUI noVNC route stubs deny unauthorized/cross-tenant/expired/canceled/
  closed/finished access, scoped browser roots, and teardown manifests. Real proxied noVNC session
  isolation and browser context teardown are still open.
- P0-E: local policy checks block non-allowlisted public targets, metadata targets, default-profile
  private ranges, redirects, iframes, and initial redirects with deterministic resolved-IP metadata.
  Resolver freshness and connection-IP mismatch evidence are validated deterministically; real
  DNS/IP-at-connection enforcement remains platform-dependent.
- P0-F: local WebUI jobs have persisted state, idempotent cancel, runner claim/heartbeat leases,
  redacted result/audit, retry-aware restart reconciliation, worker metadata, retention metadata,
  artifact hashes, local audit hash-chain verification, deterministic JSONL audit-sink validation, and
  audit outbox metadata. Local external-runner execution and fake-connector audit webhook delivery were
  reconfirmed on 2026-06-11; production runner identity/deployment and webhook audit delivery are still
  open.
- P0-G: export/retention helpers block known secret paths, raw secret patterns, unknown scan/redaction
  status, cross-tenant reuse, missing policy approval, expired/invalid signed refs, legal holds, and
  tombstoned artifacts. A production export service and tenant deletion workflow are still open.
- P0-H: a fixture-only security gate wrapper exists and has a full recorded green run from 2026-06-10;
  the full negative acceptance suite for every P0 boundary is still open. The readiness API now exposes
  a structured matrix/release-checklist view so CI and release review can see contract-only and
  external-blocked sections, their missing evidence, and blocked flow prep without parsing prose.

Major blockers:

- Real IdP/SSO user management and production cookie/session deployment.
- Real production KMS/secret broker plus migration of auth state, values, credentials, OTP seeds, and
  cookie jars.
- Real noVNC proxy/container isolation with TLS and per-job browser teardown.
- Platform-specific DNS/IP-at-connection enforcement and tenant-owned allowlist administration.
- Production runner identity/deployment, external queue operations, cancellation across deployed
  workers, and production audit webhook delivery.
- Production artifact retention, tenant deletion, and approved export service.
- Full P0 acceptance suite across operator-approved staging/live acceptance environments, plus operator-approved live/non-local
  acceptance for named flows.

## Operator-Only Commands

Run these only on an operator machine with approval from the target owner. For non-local flows, the
operator must choose the exact target origin and set `AQA_TARGET_ALLOWLIST`; agents must not widen it.

```bash
bash setup/auth.sh <app> <login-url> '<success-url>'
node bin/play-flow.mjs --flow flows/<name>.flow.json --validate-only
AQA_TARGET_ALLOWLIST=https://host[:port] bash bin/probe-record.sh verify flows/<name>.flow.json
bash bin/probe-record.sh compile flows/<name>.flow.json
AQA_RUN_MODE=staging AQA_TARGET_ALLOWLIST=https://host[:port] bash bin/operator-staging-readonly.sh <name>
AQA_RUN_MODE=live-readonly AQA_TARGET_ALLOWLIST=https://host[:port] bash bin/operator-staging-readonly.sh <name>
```

For any `live-action` or effectful flow, run a dry-run first, keep `AQA_RUN_MODE` and allowlists
explicit, and require a human owner/operator decision before touching a live target.

```bash
AQA_RUN_MODE=live-action \
AQA_TARGET_ALLOWLIST=<origin> \
AQA_LIVE_ALLOWLIST=<flow-or-app-or-origin> \
AQA_LIVE_DRY_RUN_PASSED=<flow-name-or-1> \
AQA_LIVE_ACTION_APPROVE=<flow-name-or-1> \
node bin/play-flow.mjs --flow flows/<name>.flow.json
```
