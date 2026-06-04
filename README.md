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
- **Actions covered:** click, text input (fill), select, Enter, navigation. Scroll, hover,
  drag, and file-upload are excluded (replay auto-scrolls to each element).
- **Sensitive fields** (password / OTP / card / SSN — by type/autocomplete/inputmode) are
  masked at capture and never written; their `{{input_N}}` token must be filled by hand.
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
