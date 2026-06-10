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
```

Broaden to `bash run.sh` for the normal suite. The default suite skips app-bound compiled flows unless
`AQA_INCLUDE_LIVE_AUTH=1` is set, so CI does not depend on a local SSO/OTP session.

## Non-Local Read Lane

Use this lane only after an operator confirms the target system and account are allowed for read-only
checking:

```bash
node bin/play-flow.mjs --flow flows/<name>.flow.json --validate-only
AQA_RUN_MODE=staging AQA_INCLUDE_NONLOCAL=1 bash run.sh <name>
AQA_RUN_MODE=live-readonly AQA_INCLUDE_NONLOCAL=1 bash run.sh <name>
```

Run by explicit flow name where possible. Agents may draft, repair, and validate the flow, but the
operator chooses the account, target, timing, and whether the real target is contacted.

## Live-Auth Lane

Use this lane only on the operator machine that owns the session:

```bash
bash setup/auth.sh <app> <login-url> '<success-url>'
node bin/play-flow.mjs --flow flows/<name>.flow.json --validate-only
bash bin/probe-record.sh verify flows/<name>.flow.json
bash bin/probe-record.sh compile flows/<name>.flow.json
bash run.sh <name>
```

Refresh auth when the WebUI shows `auth / OTP renewal`, when a run lands on login/MFA, when the tenant
or account changes, or when the target owner asks for session rotation.

## Live-Action Lane

Before any effectful action:

- Confirm the scenario has no `needs_review`, missing values, missing auth, stale compile, or policy
  block in the WebUI readiness card.
- Confirm live risk is understood by the operator and target owner.
- Sync/enrich records first; do not hand-build target sets.
- Run dry-run for the same target set and plan hash.
- Keep live batches capped with `--max N` and watched by an operator.
- Know the stop path: WebUI cancel/stop, `/api/approve/stop`, and `data/approve-STOP`.

Scheduler paths are not a live-action lane. `bin/scheduled-task.sh` exports `AQA_SCHEDULED_NO_LIVE=1`.

## WebUI Readiness Fields

The automation view should show:

- `auth / OTP renewal`: whether Playwright auth is required, ready, missing, or due for headed renewal.
- `policy block`: the first fail-closed reason or the operator gate for effectful work.
- `live risk`: read-only, authenticated, or effectful intent inferred from the current scenario goal.
- `timeout / last failure`: the latest report failure reason, with timeouts called out.
- `disabled reason`: why run controls are not usable before queue/busy state is considered.
- `artifacts / deep links`: run API, `report.json`, and `report.junit.xml` for the latest run.

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
- Confirm `AQA_LIVE_ACTION_APPROVE`, approve effectful/destructive scope, or cross an `irreversibleAt` gate.
- Run unattended live-action work, remove `--max` caps, suppress stop paths, or hide failed artifacts.
- Expose WebUI/noVNC, change local roles, release artifacts, or redact sensitive data without owner review.
