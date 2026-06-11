#!/usr/bin/env bash
# Browser-free checks for the operator-only staging/live-readonly lane wrapper.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/aqa-staging-readonly.XXXXXX")"
FLOW_TMP="$DIR/flows/lane_effectful_tmp.flow.json"
TEST_TMP="$DIR/tests/lane_effectful_tmp.test.sh"
cleanup() {
	rm -rf "$TMPROOT"
	rm -f "$FLOW_TMP" "$TEST_TMP"
}
trap cleanup EXIT

REAL_BASH="$(command -v bash)"
FAKE_BIN="$TMPROOT/fake-bin"
LOG="$TMPROOT/bash-invocations.log"
NOW_MS="$(node -e 'console.log(Date.now())')"
EXAMPLE_EVIDENCE="{\"example.com\":{\"addresses\":[\"93.184.216.34\"],\"connectionIps\":[\"93.184.216.34\"],\"resolvedAtMs\":$NOW_MS}}"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/bash" <<'SH'
#!/bin/sh
printf '%s\n' "$*" >> "$AQA_FAKE_BASH_LOG"
exit 0
SH
chmod +x "$FAKE_BIN/bash"

assert_log_contains() {
	local needle="$1"
	if ! grep -Fq "$needle" "$LOG"; then
		echo "  staging-readonly-lane-unit: expected fake bash invocation: $needle" >&2
		cat "$LOG" >&2 || true
		exit 1
	fi
}

assert_refused() {
	local label="$1"
	shift
	: > "$LOG"
	if PATH="$FAKE_BIN:$PATH" AQA_FAKE_BASH_LOG="$LOG" "$@" > "$TMPROOT/$label.out" 2> "$TMPROOT/$label.err"; then
		echo "  staging-readonly-lane-unit: $label unexpectedly succeeded" >&2
		exit 1
	fi
	if [[ -s "$LOG" ]]; then
		echo "  staging-readonly-lane-unit: $label reached run.sh after guard refusal" >&2
		cat "$LOG" >&2
		exit 1
	fi
	grep -q 'refused' "$TMPROOT/$label.err"
}

( cd "$DIR" && "$REAL_BASH" -n bin/operator-staging-readonly.sh )

: > "$LOG"
PATH="$FAKE_BIN:$PATH" \
AQA_FAKE_BASH_LOG="$LOG" \
AQA_RUN_MODE=live-readonly \
AQA_TARGET_ALLOWLIST=https://example.com \
AQA_EGRESS_RESOLVER_EVIDENCE="$EXAMPLE_EVIDENCE" \
"$REAL_BASH" "$DIR/bin/operator-staging-readonly.sh" nav-roundtrip
assert_log_contains "run.sh nav-roundtrip"

: > "$LOG"
PATH="$FAKE_BIN:$PATH" \
AQA_FAKE_BASH_LOG="$LOG" \
AQA_RUN_MODE=live-readonly \
AQA_TARGET_ALLOWLIST=https://example.com \
AQA_EGRESS_RESOLVER_EVIDENCE="$EXAMPLE_EVIDENCE" \
"$REAL_BASH" "$DIR/bin/operator-staging-readonly.sh" --validate-only nav-roundtrip
if [[ -s "$LOG" ]]; then
	echo "  staging-readonly-lane-unit: validate-only should not invoke run.sh" >&2
	cat "$LOG" >&2
	exit 1
fi

cat > "$FLOW_TMP" <<'JSON'
{
  "name": "lane_effectful_tmp",
  "engine": "playwright",
  "environment": "staging",
  "riskClass": "read",
  "startUrl": "https://example.com",
  "steps": [
    { "kind": "find", "by": "role", "value": "button", "name": "Submit", "action": "click" }
  ],
  "asserts": []
}
JSON
cat > "$TEST_TMP" <<'SH'
#!/usr/bin/env bash
exit 0
SH

assert_refused missing-allowlist env AQA_RUN_MODE=live-readonly "$REAL_BASH" "$DIR/bin/operator-staging-readonly.sh" nav-roundtrip
assert_refused wrong-run-mode env AQA_RUN_MODE=staging AQA_TARGET_ALLOWLIST=https://example.com "$REAL_BASH" "$DIR/bin/operator-staging-readonly.sh" nav-roundtrip
assert_refused ci env CI=true AQA_RUN_MODE=live-readonly AQA_TARGET_ALLOWLIST=https://example.com "$REAL_BASH" "$DIR/bin/operator-staging-readonly.sh" nav-roundtrip
assert_refused live-action-env env AQA_RUN_MODE=live-readonly AQA_TARGET_ALLOWLIST=https://example.com AQA_LIVE_ACTION_APPROVE=1 "$REAL_BASH" "$DIR/bin/operator-staging-readonly.sh" nav-roundtrip
assert_refused destructive-step env AQA_RUN_MODE=staging AQA_TARGET_ALLOWLIST=https://example.com "$REAL_BASH" "$DIR/bin/operator-staging-readonly.sh" --validate-only lane_effectful_tmp

echo "  staging-readonly-lane-unit: all checks passed"
