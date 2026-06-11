# Staging Acceptance Lane

Status: active
Date: 2026-06-11
Scope: operator-run development integration, staging, and production read-only acceptance for
Browser-auto.

This lane is separate from fixture CI. It supports two different uses:

- fast development integration for trying many business systems with operator-owned access
- production read-only acceptance when a validated lane is being opened as an operational service

Development integration must not be blocked on per-system owner approval packets. Production open still
requires owner/operator handoff. Neither use authorizes live-action work, OTP automation, borrowed
sessions, or model-driven pass/fail decisions. Replay stays deterministic: one compiled bash test
remains one user journey.

## Lane Boundary

Use this lane for named `environment:"staging"` and `environment:"live-readonly"` flows when an
operator is ready to run a read-only journey against a non-local target.

Development integration is allowed without a formal target-owner packet when the human tester/operator
has legitimate access, the run is read-only, and the target origins are explicit. Owner approval is
reserved for production open, unattended execution, live-action/write behavior, or customer-owned
accounts outside the tester's authority.

Do not use it for:

- CI, scheduled, or unattended runs.
- First-time auth, SSO, OTP, MFA, or account recovery. Operators do headed auth separately.
- `riskClass:"effectful"` or `riskClass:"destructive"` flows.
- `environment:"live-action"` flows or any flow with `irreversibleAt`.
- Locator repair that requires write actions or unauthorized target access.

The development integration wrapper is:

```bash
bash bin/dev-integration-readonly.sh [--validate-only] [--allowlist https://host[:port][,...]] <flow-name>
```

It records `RUN_ID`, the exact allowlist, stdout/stderr, and the lightweight JSON run note under
`artifacts/<RUN_ID>/` without requiring an owner approval packet or formal evidence pack.

The staging/production read-only acceptance wrapper is:

```bash
bash bin/operator-staging-readonly.sh [--validate-only] <flow-name>
```

Both wrappers refuse CI, wrong run modes, live-action env vars, non-read risk classes,
irreversible gates, and destructive-looking read-only steps before replay. The acceptance wrapper also
requires the operator to provide `AQA_TARGET_ALLOWLIST`; the development wrapper derives the start
origin when an exact allowlist is not supplied.

## Fixture Gates First

Run fixture gates before requesting staging acceptance:

```bash
bash tests/security-p0-gate.test.sh
bash run.sh
```

`tests/security-p0-gate.test.sh` and `run.sh` are fixture/CI gates. They use repo files,
browser-free checks, localhost or file fixtures, deterministic negative tests, and compiled local
journeys. They must not require target-system auth, OTP, public network access, or live business data.

Development integration, staging acceptance, and production read-only acceptance are different. A green
fixture gate is required before handoff, but it is not proof that a production or staging target has
accepted the journey.

## Development Integration Prerequisites

For fast multi-system development, record only:

- `commit`
- `command`
- `run_mode`
- `allowlist`
- `result`
- `RUN_ID`
- `artifact_paths`
- `issues_found`
- `next_action`

Do not create per-system owner approval packets during development integration. Use
`RPA-DEVELOPMENT-INTEGRATION-POLICY.md` as the governing policy.

## Production Acceptance Prerequisites

Before calling a lane production-open, the operator records:

- Flow name and flow file: `flows/<name>.flow.json`.
- Compiled wrapper: `tests/<name>.test.sh`.
- Target owner approval for the exact origin and account.
- Intended environment: `staging` or `live-readonly`.
- Auth state status for the flow app, if the flow declares `app`.
- Fresh target allowlist and resolver/connection-IP evidence for every non-local origin the flow can
  open, including redirects and same-origin frame navigations.

Use static metadata before touching the target:

```bash
node bin/blocked-flow-report.mjs --flows flows --format markdown
```

The blocked-flow report reads committed flow JSON and auth-state metadata only. It must not be treated
as replay success, and it must not expose cookies, `.values.json`, or auth-state contents.
Once the operator has approved the target env vars, use `bin/operator-staging-readonly.sh
--validate-only` to validate the replay envelope with the same allowlist and resolver evidence that
the real acceptance run will use.

## Required Environment

Set only the read-only lane variables for this lane:

| variable | required | meaning |
| --- | --- | --- |
| `AQA_RUN_MODE` | yes | Must match `flow.environment`: `staging` or `live-readonly`. |
| `AQA_TARGET_ALLOWLIST` | yes | Comma-separated exact origins, `https://host[:port]`; no path, query, credentials, or broad wildcard. |
| `AQA_EGRESS_RESOLVER_EVIDENCE` | yes for non-local targets | Host-keyed JSON from the approved resolver, including resolved addresses and freshness metadata. |
| `AQA_EGRESS_CONNECTION_IPS` | when not embedded in resolver evidence | Host-keyed JSON of connection IPs observed or approved for the target host. |
| `AQA_EGRESS_PROFILE` | only for authorized on-prem targets | Use `on-prem` only when the tester/operator has authority for the intranet/RFC1918 target; production open also needs target-owner approval. |

Recommended strictness for acceptance:

```bash
export AQA_EGRESS_REQUIRE_FRESH_RESOLVER_EVIDENCE=1
export AQA_EGRESS_REQUIRE_CONNECTION_IP_EVIDENCE=1
```

Do not set live-action variables in this lane:

- `AQA_LIVE_ALLOWLIST`
- `AQA_LIVE_DRY_RUN_PASSED`
- `AQA_LIVE_ACTION_APPROVE`

`bin/operator-staging-readonly.sh` treats those as live-action-only and refuses the run.

## Target Evidence

For development integration, `bin/dev-integration-readonly.sh` derives the start URL origin when no
allowlist is supplied. If supplied, `AQA_TARGET_ALLOWLIST` or `--allowlist` must contain only exact
origins being tested. Include additional origins only when the flow is expected to navigate, redirect,
or load required same-product support assets there.

For production open, `AQA_TARGET_ALLOWLIST` must match the exact origin set approved for that
operational lane.

Resolver evidence should be fresh and host-keyed. Example shape only:

```json
{
  "staging.example.com": {
    "addresses": ["203.0.113.10"],
    "connectionIps": ["203.0.113.10"],
    "resolvedAtMs": 1760000000000,
    "ttlMs": 300000
  }
}
```

Use real target evidence from the approved resolver at run time; do not copy the example IP or time.
If connection IPs are supplied separately, use:

```json
{
  "staging.example.com": ["203.0.113.10"]
}
```

For development integration, keep only the lightweight run record named above; do not create a formal
owner evidence pack. For production open, attach the evidence JSON used for the run, the command
environment, and the target-owner approval. If evidence is stale, missing, mismatched, or points to a
blocked metadata/private endpoint under the wrong profile, the acceptance attempt fails closed.

## Auth Freshness

If the flow declares `app`, the operator must own the session and refresh it when the metadata says
missing or stale, when the run reaches login/MFA, when the account or tenant changes, or when the
production owner requests rotation:

```bash
bash setup/auth.sh <app> <login-url> '<success-url>'
```

The human operator completes SSO/OTP/MFA in the headed browser. Agents must not complete auth, copy
auth state, read cookies, paste OTPs, inspect `.values.json`, or decide that stale auth is acceptable.

Acceptance evidence should include auth freshness metadata only: app name, ready/missing/stale status,
mtime or secret-ref status, and the refresh time if one was performed. Do not attach
`fixtures/auth/playwright/<app>.state.json` or raw secret material.

## Command Examples

Examples below assume PowerShell on Windows and the repo at `C:\project\Browser-auto`. Replace all
placeholders and evidence before running.

Validate the replay envelope without running the compiled journey:

```powershell
$env:AQA_RUN_MODE = "staging"
$env:AQA_TARGET_ALLOWLIST = "https://staging.example.com"
$env:AQA_EGRESS_RESOLVER_EVIDENCE = '{"staging.example.com":{"addresses":["203.0.113.10"],"connectionIps":["203.0.113.10"],"resolvedAtMs":1760000000000,"ttlMs":300000}}'
$env:AQA_EGRESS_REQUIRE_FRESH_RESOLVER_EVIDENCE = "1"
$env:AQA_EGRESS_REQUIRE_CONNECTION_IP_EVIDENCE = "1"
& "C:\Program Files\Git\bin\bash.exe" -lc 'cd /c/project/Browser-auto && bash bin/operator-staging-readonly.sh --validate-only <name>'
```

Run staging acceptance for the named flow:

```powershell
$env:AQA_RUN_MODE = "staging"
$env:AQA_TARGET_ALLOWLIST = "https://staging.example.com"
$env:AQA_EGRESS_RESOLVER_EVIDENCE = '<fresh resolver evidence JSON>'
& "C:\Program Files\Git\bin\bash.exe" -lc 'cd /c/project/Browser-auto && bash bin/operator-staging-readonly.sh <name>'
```

Run production read-only acceptance for a read-only flow:

```powershell
$env:AQA_RUN_MODE = "live-readonly"
$env:AQA_TARGET_ALLOWLIST = "https://app.example.com"
$env:AQA_EGRESS_RESOLVER_EVIDENCE = '<fresh resolver evidence JSON>'
& "C:\Program Files\Git\bin\bash.exe" -lc 'cd /c/project/Browser-auto && bash bin/operator-staging-readonly.sh <name>'
```

If Git Bash is already open:

```bash
AQA_RUN_MODE=staging \
AQA_TARGET_ALLOWLIST=https://staging.example.com \
AQA_EGRESS_RESOLVER_EVIDENCE='<fresh resolver evidence JSON>' \
bash bin/operator-staging-readonly.sh --validate-only <name>

AQA_RUN_MODE=staging \
AQA_TARGET_ALLOWLIST=https://staging.example.com \
AQA_EGRESS_RESOLVER_EVIDENCE='<fresh resolver evidence JSON>' \
bash bin/operator-staging-readonly.sh <name>
```

Do not run these examples from CI, a scheduler, or an agent-owned target session.

## Dry-Run And Live-Action Separation

For staging acceptance, `--validate-only` is the dry check. It validates the read-only envelope and
runner policy without executing the compiled journey through `run.sh`.

Live-action dry-run is a different lane. It uses `environment:"live-action"` plus
`AQA_LIVE_ALLOWLIST`, `AQA_LIVE_DRY_RUN_PASSED`, `AQA_LIVE_ACTION_APPROVE`, owner approval,
reviewed targets, and an irreversible gate. None of those variables belong in staging acceptance.

If a staging or live-readonly flow needs to submit, approve, delete, transfer, save, upload, download,
or cross an `irreversibleAt` boundary, stop. Reclassify it into the live-action runbook instead of
weakening this lane.

## Evidence To Keep

For development integration, keep lightweight technical evidence without exposing secrets:

- `commit`
- `command`
- `run_mode`
- `allowlist`
- `result`
- `RUN_ID`
- `artifact_paths`
- `issues_found`
- `next_action`

For production open, attach enough evidence for release review to replay the decision without exposing
secrets:

- Fixture gate results: `tests/security-p0-gate.test.sh`, `run.sh`, and relevant CI links or logs.
- Static prep: blocked-flow report entry for the flow and `validate-only` output.
- Exact operator command transcript: cwd, date/time, shell, flow name, command, and non-secret env vars.
- Target approval: target owner, account/tenant, exact allowlisted origins, and approval ticket or note.
- Resolver evidence: `AQA_TARGET_ALLOWLIST`, `AQA_EGRESS_RESOLVER_EVIDENCE`,
  `AQA_EGRESS_CONNECTION_IPS` if separate, and `AQA_EGRESS_PROFILE` if used.
- Auth freshness metadata only: app, ready/missing/stale status, mtime or secret-ref status, and
  refresh timestamp when applicable.
- Replay artifacts from `artifacts/<RUN_ID>/`: `report.json`, `report.junit.xml`, `results.tsv`, and
  captured stdout/stderr or job log.
- Flow source and compiled wrapper references: `flows/<name>.flow.json` and `tests/<name>.test.sh`
  revision or checksum.

Do not attach auth state, cookies, `.values.json`, OTPs, raw credentials, unredacted live business
data, or screenshots/downloads in development integration. Production-open packages may include
additional artifacts only when explicitly approved and redacted.

## Pass Criteria

Development integration or production read-only acceptance passes only when all are true:

- Fixture gates were green before the operator run.
- The flow is `environment:"staging"` or `environment:"live-readonly"` and `riskClass:"read"`.
- The flow has no `needs_review`, transient refs, unresolved values, missing compiled wrapper, or
  missing transition gates.
- `AQA_RUN_MODE` exactly matches the flow environment.
- `AQA_TARGET_ALLOWLIST` and resolver/connection-IP evidence match the tested target origins.
- Auth freshness is ready for any declared `app`, and the operator owns the session.
- `bash bin/operator-staging-readonly.sh --validate-only <name>` succeeds.
- `bash bin/operator-staging-readonly.sh <name>` exits 0 and writes passing artifacts.
- Kept evidence is complete enough to reproduce the engineering result and contains no secret material.

## Fail Criteria

Treat the acceptance attempt as failed or blocked if any are true:

- The wrapper refuses before replay, including CI detection, wrong run mode, missing allowlist,
  live-action env vars, non-read risk class, destructive-looking step, or irreversible gate.
- Resolver evidence is missing, stale, mismatched with connection IPs, or incomplete for an origin the
  flow reaches.
- The target redirects or navigates outside the exact allowlist.
- The run reaches login, SSO, OTP, MFA, account recovery, a wrong tenant, or a wrong account.
- The compiled journey exits nonzero, times out, fails an assertion, or produces missing/incomplete
  artifacts.
- Any evidence requires exposing auth state, values files, credentials, or unredacted target data.
- For development integration, the lightweight run record cannot identify the command, run mode,
  allowlist, result, `RUN_ID`, artifacts, issue, or next action.
- For production open, an operator or owner cannot identify the target approval, account, run time,
  artifacts, or stop path.

When a failure occurs, keep the artifacts local, record the refusal/failure reason, repair in the
authoring path, and rerun fixture gates before requesting another operator acceptance attempt.
