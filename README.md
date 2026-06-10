# agent-qa

Playwright-backed web test automation for deterministic user journeys.

A test is **one bash file = one user journey**. Replay is AI-free: the compiled bash file runs the
same Playwright flow every time (`bash $0`, no API key, no LLM in the loop). AI or a human may help
author and repair a flow, but the pass/fail gate is deterministic.

## Requirements

- Windows + Git Bash (`C:\Program Files\Git\bin\bash.exe`)
- `node` >= 22.5 (Node 24 verified; `lib/db.js` uses built-in `node:sqlite`)
- `jq`
- `ffmpeg` for video/artifacts (`winget install jqlang.jq Gyan.FFmpeg`)
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

Artifacts land in `artifacts/<run-id>/` (gitignored). Each suite run writes `report.json` and
`report.junit.xml`.

## Auth

Sites needing SSO, OTP, or 2FA are handled once with a headed Playwright login:

```bash
bash setup/auth.sh myapp https://app.example.com/login '**/dashboard'
```

Complete the login by hand in the browser window. The script saves
`fixtures/auth/playwright/myapp.state.json` (gitignored). Future Playwright flows with
`"app": "myapp"` replay unattended from that cached state.

## Record, Verify, Compile

```bash
# Optional: create a snapshot and stub to author against.
bash bin/probe-record.sh scaffold checkout https://app.example.com/cart

# Record a live headed journey. You drive the browser; capture writes the flow.
bash bin/probe-record.sh capture checkout https://app.example.com/cart --app myapp

# Fill any {{input_N}} values in flows/checkout.values.json and resolve needs_review steps.

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

## Flow Format

New flows should declare Playwright explicitly:

```json
{
  "name": "checkout",
  "engine": "playwright",
  "app": "myapp",
  "startUrl": "https://app.example.com/cart",
  "steps": [],
  "asserts": []
}
```

See `flows/SCHEMA.md` for all step kinds, iframe rules, `needs_review`, values sidecars, replay
fallback, and assert kinds.

## Correctness Rules

- Replay is deterministic and AI-free. No model call drives a browser or decides pass/fail.
- Never write transient element refs such as `@eN` into a test or flow.
- Use semantic locators only: `testid`, `role`, `label`, `text`, `placeholder`, `alt`, or `title`.
- Gate every page transition with a URL, text, or load wait.
- `needs_review` is fail-closed; compile/replay must refuse it until resolved.
- Committed flows use `{{input_N}}` tokens; real values live in gitignored `.values.json` files.
- The recorder fails loud rather than guessing when a locator is not stable and unique.

## Legacy Flow Migration

Older repositories may contain flows with `"engine": "agent-browser"`. Omitted `engine` now defaults
to Playwright, though new flows may still set `"engine": "playwright"` explicitly for clarity. To
migrate an explicit legacy flow:

```bash
# 1. Edit the flow to set: "engine": "playwright"
# 2. Refresh auth into fixtures/auth/playwright/<app>.state.json
bash setup/auth.sh <app> <login-url> '<success-url>'

# 3. Validate, verify, compile, and run
node bin/play-flow.mjs --flow flows/<name>.flow.json --validate-only
bash bin/probe-record.sh verify flows/<name>.flow.json
bash bin/probe-record.sh compile flows/<name>.flow.json
bash run.sh <name>
```

If a flow cannot be migrated yet, keep `"engine": "agent-browser"` explicit so it is visible technical
debt. The Playwright docs, webui defaults, and new authoring path assume `"engine": "playwright"`.

## Web UI

```bash
node webui/server.js        # http://127.0.0.1:4310
```

The webui is a thin local control plane over the same CLI tools. It can run tests, start headed auth,
record flows, verify, compile, and browse artifacts. It has no built-in public auth; keep it on
loopback or behind an authenticated tunnel/reverse proxy.

## Docker Recording Server

```bash
docker compose up -d
# http://localhost:4310          webui
# http://localhost:6080/vnc.html headed browser through noVNC
docker compose exec agent-qa bash run.sh
```

Recording and OTP login need the headed browser. Headless replay, results, and compile can be driven
from the webui. Do not expose the webui or noVNC directly to a public network.

## Layout

```text
run.sh                suite runner + CI gate
bin/play-flow.mjs     deterministic Playwright flow runner
bin/probe-record.sh   scaffold | capture | verify | compile dispatcher
bin/pw-record.mjs     headed Playwright recorder
bin/capture.js        in-page recorder script
bin/build-flow.js     raw events -> flow.json + gitignored sidecars
setup/auth.sh         headed Playwright auth -> fixtures/auth/playwright/*.state.json
flows/                committed flow.json files; gitignored values/candidates/snapshots
tests/*.test.sh       one deterministic bash journey each
webui/                localhost control plane over the CLI
artifacts/<run>/      videos, screenshots, report.json, report.junit.xml
```

## Internal Open Checklist

```bash
git status --short --untracked-files=all
node --check webui/public/app.js
node --check webui/server.js
node --check webui/routes-command-plan.js
node --check webui/routes-rpa.js
node --check webui/routes-approve.js
node --check webui/jobs.js
node --check webui/systems.js
node --check lib/db.js
bash tests/build-flow-unit.test.sh
bash tests/compile-engine-unit.test.sh
bash tests/play-flow-smoke.test.sh
bash run.sh
```

Then start `node webui/server.js` and smoke Command Center, Target Review, Systems, Action Registry,
Queue, Audit, Approval State, and Diagnostics on desktop and mobile.
