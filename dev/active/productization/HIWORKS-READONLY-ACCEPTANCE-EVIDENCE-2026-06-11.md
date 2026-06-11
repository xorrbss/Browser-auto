# Hiworks Read-Only Acceptance Evidence

Status: passed local operator acceptance
Date: 2026-06-11
Scope: `approval_office_hiworks_com_ibizsoftware_net_approval`

This evidence covers only the Hiworks `live-readonly` operator lane. It does not approve unattended
operation, live approval/reject actions, write flows, or broader production access.

## Result

```text
RUN_ID=20260611-153636-1422
flow=approval_office_hiworks_com_ibizsoftware_net_approval
mode=play
environment=live-readonly
riskClass=read
result=PASS
summary=1/1 passed
durationMs=5960
report=artifacts/20260611-153636-1422/report.json
junit=artifacts/20260611-153636-1422/report.junit.xml
```

The replay opened the first visible approval-list record and returned to the approval document list.
No approve, reject, save, upload, delete, or other write action was executed.

## Commands

Auth was refreshed by the local operator through the visible helper:

```text
auth-r45.cmd
```

The acceptance run used the operator-only wrapper:

```bash
bash bin/operator-staging-readonly.sh --validate-only approval_office_hiworks_com_ibizsoftware_net_approval
bash bin/operator-staging-readonly.sh approval_office_hiworks_com_ibizsoftware_net_approval
```

The run required `AQA_RUN_MODE=live-readonly`, fresh resolver and connection-IP evidence for every
allowed host, and an explicit target allowlist.

## Read-Only Origin Set

The final passing run used this read-only origin set:

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

`https://login.office.hiworks.com` was not included in the final passing replay allowlist.

## Fail-Closed Discovery Notes

Narrower allowlists refused execution before the final passing run:

```text
20260611-152903-86: refused login.office.hiworks.com with target-only allowlist
20260611-153312-3486: refused static.gabia.com
20260611-153417-3823: refused cdn.jsdelivr.net after opening the first record
20260611-153454-4533: refused banner-api.office.hiworks.com
```

These failures confirmed that the egress gate remained fail-closed while the required read-only support
origins were identified.

## Evidence Rules

Do not attach or commit:

- `fixtures/auth/playwright/r45.state.json`
- cookies, tokens, OTPs, bearer headers, or local storage values
- screenshots that expose business payloads
- raw resolver evidence unless owner-approved and redacted

Acceptable evidence:

- this summary
- `artifacts/20260611-153636-1422/report.json`
- `artifacts/20260611-153636-1422/report.junit.xml`
- redacted command transcript
- operator identity, run window, target owner approval ticket, and stop contact

## Owner Approval Needed

Before calling this lane open, the target owner should explicitly approve the expanded read-only origin
set above, especially the external support origins:

```text
https://static.gabia.com
https://cdn.jsdelivr.net
```

Until that owner approval is attached, the lane is technically validated but not production-open.
