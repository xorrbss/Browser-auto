# agent-qa

Hybrid, general-purpose web test-automation framework built on
[vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) 0.27.0.

A test is **one bash file = one user journey**. Replay is deterministic and free
(`$0`, no AI). AI is optional and confined to authoring/recovery — it never enters the
pass/fail gate.

## Requirements (Windows + Git Bash)

- Git Bash (`C:\Program Files\Git\usr\bin\bash.exe`)
- `agent-browser` 0.27.0 — `npm i -g agent-browser && agent-browser install`
- `jq`, `ffmpeg` (video) — `winget install jqlang.jq Gyan.FFmpeg`
- `node`

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

## 결재 (approval) sync — P0: read & display

A built-on-top feature that scrapes a groupware **approval inbox** into a local DB and shows it on
the webui dashboard. P0 is **read-only** (no approval execution — that is a later, human-gated phase).
It reuses the existing pieces: cached auth (`setup/auth.sh`), the agent-browser `.success` contract
(`lib/env.sh`), and the webui serial job queue (so the browser sync runs one-at-a-time like any run).

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
  settle gate for async lists). `doc_id` is mandatory; reserved seams `steps/detail/summarize/approve`
  are documented, not yet built.
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
  `query`/`approve`→read-only `db.queryApprovals` rows. `approve` returns **candidates only** —
  execution is the human-gated Phase 2, never triggered from here. amount has no numeric filter
  (TEXT column) → the model maps it to a keyword.

If the on-prem model is unreachable, every command safely degrades to `clarify` (no action taken).
**Not built here (by design / per the safety review): an open live agent that improvises browser
actions** — both the safety and feasibility reviews rejected an LLM→click path on live approval pages;
the model stays a classifier, effectful actions stay deterministic + human-gated.

**Summarization is intentionally out of P0**: the approval body can be confidential/PII, so sending
it to an external LLM is a policy decision. P0 stores/displays the raw text only; a policy-gated
`bin/summarize.js` can fill the `summary` column later.

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
