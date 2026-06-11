# Hiworks Read-Only Evidence Submission

Submission status: ready for owner review, pending actual owner signature
Date: 2026-06-11
Scope: limited owner review for the Hiworks read-only operator lane

This evidence pack is submitted for owner review of only
`approval_office_hiworks_com_ibizsoftware_net_approval` in `live-readonly` mode. It does not request
approval for unattended operation, automatic approval, reject, write actions, bulk processing, or any
other Hiworks or guest flow.

## Submission References

```text
owner_approval_commit=8b8deb5
acceptance_commit=d849140
flow=approval_office_hiworks_com_ibizsoftware_net_approval
environment=live-readonly
riskClass=read
tenant_domain=ibizsoftware.net
app=r45
```

Supporting documents:

```text
dev/active/productization/HIWORKS-READONLY-OWNER-APPROVAL-REQUEST-2026-06-11.md
dev/active/productization/HIWORKS-READONLY-ACCEPTANCE-EVIDENCE-2026-06-11.md
dev/active/productization/HIWORKS-READONLY-CLEAN-REVALIDATION-2026-06-11.md
dev/active/productization/HIWORKS-STAGING-READONLY-ENV-PACK.md
dev/active/productization/PRODUCT-CANDIDATE-STATUS.md
auth-r45.cmd
```

## Acceptance Evidence

```text
RUN_ID=20260611-153636-1422
result=PASS
summary=1/1 passed
durationMs=5960
report=artifacts/20260611-153636-1422/report.json
junit=artifacts/20260611-153636-1422/report.junit.xml
```

The accepted replay opened the approval document list, opened the first visible approval-list record,
waited for the document-view URL, and returned to the approval document list. No approve, reject,
save, delete, upload, download, submit, or other write action was executed.

## Clean Revalidation Evidence

The lane was revalidated from a separate clean `origin/master` checkout after the owner approval packet
was pushed:

```text
clean_checkout=C:\project\Browser-auto-clean-hiworks-20260611-163142
commit=8b8deb510d166ac2b0a9318814597d19de0078fc
git_status_short=(empty)
auth-r45.cmd dry-run=PASS
security-p0-gate via Git Bash=PASS
operator-staging-readonly --validate-only=PASS
operator-staging-readonly replay=PASS
RUN_ID=20260611-163741-963
result=PASS
summary=1/1 passed
durationMs=6963
report=C:\project\Browser-auto-clean-hiworks-20260611-163142\artifacts\20260611-163741-963\report.json
junit=C:\project\Browser-auto-clean-hiworks-20260611-163142\artifacts\20260611-163741-963\report.junit.xml
results=C:\project\Browser-auto-clean-hiworks-20260611-163142\artifacts\20260611-163741-963\results.tsv
```

The local auth state was copied into the clean checkout only for replay. Its contents were not printed,
attached, or committed.

## Read-Only Origin Set

Owner approval is requested for this exact read-only origin set:

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
OTP, account recovery, wrong tenant, or wrong account state, the operator must stop and refresh auth
through the approved manual flow.

## Attached Evidence List

Attach only these evidence items after redaction review:

- this submission document
- completed owner approval request after signature
- `dev/active/productization/HIWORKS-READONLY-ACCEPTANCE-EVIDENCE-2026-06-11.md`
- `dev/active/productization/HIWORKS-READONLY-CLEAN-REVALIDATION-2026-06-11.md`
- `dev/active/productization/HIWORKS-STAGING-READONLY-ENV-PACK.md`
- `artifacts/20260611-153636-1422/report.json`
- `artifacts/20260611-153636-1422/report.junit.xml`
- clean revalidation `report.json` and `report.junit.xml` from `RUN_ID=20260611-163741-963`
- redacted command transcript for validate-only and replay
- operator identity, operator account, approved run window, stop contact, and approval ticket
- auth freshness metadata for `app:r45` without auth-state contents

Fresh resolver and connection-IP evidence was required by the run envelope. Do not include raw
resolver evidence in this submission unless it is separately owner-approved and redacted.

## Explicit Exclusions

This submission does not authorize:

- unattended or scheduled operation
- automatic approval
- approve, reject, save, delete, upload, download, submit, or any other write action
- live-action approval gates
- bulk processing
- `hiworks01`
- `guest_samsungdisplay_com_argos_main_do`
- any flow not named in this submission
- any origin not listed in the exact read-only origin set above
- any use of `https://login.office.hiworks.com` as a replay target

## Owner Fields To Fill And Sign

Fill these fields before the lane is called open:

```yaml
target_owner:
owner_name:
owner_role:
approval_ticket:
operator_identity:
operator_account:
approved_run_window:
stop_contact:
approved_origin_set_version: 2026-06-11-hiworks-readonly
auth_state_ref: aqa-secret://tenant_a/auth-state/canonical:r45
secret_owner:
resolver_evidence_owner:
decision: # APPROVED | REJECTED | CHANGES_REQUESTED
decision_timestamp:
signature:
conditions:
```

Owner decision:

```text
[ ] APPROVED: limited open for the named Hiworks read-only operator lane
[ ] REJECTED
[ ] CHANGES REQUESTED
```

## Do Not Attach

Do not attach, paste, commit, or transmit:

- `fixtures/auth/playwright/r45.state.json`
- cookies
- tokens
- OTPs
- bearer headers
- local storage values
- screenshots that expose business payloads
- logs containing business payloads
- raw resolver evidence
- unredacted command output containing secrets or business content

## Submission Result

This pack is ready for owner review, but the lane remains pending actual owner signature. Until the
owner signs the exact scope and read-only origin set, the status is technically validated but not
production-open.
