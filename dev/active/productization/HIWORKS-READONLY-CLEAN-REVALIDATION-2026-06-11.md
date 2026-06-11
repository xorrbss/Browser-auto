# Hiworks Read-Only Clean Revalidation

Status: passed from clean `origin/master`
Date: 2026-06-11
Scope: `approval_office_hiworks_com_ibizsoftware_net_approval`

This revalidation was run from a separate clean checkout so the main working tree's unrelated local
changes did not affect the result.

## Clean Baseline

```text
clean_checkout=C:\project\Browser-auto-clean-hiworks-20260611-163142
commit=8b8deb510d166ac2b0a9318814597d19de0078fc
short_commit=8b8deb5
git_status_short=(empty)
```

The local operator auth state was copied into the clean checkout only for replay and remained ignored
by the fixture auth ignore rules. The auth state contents were not printed, attached, or committed.

## Command Results

```text
auth-r45.cmd dry-run: PASS
security-p0-gate via Git Bash: PASS
fresh resolver evidence generation: PASS for 15 allowed hosts
operator-staging-readonly --validate-only: PASS
operator-staging-readonly replay: PASS
```

The plain `bash` command on this machine resolved to WSL and was rejected for this Windows/Git Bash
target. The gate was rerun with `C:\Program Files\Git\bin\bash.exe` and passed.

## Replay Evidence

```text
RUN_ID=20260611-163741-963
flow=approval_office_hiworks_com_ibizsoftware_net_approval
result=PASS
summary=1/1 passed
durationMs=6963
report=C:\project\Browser-auto-clean-hiworks-20260611-163142\artifacts\20260611-163741-963\report.json
junit=C:\project\Browser-auto-clean-hiworks-20260611-163142\artifacts\20260611-163741-963\report.junit.xml
results=C:\project\Browser-auto-clean-hiworks-20260611-163142\artifacts\20260611-163741-963\results.tsv
```

Report summary:

```text
approval_office_hiworks_com_ibizsoftware_net_approval pass 6963ms
```

## Read-Only Origin Set Used

The clean replay used the same read-only origin set listed in
`HIWORKS-READONLY-OWNER-APPROVAL-REQUEST-2026-06-11.md` as a production-open template. The origin set
is the tested development allowlist; the owner approval document is not a development gate. Raw resolver
and connection-IP evidence were generated freshly for the run but are not included here.

## Evidence Handling

Do not attach:

- `fixtures/auth/playwright/r45.state.json`
- cookies, tokens, OTPs, bearer headers, or local storage values
- raw resolver or connection-IP evidence unless a later production-open package separately approves and
  redacts it
- raw terminal transcripts that include business payloads

Production-open attachable evidence:

- this summary
- clean replay `report.json`
- clean replay `report.junit.xml`
- clean replay `results.tsv`
- owner approval request after signature, only if the lane is later promoted to production-open
