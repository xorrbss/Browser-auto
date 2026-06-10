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
BF_ENGINE="playwright"

cat > "$REC" <<'JSON'
[
 {"seq":1,"action_type":"click","url_at_capture":"https://app.example.com/cart","primary":{"by":"testid","value":"checkout-btn"},"candidates":[{"by":"testid","value":"checkout-btn","count":1},{"by":"text","value":"Checkout","count":1}],"is_navigation_boundary":false},
 {"seq":2,"action_type":"navigate","url_at_capture":"https://app.example.com/cart","from":"https://app.example.com/cart","primary":null,"candidates":[],"is_navigation_boundary":true},
 {"seq":3,"action_type":"input","url_at_capture":"https://app.example.com/checkout/42","primary":{"by":"label","value":"Email"},"candidates":[{"by":"label","value":"Email","count":1}],"input_value":"a@b.com","is_navigation_boundary":false},
 {"seq":4,"action_type":"input","url_at_capture":"https://app.example.com/checkout/42","primary":{"by":"label","value":"Password"},"candidates":[{"by":"label","value":"Password","count":1}],"input_value":null,"masked":true,"is_navigation_boundary":false},
 {"seq":5,"action_type":"input","url_at_capture":"https://app.example.com/checkout/42","primary":{"by":"label","value":"Country"},"candidates":[{"by":"label","value":"Country","count":1}],"input_value":"US","is_navigation_boundary":false},
 {"seq":6,"action_type":"select","url_at_capture":"https://app.example.com/checkout/42","primary":{"by":"label","value":"Country"},"candidates":[{"by":"label","value":"Country","count":1}],"input_value":"US","select_text":"United States","is_navigation_boundary":false},
 {"seq":7,"action_type":"key","url_at_capture":"https://app.example.com/checkout/42","primary":null,"candidates":[],"input_value":"Enter","is_navigation_boundary":false},
 {"seq":8,"action_type":"click","url_at_capture":"https://app.example.com/checkout/42","primary":null,"insufficient":true,"candidates":[{"by":"text","value":"Edit","count":3},{"by":"role","value":"button","count":3}],"is_navigation_boundary":false}
]
JSON

node "$DIR/bin/build-flow.js" uflow "https://app.example.com/cart" "" "$REC" "$FLOWS" "$BF_ENGINE" 2>/dev/null \
	|| fail "build-flow.js exited non-zero"
FLOW="$FLOWS/uflow.flow.json"; VALUES="$FLOWS/uflow.values.json"
[ -s "$FLOW" ] || fail "no flow.json produced"
eq "$(jq -r '.steps|length' "$FLOW")" '7' "duplicate select input is dropped"

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

# 13. dom_settle (C2): a pure DOM-swap marker (click changed the DOM, not the URL) compiles to an
#     explicit settle wait — until:text on the NEXT find's literal text when available, else
#     until:load networkidle. With no URL change anywhere the trailing assert stays on the start path.
REC2="$TMP/records2.json"; FLOWS2="$TMP/flows2"; mkdir -p "$FLOWS2"
cat > "$REC2" <<'JSON'
[
 {"seq":1,"action_type":"click","url_at_capture":"https://app.example.com/dash","primary":{"by":"text","value":"Open"},"candidates":[{"by":"text","value":"Open","count":1}],"is_navigation_boundary":false},
 {"seq":2,"action_type":"dom_settle","url_at_capture":"https://app.example.com/dash","primary":null,"candidates":[],"is_navigation_boundary":false},
 {"seq":3,"action_type":"click","url_at_capture":"https://app.example.com/dash","primary":{"by":"text","value":"Details"},"candidates":[{"by":"text","value":"Details","count":1}],"is_navigation_boundary":false},
 {"seq":4,"action_type":"dom_settle","url_at_capture":"https://app.example.com/dash","primary":null,"candidates":[],"is_navigation_boundary":false}
]
JSON
node "$DIR/bin/build-flow.js" dsflow "https://app.example.com/dash" "" "$REC2" "$FLOWS2" "$BF_ENGINE" 2>/dev/null \
	|| fail "build-flow.js exited non-zero on the dom_settle stream"
FLOW2="$FLOWS2/dsflow.flow.json"
eq "$(jq -rc '.steps[0]|[.kind,.by,.value,.action]' "$FLOW2")" '["find","text","Open","click"]' "ds step0 click"
eq "$(jq -rc '.steps[1]|[.kind,.until,.value]' "$FLOW2")" '["wait","text","Details"]' "ds step1 until:text from next find"
eq "$(jq -rc '.steps[2]|[.kind,.by,.value,.action]' "$FLOW2")" '["find","text","Details","click"]' "ds step2 click"
eq "$(jq -rc '.steps[3]|[.kind,.until,.value]' "$FLOW2")" '["wait","load","networkidle"]' "ds step3 until:load fallback"
eq "$(jq -rc '.asserts[0]|[.kind,.value]' "$FLOW2")" '["url","**/dash"]' "ds trailing url assert (no nav)"
eq "$(jq -r '[.steps[]|select(.needs_review==true)]|length' "$FLOW2")" '0' "ds no needs_review"

# 14. C1 invariant: a needs_review step is NEVER empty even with exactly ONE candidate (the
#     icon-only long-aria-label case — only role+name survives, and it is overLong so primary is
#     null). The ladder must be preserved (1 element, never padded to 2, never dropped to 0).
REC3="$TMP/records3.json"; FLOWS3="$TMP/flows3"; mkdir -p "$FLOWS3"
cat > "$REC3" <<'JSON'
[
 {"seq":1,"action_type":"click","url_at_capture":"https://app.example.com/x","primary":null,"insufficient":true,"candidates":[{"by":"role","value":"button","name":"a very long aria label that exceeds eighty characters so it must stay needs review one","count":1}],"is_navigation_boundary":false}
]
JSON
node "$DIR/bin/build-flow.js" oneflow "https://app.example.com/x" "" "$REC3" "$FLOWS3" "$BF_ENGINE" 2>/dev/null \
	|| fail "build-flow.js exited non-zero on the 1-candidate stream"
FLOW3="$FLOWS3/oneflow.flow.json"
eq "$(jq -r '.steps[0].needs_review' "$FLOW3")" 'true' "1cand needs_review"
eq "$(jq -r '.steps[0].candidates|length' "$FLOW3")" '1' "1cand: exactly one candidate preserved (never empty, never padded)"

# 15. C2 look-ahead must NOT borrow text across a navigate boundary: for click -> dom_settle ->
#     navigate(A->B) -> find(text on B), the dom_settle falls back to until:load (NOT the post-nav
#     text, which would block on the OLD page), and the url-wait gate is emitted AFTER it.
REC4="$TMP/records4.json"; FLOWS4="$TMP/flows4"; mkdir -p "$FLOWS4"
cat > "$REC4" <<'JSON'
[
 {"seq":1,"action_type":"click","url_at_capture":"https://app.example.com/a","primary":{"by":"text","value":"Go"},"candidates":[{"by":"text","value":"Go","count":1}],"is_navigation_boundary":false},
 {"seq":2,"action_type":"dom_settle","url_at_capture":"https://app.example.com/a","primary":null,"candidates":[],"is_navigation_boundary":false},
 {"seq":3,"action_type":"navigate","url_at_capture":"https://app.example.com/a","from":"https://app.example.com/a","primary":null,"candidates":[],"is_navigation_boundary":true},
 {"seq":4,"action_type":"click","url_at_capture":"https://app.example.com/b","primary":{"by":"text","value":"OnPageB"},"candidates":[{"by":"text","value":"OnPageB","count":1}],"is_navigation_boundary":false}
]
JSON
node "$DIR/bin/build-flow.js" navds "https://app.example.com/a" "" "$REC4" "$FLOWS4" "$BF_ENGINE" 2>/dev/null \
	|| fail "build-flow.js exited non-zero on the dom_settle+navigate stream"
FLOW4="$FLOWS4/navds.flow.json"
eq "$(jq -rc '.steps[0]|[.kind,.value,.action]' "$FLOW4")" '["find","Go","click"]' "navds step0 click"
eq "$(jq -rc '.steps[1]|[.kind,.until,.value]' "$FLOW4")" '["wait","load","networkidle"]' "navds dom_settle -> until:load (not post-nav text)"
eq "$(jq -rc '.steps[2]|[.kind,.until,.value]' "$FLOW4")" '["wait","url","**/b"]' "navds url-wait gate AFTER the settle"
eq "$(jq -rc '.steps[3]|[.kind,.value]' "$FLOW4")" '["find","OnPageB"]' "navds step3 find on page B"

# 16. Unglobbable navigation targets (root path or entirely volatile path) still get an explicit
#     deterministic gate: wait:load networkidle, not a silent reliance on the next locator.
REC6="$TMP/records6.json"; FLOWS6="$TMP/flows6"; mkdir -p "$FLOWS6"
cat > "$REC6" <<'JSON'
[
 {"seq":1,"action_type":"click","url_at_capture":"https://app.example.com/a","primary":{"by":"text","value":"Go"},"candidates":[{"by":"text","value":"Go","count":1}],"is_navigation_boundary":false},
 {"seq":2,"action_type":"navigate","url_at_capture":"https://app.example.com/a","from":"https://app.example.com/a","primary":null,"candidates":[],"is_navigation_boundary":true},
 {"seq":3,"action_type":"click","url_at_capture":"https://app.example.com/","primary":{"by":"text","value":"Home"},"candidates":[{"by":"text","value":"Home","count":1}],"is_navigation_boundary":false}
]
JSON
node "$DIR/bin/build-flow.js" rootnav "https://app.example.com/a" "" "$REC6" "$FLOWS6" "$BF_ENGINE" 2>/dev/null \
	|| fail "build-flow.js exited non-zero on the root navigation stream"
FLOW6="$FLOWS6/rootnav.flow.json"
eq "$(jq -rc '.steps[0]|[.kind,.value,.action]' "$FLOW6")" '["find","Go","click"]' "rootnav step0 click"
eq "$(jq -rc '.steps[1]|[.kind,.until,.value]' "$FLOW6")" '["wait","load","networkidle"]' "rootnav unglobbable navigation -> load wait fallback"
eq "$(jq -rc '.steps[2]|[.kind,.value,.action]' "$FLOW6")" '["find","Home","click"]' "rootnav step2 click after fallback wait"
eq "$(jq -r '.asserts|length' "$FLOW6")" '0' "rootnav no useless trailing root-url assert"

# 17. iframe frame locators must be replay-safe before they are committed. Unsafe id/title/src
#     values fall through to a safe name or index; with no safe identity, the action is needs_review.
REC7="$TMP/records7.json"; FLOWS7="$TMP/flows7"; mkdir -p "$FLOWS7"
cat > "$REC7" <<'JSON'
[
 {"seq":1,"action_type":"click","url_at_capture":"https://app.example.com/pay","primary":{"by":"role","value":"button","name":"Pay"},"candidates":[{"by":"role","value":"button","name":"Pay","count":1}],"frame_ref":{"id":"bad\"id","name":"safeFrame","index":0},"is_navigation_boundary":false},
 {"seq":2,"action_type":"click","url_at_capture":"https://app.example.com/pay","primary":{"by":"role","value":"button","name":"Next"},"candidates":[{"by":"role","value":"button","name":"Next","count":1}],"frame_ref":{"id":"bad\"id","index":0},"is_navigation_boundary":false},
 {"seq":3,"action_type":"click","url_at_capture":"https://app.example.com/pay","primary":{"by":"role","value":"button","name":"Bad"},"candidates":[{"by":"role","value":"button","name":"Bad","count":1}],"frame_ref":{"id":"bad\"id"},"is_navigation_boundary":false}
]
JSON
node "$DIR/bin/build-flow.js" frameflow "https://app.example.com/pay" "" "$REC7" "$FLOWS7" "$BF_ENGINE" 2>/dev/null \
	|| fail "build-flow.js exited non-zero on the iframe stream"
FLOW7="$FLOWS7/frameflow.flow.json"
eq "$(jq -rc '.steps[0].frame|[.by,.value]' "$FLOW7")" '["name","safeFrame"]' "iframe unsafe id -> safe name"
eq "$(jq -rc '.steps[1].frame|[.by,.value]' "$FLOW7")" '["index",0]' "iframe unsafe id -> index fallback"
eq "$(jq -r '.steps[2].needs_review' "$FLOW7")" 'true' "iframe with no replay-safe identity -> needs_review"
eq "$(jq -r '.steps[2]|has("frame")' "$FLOW7")" 'false' "unreplayable iframe step carries no invalid frame"

# 18. scroll (#2): a valid page-scroll record -> {kind:scroll,dir,px}; malformed scrolls (bad dir /
#     px<=0) are DROPPED; compile emits only the thin Playwright wrapper, and play-flow validates
#     the scroll step directly.
REC5="$TMP/records5.json"; FLOWS5="$TMP/flows5"; mkdir -p "$FLOWS5"
cat > "$REC5" <<'JSON'
[
 {"seq":1,"action_type":"click","url_at_capture":"https://app.example.com/feed","primary":{"by":"text","value":"Open"},"candidates":[{"by":"text","value":"Open","count":1}],"is_navigation_boundary":false},
 {"seq":2,"action_type":"scroll","dir":"down","px":700,"primary":null,"candidates":[],"is_navigation_boundary":false},
 {"seq":3,"action_type":"scroll","dir":"sideways","px":50,"primary":null,"candidates":[],"is_navigation_boundary":false},
 {"seq":4,"action_type":"scroll","dir":"down","px":0,"primary":null,"candidates":[],"is_navigation_boundary":false},
 {"seq":5,"action_type":"click","url_at_capture":"https://app.example.com/feed","primary":{"by":"text","value":"Loaded"},"candidates":[{"by":"text","value":"Loaded","count":1}],"is_navigation_boundary":false}
]
JSON
node "$DIR/bin/build-flow.js" scflow "https://app.example.com/feed" "" "$REC5" "$FLOWS5" "$BF_ENGINE" 2>/dev/null \
	|| fail "build-flow.js exited non-zero on the scroll stream"
FLOW5="$FLOWS5/scflow.flow.json"
eq "$(jq -r '.steps|length' "$FLOW5")" '3' "scroll: the two malformed records (bad dir / px<=0) dropped"
eq "$(jq -rc '.steps[0]|[.kind,.value,.action]' "$FLOW5")" '["find","Open","click"]' "scroll step0 click"
eq "$(jq -rc '.steps[1]|[.kind,.dir,.px]' "$FLOW5")" '["scroll","down",700]' "scroll step1 -> {kind:scroll,dir:down,px:700}"
eq "$(jq -rc '.steps[2]|[.kind,.value]' "$FLOW5")" '["find","Loaded"]' "scroll step2 click after the dropped scrolls"
SCN="_bfu_scroll_$$"
jq --arg n "$SCN" '.name=$n' "$FLOW5" > "$DIR/flows/$SCN.flow.json"
bash "$DIR/bin/probe-record.sh" compile "$DIR/flows/$SCN.flow.json" >/dev/null 2>&1 || fail "scroll flow compile failed"
grep -q 'bin/play-flow.mjs' "$DIR/tests/$SCN.test.sh" || fail "scroll compile did not emit play-flow wrapper"
if grep -Eq '\bAB(_AUTH|_JSON|X)?\b|BATCH|wait_url|record start' "$DIR/tests/$SCN.test.sh"; then
	fail "scroll wrapper leaked legacy agent-browser commands"
fi
node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$SCN.flow.json" --validate-only >/dev/null 2>&1 || fail "play-flow validate-only rejected scroll flow"
rm -f "$DIR/flows/$SCN.flow.json" "$DIR/flows/$SCN.candidates.json" "$DIR/tests/$SCN.test.sh"

echo "  ✓ build-flow-unit.test.sh passed"
