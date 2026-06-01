#!/usr/bin/env bash
# lib/assert.sh — verification helpers. Sourced after env.sh by every test.
#
# THE ONLY sanctioned way to assert in a test. Every helper reads the agent-browser
# --json envelope (via AB_JSON from env.sh) and decides pass/fail from `.success`
# and the data field — NEVER from the process exit code, because agent-browser
# 0.27.0 exits 0 even on element-not-found / false results. A bare `is`/`find` in a
# test would silently false-green; these wrappers exist to make that impossible.
#
# Every helper returns 1 on failure so the test's `set -e` aborts the test, which
# run.sh records as a failure. On failure they print a one-line "  ✗ ..." reason.

# _ab_data: run AB_JSON and, only if .success==true, emit the requested jq path from
# .data. On .success==false (e.g. element absent) prints the agent-browser error and
# returns 1. Centralizes the success-gate so each assert stays a one-liner.
_ab_data() {
	local jqpath="$1"; shift
	local json ok
	json="$(AB_JSON "$@")" || true   # AB_JSON's own exit is unreliable; judge via JSON
	ok="$(printf '%s' "$json" | jq -r '.success')"
	if [ "$ok" != "true" ]; then
		local err; err="$(printf '%s' "$json" | jq -r '.error // "command not successful"')"
		echo "  ✗ assert: agent-browser failed [$*] -> $err" >&2
		return 1
	fi
	printf '%s' "$json" | jq -r "$jqpath"
}

# assert_url <pattern-substring>: current URL must contain the substring.
assert_url() {
	local want="$1" got
	got="$(_ab_data '.data.url' get url)" || return 1
	case "$got" in
		*"$want"*) return 0 ;;
		*) echo "  ✗ assert_url: expected to contain '$want', got '$got'" >&2; return 1 ;;
	esac
}

# assert_text <substring> [selector]: page (or element) text must contain substring.
# No selector => whole-page text via `get text` on body.
assert_text() {
	local want="$1" sel="${2:-body}" got
	got="$(_ab_data '.data.text' get text "$sel")" || return 1
	case "$got" in
		*"$want"*) return 0 ;;
		*) echo "  ✗ assert_text: '$sel' expected to contain '$want'" >&2; return 1 ;;
	esac
}

# assert_value <selector> <expected>: input/select value must equal expected exactly.
assert_value() {
	local sel="$1" want="$2" got
	got="$(_ab_data '.data.value' get value "$sel")" || return 1
	if [ "$got" = "$want" ]; then return 0; fi
	echo "  ✗ assert_value: '$sel' expected '$want', got '$got'" >&2; return 1
}

# assert_visible <selector>: element must exist AND be visible. Parses .data.visible —
# does NOT trust `is`'s exit code (false visible still exits 0; absence => success:false).
assert_visible() {
	local sel="$1" vis
	vis="$(_ab_data '.data.visible' is visible "$sel")" || return 1
	if [ "$vis" = "true" ]; then return 0; fi
	echo "  ✗ assert_visible: '$sel' exists but is not visible" >&2; return 1
}

# assert_count <selector> <n>: number of matching elements must equal n.
assert_count() {
	local sel="$1" want="$2" got
	got="$(_ab_data '.data.count' get count "$sel")" || return 1
	if [ "$got" = "$want" ]; then return 0; fi
	echo "  ✗ assert_count: '$sel' expected $want, got $got" >&2; return 1
}

# assert_absent <selector>: element must NOT be present. Uses get count == 0, which is
# instant — never `wait`, which would burn the full timeout on every (passing) run.
assert_absent() {
	local sel="$1" got
	got="$(_ab_data '.data.count' get count "$sel")" || return 1
	if [ "$got" = "0" ]; then return 0; fi
	echo "  ✗ assert_absent: '$sel' should be absent but found $got" >&2; return 1
}

# assert_no_snapshot_change <baseline-file>: structural regression gate. Parses
# .data.changed from `diff snapshot` — diff exits 0 regardless of change, so the
# boolean is the only signal. Preferred over pixel diff (font AA false positives).
assert_no_snapshot_change() {
	local baseline="$1" changed
	changed="$(_ab_data '.data.changed' diff snapshot -b "$baseline")" || return 1
	if [ "$changed" = "false" ]; then return 0; fi
	echo "  ✗ assert_no_snapshot_change: snapshot drifted from baseline '$baseline'" >&2; return 1
}
