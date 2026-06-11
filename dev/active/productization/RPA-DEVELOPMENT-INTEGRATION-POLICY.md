# RPA Development Integration Policy

Status: active
Date: 2026-06-11
Scope: fast multi-system development and read-only integration testing for Browser-auto.

This policy separates product development from production opening. The goal is to test many business
systems quickly without turning every system probe into an owner-approval project.

## Policy Decision

Per-system owner approval packets are not required for development integration testing.

Owner approval is required only for:

- production open
- unattended, scheduled, or external-runner operation
- approve, reject, submit, save, delete, upload, download, transfer, or other write actions
- bulk processing
- shared customer tenants or accounts not directly controlled by the tester/operator
- expanding a lane from technical validation into a supported operational service

For development integration, record the technical facts needed to reproduce and debug the run. Do not
block testing on target-owner signatures.

## Test Modes

### Fixture / CI

Use local fixtures, data URLs, localhost, or committed sample flows. These run in CI and must remain
deterministic.

Record:

```text
commit
command
result
RUN_ID or test output
```

### Development Integration

Use this mode to connect new business systems, discover UI patterns, validate locator strategy, verify
auth handling, and build reusable recipes.

Allowed when all are true:

- a human tester/operator has legitimate access to the target account
- the flow is read-only or explicitly marked exploratory
- the run is interactive or operator-triggered, not scheduled or unattended
- target origins are exact allowlist entries, not wildcards
- sensitive values stay in gitignored auth/values files or secret refs
- artifacts do not include cookies, tokens, OTPs, raw local storage, or business payload screenshots

Record only a lightweight run note:

```text
system:
flow:
purpose:
commit:
command:
run_mode:
allowlist:
result:
RUN_ID:
artifact_paths:
issues_found:
next_action:
```

No owner signature, approval ticket, stop contact, or formal evidence pack is required in this mode.

### Production Open

Use this mode when a validated lane becomes an operational service for real users or customer-owned
tenants.

Production open requires the heavier handoff material: owner approval, deployment identity, secret
broker/KMS, audit webhook, external runner, rollback/stop contact, and support boundaries.

## Efficient Multi-System Loop

For each new system, do this:

1. Create or capture a small read-only flow.
2. Run `validate-only`.
3. Run one operator-triggered replay if the flow is read-only.
4. Save the artifact path and `RUN_ID`.
5. Fix locators, auth freshness, iframe handling, pagination, or recipe extraction.
6. Move to the next system.

Do not create per-system owner approval packets during this loop.

## Hard Stops During Development

Stop and reclassify out of development integration if the test needs:

- approve/reject/write behavior
- unattended execution
- a customer-owned production account without tester authority
- raw secret inspection
- broad wildcard egress
- business payload capture as evidence
- bypassing fail-closed `needs_review`, egress, auth, or destructive-action gates

## What To Keep

Keep enough evidence to make engineering progress:

- flow file and compiled wrapper
- command used
- commit hash
- `RUN_ID`
- pass/fail result
- redacted failure reason
- locator/recipe/auth issues found

The artifact directories and deterministic test output are the primary development record.

## What Not To Keep

Do not keep or commit:

- `fixtures/auth/playwright/*.state.json`
- `.values.json`
- cookies, bearer tokens, OTPs, local storage values, or raw auth state
- screenshots or downloads containing business payloads
- raw resolver evidence unless it is needed for a production-open package

## Relationship To Hiworks Documents

The existing Hiworks owner approval and evidence submission documents are production-open templates.
They are not required to continue development integration against Hiworks or other systems.

For now, treat the Hiworks result as a successful development integration proof:

```text
flow=approval_office_hiworks_com_ibizsoftware_net_approval
clean_revalidation_RUN_ID=20260611-163741-963
result=PASS
scope=read-only development integration
production_open=false
```
