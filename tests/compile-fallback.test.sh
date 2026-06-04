#!/usr/bin/env bash
# tests/compile-fallback.test.sh — fast, browser-free unit for the OPT-IN replay-fallback compile
# path (flow.replayFallback). Feeds a synthetic record stream through build-flow.js to get a flow +
# candidates sidecar, then asserts `compile`:
#   - BYTE-IDENTITY: with the flag absent vs replayFallback:false, the compiled test is byte-for-byte
#     identical (the feature's central safety invariant — the flag gates the helper block and changes
#     nothing when off). (The stronger "identical to the pre-feature compiler" was a one-time manual
#     check — recompiling the committed flows produced zero git diff — recorded in the plan doc.)
#   - emits a `_find_fb '<b64>'` per resolved find step that HAS an eligible fallback, baking the
#     primary first then ONLY capture-time-UNIQUE (count==1), non-overLong (<=80c), engine-supported
#     (not role), non-primary sibling candidates — with the step's action/--exact/token propagated;
#   - FAILS LOUD (naming the reason) when replayFallback is set but the sidecar is stale/missing;
#   - compiles cleanly (no _find_fb, with a NOTE) when no step has a usable fallback.
# The framework's core promise is "never a false green": a fallback may only ever be a candidate that
# was UNIQUE at capture, so it is never weaker than the primary it stands in for.
# Deterministic; uses PID-namespaced _cfb_*_$$ names in flows/ + tests/, cleaned by an EXIT trap.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail(){ echo "  ✗ compile-fallback: $1" >&2; exit 1; }
eq(){ [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }

PR="bin/probe-record.sh"; BF="bin/build-flow.js"
B="_cfb_basic_$$"; N="_cfb_none_$$"; R="_cfb_role_$$"   # PID-namespaced so concurrent runs never collide
NAMES="$B $N $R"
cleanup(){ for n in $NAMES; do rm -f "$DIR/flows/$n.flow.json" "$DIR/flows/$n.candidates.json" "$DIR/flows/$n.values.json" "$DIR/tests/$n.test.sh"; done; }
trap cleanup EXIT
cleanup   # start clean

# fb_payload <test-file> <occurrence-1based> -> decoded JSON of the Nth `_find_fb '<b64>'` line.
fb_payload(){ grep -oE "_find_fb '[^']+'" "$1" | sed -n "${2}p" | sed "s/^_find_fb '//; s/'$//" | base64 -d | jq -c .; }

# --- 1. build a clean (no needs_review) flow + sidecar from synthetic records ---
# step0 click: primary testid:save-btn; ladder carries an ELIGIBLE fallback (text:Save count1) plus
#   three INELIGIBLE siblings: text:Edit count3 (ambiguous), role:button/Save (engine-unreliable),
#   and an >80-char text (too fragile). step1 fill: primary label:Email; eligible fallback
#   placeholder:you@x.com — to prove action(fill)+token({{input_1}})+--exact propagate to fallbacks.
REC="$(mktemp)"
cat > "$REC" <<'JSON'
[
 {"seq":1,"action_type":"click","url_at_capture":"https://app.example.com/x","primary":{"by":"testid","value":"save-btn"},"candidates":[{"by":"testid","value":"save-btn","count":1},{"by":"text","value":"Save","count":1},{"by":"text","value":"Edit","count":3},{"by":"role","value":"button","name":"Save","count":1},{"by":"text","value":"This is a very long label that definitely exceeds the eighty character limit for sure ok","count":1}],"is_navigation_boundary":false},
 {"seq":2,"action_type":"input","url_at_capture":"https://app.example.com/x","primary":{"by":"label","value":"Email"},"candidates":[{"by":"label","value":"Email","count":1},{"by":"placeholder","value":"you@x.com","count":1}],"input_value":"a@b.com","is_navigation_boundary":false}
]
JSON
node "$DIR/$BF" "$B" "https://app.example.com/x" "" "$REC" "$DIR/flows" 2>/dev/null \
	|| fail "build-flow.js exited non-zero"
rm -f "$REC"
FLOW="$DIR/flows/$B.flow.json"; T="$DIR/tests/$B.test.sh"
[ -s "$FLOW" ] || fail "no flow.json produced"
[ -s "$DIR/flows/$B.candidates.json" ] || fail "no candidates sidecar produced"
eq "$(jq -r '[.steps[]|select(.needs_review==true)]|length' "$FLOW")" '0' "flow has no needs_review"

# --- 2. compile WITHOUT the flag -> off-path: _run_batch, NO _find_fb. Snapshot for byte-identity. ---
bash "$DIR/$PR" compile "$FLOW" >/dev/null 2>&1 || fail "off-path compile failed"
[ -s "$T" ] || fail "off-path produced no test"
grep -q '_run_batch' "$T"        || fail "off-path: expected _run_batch"
if grep -qE '^_find_fb ' "$T"; then fail "off-path: must NOT contain a _find_fb call without the flag"; fi
SNAP="$(mktemp)"; cp "$T" "$SNAP"

# --- 2b. BYTE-IDENTITY guard: replayFallback:false must compile byte-for-byte identically to absent. ---
tmp="$(mktemp)"; jq '. + {replayFallback:false}' "$FLOW" > "$tmp" && mv "$tmp" "$FLOW"
bash "$DIR/$PR" compile "$FLOW" >/dev/null 2>&1 || fail "replayFallback:false compile failed"
cmp -s "$SNAP" "$T" || { diff "$SNAP" "$T" | sed 's/^/    /' >&2; fail "replayFallback:false output differs from absent (off-path NOT byte-identical)"; }
rm -f "$SNAP"

# --- 3. opt in (replayFallback:true) and recompile -> _find_fb per step, filtered ladder ---
tmp="$(mktemp)"; jq '.replayFallback=true' "$FLOW" > "$tmp" && mv "$tmp" "$FLOW"
bash "$DIR/$PR" compile "$FLOW" >/dev/null 2>&1 || fail "fallback compile failed"
# anchor to column 0 so a COMMENT mentioning "_run_batch"/"_find_fb" can't false-match a call.
eq "$(grep -cE '^_find_fb ' "$T" 2>/dev/null || echo 0)" '2' "two _find_fb steps emitted"
if grep -qE '^_run_batch ' "$T"; then fail "fallback path: both finds should be _find_fb, no _run_batch"; fi
grep -q '_VALUES_JSON=' "$T" || fail "values block must be defined when _find_fb present"

# step0 payload: primary testid then ONLY the count==1 text fallback (with --exact), nothing else.
eq "$(fb_payload "$T" 1)" \
	'[["find","testid","save-btn","click"],["find","text","Save","click","--exact"]]' \
	"step0 fallback payload (primary + unique text only)"
# the three ineligible siblings must be ABSENT from the baked step0 ladder.
P0="$(fb_payload "$T" 1)"
case "$P0" in *Edit*)   fail "count>1 'Edit' candidate leaked into the fallback ladder" ;; esac
case "$P0" in *role*)   fail "role candidate (engine-unreliable) leaked into the fallback ladder" ;; esac
case "$P0" in *eighty*) fail "overLong (>80c) candidate leaked into the fallback ladder" ;; esac

# step1 payload: action(fill) + token({{input_1}}) + --exact propagate to the placeholder fallback.
eq "$(fb_payload "$T" 2)" \
	'[["find","label","Email","fill","{{input_1}}","--exact"],["find","placeholder","you@x.com","fill","{{input_1}}","--exact"]]' \
	"step1 fallback payload (fill action + token propagate)"

# --- 4. FAIL LOUD (naming the reason) when replayFallback is set but the sidecar is stale ---
CAND="$DIR/flows/$B.candidates.json"
tmp="$(mktemp)"; jq '._steps = 99' "$CAND" > "$tmp" && mv "$tmp" "$CAND"
out4="$(bash "$DIR/$PR" compile "$FLOW" 2>&1)" && fail "compile accepted a STALE candidates sidecar (must refuse)" || true
case "$out4" in *"sidecar stale"*) : ;; *) fail "stale-sidecar refusal must name the reason ('sidecar stale'); got: $out4" ;; esac

# --- 5. replayFallback set but NO eligible fallback anywhere -> clean compile, NOTE, no _find_fb ---
# Single step whose only candidate IS the primary (nothing left after filtering).
REC2="$(mktemp)"
cat > "$REC2" <<'JSON'
[
 {"seq":1,"action_type":"click","url_at_capture":"https://app.example.com/y","primary":{"by":"testid","value":"only-btn"},"candidates":[{"by":"testid","value":"only-btn","count":1}],"is_navigation_boundary":false}
]
JSON
node "$DIR/$BF" "$N" "https://app.example.com/y" "" "$REC2" "$DIR/flows" 2>/dev/null \
	|| fail "build-flow.js exited non-zero (none case)"
rm -f "$REC2"
FLOW2="$DIR/flows/$N.flow.json"; T2="$DIR/tests/$N.test.sh"
tmp="$(mktemp)"; jq '. + {replayFallback:true}' "$FLOW2" > "$tmp" && mv "$tmp" "$FLOW2"
note="$(bash "$DIR/$PR" compile "$FLOW2" 2>&1)" || fail "no-eligible-fallback compile should still succeed"
if grep -qE '^_find_fb ' "$T2"; then fail "no-eligible case must not emit a _find_fb call"; fi
grep -q '_run_batch' "$T2" || fail "no-eligible case should fall back to a normal _run_batch"
case "$note" in *"no step had a usable"*) : ;; *) fail "expected a NOTE that no usable fallback candidate was found" ;; esac

# --- 6. compile MUST bake --exact for a `role` primary (the icon-only fix). agent-browser 0.27.0
#     `find role --name` is a SUBSTRING match without --exact, so the flag is what makes the
#     capture-time exact count==1 agree with the engine. This guards probe-record.sh's role->--exact
#     regex specifically (compile-fallback's other cases only cover text/label/placeholder). ---
RFLOW="$DIR/flows/$R.flow.json"
printf '%s\n' "{\"name\":\"$R\",\"startUrl\":\"https://app.example.com/z\",\"steps\":[{\"kind\":\"find\",\"by\":\"role\",\"value\":\"button\",\"name\":\"Close panel\",\"action\":\"click\"}],\"asserts\":[]}" > "$RFLOW"
bash "$DIR/$PR" compile "$RFLOW" >/dev/null 2>&1 || fail "role-primary flow compile failed"
RT="$DIR/tests/$R.test.sh"
RCMD="$(grep -E "^_run_batch '" "$RT" | sed "s/^_run_batch '//; s/'$//" | base64 -d | jq -c '.[0]')"
eq "$RCMD" '["find","role","button","click","--name","Close panel","--exact"]' "compile bakes --exact for a role primary"

echo "  ✓ compile-fallback.test.sh passed"
