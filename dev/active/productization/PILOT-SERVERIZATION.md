# Browser-auto Productization Plan

Status: active planning
Date: 2026-06-10
Scope: internal pilot readiness plus P0 design for an external server-style RPA product.

This document intentionally separates two postures:

- Internal pilot: single operator, trusted host, loopback or authenticated tunnel, supervised runs.
- External server product: multi-user, exposed control plane, tenant isolation, durable operations.

The current codebase is suitable for the first posture with controls. It is not yet suitable for the
second posture without the P0 serverization work below.

Operational runbook: `dev/active/productization/INTERNAL-PILOT-RUNBOOK.md`.
Security data policy: `dev/active/productization/SECURITY-DATA-POLICY.md`.

## 1. Internal Pilot Goal

Prove that Browser-auto can run one real business journey end to end without reintroducing false-green
or model-in-the-loop replay risk.

Pilot shape:

- One target system.
- One registered app/recipe/flow.
- Playwright-only path for new pilot work.
- Human-supervised auth and capture.
- Dry-run before live.
- Live action only for reviewed, bounded, operator-approved batches.
- No unattended live approve during the pilot.

Non-goals:

- Multi-tenant SaaS.
- Public internet exposure of webui/noVNC.
- Background live approvals without an operator.
- Storing or committing auth state, values, DB files, artifacts, or videos.

## 2. Pilot Checklist

Environment gate:

- [ ] Run on Windows with Git Bash: `C:\Program Files\Git\bin\bash.exe`.
- [ ] Confirm tools: `node`, `jq`, `ffmpeg`, and the Playwright runtime from `approve/`.
- [ ] Start webui only on loopback or behind an authenticated tunnel/reverse proxy.
- [ ] Keep `WEBUI_ALLOWED_HOSTS` narrow.
- [ ] Keep noVNC bound to localhost or protected by external auth.
- [ ] Confirm auth state and artifacts are gitignored.

Code gate:

- [ ] `git status --short --branch` is clean before pilot changes.
- [ ] `node --check` passes for all JS/MJS/CJS files.
- [ ] Core unit/smoke tests pass from Git Bash.
- [ ] Any new flow with `needs_review` fails compile until reviewed.
- [ ] Any new Playwright flow declares `engine: "playwright"`.
- [ ] Any non-Playwright flow is converted or explicitly kept out of the compiled gate.

Current migration debt and fixture policy:

- `flows/approval_office_hiworks_com_ibizsoftware_net_approval.flow.json` is migrated to
  `engine: "playwright"` and passes `node bin/play-flow.mjs --flow ... --validate-only`; keep it out
  of `run.sh` until the Playwright auth fixture is refreshed on the target operator host.
- `flows/hiworks01.flow.json` stays blocked until a human refreshes Playwright auth, resolves every
  `needs_review` locator, and re-validates/compiles it. Do not add a compiled test wrapper while it
  has unresolved review steps.
- `flows/guest_samsungdisplay_com_argos_main_do.flow.json` is Playwright-scoped but not runnable while
  its iframe steps remain `needs_review`; keep it out of the run gate until those locators are reviewed.
- Auth state, `.values.json`, DB files, artifacts, screenshots, and videos remain local-only artifacts.
  Do not commit or expose them; use committed flows and recipes as the only reviewable source.

RPA gate:

- [ ] Register the pilot system in webui or DB registry.
- [ ] Capture or author one deterministic flow.
- [ ] Fill values in the gitignored `.values.json`; do not commit it.
- [ ] Run Playwright validate, verify, compile, and smoke for the pilot flow.
- [ ] Run dry-run first and inspect report, screenshot/video, and audit output.
- [ ] Confirm every page transition has a URL/text/load gate.
- [ ] Confirm no `@eN` refs exist in flow or test source.
- [ ] Confirm locators are semantic and unique in the relevant snapshot.

Effectful-action gate:

- [ ] Prefer read/sync/enrich for the first pilot pass.
- [ ] For approve-like actions, run dry-run first.
- [ ] Use reviewed batch mode, small max count, and operator supervision.
- [ ] Confirm the positive completion marker, not only absence from a list.
- [ ] Confirm audit entries exist for requested, verified, clicked, confirmed, and failed states.
- [ ] Confirm kill switch behavior before any live batch.

Exit criteria:

- [ ] One target journey completes green through `run.sh` and the compiled Playwright bash wrapper.
- [ ] No assertion relies on process exit alone where `.success` must be inspected.
- [ ] Replay is deterministic and AI-free.
- [ ] Pilot artifacts are collected but not committed.
- [ ] Open issues are classified P0/P1/P2 before expanding to another system.

## 3. Recommended Pilot Command Set

Use Git Bash explicitly:

```powershell
& 'C:\Program Files\Git\bin\bash.exe' -lc 'cd /c/project/Browser-auto && bash run.sh'
```

Fast code checks:

```powershell
& 'C:\Program Files\Git\bin\bash.exe' -lc 'cd /c/project/Browser-auto && while IFS= read -r f; do node --check "$f" >/dev/null || exit 1; done < <(rg --files -g "*.js" -g "*.mjs" -g "*.cjs")'
& 'C:\Program Files\Git\bin\bash.exe' -lc 'cd /c/project/Browser-auto && bash tests/build-flow-unit.test.sh'
& 'C:\Program Files\Git\bin\bash.exe' -lc 'cd /c/project/Browser-auto && bash tests/compile-engine-unit.test.sh'
& 'C:\Program Files\Git\bin\bash.exe' -lc 'cd /c/project/Browser-auto && bash tests/play-flow-smoke.test.sh'
```

Pilot authoring sequence:

```bash
bash setup/auth.sh <app> <login-url> '<success-url>'
bash bin/probe-record.sh capture <flow-name> <start-url> --app <app>
node bin/play-flow.mjs --flow flows/<flow-name>.flow.json --validate-only
bash bin/probe-record.sh verify flows/<flow-name>.flow.json
bash bin/probe-record.sh compile flows/<flow-name>.flow.json
bash run.sh <flow-name>
```

Flow cleanup sequence:

```bash
# Edit the flow to set "engine": "playwright", then refresh Playwright auth.
bash setup/auth.sh <app> <login-url> '<success-url>'
node bin/play-flow.mjs --flow flows/<flow-name>.flow.json --validate-only
bash bin/probe-record.sh verify flows/<flow-name>.flow.json
bash bin/probe-record.sh compile flows/<flow-name>.flow.json
bash run.sh <flow-name>
```

## 4. P0 Serverization Design

External server posture requires a new security boundary. The current localhost webui is a control
plane that can spawn processes and drive authenticated browsers. Exposing it directly is equivalent to
exposing automation authority.

### P0.1 Authentication and Authorization

Required:

- Real login for every webui/API/noVNC entrypoint.
- RBAC at minimum: owner, operator, viewer.
- Per-route authorization for run, record, auth, sync, enrich, approve, artifact access, and job cancel.
- Session expiration and logout.
- SameSite secure cookies when deployed over HTTPS.

Acceptance:

- Unauthenticated requests to any API return 401.
- Authenticated users can access only their tenant/system/job/artifacts.
- Approval/live-effect routes require operator role or stronger.

### P0.2 CSRF and Browser-Origin Controls

Required:

- Authenticated CSRF token for all state-changing routes.
- Present Origin or Referer required for browser-initiated POSTs.
- Host allowlist remains as a secondary control, not the main auth boundary.
- CORS deny-by-default.

Acceptance:

- Missing Origin/Referer on browser-sensitive POSTs is rejected.
- Wrong Origin/Referer is rejected.
- Local script requests without a valid CSRF token cannot mutate state.

### P0.3 Secret and Auth-State Storage

Required:

- Move `fixtures/auth/**/*.state.json`, approve state, `.values.json`, and credentials into encrypted storage.
- Per-tenant keys with rotation.
- No secret-bearing file served by the webui.
- Redaction in logs, reports, and API responses.
- No secret material in child argv; prefer stdin or 0600 temp files when needed.

Acceptance:

- A repo scan and artifact scan find no auth state, cookies, OTPs, passwords, or values.
- Operators can rotate/delete a system credential.
- Child process logs do not expose tokens or form values.

### P0.4 noVNC and Headed Browser Isolation

Required:

- noVNC behind TLS and auth.
- Per-tenant or per-job browser isolation.
- No shared headed browser across tenants.
- Network isolation for browser jobs.
- Optional recording session timeout and forced cleanup.

Acceptance:

- A user cannot connect to another tenant's browser session.
- Closing/canceling a job tears down its browser context.
- noVNC is never passwordless on an exposed interface.

### P0.5 Target Domain and Egress Allowlist

Required:

- Tenant-level allowed domains for login, target URLs, iframes, and redirects.
- Block RFC1918, localhost, link-local, metadata endpoints, and cloud control-plane endpoints unless explicitly allowed for an on-prem runner.
- DNS rebinding defense by resolving and enforcing IP policy at connection time where possible.

Acceptance:

- Registering or running a system outside the allowlist fails closed.
- Redirects outside the allowlist abort the job.
- Browser egress to metadata and internal control-plane addresses is blocked.

### P0.6 Durable Jobs and Audit

Required:

- Durable job queue instead of in-memory-only queue.
- Job state transitions persisted: queued, running, canceling, succeeded, failed, interrupted.
- Append-only audit with actor, tenant, IP/session, route, command, target system, flow/recipe hash, and result.
- Startup reconciliation for running jobs after crash.
- Tamper-evident audit chain or external audit sink.

Acceptance:

- Server restart does not lose queued jobs.
- In-flight jobs reconcile to interrupted/unknown and never silently succeed.
- Audit can answer who ran what, against which target, with which artifact hash.

### P0.7 Tenant Data Boundary

Preferred target architecture:

- SaaS control plane stores metadata, recipes, schedules, scrubbed job status, and audit references.
- Tenant runner stores credentials, browser state, raw business data, local artifacts, and optional private LLM access.
- Runner pulls jobs outbound-only and pushes scrubbed status.

Acceptance:

- SaaS control plane never stores tenant browser sessions or confidential document bodies.
- Tenant runner can be disabled/revoked without exposing other tenants.
- Artifact retention is tenant-scoped and policy-driven.

## 5. P1/P2 After P0

P1:

- [x] Implement Playwright `open_record` for recipe-driven row/detail opens. Local coverage:
  `tests/flow-runner-unit.test.sh` and `tests/webui-flows-unit.test.sh`.
- [x] Add Playwright iframe recorder regression coverage: same-origin iframe actions compile with a
  frame locator, while cross-origin iframe actions become `needs_review` and fail closed. Local
  coverage: `tests/capture-e2e.test.sh` and `tests/rpa-local-fixture-e2e.test.sh`.
- [x] Make approval extraction and DB batch duplicate-key handling fail closed. Local coverage:
  `tests/extract-approvals.test.sh` and `tests/db-unit.test.sh`.
- [x] Make RPA pagination/list duplicate keys fail closed before save/upsert. Local coverage:
  `tests/pw-rpa-pagination-unit.test.sh`.
- [x] Make RPA pagination settle failures fail the sync/enrich path instead of storing partial green
  results. Local coverage: `tests/pw-rpa-pagination-unit.test.sh`.
- [x] Add P0 readiness UI/API status with machine-readable No-Go matrix and release-checklist
  metadata. Local coverage: `tests/webui-readiness-unit.test.sh` and
  `tests/webui-blocked-flow-route-unit.test.sh`.
- Add first-class UI links/views for pilot runbooks if operators need them beyond committed docs.

P2:

- Show approve compatibility auth state in the webui auth summary.
- Add richer observability: per-step timing, retry reason, browser crash reason, queue metrics.
- Add artifact retention policies and export bundles.
- Add tenant-level rate limits and cost controls.
- Add compliance package: threat model, data-flow diagram, audit retention policy.

## 6. Go/No-Go Summary

Internal pilot:

- Go, if it is loopback/authenticated, single-operator, supervised, and dry-run first.
- No-go for unattended live approve at scale.

External server product:

- No-go until P0.1 through P0.7 are implemented and tested.
- Reassess after authentication, CSRF, secret storage, noVNC isolation, egress allowlist, durable jobs,
  and tenant boundary are all in place.
