#!/usr/bin/env bash
# Browser-free checks for CI lane wrappers and fail-closed live guards.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/aqa-ci-lanes.XXXXXX")"
cleanup() {
	rm -rf "$TMPROOT"
}
trap cleanup EXIT

REAL_BASH="$(command -v bash)"
FAKE_BIN="$TMPROOT/fake-bin"
LOG="$TMPROOT/bash-invocations.log"
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
		echo "  ci-lanes-unit: expected fake bash invocation: $needle" >&2
		echo "  ci-lanes-unit: log was:" >&2
		cat "$LOG" >&2 || true
		exit 1
	fi
}

assert_refused() {
	local label="$1"
	shift
	: > "$LOG"
	if PATH="$FAKE_BIN:$PATH" AQA_FAKE_BASH_LOG="$LOG" "$@" > "$TMPROOT/$label.out" 2> "$TMPROOT/$label.err"; then
		echo "  ci-lanes-unit: $label unexpectedly succeeded" >&2
		exit 1
	fi
	if [[ -s "$LOG" ]]; then
		echo "  ci-lanes-unit: $label reached an inner test command after guard refusal" >&2
		cat "$LOG" >&2
		exit 1
	fi
	grep -q 'refused' "$TMPROOT/$label.err"
}

( cd "$DIR" && "$REAL_BASH" -n run.sh lib/preflight.sh bin/ci-security-p0.sh bin/ci-browser-fixture.sh bin/ci-slow-fixture.sh bin/ci-operator-only-guard.sh bin/operator-staging-readonly.sh )

: > "$LOG"
PATH="$FAKE_BIN:$PATH" AQA_FAKE_BASH_LOG="$LOG" "$REAL_BASH" "$DIR/bin/ci-security-p0.sh"
assert_log_contains "tests/security-p0-gate.test.sh"

: > "$LOG"
PATH="$FAKE_BIN:$PATH" AQA_FAKE_BASH_LOG="$LOG" "$REAL_BASH" "$DIR/bin/ci-browser-fixture.sh"
assert_log_contains "tests/play-flow-smoke.test.sh"

: > "$LOG"
PATH="$FAKE_BIN:$PATH" AQA_FAKE_BASH_LOG="$LOG" "$REAL_BASH" "$DIR/bin/ci-slow-fixture.sh"
assert_log_contains "tests/rpa-fixture-e2e.test.sh"
assert_log_contains "tests/rpa-local-fixture-e2e.test.sh"

assert_refused live-auth env AQA_INCLUDE_LIVE_AUTH=1 "$REAL_BASH" "$DIR/bin/ci-security-p0.sh"
assert_refused nonlocal env AQA_INCLUDE_NONLOCAL=true "$REAL_BASH" "$DIR/bin/ci-browser-fixture.sh"
assert_refused live-action env AQA_RUN_MODE=live-action "$REAL_BASH" "$DIR/bin/ci-slow-fixture.sh"
assert_refused allowlist env AQA_TARGET_ALLOWLIST=https://example.com "$REAL_BASH" "$DIR/bin/ci-security-p0.sh"
assert_refused egress-allowlist env AQA_EGRESS_ALLOWLIST=https://example.com "$REAL_BASH" "$DIR/bin/ci-security-p0.sh"
assert_refused live-approve env AQA_LIVE_ACTION_APPROVE=1 "$REAL_BASH" "$DIR/bin/ci-browser-fixture.sh"
assert_refused on-prem env AQA_EGRESS_PROFILE=on-prem "$REAL_BASH" "$DIR/bin/ci-slow-fixture.sh"

assert_refused operator-ci env CI=true "$REAL_BASH" "$DIR/bin/ci-operator-only-guard.sh"
assert_refused operator-local env "$REAL_BASH" "$DIR/bin/ci-operator-only-guard.sh"

echo "  ci-lanes-unit: CI lane wrappers dispatch local fixtures and refuse live/operator env"
