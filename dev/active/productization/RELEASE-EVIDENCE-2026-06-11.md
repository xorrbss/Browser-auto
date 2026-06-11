# Release Evidence - 2026-06-11

Status: fixture-ready, external-service No-Go

This file records the clean-checkout evidence for the deterministic service-open gate. It is not
operator approval for live/non-local replay and does not replace `P0-SERVICE-OPEN.md`.

## Subject

- Repository: `https://github.com/xorrbss/Browser-auto.git`
- Branch: `origin/master`
- Verified commit: `b3ee3b6`
- Clean clone: `C:\Users\ibiz\AppData\Local\Temp\browser-auto-clean-evidence-20260611-121525`
- Shell: `C:\Program Files\Git\bin\bash.exe`
- Node: `v24.16.0`
- Dependency prep: `cd approve && npm ci` passed.
- Note: `npm ci` reported one high-severity audit finding from npm audit metadata; install completed and the deterministic gates passed. This was not evaluated as part of P0 service-open security acceptance.

## Deterministic Evidence

| Command | Result | Evidence |
| --- | --- | --- |
| `bash tests/security-p0-gate.test.sh` | PASS | Fixture-only P0 gate completed without live auth, non-local target replay, or live-action execution. |
| `bash run.sh` | PASS | `75/75 passed (0 failed)`; default suite skipped operator-only/app-bound flows. |

Latest clean-clone full-suite run:

- Run ID: `20260611-121719-64`
- Report metadata: `artifacts/20260611-121719-64/report.json`
- JUnit metadata: `artifacts/20260611-121719-64/report.junit.xml`
- Skipped by default: `approval_office_hiworks_com_ibizsoftware_net_approval`, `ianatour`, `login`, `nav-roundtrip`.
- Reason for skips: app-bound/operator-owned auth or non-local lane; run only by explicit operator action with the matching auth, run mode, and target allowlist.

## Release Checklist Decision

`node bin/release-checklist.mjs --markdown --artifacts-dir artifacts` reports `Decision: No-Go`.

The No-Go decision is expected and conservative. Local deterministic contracts are green, but external
service open still requires operator-owned evidence for:

- Real IdP/SSO login, token/assertion verification, and production user management.
- Production HTTPS cookie/session deployment.
- Real KMS/secret broker connector plus approved migration, rotation, and deletion.
- Real TLS noVNC proxy/browser isolation and physical profile/download cleanup.
- Platform DNS/IP-at-connection enforcement and tenant-owned allowlist administration.
- Deployed external runners and production audit webhook delivery.
- Production export service and tenant deletion across real secrets, browser state, and log storage.
- Operator-approved staging/live acceptance and non-local/live-readonly acceptance.

## Notes

- During clean-clone verification, `tests/webui-flows-unit.test.sh` was made path-portable so artifact
  fixture links use repo-relative paths instead of clone-specific absolute paths.
- `bin/local-external-runner-smoke.mjs` now retries brief SQLite busy/locked windows during smoke job
  insertion. This stabilizes the default suite where `local-external-runner-e2e` runs directly and again
  inside `security-p0-gate`.
