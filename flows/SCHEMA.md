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

### Legacy migration

Older flows may declare `"engine": "agent-browser"`. Treat those as legacy. Omitted `engine` now
defaults to Playwright. To migrate an explicit legacy flow, set `"engine": "playwright"`, refresh auth
with `bash setup/auth.sh <app> <login-url> '<success-url>'`, run
`node bin/play-flow.mjs --flow flows/<name>.flow.json --validate-only`, then verify and compile.
Keep an explicit legacy engine only as a migration marker for flows that cannot be migrated yet.

## Top-Level Fields

- `name`: required; matches `tests/<name>.test.sh`.
- `engine`: required for new work; use `"playwright"`.
- `app`: optional; when set, Playwright replay loads `fixtures/auth/playwright/<app>.state.json`.
- `startUrl`: required; first URL opened by replay.
- `steps`: required array; interaction and wait sequence.
- `asserts`: optional array; final assertions.
- `replayFallback`: optional boolean; default `false`.
- `irreversibleAt`: optional integer step index for audited point-of-no-return gates.
- `reversible`: optional boolean override for effectful-flow gating.

## Step Kinds

- `find`: element interaction.
  - `by`: one of `testid`, `role`, `label`, `text`, `placeholder`, `alt`, `title`.
  - `value`: locator value.
  - `name`: optional accessible name for `role`.
  - `action`: one of `click`, `fill`, `type`, `select`, `check`, `uncheck`, `hover`.
  - `text` / `val`: value for `fill`, `type`, or `select`.
  - `frame`: optional same-origin iframe scope.
- `wait`: deterministic settling gate.
  - `until`: one of `url`, `text`, `load`.
  - `value`: URL glob/text/load state as appropriate.
- `scroll`: page scroll captured as `{ "dir": "up|down|left|right", "px": 300 }`.
- `press`: non-text keyboard action, such as `Enter`, `Escape`, `Tab`, or arrow keys.
- `open_record`: recipe-driven dynamic row open for RPA/detail flows.

Locator priority when authoring: **testid > role+name > label > exact-text > placeholder > title**.
Uniqueness is checked during capture/verification; a non-unique or fragile target must become
`needs_review` instead of a guessed selector.

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

## Replay Fallback

`"replayFallback": true` lets compile use the gitignored candidates sidecar as a loud fallback ladder
when a primary locator fails. Leave it off by default. A fallback can reduce flake, but it cannot prove
identity after page drift; downstream waits/assertions still carry the correctness burden.

## Parameterized Values

Committed flows store `{{input_N}}` tokens rather than literal field values. Real values live in the
gitignored `flows/<name>.values.json` sidecar:

```json
{ "input_1": "4111111111111111" }
```

Sensitive fields such as passwords, OTPs, card numbers, and SSNs are masked at capture and never
committed.

## Assert Kinds

- `url`: URL glob or substring match.
- `text`: visible text must appear.
- `value`: selector value assertion.
- `visible`: selector must be visible.
- `count`: selector count must equal `n`.
- `absent`: selector must be absent.
