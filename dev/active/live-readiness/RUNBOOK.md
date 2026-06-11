# Live Readiness Runbook

Status: active
Date: 2026-06-10
Scope: WebUI and operator workflow for Browser-auto live-readiness checks.

This runbook keeps the WebUI as a local CLI control plane. It does not add a second runner, a second
policy engine, or any model-driven pass/fail decision.

## Local RBAC Model

Until external-service RBAC is implemented, roles are enforced by local access, operator discipline,
and review. Do not treat the loopback WebUI as a public multi-user boundary.

| role | may do | must not do |
| --- | --- | --- |
| Viewer | read redacted readiness, reports, and reviewed artifacts | start jobs, handle auth, view secrets, release artifacts |
| Operator | run fixture/local jobs, record/verify/compile flows, refresh owned auth, run supervised non-local and live-auth lanes | approve their own live-action scope, bypass gates, use borrowed auth |
| Owner | approve target systems, live-action scope, rollback owner, artifact release, and role changes | delegate SSO/OTP or irreversible confirmation to an agent |
| Admin | owner-level WebUI administration and sensitive metadata review | use admin access to bypass owner approval, SSO/OTP, or irreversible gates |

Sensitive metadata GET/HEAD routes for secret migration, tenant deletion, release checklist handoff,
audit detail, and admin/auth detail require operator, owner, or admin. Viewer remains limited to
redacted status, readiness, report, and artifact summaries.

## Lane Separation

Use four lanes and do not blur them:

| lane | purpose | allowed inputs | forbidden |
| --- | --- | --- | --- |
| CI / fixture | deterministic product gate | repo files, localhost fixtures, browser-free unit tests | target auth, OTP, live business data, live approve |
| Non-local read | read-only staging or live-readonly check | explicit named flow, matching `AQA_RUN_MODE`, target allowlist | CI substitution, writes, unapproved target systems |
| Live-auth | prove a named flow against an operator-owned session | `fixtures/auth/playwright/<app>.state.json`, named flow, supervised browser | replacing CI, unattended scheduler, stale or borrowed auth |
| Live-action | supervised effectful action rehearsal or capped live test | synced records, reviewed targets, dry-run evidence, owner confirmation | CI, unattended runs, unreviewed target sets, missing rollback owner |

## CI / Fixture Lane

Run this lane before touching a real target:

```bash
node --check webui/public/app.js
bash tests/webui-flows-unit.test.sh
bash tests/webui-readiness-unit.test.sh
bash tests/flow-runner-unit.test.sh
bash tests/play-flow-smoke.test.sh
bash tests/security-p0-gate.test.sh
```

Recommended CI lane split:

- `security-p0-gate`: `bash bin/ci-security-p0.sh`
- `browser-fixture`: `bash bin/ci-browser-fixture.sh`
- `slow-fixture`: `bash bin/ci-slow-fixture.sh`
- `operator-only`: `bash bin/ci-operator-only-guard.sh` documents the lane and fails closed in CI
- `staging-readonly`: `bash bin/operator-staging-readonly.sh <flow>` is operator-only and fails closed in CI

Broaden to `bash run.sh` for the normal suite. The default suite skips app-bound compiled flows unless
`AQA_INCLUDE_LIVE_AUTH=1` is set, so CI does not depend on a local SSO/OTP session.

## Non-Local Read Lane

Use this lane only after an operator confirms the target system and account are allowed for read-only
checking:

```bash
AQA_RUN_MODE=staging AQA_TARGET_ALLOWLIST=https://host[:port] bash bin/operator-staging-readonly.sh --validate-only <name>
AQA_RUN_MODE=staging AQA_TARGET_ALLOWLIST=https://host[:port] bash bin/operator-staging-readonly.sh <name>
AQA_RUN_MODE=live-readonly AQA_TARGET_ALLOWLIST=https://host[:port] bash bin/operator-staging-readonly.sh <name>
```

Run by explicit flow name where possible. Agents may draft, repair, and validate the flow, but the
operator chooses the account, exact target allowlist, timing, and whether the real target is
contacted. The wrapper refuses CI, non-read risk classes, wrong run modes, missing allowlists,
live-action approval env, irreversible gates, and destructive-looking read-only steps before replay.

## Live-Auth Lane

Use this lane only on the operator machine that owns the session:

```bash
bash setup/auth.sh <app> <login-url> '<success-url>'
node bin/play-flow.mjs --flow flows/<name>.flow.json --validate-only
AQA_TARGET_ALLOWLIST=https://host[:port] bash bin/probe-record.sh verify flows/<name>.flow.json
bash bin/probe-record.sh compile flows/<name>.flow.json
AQA_RUN_MODE=live-readonly AQA_TARGET_ALLOWLIST=https://host[:port] bash bin/operator-staging-readonly.sh <name>
```

Refresh auth when the WebUI shows `auth / OTP renewal`, when a run lands on login/MFA, when the tenant
or account changes, or when the target owner asks for session rotation.

## Blocked Flow And Replay Prep

Use the static report before asking an operator to touch a real target:

```bash
node bin/blocked-flow-report.mjs --flows flows --format markdown
```

The report is prep metadata only. It reads committed `flows/*.flow.json` plus auth-state file metadata
for `missing`, `stale`, or `ready`; it does not read auth-state contents, raw cookies, `.values.json`,
or artifacts, and it does not run replay. For unresolved flows it shows the exact `needs_review` step
index, candidate summary, compile/replay blocked reason, `irreversibleAt` warning, and the operator
handoff gates.

For `approval_office_hiworks_com_ibizsoftware_net_approval`, treat validate-only as the safe prep step:

```bash
AQA_TARGET_ALLOWLIST=https://approval.office.hiworks.com \
AQA_EGRESS_RESOLVER_EVIDENCE='<fresh resolver evidence JSON>' \
node bin/play-flow.mjs --flow flows/approval_office_hiworks_com_ibizsoftware_net_approval.flow.json --validate-only
```

Actual replay is still operator handoff only. The operator must confirm auth freshness is `ready`, the
target owner has approved the origin/account, `AQA_TARGET_ALLOWLIST` matches the exact origin, and fresh
resolver/connection-IP evidence is present. Agents must not run the live replay or inspect/copy the
auth state.

## Live-Action Lane

Before any effectful action:

- Confirm the scenario has no `needs_review`, missing values, missing auth, stale compile, or policy
  block in the WebUI readiness card.
- If the static blocked-flow report still shows any `needs_review` step, stop: compile, validate-only,
  and replay remain fail-closed until the locator is repaired to a unique semantic locator.
- Review the blocked-flow report's `irreversibleAt` warning with the owner before dry-run/live approval.
- Confirm live risk is understood by the operator and target owner.
- Sync/enrich records first; do not hand-build target sets.
- Run dry-run for the same target set and plan hash.
- Keep live batches capped with `--max N` and watched by an operator.
- Know the stop path: WebUI cancel/stop, `/api/approve/stop`, and `data/approve-STOP`.

For direct Playwright live-action replay, the operator must make all four gates explicit:

```bash
AQA_RUN_MODE=live-action \
AQA_TARGET_ALLOWLIST=<origin> \
AQA_LIVE_ALLOWLIST=<flow-or-app-or-origin> \
AQA_LIVE_DRY_RUN_PASSED=<flow-name-or-1> \
AQA_LIVE_ACTION_APPROVE=<flow-name-or-1> \
node bin/play-flow.mjs --flow flows/<name>.flow.json
```

Scheduler paths are not a live-action lane. `bin/scheduled-task.sh` exports `AQA_SCHEDULED_NO_LIVE=1`.

## Final Operator Checklist

Fixture-only release gate, safe for agents and CI:

```bash
bash tests/security-p0-gate.test.sh
bash tests/ci-lanes-unit.test.sh
bash run.sh
```

Operator-only commands, never agent-run and never CI-run:

```bash
bash setup/auth.sh <app> <login-url> '<success-url>'
AQA_RUN_MODE=staging AQA_TARGET_ALLOWLIST=https://host[:port] bash bin/operator-staging-readonly.sh <name>
AQA_RUN_MODE=live-readonly AQA_TARGET_ALLOWLIST=https://host[:port] bash bin/operator-staging-readonly.sh <name>
```

Live-action operator-only command, requiring target owner approval and matching dry-run evidence:

```bash
AQA_RUN_MODE=live-action \
AQA_TARGET_ALLOWLIST=<origin> \
AQA_LIVE_ALLOWLIST=<flow-or-app-or-origin> \
AQA_LIVE_DRY_RUN_PASSED=<flow-name-or-1> \
AQA_LIVE_ACTION_APPROVE=<flow-name-or-1> \
node bin/play-flow.mjs --flow flows/<name>.flow.json
```

Passing the fixture-only gate is required for handoff, but it is not an external-service Go decision.
External service open stays No-Go until all P0 acceptance items are implemented and tested.
Use the WebUI readiness matrix to see which P0 sections are implemented locally, contract-only, or
external-blocked; do not treat a green fixture lane as approval to run the operator-only lane.

External-mode dry checks are configuration validation only. `WEBUI_AUTH_PROVIDER=oidc|saml|auth-proxy`,
`WEBUI_ALLOWED_ORIGINS`, `WEBUI_SECRET_STORE_BACKEND=external-broker`, `NOVNC_AUTH_BOUNDARY`, and
`WEBUI_AUDIT_SINK` can prove fail-closed contracts locally, but real IdP login, KMS access, noVNC
proxy exposure, webhook audit delivery, and non-local targets still require operator-owned
infrastructure and approval.
Audit webhook rehearsals should use deterministic fake connectors unless an owner has explicitly
approved the deployed connector, tenant-scoped secret broker, and outbound runner environment.

For external-mode rehearsals, provide only metadata and secret references: `WEBUI_PUBLIC_URL` must be
HTTPS for cookie sessions, IdP claim/header mappings must name user/tenant/role fields, secret and
audit connectors must use `aqa-secret:` token refs instead of plaintext env values, noVNC browser roots
must be tenant/job/session scoped, and egress resolver evidence must include fresh resolved/connection
IP metadata. These checks do not authorize contacting a real target.

## WebUI Readiness Fields

The automation view should show:

- `auth / OTP renewal`: whether Playwright auth is required, ready, missing, or due for headed renewal.
- `policy block`: the first fail-closed reason or the operator gate for effectful work.
- `live risk`: read-only, authenticated, or effectful intent inferred from the current scenario goal.
- `timeout / last failure`: the latest report failure reason, with timeouts called out.
- `disabled reason`: why run controls are not usable before queue/busy state is considered.
- `artifacts / deep links`: run API, `report.json`, and `report.junit.xml` for the latest run.
- `static analysis`: `bin/blocked-flow-report.mjs` classification for committed flow JSON. The
  corresponding `/api/flows/blocked-report` and `/api/readiness.blockedFlows` surfaces are metadata-only:
  no live replay, no auth-state content read, no `.values.json` read, and no artifact scan. Auth
  freshness is surfaced as metadata only.

These fields are explanations, not authority. `/api/flows`, `artifacts/*/report.json`, compiled bash
wrappers, and the CLI runner remain the source of truth.

## Artifact Handling

Artifacts stay local until reviewed. Treat `artifacts/<RUN_ID>/report.json`, JUnit XML, job logs,
screenshots, downloads, DB files, auth state, and `.values.json` as potentially sensitive. Do not
commit, paste, or upload them without review and redaction.

## No-Go Conditions

Stop and repair before live-auth or live-action work if any of these are true:

- WebUI/noVNC is publicly exposed without authentication.
- Auth state is missing, stale, wrong-account, or wrong-tenant.
- Flow contains `needs_review`, transient `@eN` refs, ambiguous locators, or missing transition gates.
- Latest run failed and the failure has not been explained.
- The operator cannot identify artifact location, rollback owner, and stop path.
- A requested action would make the WebUI decide pass/fail outside the deterministic CLI path.

Agents must not perform these actions:

- Complete SSO, OTP, MFA, or account recovery.
- Use, copy, rotate, paste, export, or publish live auth state, cookies, `.values.json`, or credentials.
- Decide that a non-local target may be contacted, choose live target records, or widen an allowlist.
- Set `AQA_LIVE_DRY_RUN_PASSED` or `AQA_LIVE_ACTION_APPROVE`, approve effectful/destructive scope, or
  cross an `irreversibleAt` gate.
- Run unattended live-action work, remove `--max` caps, suppress stop paths, or hide failed artifacts.
- Expose WebUI/noVNC, change local roles, release artifacts, or redact sensitive data without owner review.
