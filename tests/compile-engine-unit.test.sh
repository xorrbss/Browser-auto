#!/usr/bin/env bash
# Browser-free unit tests for flow.engine compile/play dispatch.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail(){ echo "  compile-engine-unit: $1" >&2; exit 1; }
assert_no_bom(){
	local file="$1" sig
	sig="$(head -c 3 "$file" | od -An -tx1 | tr -d ' \n')"
	[ "$sig" != "efbbbf" ] || fail "$file starts with a UTF-8 BOM"
}

PW="_eng_pw_frame_$$"
PWOPEN="_eng_pw_open_record_$$"
OMIT="_eng_pw_omit_$$"
LEGACY="_eng_legacy_$$"
VAL="_eng_pw_values_$$"
RECIPE="_eng_recipe_$$"
NAMES="$PW $PWOPEN $OMIT $LEGACY $VAL"
cleanup(){ for n in $NAMES; do rm -f "$DIR/flows/$n.flow.json" "$DIR/flows/$n.values.json" "$DIR/tests/$n.test.sh"; done; rm -f "$DIR/recipes/$RECIPE.json"; }
trap cleanup EXIT
cleanup

cat > "$DIR/flows/$PW.flow.json" <<JSON
{"name":"$PW","engine":"playwright","environment":"staging","riskClass":"read","startUrl":"https://example.test","steps":[{"kind":"find","by":"role","value":"button","name":"Go","action":"click","frame":{"by":"id","value":"f"}}],"asserts":[]}
JSON
bash "$DIR/bin/probe-record.sh" compile "$DIR/flows/$PW.flow.json" >/dev/null 2>&1 || fail "playwright flow compile failed"
grep -q 'bin/play-flow.mjs' "$DIR/tests/$PW.test.sh" || fail "playwright compile did not emit play-flow wrapper"
assert_no_bom "$DIR/tests/$PW.test.sh"
if grep -q 'lib/env.sh' "$DIR/tests/$PW.test.sh"; then fail "playwright wrapper must not source agent-browser env"; fi
if grep -Eq '\bAB(_AUTH|_JSON|X)?\b|BATCH|wait_url|record start' "$DIR/tests/$PW.test.sh"; then fail "playwright wrapper leaked legacy agent-browser commands"; fi
bash -n "$DIR/tests/$PW.test.sh" || fail "playwright wrapper bash syntax invalid"

cat > "$DIR/flows/$OMIT.flow.json" <<JSON
{"name":"$OMIT","environment":"staging","riskClass":"read","startUrl":"https://example.test","steps":[{"kind":"find","by":"text","value":"Example Domain","action":"hover"}],"asserts":[]}
JSON
bash "$DIR/bin/probe-record.sh" compile "$DIR/flows/$OMIT.flow.json" >/dev/null 2>&1 || fail "omitted flow.engine should compile as playwright"
grep -q 'bin/play-flow.mjs' "$DIR/tests/$OMIT.test.sh" || fail "omitted engine compile did not emit play-flow wrapper"

cat > "$DIR/flows/$LEGACY.flow.json" <<JSON
{"name":"$LEGACY","engine":"agent-browser","environment":"staging","riskClass":"read","startUrl":"https://example.test","steps":[{"kind":"find","by":"text","value":"Example Domain","action":"hover"}],"asserts":[]}
JSON
if bash "$DIR/bin/probe-record.sh" compile "$DIR/flows/$LEGACY.flow.json" >/tmp/aqa-eng-legacy.out 2>&1; then
	fail "legacy agent-browser flow compiled"
fi
grep -q 'legacy' /tmp/aqa-eng-legacy.out || fail "legacy refusal should include migration hint"

cat > "$DIR/recipes/$RECIPE.json" <<JSON
{"collection":{"name":"Tickets"},"key":"id","columns":{"id":"id","subject":"subject"}}
JSON
cat > "$DIR/flows/$PWOPEN.flow.json" <<JSON
{"name":"$PWOPEN","engine":"playwright","environment":"staging","riskClass":"read","startUrl":"https://example.test","steps":[{"kind":"open_record","source":"row_index","recipe":"$RECIPE","rowIndex":1}],"asserts":[]}
JSON
bash "$DIR/bin/probe-record.sh" compile "$DIR/flows/$PWOPEN.flow.json" >/dev/null 2>&1 || fail "playwright open_record flow compile failed"
node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$PWOPEN.flow.json" --validate-only >/dev/null 2>&1 || fail "play-flow validate-only rejected open_record flow"

cat > "$DIR/flows/$VAL.flow.json" <<JSON
{"name":"$VAL","engine":"playwright","environment":"staging","riskClass":"read","startUrl":"https://example.test","steps":[{"kind":"find","by":"label","value":"Email","action":"fill","text":"{{input_1}}"}],"asserts":[]}
JSON
if node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$VAL.flow.json" --validate-only >/tmp/aqa-eng-val.out 2>&1; then
	fail "play-flow validate-only accepted missing values sidecar"
fi
grep -q 'missing value input_1' /tmp/aqa-eng-val.out || fail "missing value error should name token"
printf '%s\n' '{"input_1":"a@example.test"}' > "$DIR/flows/$VAL.values.json"
node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$VAL.flow.json" --validate-only >/dev/null 2>&1 || fail "play-flow validate-only rejected valid playwright flow"

echo "  compile-engine-unit: all checks passed"
