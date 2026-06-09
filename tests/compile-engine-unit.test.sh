#!/usr/bin/env bash
# Browser-free unit tests for flow.engine compile/play dispatch.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail(){ echo "  compile-engine-unit: $1" >&2; exit 1; }

AB="_eng_ab_frame_$$"
PW="_eng_pw_frame_$$"
VAL="_eng_pw_values_$$"
OLD="_eng_old_$$"
NAMES="$AB $PW $VAL $OLD"
cleanup(){ for n in $NAMES; do rm -f "$DIR/flows/$n.flow.json" "$DIR/flows/$n.values.json" "$DIR/tests/$n.test.sh"; done; }
trap cleanup EXIT
cleanup

cat > "$DIR/flows/$AB.flow.json" <<JSON
{"name":"$AB","startUrl":"https://example.test","steps":[{"kind":"find","by":"role","value":"button","name":"Go","action":"click","frame":{"by":"id","value":"f"}}],"asserts":[]}
JSON
if bash "$DIR/bin/probe-record.sh" compile "$DIR/flows/$AB.flow.json" >/tmp/aqa-eng-ab.out 2>&1; then
	fail "agent-browser default flow with frame compiled (must fail closed)"
fi
grep -q 'iframe' /tmp/aqa-eng-ab.out || fail "agent-browser frame refusal should name iframe"

cat > "$DIR/flows/$PW.flow.json" <<JSON
{"name":"$PW","engine":"playwright","startUrl":"https://example.test","steps":[{"kind":"find","by":"role","value":"button","name":"Go","action":"click","frame":{"by":"id","value":"f"}}],"asserts":[]}
JSON
bash "$DIR/bin/probe-record.sh" compile "$DIR/flows/$PW.flow.json" >/dev/null 2>&1 || fail "playwright flow compile failed"
grep -q 'bin/play-flow.mjs' "$DIR/tests/$PW.test.sh" || fail "playwright compile did not emit play-flow wrapper"
if grep -q 'lib/env.sh' "$DIR/tests/$PW.test.sh"; then fail "playwright wrapper must not source agent-browser env"; fi
bash -n "$DIR/tests/$PW.test.sh" || fail "playwright wrapper bash syntax invalid"

cat > "$DIR/flows/$OLD.flow.json" <<JSON
{"name":"$OLD","startUrl":"https://example.test","steps":[{"kind":"find","by":"text","value":"Example Domain","action":"hover"}],"asserts":[]}
JSON
if node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$OLD.flow.json" --validate-only >/tmp/aqa-eng-old.out 2>&1; then
	fail "play-flow accepted an agent-browser/default flow"
fi
grep -q 'flow.engine' /tmp/aqa-eng-old.out || fail "play-flow mismatch should name flow.engine"

cat > "$DIR/flows/$VAL.flow.json" <<JSON
{"name":"$VAL","engine":"playwright","startUrl":"https://example.test","steps":[{"kind":"find","by":"label","value":"Email","action":"fill","text":"{{input_1}}"}],"asserts":[]}
JSON
if node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$VAL.flow.json" --validate-only >/tmp/aqa-eng-val.out 2>&1; then
	fail "play-flow validate-only accepted missing values sidecar"
fi
grep -q 'missing value input_1' /tmp/aqa-eng-val.out || fail "missing value error should name token"
printf '%s\n' '{"input_1":"a@example.test"}' > "$DIR/flows/$VAL.values.json"
node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$VAL.flow.json" --validate-only >/dev/null 2>&1 || fail "play-flow validate-only rejected valid playwright flow"

echo "  compile-engine-unit: all checks passed"
