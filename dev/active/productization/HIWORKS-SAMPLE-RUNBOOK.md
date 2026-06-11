# Hiworks Sample Runbook

Status: local fixture sample
Date: 2026-06-11

This is a safe local Hiworks-style approval sample. It does not contact
`approval.office.hiworks.com`, does not use auth state, and does not contain real approval data.

## What It Covers

Flow:

1. Open a local Hiworks-style waiting approval list.
2. Click `Open first approval`.
3. Wait for the read-only detail view.
4. Click `Back to list`.
5. Assert the list is visible again.

Files:

- `flows/hiworks-sample.flow.json`
- `tests/hiworks-sample.test.sh`

## Run It

From Git Bash:

```bash
bash run.sh hiworks-sample
```

Or run the compiled wrapper directly:

```bash
bash tests/hiworks-sample.test.sh
```

Validate without browser side effects:

```bash
node bin/play-flow.mjs --flow flows/hiworks-sample.flow.json --validate-only
```

## Expected Result

`bash run.sh hiworks-sample` should report:

```text
1/1 passed (0 failed)
```

The latest verified local run produced:

```text
RUN_ID=20260611-141113-1603
hiworks-sample: pass
```

## Boundary

This sample is only a local fixture. To test the real Hiworks approval target, use the operator-only
staging/live-readonly lane with exact target allowlist, resolver evidence, and fresh operator-owned
auth state. Per-system owner approval is not required for read-only development integration; it is
reserved for production open or write/unattended operation.
