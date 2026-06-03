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
NAMES="_vrt_repair _vrt_nonuniq _vrt_actfail _vrt_preexist"
cleanup(){ for n in $NAMES; do rm -f "$FL/$n.flow.json" "$FL/$n.candidates.json"; done; }
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

echo "  ✓ verify-flow.test.sh passed"
