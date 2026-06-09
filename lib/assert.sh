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

# _url_match <got-url> <want-pattern>: 0 if the URL matches. <want> may be an agent-browser
# style glob ("**/secure", query/fragment stripped); ** and * both collapse to bash * and are
# matched against the WHOLE URL (so "**/secure" => "*/secure" matches ".../secure", optionally
# followed by ?query/#frag). A plain substring (hand-written test) still matches via the contains
# fallback. Shared by assert_url and wait_url so a recorded wait gate and its trailing assert
# agree on EXACTLY the same matching.
_url_match() {
	local got="$1" want="$2" glob
	# Only * / ** are wildcards; every other char is literal. Make the OTHER bash-glob
	# metacharacters literal via single-char bracket expressions ([[] matches a literal '[',
	# [?] a literal '?') — robust, unlike backslash escaping inside ${//} replacements. Escape
	# '[' BEFORE the '?' rule introduces new '[' chars, then collapse ** -> * (the sole
	# wildcard). Without this, "**/api/[v2]/x" would read [v2] as a character class and
	# FALSE-match ".../apiv/..." — a silent false-green, the exact failure this framework prevents.
	# (glob assigned from $want on its own line: a single `local ... glob="$want"` would read
	# $want before it is set in the same declaration.)
	glob="${want//\[/[[]}"        # literal [  -> [[]
	glob="${glob//\?/[?]}"        # literal ?  -> [?]
	glob="${glob//\*\*/\*}"       # **         -> *   (sole wildcard)
	case "$got" in
		$glob | $glob\?* | $glob\#*) return 0 ;;   # glob match (whole URL, optional query/frag)
		*"$want"*) return 0 ;;                      # literal-substring fallback
		*) return 1 ;;
	esac
}

# assert_url <pattern>: current URL must match (glob or substring; see _url_match).
assert_url() {
	local want="$1" got
	got="$(_ab_data '.data.url' get url)" || return 1
	_url_match "$got" "$want" && return 0
	echo "  ✗ assert_url: '$got' does not match '$want'" >&2; return 1
}

# wait_url <pattern> [timeout_s]: poll the current URL until it matches <pattern> (default 15s).
# This is the recorder's navigation gate. agent-browser 0.27.0 `wait --url` is BROKEN for glob
# patterns ("**/secure" hangs ~34s then fails with os error 10060); it works only for plain
# substrings. `get url` is reliable, so compile() emits this poll for every `wait until:url`
# step instead of `wait --url`. Tolerates transient get-url failures mid-navigation (retries
# until the deadline) and matches with the same logic as assert_url.
wait_url() {
	local want="$1" timeout="${2:-15}" got deadline
	deadline=$(( $(date +%s) + timeout ))
	while :; do
		got="$(_ab_data '.data.url' get url 2>/dev/null)" && _url_match "$got" "$want" && return 0
		[ "$(date +%s)" -ge "$deadline" ] && break
		sleep 0.3
	done
	echo "  ✗ wait_url: URL '${got:-?}' never matched '$want' within ${timeout}s" >&2; return 1
}

wait_text() {
	local want="$1" timeout="${2:-15}" got deadline
	deadline=$(( $(date +%s) + timeout ))
	while :; do
		got="$(_ab_data '.data.text' get text body 2>/dev/null)" && case "$got" in *"$want"*) return 0 ;; esac
		[ "$(date +%s)" -ge "$deadline" ] && break
		sleep 0.3
	done
	echo "  ✗ wait_text: text '$want' not seen within ${timeout}s" >&2; return 1
}

wait_visible() {
	local sel="$1" timeout="${2:-15}" vis deadline
	deadline=$(( $(date +%s) + timeout ))
	while :; do
		vis="$(_ab_data '.data.visible' is visible "$sel" 2>/dev/null)" && [ "$vis" = "true" ] && return 0
		[ "$(date +%s)" -ge "$deadline" ] && break
		sleep 0.3
	done
	echo "  ✗ wait_visible: '$sel' not visible within ${timeout}s" >&2; return 1
}

wait_gone() {
	local sel="$1" timeout="${2:-15}" count deadline
	deadline=$(( $(date +%s) + timeout ))
	while :; do
		count="$(_ab_data '.data.count' get count "$sel" 2>/dev/null)" && [ "$count" = "0" ] && return 0
		[ "$(date +%s)" -ge "$deadline" ] && break
		sleep 0.3
	done
	echo "  ✗ wait_gone: '$sel' still present after ${timeout}s" >&2; return 1
}

wait_stable() {
	local sel="$1" timeout="${2:-15}" box prev="" stable=0 deadline
	deadline=$(( $(date +%s) + timeout ))
	while :; do
		box="$(AB_JSON get box "$sel" 2>/dev/null | jq -c 'select(.success==true) | .data' 2>/dev/null || true)"
		if [ -n "$box" ] && [ "$box" = "$prev" ]; then
			stable=$((stable + 1))
			[ "$stable" -ge 1 ] && return 0
		else
			stable=0
			prev="$box"
		fi
		[ "$(date +%s)" -ge "$deadline" ] && break
		sleep 0.2
	done
	echo "  ✗ wait_stable: '$sel' did not stabilize within ${timeout}s" >&2; return 1
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
