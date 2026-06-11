# agent-qa

Playwright-backed web test automation for deterministic user journeys.

A test is **one bash file = one user journey**. Replay is AI-free: the compiled bash file runs the
same Playwright flow every time (`bash $0`, no API key, no LLM in the loop). AI or a human may help
author and repair a flow, but the pass/fail gate is deterministic.

## Requirements

- Windows + Git Bash (`C:\Program Files\Git\bin\bash.exe`)
- `node` >= 22.5 (Node 24 verified; `lib/db.js` uses built-in `node:sqlite`)
- `jq` (`winget install jqlang.jq`)
- Playwright runtime from `approve/`:

```bash
cd approve
npm ci
npx playwright install chrome
cd ..
```

## Run

```bash
bash run.sh                 # all tests/*.test.sh; CI gate exits 1 if any fail
bash run.sh login           # tests/login.test.sh
bash tests/login.test.sh    # single journey standalone
```

The default suite skips compiled flows that declare an `app` because they need operator-owned
Playwright auth state. Run those explicitly (`bash run.sh <name>`) or set `AQA_INCLUDE_LIVE_AUTH=1`
on an operator machine with the matching local pilot auth file or configured auth-state secret ref.

Artifacts land in `artifacts/<run-id>/` (gitignored). Each suite run writes `report.json` and
`report.junit.xml`.

## Auth

Sites needing SSO, OTP, or 2FA are handled once with a headed Playwright login:

```bash
bash setup/auth.sh myapp https://app.example.com/login '**/dashboard'
```

Complete the login by hand in the browser window. The script saves
`fixtures/auth/playwright/myapp.state.json` (gitignored). Future Playwright flows with
`"app": "myapp"` can run from that cached state when an operator explicitly invokes them, without
repeating SSO/OTP in the replay path.

In external/encrypted mode (`WEBUI_EXTERNAL_MODE=1`, `AQA_EXTERNAL_MODE=1`, or
`WEBUI_SECRET_STORE_BACKEND=encrypted-local`), `setup/auth.sh` refuses local plaintext auth state unless
the configured secret backend is usable. Headed auth captures to a temporary file, imports the
storageState as an `aqa-secret://<tenant>/auth-state/canonical:<app>` ref, and removes the temporary
plaintext file. The documented local-pilot bypass is `WEBUI_LOCAL_PILOT_PLAINTEXT_SECRETS=1`.

## Record, Verify, Compile

```bash
# Optional: create a snapshot and stub to author against.
bash bin/probe-record.sh scaffold checkout https://app.example.com/cart

# Record a live headed journey. You drive the browser; capture writes the flow.
bash bin/probe-record.sh capture checkout https://app.example.com/cart --app myapp

# Fill any {{input_N}} values in the local pilot sidecar, or through the WebUI secret backend in
# external/encrypted mode, then resolve needs_review steps.

# Verify/re-drive with Playwright, repairing or promoting locators where possible.
bash bin/probe-record.sh verify flows/checkout.flow.json

# Compile to the deterministic bash wrapper.
bash bin/probe-record.sh compile flows/checkout.flow.json

# Run the compiled journey.
bash tests/checkout.test.sh
bash run.sh checkout
```

For direct runner checks:

```bash
node bin/play-flow.mjs --flow flows/checkout.flow.json --validate-only
node bin/play-flow.mjs --flow flows/checkout.flow.json --verify
node bin/play-flow.mjs --flow flows/checkout.flow.json
```

Compiled Playwright tests are small bash wrappers around `node bin/play-flow.mjs --flow ...`, preserving
the "one bash file = one user journey" contract.

## Read-Only Development Integration

For trying many business systems during development, a read-only operator-triggered run does not
require a per-system owner approval packet, approval ticket, stop contact, or formal evidence pack.
Use `validate-only`, an exact `AQA_TARGET_ALLOWLIST`, and a local operator-owned auth state or secret
ref when the flow declares an `app`.

Keep only the lightweight development record: `commit`, `command`, `run_mode`, `allowlist`, `result`,
`RUN_ID`, `artifact_paths`, `issues_found`, and `next_action`. Promotion to production-open,
unattended/scheduled operation, external-runner execution, or approve/reject/write behavior still
requires owner approval and the heavier evidence pack.

Use the development wrapper for this loop:

```bash
bash bin/dev-integration-readonly.sh --validate-only <flow-name>
bash bin/dev-integration-readonly.sh --allowlist https://host[:port][,...] <flow-name>
```

If `--allowlist` is omitted, the wrapper derives the exact origin from `startUrl`. Add a comma-separated
exact-origin allowlist only when the read-only flow is expected to navigate across known product
origins. The wrapper prints `RUN_ID`, the effective allowlist, and
`artifacts/<RUN_ID>/dev-integration-readonly.json`.

The Hiworks approval/evidence documents under `dev/active/productization/` are production-open
templates, not development integration gates. The current Hiworks read-only lane remains a
development integration PASS.

## RPA Validation Without External Dependencies

Use this gate when changing generic RPA extraction, pagination, detail-open, iframe capture, or approval
dry-run safety without hitting a real app, auth provider, LLM, or network service:

```bash
bash tests/extract-list-unit.test.sh
bash tests/extract-detail-unit.test.sh
bash tests/pw-rpa-pagination-unit.test.sh
bash tests/pw-rpa-orchestration-unit.test.sh
bash tests/approve-guards-unit.test.sh
bash tests/action-catalog-unit.test.sh
bash tests/flow-runner-unit.test.sh
bash tests/play-flow-smoke.test.sh
bash tests/capture-e2e.test.sh
bash tests/rpa-fixture-e2e.test.sh
bash tests/rpa-local-fixture-e2e.test.sh
bash tests/agent-plan-unit.test.sh
```

The unit tests are browser-free where possible; `play-flow-smoke`, `capture-e2e`, and the RPA fixture
E2Es use only file or localhost fixtures and skip if the Playwright Chrome channel is unavailable.
Representative fixture scenarios are documented in `dev/active/rpa-validation/SCENARIO-LIBRARY.md`.

For a real registered system, the same contracts are driven by:

```bash
bash bin/analyze-system.sh --system <name>
bash bin/sync-system.sh --system <name>
bash bin/enrich-system.sh --system <name> [--limit N]
bash bin/enrich-system.sh --system <name> --key <id>
```

Those commands require a registered system, `recipes/<name>.json`, and
`fixtures/auth/playwright/<name>.state.json`. Do not use live system success as a substitute for the
external-dependency-free gate.

## RPA Action Model

Generic effectful RPA uses a committed `recipes/<system>.json` action catalog. The built-in action names are
`approve`, `reject`, `update`, `upload`, `download`, and `export`. Unknown actions are refused unless the
recipe block declares a catalog `type`/`actionType`; `approve_*` and `reject_*` names are reserved for
per-form captures of the decision-modal shape.

Every catalog action is fail-closed by default. `enabled:false` means the action is documented but not captured
and cannot run. Enabled live actions require reviewed targets, dry-run evidence, explicit human confirmation,
a positive completion marker, an irreversible commit cap (`--max` for approve-like actions), and append-only
audit. Flow-backed actions use recorded semantic `steps` from the flow schema and must declare
`irreversibleAt` unless explicitly reversible; `needs_review`, unsafe flow refs, disabled blocks, or missing
completion markers refuse before replay.
Today the production approve leaf executes only captured decision-modal actions (`approve`/`reject` family).
`update`, `upload`, `download`, and `export` are defined as catalog schema plus a browser-free runner scaffold
until a dedicated route loads their recorded steps and completion checks.

## CI Lanes

Keep CI and live-operator checks separate:

- **CI / fixture lane:** run `node --check` and browser-free or localhost tests. This lane must not
  require target-system auth, OTP, public network access, or live business data.
- **Non-local read lane:** run only by explicit operator action for `environment:"staging"` or
  `environment:"live-readonly"` flows, with the matching `AQA_RUN_MODE` and `AQA_TARGET_ALLOWLIST`
  origin(s). Agents may prepare or validate the flow, but a human operator chooses when it touches a
  real target. For read-only development integration, use
  `bash bin/dev-integration-readonly.sh [--validate-only] <name>`; it keeps exact allowlists and
  lightweight run records without owner approval packets. For staging/production read-only acceptance,
  use `bash bin/operator-staging-readonly.sh <name>` so CI, wrong run modes, missing allowlists,
  live-action env, and destructive-looking read steps fail closed before replay.
- **Live-auth lane:** run explicitly on an operator host after `bash setup/auth.sh <app> ...` refreshes
  the local pilot auth file or configured auth-state secret ref. Use `bash run.sh <name>` for named
  flows, or opt into app-bound flows with `AQA_INCLUDE_LIVE_AUTH=1`.
- **Live-action lane:** never runs unattended or in CI. Flows use `environment:"live-action"` and
  `riskClass:"effectful"` or `"destructive"`, plus an `irreversibleAt` gate. `bin/play-flow.mjs` also
  requires `AQA_RUN_MODE=live-action`, `AQA_LIVE_ALLOWLIST`, dry-run evidence, and human approval.
  The target origin must be allowlisted with `AQA_TARGET_ALLOWLIST` or as an origin entry in
  `AQA_LIVE_ALLOWLIST`. Start from sync/enrich records, run dry-run first, require human confirmation,
  keep `--max` caps on live approve-like actions, and keep artifacts local until reviewed. The
  pre-commit play audit is mandatory for the irreversible gate; audit write failure aborts before the
  commit step, and recorded `startUrl` values are stripped of query strings, credentials, and fragments.

Target egress is fail-closed for browser replay and WebUI system jobs. `file:`, `data:`, and
localhost/loopback are allowed for deterministic local tests. Public non-local targets require
`AQA_TARGET_ALLOWLIST=https://host[:port]`; approved intranet/RFC1918 targets additionally require an
explicit `AQA_EGRESS_PROFILE=on-prem` or a system/flow `egress.profile:"on-prem"`. Cloud metadata
endpoints remain blocked.

The operator runbook for this separation is `dev/active/live-readiness/RUNBOOK.md`.

Local RBAC is route-enforced for the WebUI control plane: **viewer** reads redacted status and reports,
**operator** runs fixture/local jobs and supervised non-local/live-auth checks, and **owner**/**admin**
approve production target systems, live-action scope, rollback ownership, artifact release, and role changes.
Sensitive metadata GET/HEAD routes for secret migration, tenant deletion, release checklist handoff,
audit detail, and admin/auth detail require operator, owner, or admin. Agents must not perform SSO/OTP
login, use or copy live auth state, approve effectful/destructive work, choose live targets, bypass
policy gates, expose WebUI/noVNC, or publish sensitive artifacts.

## P0 Security Release Gate

Run this fixture-only gate before any internal release candidate handoff:

```bash
bash tests/security-p0-gate.test.sh
```

The wrapper runs runner policy/live-action gate checks, a local Playwright smoke with redirect egress
refusal, external-mode auth provider/CORS/origin/CSRF negatives, IdP claim/header mapping and HTTPS
cookie-deployment preflights, authenticated request-context and auth-summary metadata checks,
artifact/static secret-boundary checks, encrypted-local and external-broker secret-store contracts,
sanitized migration planning and route exposure, external-mode plaintext secret blocking, export
approval/expiry/signed-ref gates, tenant deletion route/tombstone metadata checks, target egress
allowlist, DNS evidence freshness, runtime resolver-policy checks, and control-plane blocking checks,
external/service-mode noVNC entrypoint scoped-root and route-stub boundary checks, job result/SSE
redaction, durable runner identity/claim/heartbeat/cancel route checks, audit-outbox worker/scheduler checks, RBAC denials,
effectful-route session guards, flow-value metadata checks, release checklist API checks, CI lane guard
checks, and the P0 readiness No-Go check. It does not perform live auth, contact non-local targets, or
execute live-action flows. It also does not prove full migration of every secret class into production
KMS storage, real noVNC proxy/browser isolation, platform DNS-at-connection defense, external runner
deployment, or production audit webhook delivery.
The local audit webhook tests use deterministic fake connectors only: the connector interface,
hash-only/redacted outbox envelope, retry/dead-letter behavior, and scheduler fail-closed behavior are
covered, but a real deployed webhook connector and secret broker remain release blockers.
External service open remains No-Go until every P0 acceptance item in
`dev/active/productization/P0-SERVICE-OPEN.md` is implemented and tested.

The WebUI readiness API also exposes a machine-readable P0 matrix. Each `P0-A` through `P0-H` entry is
classified as `implemented`, `contract-only`, or `external-blocked`, with local controls, contract-only
preflights, and true external blockers separated for release review. Matrix entries and the release
checklist include `missingEvidence` items with required commands or operator evidence, current evidence,
and blocker reasons, so contract-only coverage cannot silently become a Go decision. Its release
checklist keeps the operator-only lane out of CI and lists the local deterministic gates required before
handoff. It embeds `blockedFlows` from the static `bin/blocked-flow-report.mjs` analyzer so flows such
as `guest_samsungdisplay_com_argos_main_do` and `hiworks01` appear as machine-readable blocked/
operator-only metadata without replay, auth-state content reads, `.values.json` reads, or artifact scans.
Auth freshness is reported as file/secret metadata only. The WebUI also exposes
`/api/release-checklist` as metadata-only JSON/Markdown for release review.

In `WEBUI_EXTERNAL_MODE=1`, `AQA_EXTERNAL_MODE=1`, service mode, or `WEBUI_REQUIRE_DURABLE_JOBS=1`,
the WebUI job queue is fail-closed for required durable storage: enqueue is refused if the SQLite job
record cannot be persisted, and required job-audit append failures stop a queued/claimed transition
before a child process is spawned. Local localhost pilot mode keeps the older fail-soft journal behavior
for operator debugging.

## Flow Format

New flows should declare Playwright explicitly:

```json
{
  "name": "checkout",
  "engine": "playwright",
  "environment": "local",
  "riskClass": "read",
  "app": "myapp",
  "startUrl": "https://app.example.com/cart",
  "steps": [],
  "asserts": []
}
```

See `flows/SCHEMA.md` for all step kinds, iframe rules, `needs_review`, values sidecars, verify-time
locator repair, and assert kinds.

Recorder support is deliberately conservative. Same-tab semantic actions, same-origin iframe actions,
page scrolls, scrollable-container gestures with a capture-unique semantic container locator or
unique named table/list/region anchor, and navigation keys compile to deterministic Playwright steps.
If a container has no semantic evidence, a captured viewport wheel point may replay the read-only
scroll gesture; later clicks still require deterministic locators. Cross-origin iframe actions,
uploads, downloads, and scrollable-container gestures with no locator/anchor/wheel-point evidence are
captured as review-only evidence and become `needs_review`; compile/replay refuse them until a human
resolves the flow.
Modifier shortcuts such as `Control+s` compile as explicit `press` steps but emit a warning because
their effects are application-specific. Popup/new-tab and top-level cross-origin recording boundaries
fail loud during recording.

## Correctness Rules

- Replay is deterministic and AI-free. No model call drives a browser or decides pass/fail.
- Never write transient element refs such as `@eN` into a test or flow.
- Use semantic locators only: `testid`, `role`, `label`, `text`, `placeholder`, `alt`, or `title`.
- Gate every page transition with a URL, text, or load wait.
- `needs_review` is fail-closed; compile/replay must refuse it until resolved.
- Committed flows use `{{input_N}}` tokens. Local pilot real values live in gitignored `.values.json`
  files; external/encrypted mode stores flow values and credentials behind opaque
  `aqa-secret://<tenant>/flow-values/<flow>` or `aqa-secret://<tenant>/credential/<name>` refs.
- The recorder fails loud rather than guessing when a locator is not stable and unique.

## Flow Engine Cleanup

Omitted `engine` defaults to Playwright, though new flows may still set `"engine": "playwright"`
explicitly for clarity. If an older repository contains any other explicit engine value, convert it
before verify, compile, or replay:

```bash
# 1. Edit the flow to set: "engine": "playwright"
# 2. Refresh auth into the local pilot file or configured auth-state secret ref
bash setup/auth.sh <app> <login-url> '<success-url>'

# 3. Validate, verify, compile, and run
node bin/play-flow.mjs --flow flows/<name>.flow.json --validate-only
bash bin/probe-record.sh verify flows/<name>.flow.json
bash bin/probe-record.sh compile flows/<name>.flow.json
bash run.sh <name>
```

If a flow cannot be converted yet, keep it out of the compiled test gate. The docs, WebUI defaults, and
new authoring path assume `"engine": "playwright"`.

## Web UI

```bash
node webui/server.js        # http://127.0.0.1:4310
```

The webui is a thin local control plane over the same CLI tools. It can run tests, start headed auth,
record flows, verify, compile, and browse artifacts. It has no built-in public auth; keep it on
loopback or behind an authenticated tunnel/reverse proxy.

Pre-external hardening is fail-closed, not a service-open approval. Setting `WEBUI_EXTERNAL_MODE=1`
requires a configured auth provider (`static`, `oidc`, `saml`, or `auth-proxy`) plus bearer users or
session cookies before any page, API, artifact, noVNC stub, or job stream route continues. OIDC/SAML
and auth-proxy modes must declare user, tenant, and role claim/header mappings; cookie-session external
deployments must declare an HTTPS `WEBUI_PUBLIC_URL`. Mutating browser requests require same-origin or
`WEBUI_ALLOWED_ORIGINS` `Origin`/`Referer`; cookie-authenticated mutations require CSRF via
`X-AQA-CSRF`. noVNC is a separate x11vnc/websockify endpoint, not a WebUI route, so WebUI middleware
does not protect it unless a fronting proxy/tunnel applies equivalent auth before the noVNC HTTP and
websocket endpoints. See `dev/active/productization/PRODUCT-CANDIDATE-STATUS.md`.

For a developer-machine external-mode rehearsal without exposing anything publicly, use the loopback
wrapper. It enables the same fail-closed WebUI auth gate, encrypted-local secret store, jsonl audit sink,
durable-job posture, and `NOVNC_DISABLE=1`, then starts `webui/server.js` on `127.0.0.1`.

```bash
bash bin/local-external-rehearsal.sh --check-config
bash tests/local-external-runner-e2e.test.sh
bash bin/local-external-rehearsal.sh
# WebUI: http://127.0.0.1:4310
# Auth header for local fixture users: Authorization: Bearer operator00000001
```

The automation view surfaces scenario readiness from `/api/flows` and `artifacts/*/report.json`:
auth/OTP renewal, policy block, live risk, timeout or last failure, disabled reason, and deep links to
run/report/JUnit artifacts. `/api/flows` and `/api/flows/blocked-report` also include static
blocked-flow metadata generated from committed `flows/*.flow.json` plus auth freshness metadata only.
The report names unresolved `needs_review` step indices and candidate summaries, warns on
`irreversibleAt`, and generates operator handoff checklists/commands for validate-only and replay. It
does not run live replay, read `.values.json`, expose auth-state paths, or read raw cookies. These fields
are operator UX only; compiled bash replay remains the deterministic pass/fail gate.

## External Runner Worker

`bin/runner-worker.mjs` is the outbound-only worker for the existing `/api/runner/*` contract. It polls
for a claimed durable job, executes its persisted `commandSpec`, sends heartbeats, stops the child when
a cancel request appears, redacts stdout/stderr before reporting logs, and reports `succeeded`,
`failed`, or `canceled` through the runner API.

```bash
WEBUI_RUNNER_ID=runner-a \
WEBUI_RUNNER_TENANT_ID=tenant-a \
WEBUI_RUNNER_DEPLOYMENT_ID=prod-a \
WEBUI_RUNNER_TOKEN_REF=kms://tenant-a/runner-a \
WEBUI_RUNNER_API_AUTH_TOKEN=operator00000001 \
node bin/runner-worker.mjs --api http://127.0.0.1:4310/api/runner
```

On Windows, `gitBash` command specs run through `C:\Program Files\Git\bin\bash.exe` by default; override
with `AQA_GIT_BASH` or `GIT_BASH` if Git Bash is installed elsewhere. The worker does not perform SSO,
OTP, target selection, live approval, or any model-driven decision; it only executes command specs that
the control plane already persisted as WebUI-safe.
Production runner tokens and audit webhook tokens must be configured as supported secret references
(`aqa-secret:`, `kms://`, `vault://`, or equivalent provider refs), not plaintext env/body values.
When the WebUI is running in external mode, set `WEBUI_RUNNER_API_AUTH_TOKEN` (or
`AQA_RUNNER_API_AUTH_TOKEN`) to a WebUI bearer token with `run` permission so the outbound worker can
pass the control-plane HTTP gate; the runner identity itself still uses `WEBUI_RUNNER_TOKEN_REF`.

## Docker Recording Server

```bash
docker compose up -d
# http://localhost:4310          webui
# http://localhost:6080/vnc.html headed browser through noVNC
docker compose exec agent-qa bash run.sh
```

Recording and OTP login need the headed browser. Headless replay, results, and compile can be driven
from the webui. The compose file binds both published ports to host `127.0.0.1`; keep that binding for
local recording and do not publish raw VNC port `5900`.

noVNC has no VNC password in local recording mode. For `WEBUI_EXTERNAL_MODE=1`, `AQA_EXTERNAL_MODE=1`,
`WEBUI_SERVICE_MODE=1`, `AQA_SERVICE_MODE=1`, `WEBUI_REQUIRE_DURABLE_JOBS=1`, or
`WEBUI_MODE`/`AQA_MODE`/`WEBUI_DEPLOYMENT_MODE` set to `external`, `service`, `prod`, or `production`,
the Docker entrypoint refuses to start noVNC unless one boundary is explicit:

- `NOVNC_DISABLE=1` disables x11vnc/websockify and is the preferred external-mode setting.
- `NOVNC_AUTH_BOUNDARY=authenticated-proxy` may be used only when `6080` is reachable exclusively
  through an authenticated TLS reverse proxy or tunnel with tenant/session authorization.
  External mode also requires `NOVNC_PROXY_TLS=1` and `NOVNC_PROXY_AUTH=tenant-session`; optional
  `NOVNC_PROXY_URL` must be an `https://` URL. External noVNC also requires scoped browser session
  roots (`WEBUI_NOVNC_BROWSER_ROOT`/`AQA_NOVNC_BROWSER_ROOT`) so profile and download paths are
  tenant/job/session-specific rather than shared.

The same production-mode boundary requires `WEBUI_NOVNC_BROWSER_ROOT`/`AQA_NOVNC_BROWSER_ROOT` before
configured WebUI noVNC session metadata is accepted; profile and download roots are derived per
tenant/job/session and shared roots fail closed. Validate the boundary without starting Xvfb or noVNC:

```bash
bash docker/entrypoint.sh --check-config
WEBUI_EXTERNAL_MODE=1 bash docker/entrypoint.sh --check-config   # refuses unless one boundary is set
```

Do not expose the webui or noVNC directly to a public network.

## Scheduling / unattended

`bin/scheduled-task.sh` is the only sanctioned wrapper for host-scheduled runs. It locks against
overlapping runs, tees output to `data/scheduler.log`, and exports `AQA_SCHEDULED_NO_LIVE=1` so a
LIVE approve is refused no matter how the arguments were assembled (read/sync/enrich and dry-runs
only — unattended live approve stays forbidden).

```text
# Windows Task Scheduler (daily 07:30 sync)
Program : C:\Program Files\Git\bin\bash.exe
Args    : C:\project\Browser-auto\bin\scheduled-task.sh bin/sync-system.sh --system hiworks

# cron (Linux/Docker host)
30 7 * * * /usr/bin/bash /app/bin/scheduled-task.sh bin/sync-system.sh --system hiworks
```

## Layout

```text
run.sh                suite runner + CI gate
bin/play-flow.mjs     deterministic Playwright flow runner
bin/probe-record.sh   scaffold | capture | verify | compile dispatcher
bin/pw-record.mjs     headed Playwright recorder
bin/capture.js        in-page recorder script
bin/build-flow.js     raw events -> flow.json + gitignored sidecars
record.cmd            Windows launcher for `probe-record.sh capture` (any terminal)
setup/auth.sh         headed Playwright auth -> local pilot file or auth-state secret ref
flows/                committed flow.json files; gitignored values/candidates/snapshots
tests/*.test.sh       one deterministic bash journey each
webui/                localhost control plane over the CLI
artifacts/<run>/      report.json, report.junit.xml, results.tsv (no video pipeline; replay is headless)
```

## Internal Open Checklist

```bash
git status --short --untracked-files=all
node --check webui/public/app.js
node --check webui/blocked-flows.js
node --check webui/server.js
node --check webui/routes-command-plan.js
node --check webui/routes-rpa.js
node --check webui/routes-approve.js
node --check webui/jobs.js
node --check webui/systems.js
node --check lib/db.js
bash tests/build-flow-unit.test.sh
bash tests/compile-engine-unit.test.sh
bash tests/webui-blocked-flow-route-unit.test.sh
bash tests/play-flow-smoke.test.sh
bash tests/security-p0-gate.test.sh
bash run.sh
```

CI should keep these lanes distinct: `bash bin/ci-security-p0.sh` for fixture-only P0 checks,
`bash bin/ci-browser-fixture.sh` for local Playwright smoke, `bash bin/ci-slow-fixture.sh` for local
RPA E2Es, `bash bin/ci-operator-only-guard.sh` for a blocked operator-only placeholder, and
`bash bin/operator-staging-readonly.sh <name>` only from an operator shell with
`AQA_RUN_MODE=staging|live-readonly` plus `AQA_TARGET_ALLOWLIST=https://host[:port]`.

Then start `node webui/server.js` and smoke Command Center, Target Review, Systems, Action Registry,
Queue, Audit, Approval State, and Diagnostics on desktop and mobile.
