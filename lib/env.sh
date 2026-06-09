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

if [ -f "$PROBE_ROOT/lib/daemon.sh" ]; then
	# shellcheck source=daemon.sh
	source "$PROBE_ROOT/lib/daemon.sh"
fi

_AQA_DAEMON_ENSURED="${AQA_DAEMON_ENSURED:-0}"
_ensure_daemon_once() {
	[ "${AQA_SKIP_DAEMON_ENSURE:-0}" = "1" ] && return 0
	[ "$_AQA_DAEMON_ENSURED" = "1" ] && return 0
	if declare -F ensure_daemon >/dev/null 2>&1; then
		ensure_daemon
		_AQA_DAEMON_ENSURED=1
		export AQA_DAEMON_ENSURED=1
	fi
}

_agent_browser_wedged() {
	grep -Eiq 'os error 10060|10060|Failed to read' "$@" 2>/dev/null
}

_agent_browser_retry() {
	local out err rc
	out="$(mktemp)"; err="$(mktemp)"
	set +e
	agent-browser "$@" >"$out" 2>"$err"
	rc=$?
	set -e
	if _agent_browser_wedged "$out" "$err"; then
		echo "[daemon] agent-browser command hit daemon wedge; recovering and retrying: $*" >&2
		if declare -F recover_daemon >/dev/null 2>&1; then recover_daemon >&2 || true; fi
		_AQA_DAEMON_ENSURED=1
		export AQA_DAEMON_ENSURED=1
		: >"$out"; : >"$err"
		set +e
		agent-browser "$@" >"$out" 2>"$err"
		rc=$?
		set -e
	fi
	cat "$out"
	cat "$err" >&2
	rm -f "$out" "$err"
	return "$rc"
}

_agent_browser_retry_stdin() {
	local input="$1"; shift
	local out err rc
	out="$(mktemp)"; err="$(mktemp)"
	set +e
	agent-browser "$@" >"$out" 2>"$err" <<<"$input"
	rc=$?
	set -e
	if _agent_browser_wedged "$out" "$err"; then
		echo "[daemon] agent-browser command hit daemon wedge; recovering and retrying: $*" >&2
		if declare -F recover_daemon >/dev/null 2>&1; then recover_daemon >&2 || true; fi
		_AQA_DAEMON_ENSURED=1
		export AQA_DAEMON_ENSURED=1
		: >"$out"; : >"$err"
		set +e
		agent-browser "$@" >"$out" 2>"$err" <<<"$input"
		rc=$?
		set -e
	fi
	cat "$out"
	cat "$err" >&2
	rm -f "$out" "$err"
	return "$rc"
}

# AB: every agent-browser call in a test goes through this so the isolated --session
# is always applied. Raw stdout/stderr passthrough; callers that need a verdict use
# AB_JSON or the assert_* helpers instead of trusting AB's exit code.
AB() { _ensure_daemon_once; agent-browser --session "$S" "$@"; }

# AB_AUTH <app> <agent-browser-args...>: like AB but injects --state from the cached
# login produced by setup/auth.sh (fixtures/auth/<app>.state.json). Use as the first
# call of a test that needs a logged-in session, e.g.
#   AB_AUTH samsung open "https://guest.samsungdisplay.com/main/index.do"
# Fails loudly (return 1) if the state file is missing so a test never silently runs
# logged-out — run `APP=<app> LOGIN_URL=.. SUCCESS_URL=.. bash setup/auth.sh` first.
AB_AUTH() {
	local app="$1"; shift
	local state="${PROBE_ROOT}/fixtures/auth/${app}.state.json"
	if [ ! -s "$state" ]; then
		echo "  ✗ AB_AUTH: no cached state for '$app' ($state). Run setup/auth.sh first." >&2
		return 1
	fi
	_ensure_daemon_once
	_agent_browser_retry --session "$S" --state "$state" "$@"
}

# AB_JSON: run an agent-browser command with --json and echo its raw JSON envelope.
# THE failure-detection primitive. Does NOT itself decide pass/fail — it just surfaces
# the JSON so jq can read `.success`. Single command only (batch has its own shape).
AB_JSON() { _ensure_daemon_once; _agent_browser_retry --session "$S" "$@" --json; }

# ABX: checked single-action wrapper. agent-browser may exit 0 even when the
# action failed, so this fails loud on `.success != true` and echoes the JSON
# envelope only for successful actions.
ABX() {
	local out ok err
	out="$(AB_JSON "$@")" || true
	ok="$(printf '%s' "$out" | jq -r '.success // false' 2>/dev/null || echo false)"
	if [ "$ok" != "true" ]; then
		err="$(printf '%s' "$out" | jq -r '.error // "unknown error"' 2>/dev/null || echo "invalid JSON envelope")"
		echo "  ✗ ABX action failed: [$*] -> $err" >&2
		return 1
	fi
	printf '%s' "$out"
}

# BATCH: run a deterministic journey body passed as JSON on stdin, e.g.
#   BATCH --bail <<'JSON'
#   [["find","text","Checkout","click"],["wait","--url","**/pay"]]
#   JSON
# stdin-JSON mode avoids the shell token-splitting trap for values with spaces/quotes.
# IMPORTANT: --bail stops after the first failed command but agent-browser still exits 0,
# so BATCH pipes the result array to _batch_check, which fails the test if any
# command's `.success` is false. NEVER rely on BATCH's exit code alone.
BATCH() {
	local out input
	input="$(cat)"
	_ensure_daemon_once
	out="$(_agent_browser_retry_stdin "$input" --session "$S" batch --json "$@")"
	_batch_check "$out"
}

# _batch_check: inspect a `batch --json` result array. Returns 1 (failing the test via
# set -e) on the first command whose `.success` is false, printing which command and why.
_batch_check() {
	local json="$1" shape failed
	# Fail CLOSED on a missing/empty/non-array envelope. agent-browser must return a NON-EMPTY array
	# of {success,...} results; an empty string, whitespace, "[]", or garbage means the batch did not
	# run as sent. This function exists to PREVENT false-greens, so it must never pass on no evidence.
	shape="$(printf '%s' "$json" | jq -r 'if type=="array" and length>0 then "ok" else "bad" end' 2>/dev/null || echo "bad")"
	if [ "$shape" != "ok" ]; then
		echo "  ✗ BATCH: empty/invalid result envelope — batch did not run as sent (not a silent pass)" >&2
		return 1
	fi
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
