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

## External Runner Local Execution

Executed from a clean `origin/master` worktree on 2026-06-11 before this documentation update. Scope is
local deterministic external-mode contract evidence only: loopback WebUI, authenticated runner API,
durable job store, outbound `runner-worker`, local JSONL audit sink, and fixture job execution. This is
not evidence of a deployed production external runner topology or production audit webhook delivery.

| Command | Result | Evidence |
| --- | --- | --- |
| `node bin/local-external-runner-smoke.mjs` | PASS | `{"ok":true,"jobId":"j1781148278874","port":49195,"status":"succeeded","workerId":"runner-local","auditSinkWritten":true}` |
| `bash tests/local-external-runner-e2e.test.sh` | PASS | Local external-mode WebUI plus outbound runner worker smoke completed. |
| `bash tests/runner-worker-unit.test.sh` | PASS | Worker claim, execution, cancellation, and log-redaction contract remained green. |
| `bash tests/runner-contract-unit.test.sh` | PASS | External runner contract and audit outbox helper coverage remained green. |
| `bash tests/runner-api-unit.test.sh` | PASS | Runner API helper coverage remained green. |
| `bash tests/runner-api-route-unit.test.sh` | PASS | Runner API route adapter coverage remained green. |
| `bash tests/jobs-durable-unit.test.sh` | PASS | Durable job store coverage remained green. |
| `bash tests/audit-outbox-worker-unit.test.sh` | PASS | Audit outbox worker coverage remained green. |
| `bash tests/audit-outbox-scheduler-unit.test.sh` | PASS | Audit outbox scheduler coverage remained green. |
| `bash tests/local-external-rehearsal-unit.test.sh` | PASS | Local external-mode rehearsal wrapper configuration checks remained green. |
| `bash tests/security-p0-gate.test.sh` | PASS | Fixture-only P0 gate passed, including `local-external-runner-e2e` and runner contract/API/worker tests. |

## Audit Webhook Local Execution

Executed from a clean `origin/master` worktree on 2026-06-11 before this documentation update. Scope is
local deterministic audit webhook contract evidence only: a temp SQLite outbox, webhook-mode sink
metadata, tenant-scoped secret-reference metadata, fake connector delivery, hash-only envelope
verification, scheduler behavior, retry/dead-letter classification, and fail-closed missing-connector
coverage. This is not evidence of a deployed production webhook endpoint, production webhook connector,
or real secret broker delivery.

| Command | Result | Evidence |
| --- | --- | --- |
| inline Node audit webhook drain smoke (`AQA_DB_PATH=<temp> node -`) | PASS | `{"ok":true,"checked":1,"delivered":1,"failed":0,"deadLettered":0,"finalStatus":"delivered","connectorCalls":1,"connectorId":"local-fake-audit-webhook","envelopeKind":"webui-audit-outbox","payloadBody":null,"payloadRedacted":true,"targetHost":"audit.example.test","rawLeak":false}` |
| `bash tests/audit-outbox-worker-unit.test.sh` | PASS | Audit outbox worker delivered due webhook rows through the connector interface and kept connector envelopes metadata-only. |
| `bash tests/audit-outbox-scheduler-unit.test.sh` | PASS | Webhook-mode scheduler manual tick, single-flight behavior, missing-connector backoff, and scheduler backoff coverage remained green. |
| `bash tests/runner-contract-unit.test.sh` | PASS | Runner-facing audit webhook delivery contract, retry/dead-letter behavior, and plaintext credential refusal remained green. |
| `bash tests/jobs-durable-unit.test.sh` | PASS | Webhook sink preflight, pending outbox metadata, JSONL sink, and durable job audit behavior remained green. |
| `bash tests/runner-api-unit.test.sh` | PASS | Runner API audit-adjacent contract coverage remained green. |
| `bash tests/release-checklist-unit.test.sh` | PASS | Release checklist still reports production audit webhook delivery as external/operator-owned evidence. |
| `bash tests/security-p0-gate.test.sh` | PASS | Fixture-only P0 gate passed, including audit outbox worker/scheduler and runner contract/API tests. |

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
