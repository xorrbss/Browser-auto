#!/usr/bin/env bash
# tests/build-flow-unit.test.sh — fast, browser-free unit test for bin/build-flow.js and the
# compile needs_review guard. Feeds a fixed synthetic record stream (the bin/capture.js output
# shape) and asserts the produced flow.json + values.json: testid/label locators, {{input_N}}
# tokenization, sensitive masking (password value never written), select val token, Enter press,
# navigation wait-gate + URL-glob normalization, needs_review (>=2 candidates, no accepted
# locator), trailing url assert, and that NO @eN ref or raw value leaks into the committed flow.
# Also asserts `compile` REFUSES (exit !=0) a flow containing a needs_review step. Deterministic;
# uses a temp flowsDir so it never pollutes flows/ or tests/.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail(){ echo "  ✗ build-flow-unit: $1" >&2; exit 1; }
eq(){ [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
REC="$TMP/records.json"; FLOWS="$TMP/flows"; mkdir -p "$FLOWS"

cat > "$REC" <<'JSON'
[
 {"seq":1,"action_type":"click","url_at_capture":"https://app.example.com/cart","primary":{"by":"testid","value":"checkout-btn"},"candidates":[{"by":"testid","value":"checkout-btn","count":1},{"by":"text","value":"Checkout","count":1}],"is_navigation_boundary":false},
 {"seq":2,"action_type":"navigate","url_at_capture":"https://app.example.com/cart","from":"https://app.example.com/cart","primary":null,"candidates":[],"is_navigation_boundary":true},
 {"seq":3,"action_type":"input","url_at_capture":"https://app.example.com/checkout/42","primary":{"by":"label","value":"Email"},"candidates":[{"by":"label","value":"Email","count":1}],"input_value":"a@b.com","is_navigation_boundary":false},
 {"seq":4,"action_type":"input","url_at_capture":"https://app.example.com/checkout/42","primary":{"by":"label","value":"Password"},"candidates":[{"by":"label","value":"Password","count":1}],"input_value":null,"masked":true,"is_navigation_boundary":false},
 {"seq":5,"action_type":"select","url_at_capture":"https://app.example.com/checkout/42","primary":{"by":"label","value":"Country"},"candidates":[{"by":"label","value":"Country","count":1}],"input_value":"US","select_text":"United States","is_navigation_boundary":false},
 {"seq":6,"action_type":"key","url_at_capture":"https://app.example.com/checkout/42","primary":null,"candidates":[],"input_value":"Enter","is_navigation_boundary":false},
 {"seq":7,"action_type":"click","url_at_capture":"https://app.example.com/checkout/42","primary":null,"insufficient":true,"candidates":[{"by":"text","value":"Edit","count":3},{"by":"role","value":"button","count":3}],"is_navigation_boundary":false}
]
JSON

node "$DIR/bin/build-flow.js" uflow "https://app.example.com/cart" "" "$REC" "$FLOWS" 2>/dev/null \
	|| fail "build-flow.js exited non-zero"
FLOW="$FLOWS/uflow.flow.json"; VALUES="$FLOWS/uflow.values.json"
[ -s "$FLOW" ] || fail "no flow.json produced"

# 1. click -> testid find
eq "$(jq -rc '.steps[0]|[.kind,.by,.value,.action]' "$FLOW")" '["find","testid","checkout-btn","click"]' "step0 click"
# 2. navigation boundary -> url wait, glob-normalized (volatile /42 -> **)
eq "$(jq -rc '.steps[1]|[.kind,.until,.value]' "$FLOW")" '["wait","url","**/checkout/**"]' "step1 wait"
# 3. email input -> fill with token (NOT the literal value)
eq "$(jq -r '.steps[2].text' "$FLOW")" '{{input_1}}' "step2 email token"
eq "$(jq -r '.steps[2].by' "$FLOW")" 'label' "step2 by"
# 4. masked password -> still tokenized, value NEVER in flow or values
eq "$(jq -r '.steps[3].text' "$FLOW")" '{{input_2}}' "step3 password token"
# 5. select -> val token, action select
eq "$(jq -rc '.steps[4]|[.action,.val]' "$FLOW")" '["select","{{input_3}}"]' "step4 select"
# 6. Enter key -> press
eq "$(jq -rc '.steps[5]|[.kind,.value]' "$FLOW")" '["press","Enter"]' "step5 press"
# 7. no unique locator -> needs_review with >=2 candidates and NO accepted by/value
eq "$(jq -r '.steps[6].needs_review' "$FLOW")" 'true' "step6 needs_review"
[ "$(jq -r '.steps[6].candidates|length' "$FLOW")" -ge 2 ] || fail "step6 needs >=2 candidates"
eq "$(jq -r '.steps[6]|has("by") or has("value")' "$FLOW")" 'false' "step6 must carry no accepted locator"
# 8. trailing url assert from last settled URL (glob-normalized)
eq "$(jq -rc '.asserts[0]|[.kind,.value]' "$FLOW")" '["url","**/checkout/**"]' "trailing url assert"

# 9. no @eN refs, no raw value leak into the committed flow.json (values live in the sidecar)
if grep -q '@e[0-9]' "$FLOW"; then fail "flow.json contains a forbidden @eN ref"; fi
if grep -qF 'a@b.com' "$FLOW"; then fail "flow.json leaks the raw email value (must be tokenized)"; fi
if grep -qF '"US"' "$FLOW"; then fail "flow.json leaks the raw select value (must be tokenized)"; fi
# 10. values sidecar: real non-sensitive values present; masked password key absent
[ -s "$VALUES" ] || fail "no values.json sidecar produced"
eq "$(jq -r '.input_1' "$VALUES")" 'a@b.com' "values input_1"
eq "$(jq -r '.input_3' "$VALUES")" 'US' "values input_3"
eq "$(jq -r 'has("input_2")' "$VALUES")" 'false' "masked password value must NOT be in values.json"

# 11. candidates sidecar (verify-repair ladder): nested {_steps, byStep}, per-step entries carry
#     `count` (so verify only repairs to a capture-time-unique candidate), keyed by flow step index.
CAND="$FLOWS/uflow.candidates.json"
[ -s "$CAND" ] || fail "no candidates.json sidecar produced"
eq "$(jq -r '._steps' "$CAND")" "$(jq -r '.steps|length' "$FLOW")" "candidates _steps matches flow step count"
eq "$(jq -rc '.byStep["0"][0]|[.by,.value,.count]' "$CAND")" '["testid","checkout-btn",1]' "step0 ladder entry carries count"
eq "$(jq -r '.byStep|has("6")' "$CAND")" 'true' "needs_review step (#6) also has a ladder"

# 12. compile must REFUSE a flow with a needs_review step (exit non-zero, no test written)
if bash "$DIR/bin/probe-record.sh" compile "$FLOW" >/dev/null 2>&1; then
	fail "compile accepted a needs_review flow (must refuse)"
fi

echo "  ✓ build-flow-unit.test.sh passed"
