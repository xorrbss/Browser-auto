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
bin/probe-record.sh authoring: scaffold (snapshot+stub) | capture (record) -> compile -> .test.sh
bin/capture.js      in-page recorder injected via --init-script (capture mode)
bin/build-flow.js   raw captured events -> flow.json (+ gitignored values sidecar)
flows/              declarative twins (no @eN field); *.values.json sidecars (gitignored)
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
#    candidates), fill flows/checkout.values.json, then compile + run as above:
bash bin/probe-record.sh compile flows/checkout.flow.json
bash run.sh checkout
```

Sensitive fields (password / OTP / card / SSN) are masked at capture and never written.
Scope is a single top-frame, single tab; a new tab or cross-origin top-level nav ends the
recording with a warning (see `flows/SCHEMA.md` and `bin/capture.js`).

## Visual / structural regression (optional)

`assert_no_snapshot_change baselines/<test>.snapshot.json` gates structural drift
(parses `diff snapshot --json .changed`; preferred over pixel diff, which false-positives
on Windows font AA). Capture a baseline once with
`agent-browser snapshot --json > baselines/<test>.snapshot.json`.
