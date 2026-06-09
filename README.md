# agent-qa

Hybrid, general-purpose web test-automation framework built on
[vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) 0.27.0.

A test is **one bash file = one user journey**. Replay is deterministic and free
(`$0`, no AI). AI is optional and confined to authoring/recovery — it never enters the
pass/fail gate.

## Requirements (Windows + Git Bash)

- Git Bash (`C:\Program Files\Git\bin\bash.exe`)
- `agent-browser` 0.27.0 — `npm i -g agent-browser && agent-browser install`
- `jq`, `ffmpeg` (video) — `winget install jqlang.jq Gyan.FFmpeg`
- `node` >= 22.5 (Node 24 verified; `lib/db.js` uses built-in `node:sqlite`)
- System Chrome for the Playwright approve leaf (`approve/approve-run.mjs`)

`lib/preflight.sh` resolves ffmpeg's absolute path automatically and hard-fails if
video cannot record, so a missing/stale ffmpeg PATH can never silently drop videos.

## Run

```bash
bash run.sh            # run every tests/*.test.sh — exit 1 if any fail (CI gate)
bash run.sh login      # run tests matching tests/login.test.sh
bash tests/login.test.sh   # run a single test standalone (no suite/report)
```

Artifacts (video, screenshots, report) land in `artifacts/<run-id>/` (gitignored).
`report.json` + `report.junit.xml` are written per run.

## Internal open checklist

Before calling a checkout an openable release candidate:

```bash
git status --short --untracked-files=all
git rev-list --left-right --count origin/master...HEAD

node --check webui/public/app.js
node --check webui/server.js
node --check webui/routes-command-plan.js
node --check webui/routes-rpa.js
node --check webui/routes-approve.js
node --check webui/jobs.js
node --check webui/systems.js
node --check lib/db.js

bash tests/agent-plan-unit.test.sh
bash tests/jobs-result-unit.test.sh
bash tests/systems-capabilities-unit.test.sh
bash tests/approve-session-gate-unit.test.sh
bash lib/preflight.sh
bash run.sh
```

Then start the local console (`node webui/server.js`) and smoke the web UI on loopback:
Command Center, Target Review, Systems, Action Registry, Queue, Audit, Approval State, and
Diagnostics. Check desktop and mobile layout, console errors, and document-level horizontal overflow.

Open posture remains local/single-user unless it is fronted by an authenticated tunnel or reverse proxy.
For exposed Docker/noVNC use, keep host publishing on `127.0.0.1`, set `WEBUI_ALLOWED_HOSTS` to the
fronting host, and do not expose the process-spawning webui directly.

External dependencies that must be ready for real operation:

- `fixtures/auth/playwright/<app>.state.json` for default Playwright RPA sync/enrich, or
  `fixtures/auth/<app>.state.json` for explicitly legacy agent-browser systems.
- `approve/<app>.pw-state.json`, `recipes/<app>.json`, and a pending-list URL for approve-like actions.
- `data/approvals.config` for the legacy Hiworks approval inbox path.
- A private/TLS on-prem OpenAI-compatible endpoint for summaries/classification; set
  `LLM_REQUIRE_PRIVATE=1` once the endpoint is hardened.
- Operational test data or staged/disposable approval documents for live verification.

## Docker recording server (Linux)

Run the framework on a Linux host as a remote recording service. Replay (`run.sh`) is headless; a
remote human drives the recorder's **headed** Chrome through a browser-based noVNC view.

```bash
docker compose up -d
#   http://localhost:4310            webui — run tests, view results, record/compile flows
#   http://localhost:6080/vnc.html   noVNC — drive the recorder's Chrome (record / OTP login)
docker compose exec agent-qa bash run.sh   # the headless gate, in-container
```

The image is a Playwright base (Node 24, so `node:sqlite` is unflagged) plus Xvfb + x11vnc + noVNC
for the headed browser. The same cross-platform `webui/spawn.js` runs on Windows (Git Bash) and Linux.

**Security.** The webui has no built-in auth and spawns processes; noVNC has no password. Compose
publishes both ports to the host's `127.0.0.1` only — never expose them directly. To reach them
externally, front with an authenticated tunnel / reverse proxy. Two controls bound the exposure:

- `WEBUI_HOST` — bind address (default `127.0.0.1`; the image sets `0.0.0.0` so the published port is
  reachable inside the container).
- `WEBUI_ALLOWED_HOSTS` — Host-header allowlist, a DNS-rebinding defense (default `localhost`/`127.0.0.1`).
  When fronting with a proxy on a public hostname, set this to that hostname.

Recording and OTP login need the headed browser (driven via noVNC); `run`, results, and compile work
from the webui alone.

### Recovering a wedged daemon

If agent-browser ops start failing with `os error 10060` (or hang ~34s then fail), a dead daemon left
stale per-session state in `~/.agent-browser`. Recover it — stops the daemon, kills only its own PID
(never a blanket `node` kill), removes the stale `*.engine/*.pid/*.port/*.stream/*.version` files, and
preserves the downloaded `browsers/`:

```bash
bash bin/daemon-recover.sh
```

It then **primes** a fresh daemon (a throwaway `open → navigate → get url`, retried once) so the next
real op starts **warm and flake-free** — absorbing the one-time "Daemon version mismatch → restarting"
(`os error 10060`) the first op after a restart can hit. The throwaway session is left open on purpose
(a daemon with zero sessions exits); the next recovery reaps it. Set `DAEMON_RECOVER_NO_PRIME=1` to skip
priming (e.g. a headless box with no browser). Re-run `setup/auth.sh` if the cached session expired.

## Writing a test

```bash
#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DIR/lib/env.sh"      # S, ARTDIR, AB(), BATCH()
source "$DIR/lib/cleanup.sh"  # EXIT trap: record stop + session close
source "$DIR/lib/assert.sh"   # assert_* helpers

AB open "https://app.example.com" >/dev/null
AB record start "$ARTDIR/video.webm" >/dev/null

# Deterministic body: semantic locators only. Gate page changes with wait_url (URL) or an
# in-batch text/load wait so the next locator runs against a settled page.
BATCH --bail <<'JSON'
[["find","label","Email","fill","user@example.com"],
 ["find","role","button","--name","Sign in","click"]]
JSON

wait_url "**/dashboard"   # polls `get url`; NOT batch ["wait","--url",..], which is
                          # broken for glob patterns on 0.27.0 (see Hard rules).

assert_url  "**/dashboard"
assert_text "Welcome"
```

## Hard rules (verified footguns — do not break)

- **Never assert via exit code.** A `batch --bail` call exits 0 even when a step
  failed. Use the `assert_*` helpers and `BATCH` — they read the `--json` `.success`
  field. A bare `is`/`find` in a test is a false-green waiting to happen.
- **Never write `@eN` refs into a test.** Refs go stale on any page change. Use
  semantic `find role|text|label|placeholder|alt|title|testid` locators.
- **Gate every page transition** so the next locator runs against a settled page: use
  `wait_url "<glob>"` for a URL change (it polls the reliable `get url`; the batch
  `["wait","--url",…]` command is broken for glob patterns on 0.27.0 — it ignores the
  timeout, hangs ~34s, then fails with `os error 10060`), or an in-batch
  `["wait","--text",…]` / `["wait","--load","networkidle"]`.
- **Run via `run.sh`**, which owns the daemon + ffmpeg PATH. Ad-hoc `agent-browser`
  calls from a stale-PATH shell can silently lose video.

## Layout

```
run.sh              suite runner + CI gate
lib/                env, cleanup, preflight, assert, report  (leaves; one-way deps)
tests/*.test.sh     one journey each (standalone-runnable)
setup/auth.*.sh     one-time human OTP login -> state save  (Phase 1)
bin/probe-record.sh authoring: scaffold (snapshot+stub) | capture (record) | verify (repair) -> compile
bin/capture.js      in-page recorder injected via --init-script (capture mode)
bin/build-flow.js   raw captured events -> flow.json (+ gitignored values/candidates sidecars)
bin/verify-flow.sh  optional: re-drive a flow, verify/repair each locator or promote to needs_review
flows/              declarative twins (no @eN field); *.values.json / *.candidates.json (gitignored)
fixtures/auth/      cached *.state.json  (gitignored — secrets)
baselines/          committed golden snapshots/screenshots
artifacts/<run>/    per-run video/screenshots/report  (gitignored)
```

## Auth & OTP

Sites needing OTP/2FA are handled once, interactively, via `setup/auth.sh`:

```bash
APP=myapp LOGIN_URL="https://app.example.com/login" SUCCESS_URL="**/dashboard" \
  bash setup/auth.sh
```

It opens a real Chrome window; you complete the login + OTP by hand; the script polls
`get url` until it matches `SUCCESS_URL` — an agent-browser glob like `**/dashboard`, or a
plain substring, matched across origins — then saves `fixtures/auth/myapp.state.json`.
(It polls rather than calling `wait --url` because that command is broken for globs on
0.27.0.) Tests then start with `AB_AUTH myapp open <url>` and replay unattended — the OTP
cost is paid once.

## RPA — register any web system (generic data collection)

The product layer on top of the framework: a non-coder operator **registers ANY data-collection web
system** (groupware / ERP / ticketing / a custom admin) from the webui, and the tool **fetches →
summarizes → queries** its records. There is **no per-site code** — the only thing that differs per
system is a declarative `recipe` (see `recipes/SCHEMA.md`). Replay/extraction is deterministic; an
**on-prem** model is used only to *propose* a recipe (analyze) and to *summarize* bodies — never to
drive the browser, decide an action, or touch the pass/fail gate.

Data lives in `lib/db.js` (`node:sqlite`) — two generic tables: `systems` (the registry: name, label,
login/success/target URLs, recipe) and `records` (rows keyed per system, `data` JSON + `summary` +
`status`), at gitignored `data/approvals.db` (PII). The webui **시스템** view drives the whole
lifecycle (each button enqueues a bash driver on the serial job queue; the web layer reimplements no
extraction logic):

| step | webui | route | driver | what it does |
|------|-------|-------|--------|--------------|
| 1. register | 등록 | `POST /api/systems` | — (`systems.js saveSystem`) | store name + URLs + (optional) recipe; the recipe shape is validated (`collection.name` + `columns` + a `key` ∈ `columns`) so a malformed recipe can't be saved. |
| 2. 인증 | 인증 | `POST /api/systems/:n/auth` | `setup/auth.sh` | one-time **headed** human login/OTP → `fixtures/auth/<n>.state.json` (cached, gitignored). |
| 3. 구조분석 | 구조분석 | `POST /api/systems/:n/analyze` | `bin/analyze-system.sh` | open target (cached auth) → snapshot → `propose-recipe.js` (detect ARIA tables/headers + on-prem model maps headers→fields, with a deterministic fallback) → `data/<n>.proposed.json`. The human **reviews/edits** the proposal in the recipe form, then saves it (step 1). |
| 4. 동기화 | 동기화 | `POST /api/systems/:n/sync` | `bin/sync-system.sh` | cached-auth browser → target list → paginate → `extract-list.js` (arbitrary recipe fields) → `store-records.js` → `records`. |
| 5. 상세·요약 | 상세·요약 | `POST /api/systems/:n/enrich` | `bin/enrich-system.sh` | per record lacking a summary → open detail (`recipe.detail`, `idLabel == key` guard rejects a wrong/list page) → `extract-detail.js --generic` (arbitrary fields + `raw_text` body) → on-prem `summarize.js` → merge into `records` (`COALESCE`/`json_patch`, never clobbers the list sync). Body **never leaves** the local endpoint. |
| 6. 조회 | 조회 / NL 명령 | `GET /api/systems/:n/records?q=` · `POST /api/agent` | — | read the records; the NL command box classifies Korean text (on-prem model, **classify-only**) into a validated intent (`sync`/`summarize`/`query`) spanning **both** registered-system records and 결재. |

CLI equivalents (no API key — replay is AI-free): `bin/analyze-system.sh --system <n>` ·
`bin/sync-system.sh --system <n>` · `SUMMARY_MODEL=… bin/enrich-system.sh --system <n> [--limit N] [--key <id>]`.

**Pagination & the full batch.** Both `sync-system.sh` and `enrich-system.sh` drive a
`pagination.mode == "combobox"` list across **every** page (the page-number `<select>` via its
transient `@ref`, read fresh per page — never stored), so enrich reaches a record on **any** page, not
just the first. Running detail+summary over a large inbox is a deliberate **heavy batch** (each record =
a browser open + an on-prem inference). Because the bodies are confidential, run the full summarize
batch only against a **private/TLS** model endpoint — set `LLM_REQUIRE_PRIVATE=1` so `summarize.js`
refuses a public-host/plain-HTTP endpoint (see *Safety model*). Detail-only enrich (no `SUMMARY_MODEL`)
sends nothing to the model.

The **결재 (Hiworks) feature below is the reference implementation** of this generic path — it predates
the generalization and keeps its own `fetch-approvals.sh`/`approvals` table, but a recipe written for
it (`recipes/hiworks.json`) is valid on **both** paths (see `recipes/SCHEMA.md` *Portability*).

## 결재 (approval) sync — P0: read & display (reference implementation)

A built-on-top feature that scrapes a groupware **approval inbox** into a local DB and shows it on
the webui dashboard. This sync path is **read-only**; approval *execution* is the separate, deterministic
full-auto path (*Safety model → Phase 2 — auto-approve* below). It reuses the existing pieces: cached auth (`setup/auth.sh`), the
agent-browser `.success` contract (`lib/env.sh`), and the webui serial job queue (so the browser sync
runs one-at-a-time like any run).

New pieces (no new stack):

- `lib/db.js` — the approvals store over **`node:sqlite`** (built-in, zero external deps; needs
  Node ≥ 22.5). One table `approvals(doc_id PK, title, drafter, dept, submitted_at, amount,
  raw_text, summary, status, fetched_at)`. The DB is the **single source of truth** for fetched
  결재 (unlike runs, which are fs-authoritative). Lives at gitignored `data/approvals.db` (PII).
- `recipes/<app>.json` — the **declarative read recipe** (committed; product STRUCTURE only — no PII,
  no CSS, no `@eN` refs). Selected by `--app` (like `fixtures/auth/<app>.state.json`). It is the ONLY
  thing that differs per groupware — **no per-site code**. Fields: `collection.name` (the aria table's
  accessible name, matched normalized-exact — exactly one match or fail loud), `columns`
  (`{db_field: "header text"}`, header-anchored), optional `strip` (`{db_field: "literal suffix"}` for
  UI noise like Hiworks' `첨부 파일 표시`), optional `ready.{text,timeout}` (an in-batch `wait --text`
  settle gate for async lists). `doc_id` is mandatory. Detail, summarize, and approve-like behavior now
  lives in explicit `detail`, `summarize`, and `actions.<name>` recipe blocks; actions that are absent or
  `enabled:false` are surfaced as disabled/needs implementation, never as mock success.
- `bin/fetch-approvals.sh` — generic driver: resolve `recipes/<app>.json` → launch (`AB_AUTH open`) →
  `navigate` inbox → optional `ready` gate → snapshot → `extract-approvals.js <recipe>` →
  `store-approvals.js`. fd-hang-guarded (`</dev/null`, no inline pipe), with a generic
  redirect/stale-session warning. Reads gitignored `data/approvals.config` (`GW_APP`/`GW_INBOX_URL`)
  so a bare run and the webui button need no args.
- `bin/extract-approvals.js` — **generic, recipe-driven** aria-table list extractor (NOT site-coupled):
  parses the saved aria-snapshot tree per the recipe → items JSON. Anchors row→cell mapping to the
  column HEADERS and FAILS LOUD (never guesses) on a missing/duplicate header, a per-row cell-count ≠
  header-column count, an unknown db field, or 0/≥2 matching tables. Pinned by the browser-free golden
  `tests/extract-approvals.test.sh` (part of the `run.sh` gate).
- `bin/store-approvals.js` — stdin items JSON → `lib/db.js` upsert (re-sync preserves `status`).
- `webui` — `GET /api/approvals` (read) + `POST /api/sync` (enqueue the browser sync) + a **결재**
  dashboard view with a **동기화** button.

Operator steps — **Hiworks (verified working end-to-end on `ibizsoftware.net`)**:

```bash
# 1. One-time login cache. Opens a real Chrome window; YOU complete the Hiworks login by hand
#    (ID/PW + OTP/SSO if any). Lands on dashboard.office.hiworks.com -> session saved.
bash setup/auth.sh hiworks \
  "https://login.office.hiworks.com/<company-domain>" \
  "**dashboard.office.hiworks.com/**"

# 2. data/approvals.config (gitignored) holds the inbox URL so a bare run / the webui button work:
#    GW_APP=hiworks
#    GW_INBOX_URL="https://approval.office.hiworks.com/<company-domain>/approval/document/lists/W"
#    ('/document/lists/W' is the 대기(pending) box — the approval home auto-redirects here.)
#    GW_LOGIN_URL / GW_SUCCESS_URL let the webui 결재-로그인 button trigger the Playwright headed login
#    (approve/auth-pw.mjs) without the terminal — a Chrome window still opens for ID/PW + OTP (the
#    human gesture is irreducible; credentials are NOT typed into the webui). GW_SUCCESS_URL is matched
#    as a substring of the post-login URL:
#    GW_LOGIN_URL="https://login.office.hiworks.com/<company-domain>"
#    GW_SUCCESS_URL="dashboard.office.hiworks.com"
bash bin/fetch-approvals.sh        # or: --app hiworks --url <inbox>; or the webui 동기화 button
#    -> snapshot -> extract 대기 rows -> upsert into data/approvals.db; the 결재 view shows the cards.
```

For a **different groupware**, write `recipes/<app>.json` (no code) from its saved
`data/approval-inbox.snapshot.json` — `bin/*`, the DB, and the webui all stay byte-identical.
`recipes/daou.json` is a committed example for a different vendor; the golden test exercises it.
**Ceiling (honest):** the extractor handles the ARIA **table** family (a single named `table`/`grid`
with `columnheader`/`row`/`cell`); a pure CSS div-grid with no table semantics, or two same-named
tables on one page, is out of scope and fails loud rather than guessing.

**Field coverage:** `doc_id/title/drafter/submitted_at` come from the Hiworks 대기 LIST; `dept/raw_text`
are DETAIL-only (per document), filled by the P0+ enrichment below. (Structured `amount` is form-specific —
it lives inside `raw_text` for now; a per-form recipe can lift it later.)

### P0+ — per-document detail enrichment + local summary

A SECOND, slower pass that opens each pending doc, pulls `dept` + the body `raw_text`, and (optionally)
summarizes it with a **local / on-prem model** — kept separate from the fast list sync so the dashboard
shows the list immediately and enrichment fills in. The body **never leaves the configured local endpoint**.

- `bin/extract-detail.js` — recipe-driven DETAIL extractor. The detail page is a **label→value** layout
  (`rowheader "기안 부서"` → adjacent cell), not the list's column model, so it's a separate parser. It
  also collects the form body from the top heading onward as `raw_text` (a blob for the summarizer).
  Driven by the recipe's `detail` block: `{ ready{text}, fields{db_field: "rowheader label"},
  bodyFromHeadingLevel }`.
- `bin/summarize.js` — fills `summary` from an **OpenAI-compatible local endpoint** (Ollama / vLLM / a
  사내 gateway). Zero external deps. Config (env): `SUMMARY_MODEL` (required), `SUMMARY_API_URL`
  (default `http://localhost:11434/v1`), `SUMMARY_API_KEY` (optional). A network failure is fatal; a
  per-doc model error is a warning (that doc keeps `raw_text`, no summary).
- `bin/enrich-approvals.sh` — the loop: for each pending doc lacking a summary → open it (`find text
  "<doc_id>" click`, same tab) → detail snapshot → `extract-detail` → (`summarize` if `SUMMARY_MODEL`
  set) → store. `lib/db.js` upsert uses `COALESCE`, so this pass and the list sync never null out each
  other's fields. `--limit N` bounds a run.

```bash
# detail only (no model yet): fills dept + raw_text for the cards
bash bin/enrich-approvals.sh                     # or --app hiworks --limit 3

# with a local model (body stays on-prem):
#   Ollama: winget install Ollama.Ollama && ollama pull qwen2.5:7b   (serves :11434)
SUMMARY_MODEL=qwen2.5:7b bash bin/enrich-approvals.sh
#   -> opens each 대기 doc, stores dept + raw_text + summary; the 결재 view shows the summary.
```

**Correctness guard:** `extract-detail` verifies the opened page's `idLabel` (문서 번호) equals the
doc it meant to open, and `enrich` gates on the detail URL (`detail.urlGlob`) — a click that stays on
the list or opens the wrong document is **rejected, never stored** (no silent wrong-data).

**Pagination:** when `recipe.pagination.mode == "combobox"`, `fetch-approvals` drives the list's
single page-number `<select>` (via its transient `@ref`, read fresh per page — never stored) and
accumulates EVERY page, deduped by `doc_id` — so the list sync captures the full inbox (verified:
177/177 on the live tenant), not just the first page. **Enrichment** (`enrich-approvals.sh`) still
walks the **first page's** docs; summarizing all N is a deliberate, heavy batch (each doc = a browser
open + a local-model inference) and is the remaining scale step.

### NL command box (web) — describe, don't hand-build

The 결재 view has a command box: type Korean ("관리팀 출장 관련 조회", "최근 10건 요약", "미결 새로고침")
and it runs. The **on-prem model ONLY classifies** the text into one validated intent — it never drives
the browser, never decides/executes an approval, never touches the pass/fail gate:

- `lib/llm.js` — shared on-prem OpenAI-compatible client (reads `LLM_*`/`SUMMARY_*` lazily; same model
  as summaries; nothing leaves the endpoint).
- `webui/agent.js` — `classifyIntent` (model reply is UNTRUSTED: JSON-extract → strict allowlist/type
  validation → degrade to **clarify** on any doubt; never a default action, NEVER approve) + `runQuery`.
- `POST /api/agent {text}` — routes: `sync`→fetch-approvals (queue), `summarize`→enrich (queue),
  `query`/`approve`→read-only `db.queryApprovals` rows, `review`→**prepare the checkbox review surface**
  (optionally summarize, then the UI shows the 결재 list with checkboxes so the human checks + clicks
  선택 항목 결재). `approve` returns **candidates only** and `review` only *prepares* — **neither executes**
  an approval (the model has no path to `/api/approve/run`; that route fires only on the human's click).
  So one sentence like "결재 요약해서 검토-결재 띄워줘" chains summarize → the review screen, with the human
  still making every approve decision. amount has no numeric filter (TEXT column) → the model maps it to a
  keyword. The model↔approve isolation is pinned by `tests/agent-isolation-unit.test.sh` (run.sh gate).

If the on-prem model is unreachable, every command safely degrades to `clarify` (no action taken).
**Not built here (by design / per the safety review): an open live agent that improvises browser
actions** — both the safety and feasibility reviews rejected an LLM→click path on live approval pages;
the model stays a classifier, effectful actions stay deterministic + human-gated.

**Summarization is intentionally separate from the fast P0 list sync**: the approval body can be
confidential/PII, so model transport is a policy and infrastructure decision. Detail-only enrich stores
raw text without model egress; summary generation is enabled only when a local/on-prem endpoint is
configured.

## CommandPlan operator workflow

The durable NL control plane turns a command into a server-validated plan before any irreversible work:

```text
natural language -> CommandPlan -> reviewed targets -> dry-run -> human confirm -> queued deterministic driver -> audit/result
```

Implemented contract:

- `POST /api/agent/plan` creates a persisted plan with a server hash and no side effect.
- `GET /api/agent/plan/:id`, `/events`, and `/result` reload plan state, command events, and current result.
- `POST /api/agent/plan/:id/targets` stores a reviewed target set and target-set hash.
- `POST /api/agent/plan/:id/dry-run` requires the plan hash, revalidates targets/action/recipe, then queues the deterministic dry-run.
- `POST /api/agent/plan/:id/confirm` requires same-origin session gate, exact plan hash, exact target-set hash, passing dry-run hash, explicit human confirmation, and an unconfirmed `awaiting_confirmation` plan.
- `GET /api/actions`, `/api/systems/:name/state`, and `/api/systems/:name/actions` expose readiness and disabled reasons.
- `GET /api/jobs/:id/result` exposes structured job result data; logs are observability, not the product contract.

Daily workflow:

1. Register or select a system, run auth/analyze/sync/enrich as needed, and verify records exist.
2. Create a CommandPlan from the Command Center.
3. Review the target table; every irreversible target must be selected by the operator.
4. Run dry-run and inspect per-target `dry-ok` plus the command event timeline.
5. Confirm live only while supervised and only after the server shows the dry-run/hash gates as satisfied.
6. Monitor Queue and Audit. `data/approve-audit.jsonl` is the source of truth for irreversible work.

Approval runbook:

- Prerequisites: synced records with titles, `recipes/<app>.json`, `fixtures/auth/<app>.state.json`,
  `approve/<app>.pw-state.json`, pending-list URL, and no active `data/approve-STOP` kill switch.
- Dry-run must pass every selected target before live. A changed reviewed target set invalidates the prior dry-run.
- Live confirm is single-use for a plan. Re-running live requires a new plan and a new dry-run.
- Audit confirmation for dry-run should include `requested`, `identity_ok`, and `dry_ok`. Live confirmation
  should include `requested`, `identity_ok`, `clicked`, and `confirmed`, with actor/stamp/departure evidence.
- There is no rollback for a live approval. Cancel/STOP only prevents future documents from being clicked.
  Recovery means reconcile stranded `clicked` rows, resync, inspect audit, and use the business system's
  reversal process outside this tool if needed.

## Safety model

The framework's correctness rests on a structural separation: **the AI/LLM never enters the pass/fail
gate or any effectful (write/approve) click path** — it is confined to *authoring* (proposing a recipe,
classifying an NL command) and *summarizing*. Replay and data extraction are deterministic.

- **No LLM in the gate (structural, not convention).** Replay is `bash $0` — no API key, no model in
  the loop. The NL command box classifies into a validated, allow-listed intent only; on any doubt or an
  unreachable model it degrades to `clarify` (no action). `/api/agent` returns approval **candidates
  only** — it has no path to execute one.
- **Confidential bodies stay on-prem.** Detail bodies are summarized only via the configured
  local/사내 endpoint (`lib/llm.js`); nothing leaves it. `lib/llm.js` *warns* on a public-IP plain-HTTP
  endpoint; production must harden transport (VPN/SSH-tunnel/TLS) and set `LLM_REQUIRE_PRIVATE=1`.
- **Single-user, operator-controlled host.** The webui is loopback, no built-in auth; it is only safe on
  a single-user host. Do not run the effectful path on a shared/multi-user machine.

### Phase 2 — auto-approve execution (BUILT; full-auto, deterministic-guarded)

> **Owner decision (2026-06-07).** The system owner, shown the irreversible-financial risk in plain terms,
> **explicitly released the prior "per-item human approval only" gate** and chose **full auto-approve (no
> human click)** for their own system. The full history + red-teams live in
> `dev/active/phase2-guarded-approve/`; the decision is recorded in memory `approve-gate-override`. This
> README documents the BUILT path. The human gate was the main safety, so with it removed the
> **deterministic guards below are the SOLE safety — and therefore every one FAILS CLOSED** (skips/aborts
> the doc on any doubt; they only ever catch errors, they never relax the approve).

**Architecture.** The approve action needs a *trusted* (`isTrusted`) click — Hiworks ignores agent-browser's
synthetic 확인 (proven at Gate B), so the approve leaf is an **isolated Playwright driver**
(`approve/approve-run.mjs`, own `approve/` dir, pinned Playwright, system Chrome via `channel:'chrome'`).
Read/sync/enrich stay on agent-browser. **The model is structurally OFF this path** — `/api/agent` returns
approval **candidates only** and has no route to the leaf; the effectful action is a separate deterministic
route (`POST /api/approve/run`).

**Two ways to drive it — the human-reviewed batch is recommended:**
- **검토 후 일괄 결재 (recommended).** The 결재 view lists each pending doc with its summary + a **checkbox**;
  the operator reviews and **checks** the items to approve, then clicks **선택 항목 결재** to approve all the
  checked docs in one batch. **The human's review of the summary is the content/amount control** — important
  because a form's 총 금액/총 합 계 figure is **drafter-typed free text**, so a label-anchored amount ceiling
  is unreliable. This mode (`reviewed:true`) drops the automated amount ceiling and the form-homogeneity
  guard (a mixed-form selection is the human's deliberate choice); every *form-agnostic* guard below still
  fires per item, and the count cap defaults to the number of checked items.
- **자동 승인 (advanced, typed).** Type 문서번호s for a fully-unattended batch with **no** human review; here
  the deterministic guards — **including** the amount ceiling and form-homogeneity — are the sole safety.

**Per-doc deterministic guards (all fail-closed) before the irreversible 확인:**
- open by the **UNIQUE exact 문서번호 cell, counted across ALL pages** (===1, abort 0/≥2) — never substring;
- the detail URL matches the recipe `urlGlob`; **exactly one** idLabel cell == doc_id;
- **TITLE content binding** — the synced title (from the approvals DB) must appear on the live detail (a doc
  not in the DB is refused — can't content-verify);
- **amount ceiling** *(full-auto/typed mode only)* — label-anchored (`approve.amount.label`), largest KRW
  figure ≤ ceiling, **fail-closed** when no locator/figure; live requires a ceiling OR `allowNoValueCeiling`.
  Because the label is **drafter-typed**, this is a heuristic — the human-reviewed mode replaces it with the
  operator's review of the summary;
- **decision radio asserted checked** (승인) before 확인 *(both modes)*;
- **form-type guard** *(full-auto/typed mode only)* — the detail h1 must be readable, match an optional
  `approve.formType` pin, and stay **homogeneous across the batch**; relaxed in human-reviewed mode (the
  operator checked each item, so a mixed-form selection is intended);
- **reliable pager** — the all-pages scan only trusts a contiguous `1..N` combobox; a windowed/ambiguous
  pager ⇒ uncertain ⇒ fail-closed (never under-scans → never a false "left 대기").

**Positive completion + recovery:** success requires a **new today-dated 승인 stamp** on the doc's own
결재선 line **AND** departure from the 대기 inbox (either alone ⇒ fail-closed). An append-only, fsync'd
JSONL audit (`data/approve-audit.jsonl`, viewable in the 결재 view) is the source of truth; a live run
first **reconciles** any doc stranded at `clicked` (committed but the process died) by re-checking 대기 +
the stamp. The **live approver identity** is bound into the `confirmed` audit row.

**Access control:** dry-run is the **default**; live requires explicit `--live` + a positive `--max` count
cap (the human-reviewed mode supplies it as the checked-item count) + a value ceiling (full-auto/typed mode
only); the irreversible-click counter (`clicksIssued`) binds the cap; a **kill-switch**
(`data/approve-STOP`, the webui 🛑 일괄 중지 button) halts before the next doc. The webui route is gated by a
present same-origin **Origin/Referer + a session cookie** (`webui/session.js`); it is only safe on a
**single-user, operator-controlled host**.

**Operating posture — SUPERVISED + BOUNDED, not yet unattended-at-scale.** Run dry-run first on a
single-user host. For the recommended reviewed batch, the operator's target review is the amount/content
control and the count cap is the checked-item count. For typed/full-auto runs, keep a small `--max` and a
value ceiling or an explicit owner opt-out. **Unattended/scheduled LIVE approve stays FORBIDDEN
(fail-closed; `bin/scheduled-task.sh` refuses `--live`)** until operator-accompanied live verification and
signed auto-approve criteria exist. Gate-B amount-cell capture remains relevant for typed/unattended
amount-dependent policies, but is not required for the reviewed-batch flow. Read/sync/enrich carry no
financial risk and may be scheduled freely. Approval bodies stay **on-prem**; harden transport before prod.
Tests use **staged/disposable docs only — never a real financial approval.**

### Scheduling (unattended periodic tasks)

Read/sync/enrich carry no financial risk and can run unattended on a schedule. `bin/scheduled-task.sh` is
a thin, **fail-closed** entrypoint for the host scheduler (Windows Task Scheduler / cron): it reuses the
existing drivers (no new engine), **serializes** ticks with a self-healing lock (so two runs never drive
the one shared agent-browser daemon at once), tees output to `data/scheduler.log`, and **REFUSES any
`--live`** — so an unattended **LIVE auto-approve can never run through it** (it stays forbidden until the
three prerequisites above clear).

```bash
# Wrap any read/sync/enrich driver (repo-relative .sh or .mjs; args pass through):
bash bin/scheduled-task.sh bin/fetch-approvals.sh --app hiworks      # 결재 list sync
bash bin/scheduled-task.sh bin/sync-system.sh   --system hiworks      # generic RPA sync
bash bin/scheduled-task.sh bin/enrich-system.sh --system hiworks      # detail + on-prem summary
bash bin/scheduled-task.sh approve/approve-run.mjs … --max-amount N   # approve is DRY-RUN only (no --live)
```

- **Windows Task Scheduler:** Program `C:\Program Files\Git\bin\bash.exe`, Arguments
  `bin/scheduled-task.sh bin/fetch-approvals.sh --app hiworks`, Start-in `C:\project\Browser-auto`.
- **cron (Linux/Docker):** `*/30 * * * * cd /app && bash bin/scheduled-task.sh bin/sync-system.sh --system hiworks`.

On a single-user host the scheduler assumes you are not also manually driving a browser job in the webui at
the same instant (the lock serializes scheduled ticks with each other; cross-coordination with a live manual
session is the accepted single-user-host residual).

## Authoring a test (AI or human, no API key)

A coding agent (e.g. Claude Code) or a human inspects the site and writes a declarative
flow, which compiles to a runnable test. No AI API key is needed — the agent doing the
authoring is the "AI"; agent-browser's own `chat` (which needs a Vercel AI Gateway key)
is intentionally not used.

```bash
# 1. Capture the page's interactive snapshot + a flow stub:
bash bin/probe-record.sh scaffold checkout https://app.example.com/cart
#    -> flows/checkout.snapshot.txt  (the menu of stable locators)
#    -> flows/checkout.flow.json     (stub to fill in)

# 2. Fill flows/checkout.flow.json with steps/asserts using STABLE locators read off the
#    snapshot (priority: testid > role+name > label > exact-text > placeholder > title).
#    Pick a value that is UNIQUE in the snapshot. `get count` validates uniqueness only for
#    CSS selectors (e.g. a testid's `[data-testid="v"]` equivalent) — it CANNOT count the
#    semantic role/text/label locators replay uses, so judge those from the snapshot
#    (capture mode below computes in-page uniqueness automatically).
#    NEVER write @eN refs — they go stale. See flows/SCHEMA.md.

# 3. Compile to a runnable, harness-compatible test:
bash bin/probe-record.sh compile flows/checkout.flow.json
#    -> tests/checkout.test.sh

# 4. Run it:
bash run.sh checkout
```

### Browser engine selection

Flows may set top-level `"engine": "agent-browser"` or `"engine": "playwright"`.
If the field is absent, the flow is treated as `agent-browser` for backward
compatibility. `flow.engine` is the replay source of truth; changing a registered
system's default engine only affects new auth/record/play work and never rewrites
existing flows. New auth/record/system work defaults to `playwright`; pass
`--engine agent-browser` only when you need the legacy agent-browser path.

```bash
bash setup/auth.sh myapp https://app.example.com/login '**/dashboard'                 # default: playwright
bash setup/auth.sh --engine agent-browser myapp https://app.example.com/login '**/dashboard'

bash bin/probe-record.sh capture checkout https://app.example.com/cart --app myapp     # default: playwright
bash bin/probe-record.sh capture checkout https://app.example.com/cart --engine agent-browser --app myapp

bash bin/probe-record.sh compile flows/checkout.flow.json
node bin/play-flow.mjs --flow flows/checkout.flow.json
```

There is no silent fallback between engines. Agent-browser auth state remains
`fixtures/auth/<app>.state.json`; generic Playwright auth state is stored under
`fixtures/auth/playwright/<app>.state.json` (the legacy approve state
`approve/<app>.pw-state.json` is still recognized for compatibility). Generic
read/analyze/sync/enrich drivers now follow the registered system's selected
engine, so Playwright-default systems use the Playwright auth state end to end.

### Or: record a live journey (capture mode)

Instead of hand-authoring, drive the site yourself and let the recorder build the flow. It
injects `bin/capture.js` via `--init-script`, hardens each action to a semantic locator
in-page (computing uniqueness itself), masks sensitive values, inserts navigation wait-gates
and a trailing URL assert, and emits the same `flows/<name>.flow.json`:

```bash
# 1. Record: opens a headed browser (from cached AB_AUTH state if --app); you click / type /
#    select / navigate, then press Enter (or Ctrl-C) to stop. --seconds N auto-stops after N s.
bash bin/probe-record.sh capture checkout https://app.example.com/cart --app myapp
#    -> flows/checkout.flow.json     (steps hardened to semantic locators)
#    -> flows/checkout.values.json   (gitignored sidecar: real input values; {{input_N}} tokens in the flow)

# 2. Resolve any needs_review steps (no unique locator found — pick one of the listed
#    candidates) and fill flows/checkout.values.json.

# 3. (optional) VERIFY-REPAIR: re-drive the flow once to confirm each locator still resolves.
#    The captured in-page uniqueness is only an estimate of how the engine's `find` resolves, so
#    a step can pass capture yet fail replay; verify auto-repairs from the candidate ladder
#    (flows/checkout.candidates.json) or promotes a step to needs_review. It re-executes the
#    journey (side effects, same build) headless, so run it on a safe/idempotent flow.
bash bin/probe-record.sh verify flows/checkout.flow.json

# 4. Compile + run:
bash bin/probe-record.sh compile flows/checkout.flow.json
bash run.sh checkout
```

**Optional: replay fallback** (`"replayFallback": true` in the flow.json). Off by default. When set,
`compile` bakes a per-step fallback ladder into the test so a flaky primary locator retries down
capture-time-**unique** sibling candidates at replay (logging a loud `⚠ FALLBACK` whenever it fires)
instead of going red. It reduces flake on healthy journeys but carries an inherent wrong-element risk
(a once-unique candidate can match a different element after drift), so it is opt-in, loud, and
filtered to count==1 / non-overLong / engine-supported locators only. See `flows/SCHEMA.md`.

**Capture scope & limitations** (by design — the recorder fails loud or marks `needs_review`
rather than guessing):

- **Single top-frame, single tab.** A new tab/popup is detected (`tab list` poll); the
  recorder stops, saves the original tab's actions, and exits non-zero — re-record the
  journey within one tab if the new-tab steps are needed.
- **Same-origin journeys persist losslessly** (the buffer lives in per-origin
  sessionStorage). Crossing a top-level origin boundary drops the prior origin's buffered
  actions; cross-origin iframes are unreachable. Stay on one origin for a clean recording.
- **Actions covered:** click, text input incl. `contenteditable` (fill), select, keyboard (Enter + Esc/Tab/Arrows as `press`), navigation, explicit **page scroll**
  (coalesced per gesture → `scroll <dir> <px>`; mostly redundant since replay auto-scrolls to each
  element, but it captures lazy-load / infinite-scroll reveals), and **checkbox/radio**. `hover` is
  implicit (replay hovers/scrolls to each target).
- **Checkbox / radio:** a bare `click` TOGGLES, so if the page's initial state differs at replay the
  final state would be wrong yet the run would pass green. So a native `<input type=checkbox|radio>`
  that ends **checked** compiles to `find … check` — an ABSOLUTE set that reaches the captured state
  regardless of the initial state. **Unchecking stays a `click`**: agent-browser 0.27.0 `uncheck` is
  broken (probe-verified: returns success=false and leaves the box checked), so an absolute uncheck is
  not available — the click works only when the replay's initial state matches capture (a documented
  residual). Custom `role="checkbox"` divs (aria-checked) also stay a click. **`drag` and file `upload` are excluded** — agent-browser's `drag`/
  `upload` commands take a CSS selector or a stale `@ref` (both forbidden by this framework), the `find`
  marker is transient, and drag targets are usually non-semantic `<div>`s with no stable locator, so
  there is no reliable semantic replay path; forcing one would risk the silent-wrong-element matches
  this framework exists to prevent. Container (non-page) scroll is likewise excluded (needs a selector).
- **Sensitive fields** (password / OTP / card / SSN — by type/autocomplete/inputmode) are
  masked at capture and never written; their `{{input_N}}` token must be filled by hand.
- **Keyboard:** Enter plus a navigation allowlist (**Esc / Tab / Arrows**) are captured as `press` steps.
  **Space, bare printable keys, and AltGr-composed characters are not** (they are text, or a button's
  synthetic click — already captured). A **modifier shortcut** (Ctrl/Cmd/Alt, e.g. `Control+s`) is captured
  but **build-flow warns** (its replay effect is app-specific); `Shift+Tab` and friends are normal
  navigation. Like scroll, a `press` is best-effort — a no-op press can't false-green a **following**
  locator (which gates correctness). **Caveat:** a *run* of consecutive arrow presses on a custom
  listbox/menu is index-relative with no intervening locator, so if the page's selection drifts a different
  item can be chosen — **build-flow warns on arrow presses** to surface this.
- **`contenteditable`** is captured as a `fill` step — its text is read from `textContent` (it has no
  `.value`) and replays via `find … fill` (probe-verified). Before this, the typed text was lost (captured
  as null) and the benign field was mislabelled "sensitive".
- **`<select multiple>`** is marked `needs_review`: `el.value` exposes only the first selected option, so
  a single-value `select` step can't faithfully represent it (selecting one of N would be a false-green).
  A human resolves the multi-selection (agent-browser `select` accepts multiple values).
- **Icon-only buttons** whose only accessible name is `aria-label` ARE captured cleanly: an
  aria-label `<button>` (or explicit `role="button"`) compiles to a `find role button --name "<label>"
  --exact` primary, which agent-browser 0.27.0 resolves reliably (probe-verified). The `--exact` is
  load-bearing: `find role --name` is a **substring** match without it, so it is required for the
  capture-time exact `count==1` to agree with the engine. The engine does **not** resolve
  `find role --name` for a native `<a>`/`<input>`/`<heading>` or for a name from `aria-labelledby`, and
  an **auto-generated** aria-label (looks like a dynamic id) is too fragile — so an icon-only **link**,
  native checkbox/radio, `<input type=button>`, aria-labelledby control, or auto-labelled button stays
  `needs_review` rather than getting a primary that would silently fail (or mis-resolve at) replay.
- **No unique stable locator → `needs_review`** (with a non-empty candidate ladder), never a fragile
  guess. This is expected for duplicate-text grids (N identical "Edit" rows), closed shadow roots,
  the icon-only cases above, and links or buttons whose visible text is **very long** (>80 chars).
  Long exact text IS kept as a reviewable candidate (the ladder is never empty), but is **not
  auto-accepted** as the step's primary locator because long exact text is fragile — the step stays
  `needs_review`. Tip: when recording, click the **short labelled** control, not a long descriptive
  block. Resolve a `needs_review` step by picking a candidate, or run `verify` (re-drives and repairs
  from the captured ladder where it can).
- **SPA navigation:** `history.pushState`/`replaceState`/hash changes are captured as url
  wait-gates. A pure DOM-swap router that changes **no** URL is detected heuristically (a click
  that triggers a large DOM mutation with no URL change) and emits a settle wait — `until:text`
  on the next step's target when available, else `until:load networkidle`. A swap below the
  mutation threshold still falls back to the next locator's implicit wait.
- **Data integrity:** a silent sessionStorage quota / private-mode write loss is caught by a
  seq-advance health-check and fails the capture loudly (never a quietly-incomplete flow).

See `flows/SCHEMA.md` (schema, needs_review, values sidecar) and `bin/capture.js`.

## Visual / structural regression (optional)

`assert_no_snapshot_change baselines/<test>.snapshot.json` gates structural drift
(parses `diff snapshot --json .changed`; preferred over pixel diff, which false-positives
on Windows font AA). Capture a baseline once with
`agent-browser snapshot --json > baselines/<test>.snapshot.json`.
