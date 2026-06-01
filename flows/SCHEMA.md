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
  **testid > role+name > label > exact-text > placeholder > title** (most stable first),
  each verified unique via `get count --json == 1` before being accepted.
- `wait`  — `until` ∈ {url,text,load}, `value`.

## Assert kinds (map 1:1 to lib/assert.sh)

- `url` → assert_url · `text` → assert_text · `value` → assert_value (needs `selector`)
- `visible` → assert_visible (needs `selector`) · `count` → assert_count (needs `selector`,`n`)
- `absent` → assert_absent (needs `selector`)
