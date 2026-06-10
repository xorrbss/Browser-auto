# DESIGN: selectable browser engine for record and replay

> **⚠ SUPERSEDED (2026-06-10).** The product moved past per-flow engine selection: commit `441294d`
> made the runtime **Playwright-only** (`lib/engine.js` ENGINES=['playwright']; `engine:"agent-browser"`
> is refused fail-closed with a migration hint; omitted engine defaults to playwright). The engine
> resolver, engine-scoped auth layout (`fixtures/auth/playwright/`), pw-record/play-flow, and the webui
> dispatch described here WERE built and survive — but the agent-browser half no longer exists.
> Kept as design history only.

## Goal

Let an operator choose the browser engine for a system or flow:

- `agent-browser`
- `playwright`

The selected engine must own the whole browser session lifecycle for that flow:

1. headed login / auth-state capture
2. headed journey recording
3. verify / repair
4. deterministic replay / test run
5. effectful dry-run and live execution, where applicable

No runtime path should silently fall back to the other engine. A flow recorded with
Playwright replays with Playwright. A flow recorded with agent-browser replays with
agent-browser.

This is not a return to an open browser agent. The durable contract stays the same:
declarative flow/recipe, deterministic AI-free replay, fail-closed safety gates, and
auditable execution.

This replaces the binary "Option A agent-browser only" vs "Option B Playwright
only" decision with a per-system/per-flow choice.

## Current state

### agent-browser path

- Auth: `setup/auth.sh` -> `fixtures/auth/<app>.state.json`.
- Recording: `bin/probe-record.sh capture` opens agent-browser headed, injects
  `bin/capture.js`, drains `sessionStorage`, and writes `flows/<name>.flow.json`
  through `bin/build-flow.js`.
- Verify/repair: `bin/verify-flow.sh`.
- Replay/test compile: `bin/probe-record.sh compile` -> `tests/<name>.test.sh`.
- Runtime read drivers: `bin/analyze-system.sh`, `bin/sync-system.sh`,
  `bin/enrich-system.sh`, `bin/fetch-approvals.sh`, `bin/enrich-approvals.sh`.
- Web UI spawn: `webui/spawn.js::browserBash`, guarded by `lib/daemon.sh`.

Strength: already integrated with test harness and generic read/sync drivers.

Cost: daemon lifecycle, agent-browser command quirks, and limited frame support in the
compiled test path.

### Playwright path

- Auth: `approve/auth-pw.mjs` -> `approve/<app>.pw-state.json`.
- Effectful execution: `approve/approve-run.mjs`.
- Generic flow step executor: `approve/flow-runner.mjs`.
- Web UI spawn: `webui/spawn.js::nodeLeaf`.

Strength: trusted browser actions, strict locators, first-class frame locators, no
agent-browser daemon.

Cost: not yet a generic recorder/test compiler; currently mostly approve-shaped.

## Product model

### Engine is a system default and a flow lock

Add two related but different concepts:

```jsonc
// systems table / registry object
{
  "name": "hiworks",
  "engine": "agent-browser" // default for new auth/record/play work; sync when supported
}
```

```jsonc
// flows/<name>.flow.json
{
  "name": "checkout",
  "app": "hiworks",
  "engine": "agent-browser",
  "startUrl": "https://...",
  "steps": [],
  "asserts": []
}
```

Rules:

- `system.engine` is the default for new work.
- `flow.engine` is the replay source of truth once a flow exists.
- Existing flows with no `engine` mean `agent-browser`.
- Changing a system's default engine does not mutate existing flows.
- A caller may pass `--engine <engine>` while recording a new flow; the generated
  flow stores that engine.
- Replay refuses if the requested engine and `flow.engine` disagree, unless an
  explicit future migration command rewrites the flow after validation.

### Auth state is engine-scoped

Do not pretend the two engines share a session cache.

Initial compatible layout:

```text
fixtures/auth/<app>.state.json       agent-browser storage state
approve/<app>.pw-state.json          existing Playwright storage state
```

Target layout, after compatibility shims:

```text
fixtures/auth/agent-browser/<app>.state.json
fixtures/auth/playwright/<app>.state.json
```

Rules:

- `auth --engine agent-browser` writes/reads only the agent-browser state.
- `auth --engine playwright` writes/reads only the Playwright state.
- UI status must display engine-specific auth readiness.
- A missing state for the selected engine disables work for that engine.
- No route should refresh only one engine while reporting the other as ready.

## Architecture

Introduce a small engine adapter boundary. Keep it thin; do not build a framework
inside the framework.

```text
webui / CLI
   |
   v
engine resolver
   |
   +-- agent-browser adapter
   |     auth:    setup/auth.sh
   |     record:  bin/probe-record.sh capture --engine agent-browser
   |     verify:  bin/verify-flow.sh
   |     play:    compiled bash test / AB helpers
   |
   +-- playwright adapter
         auth:    setup/auth-pw.mjs or generalized approve/auth-pw.mjs
         record:  bin/pw-record.mjs
         verify:  bin/pw-verify.mjs or bin/play-flow.mjs --verify
         play:    bin/play-flow.mjs using approve/flow-runner.mjs
```

The shared artifact is still `flows/*.flow.json`; the engine adapter only decides
how to record and replay that artifact.

## CLI surface

### Keep existing commands working

All current commands default to `agent-browser` when no engine is specified:

```bash
bash bin/probe-record.sh capture checkout https://app.example.com --app myapp
bash bin/probe-record.sh verify flows/checkout.flow.json
bash bin/probe-record.sh compile flows/checkout.flow.json
```

### Add explicit engine selection

```bash
bash setup/auth.sh --engine agent-browser myapp <login-url> <success-url>
bash setup/auth.sh --engine playwright     myapp <login-url> <success-url>

bash bin/probe-record.sh capture --engine agent-browser checkout <url> --app myapp
bash bin/probe-record.sh capture --engine playwright     checkout <url> --app myapp

bash bin/probe-record.sh verify  flows/checkout.flow.json
bash bin/probe-record.sh compile flows/checkout.flow.json
node bin/play-flow.mjs --flow    flows/checkout.flow.json
```

`verify`, `compile`, and `play-flow` read `flow.engine`.

### What compile means per engine

Keep the core invariant: one bash file is still one user journey.

For `agent-browser`:

- `compile` keeps generating the current self-contained bash body using `BATCH`,
  `ABX`, `wait_url`, and `assert_*`.

For `playwright`:

- `compile` generates a bash wrapper that invokes a deterministic Node runner:

```bash
#!/usr/bin/env bash
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/checkout.flow.json"
```

The wrapper is the CI/test entrypoint; `bin/play-flow.mjs` is the engine-specific
replay implementation.

## Playwright generic recorder

Add `bin/pw-record.mjs` rather than duplicating capture semantics in bash.

Responsibilities:

- Launch headed Chromium/Chrome through Playwright.
- Load `fixtures/auth/playwright/<app>.state.json` or the compatibility
  `approve/<app>.pw-state.json` when `--app` is supplied.
- Inject the existing `bin/capture.js` with `context.addInitScript`.
- Open `startUrl`.
- Stop via timeout/stopfile/Enter equivalent.
- Drain `sessionStorage.__aqa_buf` and `__aqa_seq`.
- Close browser.
- Call `bin/build-flow.js` or write an equivalent raw records file and then call
  the existing builder.
- Write `engine:"playwright"` into the flow.

Do not fork `capture.js` at first. The fastest safe path is one recorder script,
one raw event shape, one `build-flow.js`.

Known constraint:

- Keep cross-origin iframe actions fail-closed until proven and tested. Playwright
  can scope frames better than agent-browser, but recording fidelity must be proven
  before widening the product promise.

## Playwright generic replay

Add `bin/play-flow.mjs` around `approve/flow-runner.mjs`.

Responsibilities:

- Read `flows/<name>.flow.json`.
- Fail if `flow.engine !== "playwright"` unless called with an explicit
  compatibility mode for tests.
- Read values from `flows/<name>.values.json`.
- Resolve auth state for `flow.app`.
- Launch Playwright.
- Open `flow.startUrl`.
- Run `runSteps(page, flow.steps, ...)`.
- Run `flow.asserts`.
- Emit `AQA_JOB_RESULT=<json>` for webui jobs when used as a job leaf.
- Exit non-zero on any failed step/assert.

Assertion mapping:

| flow assert | Playwright implementation |
|---|---|
| `url` | `page.url()` plus the existing glob semantics from `assert.sh` |
| `text` | page/body text contains substring |
| `value` | locator/value read, with selector support retained |
| `visible` | locator visible |
| `count` | locator count equals n |
| `absent` | locator count is 0 |

Locator mapping should reuse `approve/flow-runner.mjs::buildLocator` for semantic
`find` steps. Selector-based asserts remain supported because the current assert
schema uses selectors.

## Verify/repair per engine

For `agent-browser`, keep `bin/verify-flow.sh`.

For `playwright`, add a minimal `bin/pw-verify.mjs` or implement `bin/play-flow.mjs
--verify`:

- Re-drive from `startUrl`.
- For each `find` step, build the Playwright locator and require exact uniqueness
  for effectful steps.
- Probe with `hover` for non-destructive locator validation.
- Use the existing candidate sidecar only when the candidate is capture-time
  unique.
- Promote unresolved steps to `needs_review`.
- Rewrite flow atomically, same as `verify-flow.sh`.

Important difference:

- Playwright can count semantic locators at replay time. That means Playwright
  verify can be stricter than agent-browser verify. This is good, but it must be
  engine-scoped so it does not change agent-browser behavior.

## Runtime drivers

Read/sync/enrich drivers currently assume agent-browser. There are two possible
levels of engine support.

### Phase 1: flow/session engine only

Implement engine selection for:

- auth
- record
- verify
- compile
- replay/test
- effectful flow execution

Keep generic read drivers on agent-browser until a Playwright extraction driver
exists. The UI should label this honestly:

```text
System engine: Playwright
Recording/replay: Playwright
Read sync: agent-browser only for now
```

This is the smallest useful slice for the user's request: session recording and
playback follow the selected engine.

### Phase 2: read/sync drivers also engine-scoped

Add Playwright read drivers:

- `bin/analyze-system-pw.mjs`
- `bin/sync-system-pw.mjs`
- `bin/enrich-system-pw.mjs`

or a single `bin/system-driver.mjs --engine playwright --action sync`.

Reuse extraction scripts by producing the same aria-like snapshot data shape, or
split extraction into DOM/table extraction adapters. The safer first slice is to
keep extraction output identical to the current `snapshot .data` contract.

## Web UI changes

### System form

Add an engine segmented control:

```text
Engine: [agent-browser] [Playwright]
```

Save it to the system registry.

Validation:

- accepted values only: `agent-browser`, `playwright`
- default: `agent-browser`

### State panel

Show engine-scoped readiness:

```jsonc
{
  "engine": "playwright",
  "auth": {
    "selected": "ready",
    "agentBrowser": "missing",
    "playwright": "ready"
  }
}
```

### Record flow

When recording a flow for a system:

- default engine = `system.engine`
- allow explicit override before starting
- recorded flow stores `engine`
- job uses `recordCmd(..., { engine })`

### Spawn routing

Extend `webui/spawn.js`:

```js
recordCmd(name, startUrl, { app, seconds, stopFile, engine })
```

Dispatch:

- `agent-browser` -> current `browserBash('bin/probe-record.sh', ...)`
- `playwright` -> `nodeLeaf('bin/pw-record.mjs', ...)`

Playwright jobs must not run through `browserBash`; they do not need daemon ensure.

## Schema and DB changes

### systems table

Add nullable/default column:

```sql
ALTER TABLE systems ADD COLUMN engine TEXT;
```

Parsing rule:

```js
engine = row.engine || 'agent-browser'
```

Register/update rule:

- store only valid engines
- preserve existing engine if omitted
- new systems default to `agent-browser`

### flow schema

Add optional top-level:

```json
"engine": "agent-browser"
```

Back-compat:

- absent means `agent-browser`

Forward rule:

- new captures always write it
- compile/play verify against it

### recipe actions

For effectful actions, prefer action-level engine only when needed:

```jsonc
"actions": {
  "approve": {
    "enabled": true,
    "engine": "playwright",
    "steps": []
  }
}
```

Default:

- `action.engine || flow.engine || system.engine || "agent-browser"`

Fail-closed:

- if an enabled action has `steps` recorded with a different engine than the
  chosen action engine, refuse.

## Safety rules

- No automatic fallback to another engine.
- Engine state files are not interchangeable.
- Existing `agent-browser` hardening remains active.
- Playwright actions are not automatically safer for business logic; effectful
  gates remain required.
- A flow with `needs_review` is non-runnable on both engines.
- Cross-origin iframe recording remains unsupported until separately proven.
- Changing a system engine is not a migration of previously recorded flows.

## Implementation sequence

1. Add engine resolver and schema defaults.
   - `lib/engine.js` or small helpers in `webui/systems.js`/CLI scripts.
   - DB default parsing.
   - flow schema docs.
   - Unit tests for defaults and invalid values.

2. Generalize auth entrypoints.
   - `setup/auth.sh --engine agent-browser` keeps current behavior.
   - `setup/auth.sh --engine playwright` delegates to `approve/auth-pw.mjs`
     or a renamed `setup/auth-pw.mjs`.
   - UI auth button uses selected engine.

3. Add Playwright generic replay first.
   - `bin/play-flow.mjs` using `approve/flow-runner.mjs`.
   - Compile Playwright flows to bash wrappers.
   - Browser-free tests for step/assert validation.
   - One local HTML smoke test.

4. Add Playwright generic recording.
   - `bin/pw-record.mjs`.
   - Reuse `bin/capture.js` and `bin/build-flow.js`.
   - Flow output includes `engine:"playwright"`.
   - Tests for generated flow metadata and stop/drain behavior.

5. Wire webui record/play.
   - Engine selector in system/flow UI.
   - `recordCmd(...engine...)`.
   - Job labels include engine.
   - State view displays selected engine auth.

6. Add Playwright verify/repair.
   - Semantic locator count at replay.
   - Candidate repair.
   - Atomic rewrite.

7. Optional: engine-scope read/sync/enrich.
   - Only after record/play is stable.
   - Decide whether to reproduce the agent-browser snapshot shape or create a
     Playwright extraction adapter.

## Acceptance criteria

- Existing agent-browser flows run unchanged.
- Existing `bash run.sh` remains green.
- A newly recorded agent-browser flow stores `engine:"agent-browser"` and compiles
  to the current bash body.
- A newly recorded Playwright flow stores `engine:"playwright"` and compiles to a
  bash wrapper around `bin/play-flow.mjs`.
- Web UI recording with a Playwright-selected system spawns Playwright, not
  agent-browser.
- Web UI recording with an agent-browser-selected system still daemon-guards
  agent-browser.
- Playwright replay refuses an agent-browser flow and vice versa, unless an
  explicit test-only compatibility flag is used.
- Auth readiness is engine-specific in the UI.
- No path silently refreshes one engine's auth and reports the other engine ready.

## Recommended first build slice

Build in this order:

1. `engine` field defaults in DB + flow schema docs.
2. Playwright `bin/play-flow.mjs` replay for an already-auth-free local flow.
3. `probe-record.sh compile` emits a Playwright wrapper when `flow.engine` is
   Playwright.
4. Playwright `bin/pw-record.mjs` writes the same flow shape with
   `engine:"playwright"`.
5. Web UI engine selector + `recordCmd` dispatch.

This gives the user-visible behavior first: choosing Agent-browser or Playwright
causes that engine to record and play the session. Engine-scoped read/sync can then
follow without blocking the core request.
