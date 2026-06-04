#!/usr/bin/env bash
# tests/capture-masking.test.sh — pins capture.js sensitive() masking decisions (the PII guarantee).
# The build-flow-unit masking check feeds a SYNTHETIC masked:true record and would stay green even if
# sensitive() were gutted to `return false`. This drives REAL sensitive fields through capture.js and
# asserts the secret is masked AT CAPTURE (never stored): a password (by type), an OTP (by autocomplete),
# a card number (by autocomplete), and a CVV (by inputmode+name hint) -> input_value:null, masked:true;
# while a benign email is NOT masked (its value IS captured — sensitive() must not over-mask). Also
# asserts the raw secret values never appear anywhere in the buffer.
#
# Mechanism mirrors the other capture tests: capture.js via --init-script into example.com (file://
# sessionStorage is opaque); type into fields (real input events) and commit via the next field /
# focusout; drain __aqa_buf; assert. Headless; verdicts read JSON.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DIR/lib/env.sh"
source "$DIR/lib/cleanup.sh"
source "$DIR/lib/assert.sh"

fail(){ echo "  ✗ capture-masking: $1" >&2; exit 1; }
eq(){ [ "$1" = "$2" ] || fail "$3: expected '$2', got '$1'"; }

CAPJS="$DIR/bin/capture.js"
[ -s "$CAPJS" ] || fail "missing $CAPJS"
AB open --init-script "$CAPJS" "https://example.com" >/dev/null

# Build 4 sensitive fields (one per sensitive() branch) + 1 benign email. Distinctive UPPERCASE values
# so the leak check can't coincidentally match JSON noise. Type each (real input event), then a focusout
# on the last to commit it (the input coalescer commits the prior field when the next one gets input).
AB_JSON eval "document.body.innerHTML='<input type=password id=pw placeholder=Password><input autocomplete=one-time-code inputmode=numeric id=otp placeholder=Code><input autocomplete=cc-number id=cc placeholder=Card><input inputmode=numeric name=cvv id=cvv placeholder=CVV><input type=email id=em placeholder=Email>';function tp(i,v){var f=document.getElementById(i);f.value=v;f.dispatchEvent(new Event('input',{bubbles:true}));}tp('pw','SECRETPWZ');tp('otp','OTPCODEZ');tp('cc','CARDNUMZ');tp('cvv','CVVCODEZ');tp('em','benign@x.com');document.getElementById('em').dispatchEvent(new Event('focusout',{bubbles:true}));1" >/dev/null

BUF="$(AB_JSON eval "JSON.parse(sessionStorage.getItem('__aqa_buf')||'[]')")"
INPUTS="$(printf '%s' "$BUF" | jq -c '[.data.result[] | select(.action_type=="input")]')"
eq "$(printf '%s' "$INPUTS" | jq 'length')" '5' "all 5 input fields recorded"
rec(){ printf '%s' "$INPUTS" | jq -c --arg v "$1" 'map(select(.primary.value==$v)) | .[0]'; }
# each sensitive field: masked:true AND input_value:null (the secret never stored).
for ph in Password Code Card CVV; do
	r="$(rec "$ph")"
	[ -n "$r" ] && [ "$r" != "null" ] || fail "$ph: no input record found"
	eq "$(printf '%s' "$r" | jq -r '.masked // false')"      'true' "$ph field must be masked:true"
	eq "$(printf '%s' "$r" | jq -r '.input_value')"          'null' "$ph field value must be null (not stored)"
done
# the benign email must NOT be masked, and its value IS captured (no over-masking).
em="$(rec Email)"
eq "$(printf '%s' "$em" | jq -r '.masked // false')" 'false'        "Email field must NOT be masked"
eq "$(printf '%s' "$em" | jq -r '.input_value')"     'benign@x.com' "Email field value must be captured"

# Hard PII guarantee: no raw secret value appears ANYWHERE in the captured buffer.
for secret in SECRETPWZ OTPCODEZ CARDNUMZ CVVCODEZ; do
	case "$BUF" in *"$secret"*) fail "sensitive value '$secret' LEAKED into the capture buffer" ;; esac
done

echo "  ✓ capture-masking.test.sh passed"
