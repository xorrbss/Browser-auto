# Hiworks Staging Readonly Env Pack

Status: operator template, not executable as-is
Date: 2026-06-11
Scope: first operator-owned Hiworks read-only acceptance for
`approval_office_hiworks_com_ibizsoftware_net_approval`.

This pack prepares the real Hiworks read-only lane without exposing secrets. It does not authorize
`hiworks01`, `guest_samsungdisplay_com_argos_main_do`, unattended approval, or any live-action flow.

## Flow Boundary

Use only this candidate flow for the first real Hiworks acceptance:

```text
flow_name: approval_office_hiworks_com_ibizsoftware_net_approval
flow_file: flows/approval_office_hiworks_com_ibizsoftware_net_approval.flow.json
compiled_wrapper: tests/approval_office_hiworks_com_ibizsoftware_net_approval.test.sh
declared_environment: live-readonly
risk_class: read
app: r45
target_origin: https://approval.office.hiworks.com
start_url: https://approval.office.hiworks.com/ibizsoftware.net/approval/document/lists/W
```

Because the committed flow declares `environment:"live-readonly"`, the operator command must use
`AQA_RUN_MODE=live-readonly`. If an owner wants a true staging origin, capture or clone a separate flow
whose `startUrl` and `environment` are explicitly staging.

## Owner Inputs

Fill this before any real-target run. Do not paste secret values.

```yaml
approval:
  target_owner:
  approval_ticket:
  run_window:
  stop_contact:

account:
  operator_account:
  tenant_domain: ibizsoftware.net
  app: r45
  auth_state_status: ready # ready | missing | stale
  auth_state_ref: aqa-secret://tenant_a/auth-state/canonical:r45

target:
  origin: https://approval.office.hiworks.com
  expected_start_path: /ibizsoftware.net/approval/document/lists/W
  expected_return_path: /ibizsoftware.net/approval/document/lists/W
  approved_readonly_origins:
    - https://approval.office.hiworks.com
    - https://account-api.office.hiworks.com
    - https://banner-api.office.hiworks.com
    - https://cache-api.office.hiworks.com
    - https://cdn.jsdelivr.net
    - https://count-api.office.hiworks.com
    - https://gnb.office.hiworks.com
    - https://hr-api.office.hiworks.com
    - https://in-app.office.hiworks.com
    - https://menu-api-v4.office.hiworks.com
    - https://office.hiworks.com
    - https://security-alarm-api.office.hiworks.com
    - https://static.gabia.com
    - https://static.hiworks.com
    - https://tab-menu.office.hiworks.com

egress:
  resolver_evidence_file:
  connection_ip_evidence_file:
  evidence_generated_at:
  evidence_owner:
```

## Env Template

Use Git Bash. Replace the resolver evidence JSON before running. The example IP and timestamp are
documentation placeholders only.

```bash
export AQA_RUN_MODE=live-readonly
export AQA_TARGET_ALLOWLIST='https://approval.office.hiworks.com,https://account-api.office.hiworks.com,https://banner-api.office.hiworks.com,https://cache-api.office.hiworks.com,https://cdn.jsdelivr.net,https://count-api.office.hiworks.com,https://gnb.office.hiworks.com,https://hr-api.office.hiworks.com,https://in-app.office.hiworks.com,https://menu-api-v4.office.hiworks.com,https://office.hiworks.com,https://security-alarm-api.office.hiworks.com,https://static.gabia.com,https://static.hiworks.com,https://tab-menu.office.hiworks.com'
export AQA_EGRESS_REQUIRE_FRESH_RESOLVER_EVIDENCE=1
export AQA_EGRESS_REQUIRE_CONNECTION_IP_EVIDENCE=1

# Replace this with fresh operator-approved resolver evidence for every host in AQA_TARGET_ALLOWLIST.
export AQA_EGRESS_RESOLVER_EVIDENCE='{
  "approval.office.hiworks.com": {
    "addresses": ["203.0.113.10"],
    "connectionIps": ["203.0.113.10"],
    "resolvedAtMs": 1760000000000,
    "ttlMs": 300000
  }
}'
```

If connection IP evidence is supplied separately instead of embedded in the resolver evidence:

```bash
export AQA_EGRESS_CONNECTION_IPS='{
  "approval.office.hiworks.com": ["203.0.113.10"]
}'
```

## Local Preflight Commands

Run local gates first. These commands do not contact the real target:

```bash
node bin/blocked-flow-report.mjs --flows flows --format markdown
bash tests/security-p0-gate.test.sh
```

Expected preflight state:

- blocked-flow report classifies the flow as `operator-only`, not blocked.
- `security-p0-gate` passes locally.
- release checklist remains `Decision: No-Go` until real operator evidence is attached.

Do not run bare `node bin/play-flow.mjs --flow
flows/approval_office_hiworks_com_ibizsoftware_net_approval.flow.json --validate-only` without the
operator env above. The flow is `live-readonly`, so validation must include matching `AQA_RUN_MODE`,
target allowlist, and fresh resolver/connection-IP evidence.

## Manual Auth Helper

When `auth_state_status` is `missing` or `stale`, refresh the local `r45` Playwright auth state from
the operator's own Windows desktop:

```text
auth-r45.cmd
```

This helper opens a visible Git Bash auth runner, which then opens the Playwright browser. Log in to
Hiworks, navigate to the approval document list, and press Enter in the helper window only after the
list is visible. The helper writes a local stopfile so `setup/auth.sh` saves
`fixtures/auth/playwright/r45.state.json`.

Do not attach the saved state file, cookies, OTPs, or screenshots that expose business payloads as
evidence. Record only the operator, timestamp, target origin, and whether the auth state was refreshed
successfully.

## Operator Validate-Only

After exporting the env above:

```bash
bash bin/operator-staging-readonly.sh --validate-only approval_office_hiworks_com_ibizsoftware_net_approval
```

This validates the live-readonly envelope without executing the compiled journey. If it refuses, do not
weaken the gate. Fix the env, approval, resolver evidence, or flow metadata.

## Operator Replay

Run only after validate-only passes and the target owner approves the window:

```bash
bash bin/operator-staging-readonly.sh approval_office_hiworks_com_ibizsoftware_net_approval
```

Stop immediately if the browser reaches login, MFA, OTP, account recovery, a wrong tenant, a wrong
account, a write/approve action, or a target outside the allowlist.

## Evidence To Attach

Attach redacted evidence only:

- Commit hash and clean worktree status.
- Local gate transcript: `security-p0-gate`, `run.sh`, and the flow `validate-only`.
- Blocked-flow report showing this flow is operator-only and read-only.
- Owner approval ticket, target origin, run window, operator identity, and stop contact.
- Auth freshness metadata for `app:r45`; never attach `fixtures/auth/playwright/r45.state.json`.
- Exact env values except secret material; resolver and connection-IP evidence may be attached if
  redacted and owner-approved.
- `operator-staging-readonly.sh --validate-only` transcript.
- Replay transcript and `artifacts/<RUN_ID>/report.json` / `report.junit.xml` metadata after review.

## Hard Stops

Do not run if any of these are true:

- `AQA_RUN_MODE` is not `live-readonly`.
- `AQA_TARGET_ALLOWLIST` is broader than the owner-approved Hiworks read-only origin set above.
- Resolver or connection-IP evidence is stale, missing, or mismatched.
- Auth state is missing/stale, reaches MFA/OTP, or belongs to the wrong account or tenant.
- The journey exposes a write, approve, reject, delete, save, upload, download, or irreversible action.
- Any operator asks to include `hiworks01` or `guest_samsungdisplay_com_argos_main_do` in this lane.
- Any secret, cookie, OTP, bearer token, `.values.json`, or raw business payload appears in evidence.
