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
  (for fill/type/select). Locator priority when AI-authored:
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
  `until:text`/`until:load` waits DO work and stay inline in the batch.

### needs_review (additive field on a `find` step)

When recording finds **no unique stable locator** for an element, the step is emitted with:

- `needs_review` (boolean true) — the step is **non-compilable** until a human/agent resolves it.
- `candidates` (array of ≥2 `{by, value, name?, count}`) — the alternatives observed, with
  their in-page match counts. A needs_review step carries **no accepted top-level by/value**.

Absent field == false; hand-written flows are unaffected. `compile` **refuses** (exits
non-zero, lists the offending steps) on any `needs_review:true` — never a silent drop, never
a fragile/positional fallback.

**verify-repair (optional, `probe-record.sh verify`).** Because in-page uniqueness is only an
estimate of how the engine's `find` resolves (an open risk), a step can pass capture yet fail at
replay. `verify` re-drives the flow and, for each `find` step, non-destructively probes the
locator (`find … hover`); if it no longer resolves it **repairs** the step from the captured
candidate ladder or **promotes** it to `needs_review`, then rewrites the flow. The ladder lives in
a **gitignored** `flows/<name>.candidates.json` sidecar (per-step `{by, value, name?}` alternates,
written by capture); it is page structure, not PII, and is regenerated on each capture.

### Parameterized input values (flows/*.flow.json is git-committed)

`fill`/`type`/`select` steps store **`{{input_N}}` tokens**, never the literal value, in the
committed flow.json. Real values live in a **gitignored** `flows/<name>.values.json` sidecar
(`{"input_1":"user@example.com", ...}`), mirroring auth-state handling. `compile`/run
substitute tokens from the sidecar at runtime (fail-loud if a referenced key is missing).
Sensitive fields (password / OTP / card / SSN — by type/autocomplete/inputmode heuristics)
are **masked at capture** and never recorded at all.

## Assert kinds (map 1:1 to lib/assert.sh)

- `url` → assert_url · `text` → assert_text · `value` → assert_value (needs `selector`)
- `visible` → assert_visible (needs `selector`) · `count` → assert_count (needs `selector`,`n`)
- `absent` → assert_absent (needs `selector`)
