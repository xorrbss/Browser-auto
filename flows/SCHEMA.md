# flows/*.flow.json schema

The OPTIONAL declarative twin of a `tests/*.test.sh`. Produced by `bin/probe-record.sh`
(AI authoring) or hand-written. The `.test.sh` is the runnable source of truth; the
`.flow.json` is a diff-able / machine-generatable mirror.

**Hard rule: NO `@eN` ref field exists in this schema.** Refs go stale on any page
change, so by omitting the field entirely, a stale-ref bug is impossible by
construction. Every step targets an element by a *semantic locator* only.

```jsonc
{
  "name": "checkout",                    // matches tests/<name>.test.sh
  "app": "myapp",                        // optional; if set, test starts with AB_AUTH <app>
  "startUrl": "https://app.example.com/cart",
  "steps": [
    // interaction step — semantic locator only
    { "kind": "find", "by": "text",  "value": "Checkout", "action": "click" },
    { "kind": "wait", "until": "url", "value": "**/payment" },
    { "kind": "find", "by": "label", "value": "Card number", "action": "fill", "text": "4111111111111111" },
    { "kind": "find", "by": "role",  "value": "button", "name": "Pay", "action": "click" },
    { "kind": "wait", "until": "text", "value": "Order confirmed" }
  ],
  "asserts": [
    { "kind": "url",  "value": "**/receipt" },
    { "kind": "text", "value": "Order #" }
  ]
}
```

## Step kinds

- `find`  — `by` ∈ {testid,role,label,text,placeholder,alt,title}, `value`, `action`
  (click|fill|type|select|check|uncheck|hover), optional `name` (for role), `text`/`val`
  (for fill/type/select). `check` is the ABSOLUTE set capture emits for a native checkbox/radio that
  ends checked (vs a toggling `click`, which would false-green when the page's initial state differs).
  `uncheck` is in the schema but capture does NOT emit it — agent-browser 0.27.0 `uncheck` is broken
  (returns success=false), so a checkbox-uncheck stays a `click` (a hand-written `uncheck` step would
  fail at replay). Locator priority when AI-authored:
  **testid > role+name > label > exact-text > placeholder > title** (most stable first).
  Uniqueness is verified **in-page** at capture time (mirroring how replay `find` matches);
  host-side `get count` is CSS-only and CANNOT count semantic locators, so it serves only
  as a redundant cross-check for the testid CSS-equivalent `[data-testid="v"]`.
- `wait`  — `until` ∈ {url,text,load}, `value`. URL globs are normalized to `**/<stable-path>`
  (query/fragment stripped, volatile path segments → `**`); a wait is emitted only when the
  URL actually changed at that boundary. **Replay note:** a `until:url` step does NOT compile to
  agent-browser `wait --url` — that command is broken for glob patterns on 0.27.0 (it hangs ~34s
  then fails with `os error 10060`; only plain substrings work). Instead `compile` emits a
  `wait_url '<glob>'` call (lib/assert.sh) that polls the reliable `get url` and matches with the
  same logic as `assert_url`. This splits the surrounding `batch` at each url-wait boundary.
  `until:text`/`until:load` waits DO work and stay inline in the batch. Capture also emits an
  inline settle wait (`until:text` on the next step's target, else `until:load networkidle`) when
  a click swaps a large DOM subtree but changes **no** URL (a pure client-side SPA route).
- `scroll` — `dir` ∈ {up,down,left,right}, `px` (positive int). An explicit **PAGE** scroll, captured
  as a coalesced gesture (capture.js debounces `window` scroll; a scrollable container's scroll never
  changes `window.scrollY`, so containers are ignored — they'd need a selector, out of scope). Compiles
  to a standalone `AB scroll <dir> <px>` line (NOT a `batch` command — `batch` rejects `scroll`), so
  like a url-wait it splits the surrounding batch. The scroll runs via the bare `AB` passthrough (no
  `.success` gate) — intentionally, like the bare-`AB` `open` / `record start`: scroll is **best-effort
  setup**, not an assertion. A scroll that no-ops cannot false-green — if the scroll was essential
  (lazy-load) the next step's locator fails (gated), and if it was incidental the run passes correctly. Replay scrolls BY `px` in `dir` from the current
  position, so successive captured deltas compose. Mostly redundant (replay auto-scrolls to each
  element); the real value is **lazy-load / infinite-scroll** journeys where a scroll reveals content
  the next step needs. (`drag` and file `upload` are NOT captured: agent-browser's `drag`/`upload` take
  a CSS selector or stale `@ref` — both forbidden here — and drag targets are usually non-semantic
  `<div>`s with no stable locator. See README "Capture scope & limitations".)

### needs_review (additive field on a `find` step)

When recording finds **no unique stable locator** for an element, the step is emitted with:

- `needs_review` (boolean true) — the step is **non-compilable** until a human/agent resolves it.
- `candidates` (a **non-empty** array of `{by, value, name?, count}`) — the alternatives observed,
  with their in-page match counts. A needs_review step carries **no accepted top-level by/value**.
  The array can hold a **single** candidate when only one alternative exists yet is not auto-acceptable
  as a primary — e.g. an icon-only **link** / native checkbox / `aria-labelledby` control whose lone
  `role+name` the engine won't resolve, or a long (>80-char) exact-text / role-name value (too fragile).
  Non-empty is the only hard invariant. A **`<select multiple>`** is also emitted `needs_review` (even
  with a good locator): `el.value` exposes only the first selected option, so the single-value `select`
  action can't faithfully represent a multi-selection — a human resolves it.

Absent field == false; hand-written flows are unaffected. `compile` **refuses** (exits
non-zero, lists the offending steps) on any `needs_review:true` — never a silent drop, never
a fragile/positional fallback.

**verify-repair (optional, `probe-record.sh verify`).** Because in-page uniqueness is only an
estimate of how the engine's `find` resolves (an open risk), a step can pass capture yet fail at
replay. `verify` re-drives the flow and, for each `find` step, non-destructively probes the
locator (`find … hover`); if it no longer resolves it **repairs** the step from the captured
candidate ladder or **promotes** it to `needs_review`, then rewrites the flow. The ladder lives in
a **gitignored** `flows/<name>.candidates.json` sidecar (per-step `{by, value, name?}` alternates,
written by capture); it is page structure, not PII, and is regenerated on each capture. `verify` also
re-checks each resolved **`testid`** step's uniqueness with `get count` on the CSS-equivalent 4-attr
selector: a testid that now matches **≥2** elements is promoted to `needs_review` (replay's `find` would
silently act on the first), while `0`/`1` is accepted (`0` = inconclusive, e.g. shadow DOM — never a
false RED). Non-`testid` locators have no replay-count primitive on 0.27.0, so verify's verdict states
that their uniqueness remains a capture-time estimate.

### Replay fallback (opt-in, `replayFallback: true`)

An OPTIONAL top-level boolean. **Absent/false (the default) ⇒ compile output is byte-identical to
not having the feature** — existing flows are unaffected by construction. When `true`, `compile`
bakes a per-step *fallback ladder* into each RESOLVED `find` step of the generated test: at replay,
if the step's primary locator fails, it retries down capture-time-UNIQUE sibling candidates (from the
gitignored `<name>.candidates.json` sidecar) instead of immediately going red. This reduces FLAKE on
healthy journeys; it is **not** a `needs_review` reducer (a `needs_review` step has no auto-acceptable
primary, and the fallback filter below excludes `role` and any non-unique candidate, so a needs_review
step's leftover candidates — e.g. an icon-only link's lone `role+name` — are never usable as a
fallback; `compile` still refuses such a step).

- **Eligibility** (a fallback may only ever be as strong as the primary it replaces): a sibling
  candidate is used only if `count == 1` at capture, value ≤ 80 chars and name ≤ 80 chars (not
  overLong), `by != "role"` (role+name is unreliable on 0.27.0), and it is not the primary itself.
- **Loud on use**: when a fallback actually fires at replay, the test prints a `⚠ FALLBACK` line to
  stderr naming the failed primary and the substituted locator — a fallback is never silent.
- **Fail-loud at compile**: `replayFallback: true` requires a non-stale candidates sidecar
  (`._steps` must equal the flow's step count, the same guard `verify` uses); otherwise `compile`
  refuses rather than silently downgrading. The compiled `.test.sh` is self-contained (the sidecar is
  only an authoring-time input — it is not needed at run time).
- **Residual risk (inherent, documented)**: `cardinality ≠ identity` — a candidate that was unique at
  capture can resolve to a *different* single element at replay if the page drifts, so a fallback
  could act on the wrong element (a false-green). 0.27.0 has no semantic-count primitive at replay to
  re-verify uniqueness, so this is mitigated, not eliminated, by the count==1 bar + non-role filter +
  opt-in + the loud log + the flow's own downstream steps/asserts. **Leave it off unless a flow is
  flaky enough to need it**, and review runs where the `⚠ FALLBACK` line appears.

### Parameterized input values (flows/*.flow.json is git-committed)

`fill`/`type`/`select` steps store **`{{input_N}}` tokens**, never the literal value, in the
committed flow.json. A **`contenteditable`** element is captured as a `fill` step too — its text is
read from `textContent` (it has no `.value`) and replays via `find … fill`. Real values live in a **gitignored** `flows/<name>.values.json` sidecar
(`{"input_1":"user@example.com", ...}`), mirroring auth-state handling. `compile`/run
substitute tokens from the sidecar at runtime (fail-loud if a referenced key is missing).
Sensitive fields (password / OTP / card / SSN — by type/autocomplete/inputmode heuristics)
are **masked at capture** and never recorded at all.

## Assert kinds (map 1:1 to lib/assert.sh)

- `url` → assert_url · `text` → assert_text · `value` → assert_value (needs `selector`)
- `visible` → assert_visible (needs `selector`) · `count` → assert_count (needs `selector`,`n`)
- `absent` → assert_absent (needs `selector`)
