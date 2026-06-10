# P0 Service Open Security Backlog

Status: active backlog
Date: 2026-06-10
Scope: external-service readiness for the Browser-auto control plane, runner, noVNC/headed browser,
job execution, artifacts, and tenant data boundaries.

This is not a runbook. It is the P0 acceptance checklist that must be complete before exposing the
service to external users or tenants. Internal pilots may continue under the narrower controls in
`PILOT-SERVERIZATION.md`, but external service open is blocked until every P0 item below is accepted.
The companion data policy for threat model, data flow, audit retention, artifact retention, and export
gates is `SECURITY-DATA-POLICY.md`.

## Priority Order

1. P0-A: Establish auth/RBAC and tenant identity before any public endpoint exists.
2. P0-B: Lock browser-origin controls, CSRF, host/CORS policy, and state-changing route guards.
3. P0-C: Move secrets, auth state, values, and credentials to encrypted tenant-scoped storage.
4. P0-D: Isolate noVNC/headed browser sessions per tenant/job and prevent cross-session access.
5. P0-E: Enforce target-domain and egress allowlists for every run, redirect, iframe, and browser job.
6. P0-F: Replace in-memory execution with durable jobs, cancellation, reconciliation, and audit.
7. P0-G: Prove tenant data boundaries for metadata, artifacts, auth state, logs, and raw business data.
8. P0-H: Add acceptance tests that fail closed for each security boundary.

## P0-A Auth, RBAC, And Tenant Identity

Backlog:

- [ ] Require login for every webui page, API route, noVNC route, artifact route, and job event stream.
- [ ] Introduce tenant identity as a first-class field for users, systems, flows, jobs, artifacts, and audit events.
- [ ] Add RBAC roles: owner, operator, viewer.
- [ ] Enforce route-level authorization for auth setup, record, verify, compile, run, approve, sync, enrich,
  artifact read, artifact delete, job cancel, tenant settings, and user management.
- [ ] Require operator or owner for live/effectful actions; viewer is read-only.
- [ ] Add session expiration, logout, secure cookie settings, and SameSite protection for HTTPS deployment.
- [ ] Make local development bypasses explicit, disabled by default in external mode, and visible in startup logs.

Acceptance:

- [ ] Unauthenticated requests to every API, page, noVNC, artifact, and event route return 401 or redirect to login.
- [ ] A viewer cannot start, record, approve, cancel, mutate settings, or read secret-bearing data.
- [ ] An operator cannot manage tenant users or view another tenant's systems, jobs, artifacts, or browser sessions.
- [ ] Live/effectful routes reject any role weaker than operator.
- [ ] Session expiry invalidates API, webui, noVNC, artifact, and event-stream access.
- [ ] Automated tests cover same-tenant allowed access and cross-tenant denied access for each route family.

## P0-B CSRF And Browser-Origin Controls

Backlog:

- [ ] Add CSRF tokens for all cookie-authenticated state-changing routes.
- [ ] Require valid Origin or Referer for browser-initiated POST, PUT, PATCH, and DELETE requests.
- [ ] Reject state-changing requests with missing, wrong, or ambiguous Origin/Referer unless a non-browser
  machine credential path is explicitly implemented.
- [ ] Keep `WEBUI_ALLOWED_HOSTS` as a secondary binding control, not the primary auth boundary.
- [ ] Set CORS deny-by-default; allow only explicitly configured trusted origins.
- [ ] Add security headers for frame, MIME, referrer, and content-type protections.

Acceptance:

- [ ] Missing CSRF token on every mutating browser route is rejected.
- [ ] Wrong CSRF token on every mutating browser route is rejected.
- [ ] Missing Origin/Referer on browser-sensitive mutation is rejected.
- [ ] Wrong Origin/Referer is rejected even with a valid session cookie.
- [ ] Cross-origin JavaScript cannot run, cancel, record, approve, read artifacts, or mutate tenant settings.
- [ ] Tests prove host allowlist bypass attempts do not grant authorization.

## P0-C Secret Storage And Redaction

Backlog:

- [ ] Move `fixtures/auth/**/*.state.json`, approve state, `.values.json`, credentials, OTP seeds, tokens,
  and cookie jars out of repo-adjacent plaintext storage for external mode.
- [ ] Store secrets in encrypted tenant-scoped storage with key rotation and deletion support.
- [ ] Prevent webui static serving of any secret-bearing path, temp directory, auth fixture, values sidecar,
  raw browser profile, database file, or runner work directory.
- [ ] Redact secrets in logs, reports, API responses, screenshots metadata, job events, and audit summaries.
- [ ] Avoid passing secrets through child-process argv or environment where possible; prefer scoped stdin,
  sealed files with restrictive permissions, or a runner-local secret broker.
- [ ] Add secret scanning for repository files, generated artifacts, job logs, and export bundles.

Acceptance:

- [ ] Repo scan finds no committed auth states, cookies, passwords, OTPs, bearer tokens, or values.
- [ ] Artifact scan finds no unredacted secrets in reports, logs, generated JSON, and exported bundles.
- [ ] Operators can rotate and delete a system credential; subsequent runs use the new secret or fail closed.
- [ ] Artifact and static-file routes cannot retrieve auth state, values sidecars, local DBs, temp files, or runner
  work directories.
- [ ] Child-process command lines and stored job records do not expose form values, tokens, cookies, or passwords.

## P0-D noVNC And Headed Browser Isolation

Backlog:

- [ ] Put noVNC behind the same authenticated and authorized control plane as the rest of the service.
- [ ] Require TLS for exposed noVNC access.
- [ ] Allocate browser/noVNC sessions per job or per tenant with no cross-tenant sharing.
- [ ] Bind browser contexts, storage state, downloads, screenshots, video, and profiles to the tenant/job.
- [ ] Tear down browser contexts on cancel, timeout, job completion, and server restart reconciliation.
- [ ] Add session idle timeout, hard maximum duration, and operator-visible force cleanup.

Acceptance:

- [ ] A user cannot connect to another tenant's noVNC session by guessing IDs, URLs, websocket paths, or job IDs.
- [ ] A second tenant never sees the first tenant's cookies, local storage, downloads, screenshots, video, or page state.
- [ ] Canceling or timing out a job closes its browser context and noVNC session.
- [ ] noVNC is never passwordless or unauthenticated on an exposed interface.
- [ ] Tests cover unauthorized websocket upgrade, cross-tenant websocket upgrade, expired session, and canceled-job access.

## P0-E Target Domain And Egress Allowlist

Backlog:

- [ ] Add tenant-level allowlists for login URLs, start URLs, redirects, iframes, artifact fetches, and recipe targets.
- [ ] Validate allowlists at system registration, flow import, job enqueue, and each browser navigation.
- [ ] Block localhost, loopback, RFC1918, link-local, multicast, cloud metadata endpoints, and service-control endpoints
  unless an on-prem runner profile explicitly allows the specific destination.
- [ ] Enforce redirect and iframe policy fail-closed.
- [ ] Add DNS rebinding defenses by resolving and checking IP policy at connection time where the platform permits.
- [ ] Record denied egress attempts in audit without leaking secret URL parameters.

Acceptance:

- [ ] Registering a system outside the tenant allowlist fails.
- [ ] Starting a run outside the tenant allowlist fails before browser launch.
- [ ] Redirects outside the allowlist abort the job and mark it failed, not green.
- [ ] Browser egress to metadata, localhost, internal control-plane addresses, and non-allowed private ranges is blocked.
- [ ] Tests cover direct URL, redirect, iframe, DNS/IP mismatch, and blocked metadata endpoint attempts.

## P0-F Durable Jobs And Audit

Backlog:

- [ ] Replace in-memory-only job execution with a durable queue.
- [ ] Persist job states: queued, claimed, running, canceling, canceled, succeeded, failed, interrupted, expired.
- [ ] Make cancellation durable and idempotent.
- [ ] Reconcile claimed/running jobs on startup; never silently mark unknown in-flight work as succeeded.
- [ ] Persist artifact metadata with tenant, job, flow/recipe hash, retention policy, and integrity hash.
- [ ] Append audit events for actor, tenant, role, IP/session, route, command, target system, flow/recipe hash,
  input redaction status, job state changes, noVNC access, egress denial, artifact reads, and result.
- [ ] Make audit append-only with either a tamper-evident hash chain or external audit sink.

Acceptance:

- [ ] Server restart preserves queued jobs.
- [ ] Server restart reconciles in-flight jobs to interrupted/unknown unless a runner proves a terminal result.
- [ ] Cancel requested before, during, and after browser launch has deterministic persisted outcomes.
- [ ] Audit can answer who did what, against which tenant/system, with which flow/recipe hash, when, from where,
  and whether it succeeded.
- [ ] Audit records survive process restart and cannot be modified through normal service routes.
- [ ] Tests cover restart reconciliation, duplicate cancel, failed child process, artifact hash recording, and audit readback.

## P0-G Tenant Boundary And Data Placement

Backlog:

- [ ] Split SaaS/control-plane metadata from tenant-runner confidential state.
- [ ] Keep credentials, browser auth state, raw business data, raw screenshots/video, local downloads, and raw artifacts
  on the tenant runner unless a tenant-specific policy explicitly permits upload.
- [ ] Let runners pull jobs outbound-only and push scrubbed status/audit references.
- [ ] Make tenant IDs mandatory in storage keys, queue records, artifact paths, logs, and audit records.
- [ ] Enforce tenant-scoped retention and deletion for artifacts, job records, browser state, and logs.
- [ ] Add explicit export controls for any bundle that contains tenant data.

Acceptance:

- [ ] SaaS control plane stores metadata, scrubbed job status, flow/recipe hashes, schedules, and audit references only.
- [ ] SaaS control plane does not store tenant browser sessions, credentials, raw document bodies, raw screenshots,
  raw video, or raw downloads unless a documented tenant policy enables it.
- [ ] Revoking one tenant runner cannot expose another tenant.
- [ ] Tenant deletion removes or tombstones tenant-scoped jobs, artifacts, browser state, and secrets according to policy.
- [ ] Tests prove path traversal, guessed IDs, shared cache keys, and artifact URL reuse cannot cross tenant boundaries.

## P0-H Tests And Release Gate

Backlog:

- [ ] Add an external-mode test profile that enables auth, RBAC, CSRF, tenant checks, egress enforcement,
  durable jobs, and audit assertions.
- [ ] Add negative tests for every P0 acceptance item above.
- [ ] Add fixture tenants: owner, operator, viewer, tenant A, tenant B, allowed target, blocked target, blocked metadata URL.
- [ ] Add security smoke command to CI after existing deterministic flow tests.
- [ ] Add a release checklist that requires all P0 tests green and any exception signed off as a no-go blocker.

Acceptance:

- [ ] `bash run.sh` remains deterministic and AI-free.
- [ ] Security acceptance tests fail closed without relying on a live external LLM or non-deterministic browser decision.
- [ ] Every external-service mutating route has at least one authorized positive test and one unauthorized negative test.
- [ ] Every tenant-scoped read route has same-tenant positive and cross-tenant negative coverage.
- [ ] Release is no-go if any P0 acceptance item is unchecked.

## External Service Open Decision

- [ ] No-go while any P0-A through P0-H acceptance item is unchecked.
- [ ] No-go if any external route can spawn a process, open a browser, access noVNC, read artifacts, or mutate state
  without authenticated tenant-scoped authorization.
- [ ] No-go if any secret-bearing state is stored or served as plaintext in external mode.
- [ ] No-go if browser egress can reach non-allowlisted targets or internal control-plane addresses.
- [ ] Go only after the P0 test profile is green, audit readback proves accountability, and tenant boundary tests pass.
