# flows/*.flow.json schema

The optional declarative twin of a `tests/*.test.sh`. A flow may be produced by
`bin/probe-record.sh` or written by hand. The compiled `.test.sh` remains the deterministic,
standalone runnable journey; the `.flow.json` is the diffable authoring source.

**Hard rule: no `@eN` ref field exists in this schema.** Refs go stale on page changes. Every action
targets an element through a semantic locator.

```jsonc
{
  "name": "checkout",
  "engine": "playwright",
  "environment": "local",
  "riskClass": "read",
  "app": "myapp",
  "startUrl": "https://app.example.com/cart",
  "steps": [
    { "kind": "find", "by": "text", "value": "Checkout", "action": "click" },
    { "kind": "wait", "until": "url", "value": "**/payment" },
    { "kind": "find", "by": "label", "value": "Card number", "action": "fill", "text": "{{input_1}}" },
    { "kind": "find", "by": "role", "value": "button", "name": "Pay", "action": "click" },
    { "kind": "wait", "until": "text", "value": "Order confirmed" }
  ],
  "asserts": [
    { "kind": "url", "value": "**/receipt" },
    { "kind": "text", "value": "Order #" }
  ]
}
```

## Engine

New and migrated flows use:

```json
{ "engine": "playwright" }
```

`flow.engine` is the replay source of truth. Compile, verify, and replay fail closed if the requested
runner and `flow.engine` disagree; there is no silent fallback to another engine.

### Engine cleanup

Omitted `engine` defaults to Playwright. If an older flow declares any other explicit engine value,
set `"engine": "playwright"`, refresh auth with `bash setup/auth.sh <app> <login-url> '<success-url>'`,
run `node bin/play-flow.mjs --flow flows/<name>.flow.json --validate-only`, then verify and compile.
Keep unconverted flows out of the compiled test gate.

## Top-Level Fields

- `name`: required; matches `tests/<name>.test.sh`.
- `engine`: required for new work; use `"playwright"`.
- `environment`: required for new work; one of `local`, `staging`, `live-readonly`, or `live-action`.
- `riskClass`: required for new work; one of `read`, `effectful`, or `destructive`.
- `app`: optional; when set, Playwright replay uses the app's cached Playwright auth state. Local pilot
  mode stores it at `fixtures/auth/playwright/<app>.state.json`; external/encrypted mode stores backend
  metadata as `aqa-secret://<tenant>/auth-state/canonical:<app>` and refuses plaintext local auth state.
- `startUrl`: required; first URL opened by replay.
- `steps`: required array; interaction and wait sequence.
- `asserts`: optional array; final assertions.
- `irreversibleAt`: optional integer step index for audited point-of-no-return gates.
- `reversible`: optional boolean override for effectful-flow gating.

## Live-Readiness Policy

Replay validates `environment` and `riskClass` before opening a browser.

- `local`: deterministic local/file/localhost fixtures; default CI lane.
- `staging`: staging-safe systems; manual lane.
- `live-readonly`: live/public read-only browsing; default CI skips it.
- `live-action`: live effectful work; must declare `riskClass:"effectful"` or `"destructive"` and an
  `irreversibleAt` step that points at the effectful point of no return.

Actual replay of non-local environments is gated by `AQA_RUN_MODE`. A `live-action` replay also requires
`AQA_LIVE_ALLOWLIST` to include the flow name, app, or start URL origin, plus
`AQA_LIVE_DRY_RUN_PASSED=1` or the exact flow name, plus `AQA_LIVE_ACTION_APPROVE=1` or the exact flow
name. Scheduled runs (`AQA_SCHEDULED_NO_LIVE=1`) refuse live environments. `live-readonly` flows that
look like submit/approve/delete/transfer/save actions fail closed.

OTP/MFA is never automated in deterministic replay. A `fill`/`type`/`select` step whose locator looks like an
OTP, MFA, one-time, SMS, email-code, authenticator, push, or recovery-code challenge is refused; refresh auth
with headed `setup/auth.sh` instead.

## Step Kinds

- `find`: element interaction.
  - `by`: one of `testid`, `role`, `label`, `text`, `placeholder`, `alt`, `title`.
  - `value`: locator value.
  - `name`: optional accessible name for `role`.
  - `action`: one of `click`, `fill`, `type`, `select`, `check`, `uncheck`, `hover`.
  - `text` / `val`: value for `fill`, `type`, or `select`.
  - `frame`: optional same-origin iframe scope.
  - `timeoutMs`: optional per-step timeout override, positive integer up to 600000.
- `wait`: deterministic settling gate.
  - `until`: one of `url`, `text`, `load`.
  - `value`: URL glob/text/load state as appropriate.
  - `timeoutMs`: optional per-step timeout override, positive integer up to 600000.
- `scroll`: page scroll captured as `{ "dir": "up|down|left|right", "px": 300 }`.
- `press`: non-text keyboard action, such as `Enter`, `Escape`, `Tab`, or arrow keys.
- `open_record`: recipe-driven dynamic row open for RPA/detail flows.
  - `timeoutMs`: optional per-step timeout override for runner-controlled work where supported.

Locator priority when authoring: **testid > role+name > label > exact-text > placeholder > title**.
Uniqueness is checked during capture/verification; a non-unique or fragile target must become
`needs_review` instead of a guessed selector.

## Recorder Capability Matrix

Recorder support is intentionally conservative. Captured records are either compiled into deterministic
Playwright steps, marked `needs_review`, or refused before a flow is produced.

| Capability | Recorder result | Replay status |
| --- | --- | --- |
| Same-tab clicks, fills, single selects, checkbox/radio check, same-page waits | Semantic `find`/`wait` steps when the locator is unique | Supported |
| Same-origin iframe action with safe `id`, `name`, `title`, `urlGlob`, or `index` | `find` step with `frame` scope | Supported |
| Cross-origin iframe action | `needs_review` with captured candidates/evidence | Unsupported, fail-closed |
| File upload input | `needs_review`; local file path is never captured | Unsupported, fail-closed |
| Download link | `needs_review`; no runnable click fallback is emitted | Unsupported, fail-closed |
| Page scroll | `{ "kind": "scroll", "dir": "...", "px": N }` | Supported for page scroll only |
| Scrollable container gesture | `needs_review` with `unsupported:"container-scroll"` and recorded direction/px | Unsupported, fail-closed |
| `Enter`, `Escape`, `Tab`, arrow keys | `press` step | Supported with drift warnings for arrows |
| `Ctrl`/`Meta`/`Alt` shortcuts such as `Control+s` | `press` step plus build warning | Partial; human must review app-specific effects |
| Popup/new tab or top-level cross-origin recording boundary | Recorder refuses/fails loud | Unsupported, fail-closed |

## Iframes

A `find` step inside a same-origin iframe may include:

```json
{ "frame": { "by": "id", "value": "payment-frame" } }
```

Supported frame locators are `id`, `name`, `title`, `urlGlob`, and `index`. Cross-origin iframes are a
ceiling for capture and must fail closed or become `needs_review`.

## `needs_review`

When capture cannot identify one stable unique locator, the step is emitted as:

```jsonc
{
  "kind": "find",
  "action": "click",
  "needs_review": true,
  "candidates": [
    { "by": "text", "value": "Edit", "count": 4 }
  ]
}
```

`needs_review:true` is non-runnable. Compile and replay must refuse it. A human or agent must select a
stable locator, adjust the flow, or re-record the journey.

## Locator Repair

There is no replay-time locator fallback: replay runs exactly the committed locators, fail-closed.
Repair happens at VERIFY time instead — `probe-record.sh verify` re-drives the flow and may swap a
broken `find` locator for a capture-time-unique candidate from the gitignored candidates sidecar
(or promote the step to `needs_review`). The historical `replayFallback` flag from the previous
engine is gone; a flow setting it is ignored.

## Parameterized Values

Committed flows store `{{input_N}}` tokens rather than literal field values. Real values live in the
gitignored `flows/<name>.values.json` sidecar in local pilot mode:

```json
{ "input_1": "4111111111111111" }
```

Sensitive fields such as passwords, OTPs, card numbers, and SSNs are masked at capture and never
committed.

In external/encrypted mode, flow values and credentials are stored through the WebUI secret backend and
reported only as opaque refs such as `aqa-secret://<tenant>/flow-values/<name>` or
`aqa-secret://<tenant>/credential/<name>`. WebUI reads expose token/key presence metadata only; raw
secret bytes require the runner secret-broker purpose and are not returned by normal API summaries.

## Assert Kinds

- `url`: URL glob or substring match.
- `text`: visible text must appear.
- `value`: selector value assertion.
- `visible`: selector must be visible.
- `count`: selector count must equal `n`.
- `absent`: selector must be absent.
