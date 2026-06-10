# Browser-auto Product Candidate Status

Status: internal-pilot candidate, external-service no-go
Date: 2026-06-10

This status file summarizes the current productization pass. `P0-SERVICE-OPEN.md` remains the source
of truth for external-service acceptance; this file records what is implemented now and what still
blocks service open.

## Implemented In This Pass

- External mode gate: `WEBUI_EXTERNAL_MODE=1` now requires `WEBUI_AUTH_TOKEN` and `WEBUI_TENANT_ID`
  before any page, API, artifact, or job stream route can proceed.
- External mutating requests require bearer auth plus same-origin `Origin` or `Referer`; optional
  `WEBUI_CSRF_TOKEN` requires `X-AQA-CSRF`.
- WebUI responses now set baseline security headers and deny direct secret-bearing path shapes such
  as auth state, values sidecars, DB files, and runtime data paths.
- Local RBAC readback now includes tenant/security-mode metadata; queued jobs expose tenant/actor
  metadata.
- Job API, SSE logs, command-plan readback, audit readback, and run failure summaries use shared
  redaction helpers for tokens, cookies, auth headers, OTP/MFA/code fields, URL query strings, IDs,
  emails, and phone numbers.
- Flow values are write-only through the WebUI API. `GET /api/flows/:name` returns token presence
  metadata, not raw `.values.json` content.
- Job state transitions append a redacted JSONL journal under `data/webui-jobs.jsonl` as an initial
  durable audit direction. This is not yet a durable queue.
- Docker entrypoint refuses passwordless noVNC in external mode unless noVNC is disabled or an
  explicit authenticated proxy boundary is declared.
- `ianatour` and `nav-roundtrip` now declare `engine: "playwright"` explicitly.

## Flow Inventory

| Flow | Status | Blocker |
| --- | --- | --- |
| `login` | Runnable local candidate | None; validate/compile/run through fixture lane. |
| `nav-roundtrip` | Playwright, operator-only | `live-readonly` external target; do not run unattended. |
| `ianatour` | Playwright, operator-only | `live-readonly` external target; do not run unattended. |
| `approval_office_hiworks_com_ibizsoftware_net_approval` | Playwright, operator-only | App-bound external business URL; requires operator auth refresh. |
| `guest_samsungdisplay_com_argos_main_do` | Blocked | `live-action` effectful flow with 2 `needs_review` steps and missing irreversible gate review. |
| `hiworks01` | Legacy debt | Explicit `agent-browser`, destructive live-action, 2 `needs_review` steps. |

## P0 Readiness

External service open remains no-go.

Closed or partially closed for pre-serverization:

- P0-A: external mode has a fail-closed auth gate and tenant metadata, but no real user login/session
  lifecycle or cross-tenant storage enforcement.
- P0-B: external mutating routes require bearer auth and same-origin metadata, with optional CSRF; a
  complete cookie-session CSRF system and CORS policy are still open.
- P0-C: direct secret path serving and WebUI value readback are blocked; encrypted tenant-scoped
  secret storage and rotation are still open.
- P0-D: noVNC is fail-closed in external mode unless explicitly fronted or disabled; per-tenant/job
  browser isolation is still open.
- P0-F: redacted job journaling exists; durable queue, restart reconciliation, and tamper-evident audit
  are still open.

Major blockers:

- Real login/session management with expiration, logout, secure cookies, and user management.
- Tenant IDs in DB schema, artifact metadata, auth state keys, flow/job ownership, and audit records.
- Encrypted tenant-scoped secret storage for auth state, values, credentials, and cookie jars.
- Target egress allowlist enforced at registration, enqueue/import, navigation, redirects, and iframes.
- Durable queue with persisted cancellation and startup reconciliation.
- Full P0 negative acceptance suite and release gate.

## Operator-Only Commands

Run these only on an operator machine with approval from the target owner:

```bash
bash setup/auth.sh <app> <login-url> '<success-url>'
node bin/play-flow.mjs --flow flows/<name>.flow.json --validate-only
bash bin/probe-record.sh verify flows/<name>.flow.json
bash bin/probe-record.sh compile flows/<name>.flow.json
bash run.sh <name>
```

For any `live-action` or effectful flow, run a dry-run first, keep `AQA_RUN_MODE` and allowlists
explicit, and require a human owner/operator decision before touching a live target.
