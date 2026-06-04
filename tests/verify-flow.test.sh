#!/usr/bin/env bash
# tests/verify-flow.test.sh — regression for bin/verify-flow.sh (verify-repair, P2.6).
#
# Deterministic, headless re-drives on example.com covering the repair path AND the fail-loud
# guards an adversarial review added. The framework's core promise is "never a false green": a
# step that resolves but cannot be ACTED on, a NON-UNIQUE candidate, and a PRE-EXISTING
# needs_review must each FAIL the run (non-zero exit) — never report "Safe to compile".
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FL="$DIR/flows"; VF="$DIR/bin/verify-flow.sh"
fail(){ echo "  ✗ verify-flow: $1" >&2; exit 1; }
NAMES="_vrt_repair _vrt_nonuniq _vrt_actfail _vrt_preexist _vrt_testiddup _vrt_testiduniq _vrt_textdup"
cleanup(){ for n in $NAMES; do rm -f "$FL/$n.flow.json" "$FL/$n.candidates.json"; done; rm -f "$DIR/artifacts/_vrt_dupfx.html" "$DIR/artifacts/_vrt_uniqfx.html" "$DIR/artifacts/_vrt_textdupfx.html"; }
trap cleanup EXIT
flow(){ printf '%s\n' "$2" > "$FL/$1.flow.json"; }
cand(){ printf '%s\n' "{\"_steps\":1,\"byStep\":{\"0\":[$2]}}" > "$FL/$1.candidates.json"; }

# 1. REPAIR: bad primary, a UNIQUE (count==1) candidate -> rewrite to the candidate, exit 0.
flow _vrt_repair '{"name":"_vrt_repair","startUrl":"https://example.com","steps":[{"kind":"find","by":"text","value":"NoSuchText_zzz","action":"click"}],"asserts":[]}'
cand _vrt_repair '{"by":"text","value":"Example Domain","count":1}'
bash "$VF" "$FL/_vrt_repair.flow.json" >/tmp/_vrt1.log 2>&1 || { sed 's/^/    /' /tmp/_vrt1.log >&2; fail "repair exited non-zero (expected 0)"; }
jq -e '.steps[0].by=="text" and .steps[0].value=="Example Domain" and (.steps[0].needs_review|not)' \
	"$FL/_vrt_repair.flow.json" >/dev/null || fail "repair did not rewrite step0 to the candidate"

# 2. NON-UNIQUE candidate (count>1) must NOT be used (weaker than capture's gate) -> promote, exit !=0.
flow _vrt_nonuniq '{"name":"_vrt_nonuniq","startUrl":"https://example.com","steps":[{"kind":"find","by":"text","value":"NoSuchText_zzz","action":"click"}],"asserts":[]}'
cand _vrt_nonuniq '{"by":"text","value":"Example Domain","count":2}'
if bash "$VF" "$FL/_vrt_nonuniq.flow.json" >/tmp/_vrt2.log 2>&1; then fail "non-unique candidate was accepted (expected non-zero exit)"; fi
jq -e '.steps[0].needs_review==true' "$FL/_vrt_nonuniq.flow.json" >/dev/null || fail "non-unique case did not promote to needs_review"

# 3. ACTION-FAILURE: locator resolves (the h1) but its action (fill) cannot succeed -> promote, exit !=0.
flow _vrt_actfail '{"name":"_vrt_actfail","startUrl":"https://example.com","steps":[{"kind":"find","by":"text","value":"Example Domain","action":"fill","text":"x"}],"asserts":[]}'
cand _vrt_actfail '{"by":"text","value":"Example Domain","count":1}'
if bash "$VF" "$FL/_vrt_actfail.flow.json" >/tmp/_vrt3.log 2>&1; then fail "resolve-but-action-failed exited 0 (false green!)"; fi
grep -q 'action failed' /tmp/_vrt3.log || fail "action-failure not reported"

# 4. PRE-EXISTING needs_review: verify must refuse (exit !=0), not greenlight a flow compile rejects.
flow _vrt_preexist '{"name":"_vrt_preexist","startUrl":"https://example.com","steps":[{"kind":"find","needs_review":true,"candidates":[{"by":"text","value":"A"},{"by":"text","value":"B"}],"action":"click"}],"asserts":[]}'
if bash "$VF" "$FL/_vrt_preexist.flow.json" >/tmp/_vrt4.log 2>&1; then fail "pre-existing needs_review exited 0 (must refuse)"; fi

# 5/6 — testid uniqueness cross-check. Local file:// fixtures (data: URLs hang agent-browser `open`;
# file:// is reliable). `pwd -W` yields a Windows path so Chrome gets file:///C:/...; verify's own open
# is redirected (not piped), so it does not hit the cold-spawn-pipe hang.
WROOT="$(cd "$DIR" && pwd -W)"; mkdir -p "$DIR/artifacts"
printf '%s' '<!doctype html><meta charset=utf-8><title>dup</title><button data-testid=dupz>A</button><button data-testid=dupz>B</button>' > "$DIR/artifacts/_vrt_dupfx.html"
printf '%s' '<!doctype html><meta charset=utf-8><title>uniq</title><button data-testid=uniqz>U</button>' > "$DIR/artifacts/_vrt_uniqfx.html"
DUPURL="file:///$WROOT/artifacts/_vrt_dupfx.html"; UNIQURL="file:///$WROOT/artifacts/_vrt_uniqfx.html"

# 5. TESTID DUPLICATE-DRIFT: a testid that resolves AND acts but now matches 2 elements must NOT be
#    trusted (`find` silently hits the first) -> get count cross-check -> promote needs_review, exit !=0.
flow _vrt_testiddup "{\"name\":\"_vrt_testiddup\",\"startUrl\":\"$DUPURL\",\"steps\":[{\"kind\":\"find\",\"by\":\"testid\",\"value\":\"dupz\",\"action\":\"click\"}],\"asserts\":[]}"
if bash "$VF" "$FL/_vrt_testiddup.flow.json" >/tmp/_vrt5.log 2>&1; then sed 's/^/    /' /tmp/_vrt5.log >&2; fail "duplicate testid accepted (expected non-zero exit = false-green)"; fi
jq -e '.steps[0].needs_review==true' "$FL/_vrt_testiddup.flow.json" >/dev/null || fail "duplicate testid did not promote to needs_review"
grep -q 'matches 2 elements' /tmp/_vrt5.log || fail "duplicate-testid count not reported"

# 6. CONTROL — a UNIQUE testid (count==1) resolves, cross-checks unique, acts, and PASSES (exit 0): the
#    cross-check must not false-RED a legitimately unique testid.
flow _vrt_testiduniq "{\"name\":\"_vrt_testiduniq\",\"startUrl\":\"$UNIQURL\",\"steps\":[{\"kind\":\"find\",\"by\":\"testid\",\"value\":\"uniqz\",\"action\":\"click\"}],\"asserts\":[]}"
bash "$VF" "$FL/_vrt_testiduniq.flow.json" >/tmp/_vrt6.log 2>&1 || { sed 's/^/    /' /tmp/_vrt6.log >&2; fail "unique testid rejected (expected exit 0)"; }
jq -e '.steps[0].needs_review!=true' "$FL/_vrt_testiduniq.flow.json" >/dev/null || fail "unique testid wrongly promoted"
grep -q 'testid-unique=1' /tmp/_vrt6.log || fail "unique testid not tallied in the verify summary"

# 7. NON-TESTID CEILING — a duplicate NON-testid locator (text) is NOT cross-checked (no replay-count
#    primitive on 0.27.0 for semantic locators) and still PASSES (exit 0). Pins that the get-count guard
#    is testid-scoped: a regression that broadened it to text/label (false-RED) or that mis-detected
#    use_by in the testid branch would be caught here. tidok must stay 0 (a text step is not a testid check).
printf '%s' '<!doctype html><meta charset=utf-8><title>tdup</title><button>Dup</button><button>Dup</button>' > "$DIR/artifacts/_vrt_textdupfx.html"
TEXTURL="file:///$WROOT/artifacts/_vrt_textdupfx.html"
flow _vrt_textdup "{\"name\":\"_vrt_textdup\",\"startUrl\":\"$TEXTURL\",\"steps\":[{\"kind\":\"find\",\"by\":\"text\",\"value\":\"Dup\",\"action\":\"click\"}],\"asserts\":[]}"
bash "$VF" "$FL/_vrt_textdup.flow.json" >/tmp/_vrt7.log 2>&1 || { sed 's/^/    /' /tmp/_vrt7.log >&2; fail "duplicate non-testid (text) wrongly rejected — the cross-check must be testid-only"; }
jq -e '.steps[0].needs_review!=true' "$FL/_vrt_textdup.flow.json" >/dev/null || fail "duplicate text locator wrongly promoted (cross-check leaked to non-testid)"
grep -q 'testid-unique=0' /tmp/_vrt7.log || fail "a non-testid step must not be tallied as a testid uniqueness check (expected testid-unique=0)"

echo "  ✓ verify-flow.test.sh passed"
