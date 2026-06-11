# Hiworks Read-Only Owner Approval Request

Status: ready for owner review; awaiting owner decision
Date: 2026-06-11
Requested scope: limited open for the Hiworks read-only operator lane

This request asks the target owner to approve only the read-only operator lane for
`approval_office_hiworks_com_ibizsoftware_net_approval`. It does not request approval for unattended
operation, automatic approval, reject, write actions, bulk processing, or broader production access.

## Decision Requested

Approve or reject this exact scope:

```text
lane: Hiworks read-only operator lane
flow: approval_office_hiworks_com_ibizsoftware_net_approval
environment: live-readonly
riskClass: read
tenant_domain: ibizsoftware.net
app: r45
start_url: https://approval.office.hiworks.com/ibizsoftware.net/approval/document/lists/W
operator_wrapper: bash bin/operator-staging-readonly.sh approval_office_hiworks_com_ibizsoftware_net_approval
```

Approved behavior, if accepted:

- open the approval document list
- open the first visible approval-list record
- wait for the document-view URL
- return to the approval document list
- collect deterministic pass/fail metadata

Not approved by this request:

- approve, reject, save, delete, upload, download, or submit actions
- unattended or scheduled operation
- live-action approval gates
- `hiworks01`
- `guest_samsungdisplay_com_argos_main_do`
- any flow not named in this request
- any origin not named in the approved read-only origin set

## Evidence

Technical acceptance already passed locally:

```text
submission_commit=ad70af8 Submit Hiworks readonly evidence pack
owner_approval_packet_commit=8b8deb5 Add Hiworks readonly owner approval request
commit=d849140 Document Hiworks readonly acceptance
RUN_ID=20260611-153636-1422
result=PASS
summary=1/1 passed
durationMs=5960
report=artifacts/20260611-153636-1422/report.json
junit=artifacts/20260611-153636-1422/report.junit.xml
```

Clean revalidation also passed from a separate `origin/master` checkout:

```text
clean_commit=8b8deb510d166ac2b0a9318814597d19de0078fc
clean_checkout=C:\project\Browser-auto-clean-hiworks-20260611-163142
clean_git_status_short=(empty)
RUN_ID=20260611-163741-963
result=PASS
summary=1/1 passed
durationMs=6963
report=C:\project\Browser-auto-clean-hiworks-20260611-163142\artifacts\20260611-163741-963\report.json
junit=C:\project\Browser-auto-clean-hiworks-20260611-163142\artifacts\20260611-163741-963\report.junit.xml
```

Supporting documents:

```text
dev/active/productization/HIWORKS-READONLY-EVIDENCE-SUBMISSION-2026-06-11.md
dev/active/productization/HIWORKS-READONLY-ACCEPTANCE-EVIDENCE-2026-06-11.md
dev/active/productization/HIWORKS-READONLY-CLEAN-REVALIDATION-2026-06-11.md
dev/active/productization/HIWORKS-STAGING-READONLY-ENV-PACK.md
auth-r45.cmd
```

The replay did not execute approve, reject, save, upload, delete, or other write actions.

## Read-Only Origin Set

Approve this exact origin set for the read-only lane:

```text
https://approval.office.hiworks.com
https://account-api.office.hiworks.com
https://banner-api.office.hiworks.com
https://cache-api.office.hiworks.com
https://cdn.jsdelivr.net
https://count-api.office.hiworks.com
https://gnb.office.hiworks.com
https://hr-api.office.hiworks.com
https://in-app.office.hiworks.com
https://menu-api-v4.office.hiworks.com
https://office.hiworks.com
https://security-alarm-api.office.hiworks.com
https://static.gabia.com
https://static.hiworks.com
https://tab-menu.office.hiworks.com
```

`https://login.office.hiworks.com` is not part of the replay allowlist. If replay reaches login, MFA,
OTP, account recovery, or any wrong-account state, the operator must stop and refresh auth through the
approved manual flow.

## Operator Conditions

Use this pre-filled block. The `TBD` values must be supplied by the human owner/operator before the
lane is called open:

```yaml
target_owner: TBD - Hiworks / ibizsoftware.net approval system owner
approval_ticket: TBD - owner ticket or approval record id
operator_identity: TBD - named human operator
operator_account: TBD - approved Hiworks r45 account
run_window: TBD - owner-approved KST run window
stop_contact: TBD - person/channel to contact for immediate stop
auth_state_ref: aqa-secret://tenant_a/auth-state/canonical:r45
secret_owner: TBD - owner of the r45 auth-state secret reference
resolver_evidence_owner: TBD - owner/operator approving fresh DNS and connection-IP evidence
```

Operator must run from Windows + Git Bash with:

```bash
export AQA_RUN_MODE=live-readonly
export AQA_TARGET_ALLOWLIST='<approved read-only origin set>'
export AQA_EGRESS_REQUIRE_FRESH_RESOLVER_EVIDENCE=1
export AQA_EGRESS_REQUIRE_CONNECTION_IP_EVIDENCE=1
export AQA_EGRESS_RESOLVER_EVIDENCE='<fresh owner-approved evidence for every allowed host>'
```

## Hard Stops

The lane must not run if any of these are true:

- the owner has not approved every origin in the read-only origin set
- resolver or connection-IP evidence is missing, stale, or broader than the approved set
- `AQA_RUN_MODE` is not `live-readonly`
- auth state is missing, stale, wrong tenant, wrong account, or reaches MFA/OTP during replay
- the journey exposes a write, approve, reject, save, delete, upload, download, or submit action
- any raw cookie, token, OTP, bearer header, local storage value, or `r45.state.json` is requested as evidence
- the operator is asked to run a flow outside this approval request

## Owner Decision

Select one:

```text
[ ] APPROVED: limited open for the named Hiworks read-only operator lane
[ ] REJECTED
[ ] CHANGES REQUESTED
```

Approval metadata:

```yaml
owner_name: TBD
owner_role: TBD
approval_ticket: TBD
approved_run_window: TBD
approved_operator: TBD
approved_origin_set_version: 2026-06-11-hiworks-readonly
decision_timestamp: TBD
signature: TBD
conditions: limited to the named Hiworks live-readonly operator lane; no unattended or write actions
```

## Evidence Attachment Rules

Attach only:

- this approval request after owner decision
- redacted command transcript
- `artifacts/20260611-153636-1422/report.json`
- `artifacts/20260611-153636-1422/report.junit.xml`
- clean revalidation `report.json` and `report.junit.xml` for `RUN_ID=20260611-163741-963`
- operator identity, run window, stop contact, and approval ticket

Do not attach:

- `fixtures/auth/playwright/r45.state.json`
- cookies, tokens, OTPs, bearer headers, or local storage values
- screenshots or logs containing business payloads
- unredacted resolver data unless owner-approved
