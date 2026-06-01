#!/usr/bin/env bash
# lib/env.sh — per-test boilerplate. Sourced first by every tests/*.test.sh.
#
# Provides the isolated-session wrappers and the ONE primitive that makes this
# framework correct on agent-browser 0.27.0: agent-browser returns exit 0 even
# when an action FAILS (element not found, etc) — exit codes only catch infra
# errors. So success/failure MUST be read from the --json `.success` field, never
# from `$?`. AB_JSON() is that single source of truth; assert.sh builds on it.
#
# Expects: PROBE_ROOT (project root) set by the caller (run.sh) or derived here.
# Sets (exported for cleanup.sh/assert.sh): S, ARTDIR.

set -euo pipefail

# Project root: prefer caller-provided PROBE_ROOT, else two levels up from this file.
PROBE_ROOT="${PROBE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export PROBE_ROOT

# Test name = the sourcing script's basename without .test.sh; falls back to "test".
_PROBE_TEST_NAME="$(basename "${BASH_SOURCE[1]:-test}" .test.sh)"

# S: isolated agent-browser session per test process. The $$ suffix keeps parallel
# or repeated runs from colliding on session state. cleanup.sh closes exactly this S.
S="${_PROBE_TEST_NAME}-$$"
export S

# ARTDIR: per-run, per-test artifact dir (video/screenshots/har). RUN_ID comes from
# run.sh; standalone `bash tests/x.test.sh` gets a "standalone" run id.
ARTDIR="${PROBE_ROOT}/artifacts/${RUN_ID:-standalone}/${_PROBE_TEST_NAME}"
export ARTDIR
mkdir -p "$ARTDIR"

# AB: every agent-browser call in a test goes through this so the isolated --session
# is always applied. Raw stdout/stderr passthrough; callers that need a verdict use
# AB_JSON or the assert_* helpers instead of trusting AB's exit code.
AB() { agent-browser --session "$S" "$@"; }

# AB_JSON: run an agent-browser command with --json and echo its raw JSON envelope.
# THE failure-detection primitive. Does NOT itself decide pass/fail — it just surfaces
# the JSON so jq can read `.success`. Single command only (batch has its own shape).
AB_JSON() { agent-browser --session "$S" "$@" --json; }

# BATCH: run a deterministic journey body passed as JSON on stdin, e.g.
#   BATCH --bail <<'JSON'
#   [["find","text","Checkout","click"],["wait","--url","**/pay"]]
#   JSON
# stdin-JSON mode avoids the shell token-splitting trap for values with spaces/quotes.
# IMPORTANT: --bail stops after the first failed command but agent-browser still exits 0,
# so BATCH pipes the result array to _batch_check, which fails the test if any
# command's `.success` is false. NEVER rely on BATCH's exit code alone.
BATCH() {
	local out
	out="$(agent-browser --session "$S" batch --json "$@")"
	_batch_check "$out"
}

# _batch_check: inspect a `batch --json` result array. Returns 1 (failing the test via
# set -e) on the first command whose `.success` is false, printing which command and why.
_batch_check() {
	local json="$1" failed
	failed="$(printf '%s' "$json" | jq -r 'map(select(.success == false)) | .[0] // empty | @json')"
	if [ -n "$failed" ]; then
		local cmd err
		cmd="$(printf '%s' "$failed" | jq -r '.command | join(" ")')"
		err="$(printf '%s' "$failed" | jq -r '.error // "unknown error"')"
		echo "  ✗ BATCH step failed: [$cmd] -> $err" >&2
		return 1
	fi
	return 0
}
