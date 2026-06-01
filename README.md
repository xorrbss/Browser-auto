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

# Deterministic body: semantic locators only, a wait-gate between page changes.
BATCH --bail <<'JSON'
[["find","label","Email","fill","user@example.com"],
 ["find","role","button","--name","Sign in","click"],
 ["wait","--url","**/dashboard"]]
JSON

assert_url  "/dashboard"
assert_text "Welcome"
```

## Hard rules (verified footguns — do not break)

- **Never assert via exit code.** A `batch --bail` call exits 0 even when a step
  failed. Use the `assert_*` helpers and `BATCH` — they read the `--json` `.success`
  field. A bare `is`/`find` in a test is a false-green waiting to happen.
- **Never write `@eN` refs into a test.** Refs go stale on any page change. Use
  semantic `find role|text|label|placeholder|alt|title|testid` locators.
- **Gate every page transition** with `wait --url|--text|--load networkidle` so the
  next locator runs against a settled page.
- **Run via `run.sh`**, which owns the daemon + ffmpeg PATH. Ad-hoc `agent-browser`
  calls from a stale-PATH shell can silently lose video.

## Layout

```
run.sh              suite runner + CI gate
lib/                env, cleanup, preflight, assert, report  (leaves; one-way deps)
tests/*.test.sh     one journey each (standalone-runnable)
setup/auth.*.sh     one-time human OTP login -> state save  (Phase 1)
bin/probe-record.sh authoring: scaffold (snapshot+stub) -> compile -> .test.sh
flows/              optional declarative twins (no @eN field)
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

It opens a real Chrome window; you complete the login + OTP by hand; the script waits on
`SUCCESS_URL` and saves `fixtures/auth/myapp.state.json`. Tests then start with
`AB_AUTH myapp open <url>` and replay unattended — the OTP cost is paid once.

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
#    snapshot (priority: testid > role+name > label > exact-text > placeholder > title;
#    verify each is unique with `agent-browser get count '<sel>' --json` -> .data.count==1).
#    NEVER write @eN refs — they go stale. See flows/SCHEMA.md.

# 3. Compile to a runnable, harness-compatible test:
bash bin/probe-record.sh compile flows/checkout.flow.json
#    -> tests/checkout.test.sh

# 4. Run it:
bash run.sh checkout
```

## Visual / structural regression (optional)

`assert_no_snapshot_change baselines/<test>.snapshot.json` gates structural drift
(parses `diff snapshot --json .changed`; preferred over pixel diff, which false-positives
on Windows font AA). Capture a baseline once with
`agent-browser snapshot --json > baselines/<test>.snapshot.json`.
