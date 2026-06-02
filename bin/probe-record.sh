#!/usr/bin/env bash
# bin/probe-record.sh — authoring helper (Layer 2, opt-in). Standalone leaf: nothing in
# lib/ or run.sh imports it; it only WRITES tests/flows, never runs in the CI gate.
#
# Three modes:
#   scaffold <name> <startUrl>            Open headed, dump interactive snapshot + flow stub
#                                         to author against. No AI, no key.
#   capture  <name> <startUrl> [--app a]  RECORD a live user journey: open headed (from cached
#                                         AB_AUTH state if --app), inject bin/capture.js via
#                                         --init-script, you drive the page, press Enter (or
#                                         Ctrl-C) to stop; the captured raw events become
#                                         flows/<name>.flow.json via bin/build-flow.js. Real
#                                         input values go to a gitignored flows/<name>.values.json
#                                         sidecar ({{input_N}} tokens in the flow); sensitive
#                                         fields are masked at capture.
#   compile  <flow.json>                  Deterministic: flows/<name>.flow.json -> runnable
#                                         tests/<name>.test.sh. The load-bearing part.
#
# "Generate with AI, replay deterministically": authoring produces a flow once; the compiled
# .test.sh then runs through the verified harness with zero AI.
#
# Locator priority (most stable first): testid > role+name > label > exact-text > placeholder
# > title. Uniqueness is decided IN-PAGE by capture.js (host `get count` is CSS-only and cannot
# count semantic locators). No unique stable locator -> the step is needs_review (compile refuses).

set -euo pipefail
PROBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
	echo "usage:" >&2
	echo "  bin/probe-record.sh scaffold <name> <startUrl>           # snapshot + flow.json stub (no key)" >&2
	echo "  bin/probe-record.sh capture  <name> <startUrl> [--app a] [--seconds N] # record a live journey -> flow.json" >&2
	echo "  bin/probe-record.sh compile  <flows/name.flow.json>      # flow.json -> runnable test.sh" >&2
	exit 2
}

# --- compile: flow.json -> test.sh (deterministic, the load-bearing part) ---
compile() {
	local flow="$1"
	[ -s "$flow" ] || { echo "[probe] no such flow: $flow" >&2; exit 1; }

	# FAIL-LOUD on needs_review steps. The step jq below uses `else empty` and would otherwise
	# SILENTLY DROP an unresolved step; refuse instead so a fragile/incomplete flow can never
	# compile to a green-but-wrong test.
	if ! jq -e '[.steps[] | select(.needs_review==true)] | length==0' "$flow" >/dev/null 2>&1; then
		jq -r '.steps | to_entries[] | select(.value.needs_review==true)
			| "  needs_review step #\(.key): " + ((.value.candidates // []) | map(.by+":"+.value) | join(", "))' "$flow" >&2
		echo "[probe] compile refused: $flow has needs_review step(s); resolve them (pick a unique locator) first." >&2
		exit 1
	fi

	local name app starturl
	name="$(jq -r '.name' "$flow")"
	app="$(jq -r '.app // empty' "$flow")"
	starturl="$(jq -r '.startUrl' "$flow")"
	local out="${PROBE_ROOT}/tests/${name}.test.sh"

	# Build the runnable body lines. Steps become agent-browser `batch` commands EXCEPT
	# `wait until:url`, which compiles to a `wait_url` poll (lib/assert.sh) because 0.27.0
	# `wait --url` hangs on glob patterns. So the body is a sequence of batch SEGMENTS split at
	# every url-wait: jq coalesces consecutive batch commands into one segment, base64-encodes
	# each (survives quotes/spaces/tokens), and emits `_run_batch '<b64>'` / `wait_url '<glob>'`.
	local body_lines
	body_lines="$(jq -r '
		.steps
		| map(
			if .kind == "find" then
				{t:"c", v:(["find", .by, .value, .action]
				 + (if .action == "select"
				      then (if .val then [.val] elif .text then [.text] else [] end)
				      else (if .text then [.text] elif .val then [.val] else [] end) end)
				 + (if .name then ["--name", .name] else [] end)
				 + (if (.by | test("^(text|label|placeholder|alt|title)$")) then ["--exact"] else [] end))}
			elif .kind == "wait" and .until == "url" then {t:"w", v:.value}
			elif .kind == "wait" then {t:"c", v:["wait", ("--" + .until), .value]}
			elif .kind == "press" then {t:"c", v:["press", .value]}
			else empty end)
		| reduce .[] as $s ([];
			if $s.t == "w" then . + [{w:$s.v}]
			elif (length > 0 and (.[-1] | has("b"))) then (.[0:-1] + [{b:(.[-1].b + [$s.v])}])
			else . + [{b:[$s.v]}] end)
		| .[]
		| if has("w") then ("wait_url " + (.w | @sh))
		  else ("_run_batch " + ((.b | @json | @base64) | @sh)) end
	' "$flow")"

	# Build assert_* lines.
	local assert_lines
	assert_lines="$(jq -r '.asserts[] |
		if .kind == "url"     then "assert_url   " + (.value|@sh)
		elif .kind == "text"  then "assert_text  " + (.value|@sh)
		elif .kind == "value" then "assert_value " + (.selector|@sh) + " " + (.text|@sh)
		elif .kind == "visible" then "assert_visible " + (.selector|@sh)
		elif .kind == "count" then "assert_count " + (.selector|@sh) + " " + (.n|tostring)
		elif .kind == "absent" then "assert_absent " + (.selector|@sh)
		else empty end' "$flow")"

	# Open line: authed (AB_AUTH <app>) or plain (AB open).
	local open_line
	if [ -n "$app" ]; then
		open_line="AB_AUTH $(printf '%q' "$app") open $(printf '%q' "$starturl") >/dev/null"
	else
		open_line="AB open $(printf '%q' "$starturl") >/dev/null"
	fi

	{
		echo '#!/usr/bin/env bash'
		echo "# tests/${name}.test.sh — COMPILED from flows/${name}.flow.json by bin/probe-record.sh."
		echo '# Edit the .flow.json and recompile, or edit here directly (then this becomes the source).'
		echo 'set -euo pipefail'
		echo 'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"'
		echo 'source "$DIR/lib/env.sh"'
		echo 'source "$DIR/lib/cleanup.sh"'
		echo 'source "$DIR/lib/assert.sh"'
		echo ''
		echo "$open_line"
		echo 'AB record start "$ARTDIR/video.webm" >/dev/null'
		echo ''
		# _run_batch helper: decode a base64 batch template, substitute {{input_N}} tokens from the
		# gitignored values sidecar at RUNTIME (so PII never enters the committed test/flow), then
		# run it — fail loud on any unfilled token. One helper, called per batch segment; harmless
		# (walk no-ops) for token-free flows, so all batches go through the same path.
		if printf '%s' "$body_lines" | grep -q '_run_batch'; then
			echo "_VALUES_FILE=\"\$DIR/flows/${name}.values.json\""
			cat <<'HELPEOF'
_VALUES_JSON="{}"; [ -s "$_VALUES_FILE" ] && _VALUES_JSON="$(cat "$_VALUES_FILE")"
_run_batch() {
	local _body
	_body="$(printf %s "$1" | base64 -d | jq -c --argjson v "$_VALUES_JSON" \
		'walk(if type=="string" then gsub("[{][{](?<k>[A-Za-z0-9_]+)[}][}]"; ($v[.k] // ("__AQA_MISSING__"+.k))) else . end)')"
	case "$_body" in
		*__AQA_MISSING__*) echo "  ✗ missing value(s) in $_VALUES_FILE — fill the gitignored sidecar before replay" >&2; exit 1 ;;
	esac
	BATCH --bail <<<"$_body"
}
HELPEOF
			echo ''
		fi
		echo "$body_lines"
		echo ''
		echo "$assert_lines"
		echo ''
		echo "echo \"  ✓ ${name}.test.sh passed\""
	} > "$out"

	echo "[probe] compiled -> $out"
}

# --- scaffold: capture a snapshot + emit a flow.json stub to author against ---
scaffold() {
	local name="$1" starturl="$2"
	local sess="probe-${name}-$$"
	local snap="${PROBE_ROOT}/flows/${name}.snapshot.txt"
	local stub="${PROBE_ROOT}/flows/${name}.flow.json"

	echo "[probe] opening $starturl (headed) for authoring..."
	agent-browser --session "$sess" --headed open "$starturl" >/dev/null
	agent-browser --session "$sess" wait --load networkidle >/dev/null 2>&1 || true
	agent-browser --session "$sess" snapshot -i > "$snap" 2>/dev/null || true
	agent-browser --session "$sess" close >/dev/null 2>&1 || true
	echo "[probe] interactive snapshot -> $snap"

	if [ -s "$stub" ]; then
		echo "[probe] $stub already exists; left untouched."
	else
		jq -n --arg name "$name" --arg url "$starturl" \
			'{name:$name, startUrl:$url, steps:[], asserts:[]}' > "$stub"
		echo "[probe] flow stub -> $stub (fill in steps/asserts, then: compile)"
	fi
	echo "[probe] locator priority: testid > role+name > label > exact-text > placeholder > title"
}

# --- capture: record a live user journey -> flow.json (+ gitignored values sidecar) ---
# Headed + human-driven. Injects bin/capture.js via --init-script (the listener buffers actions
# into sessionStorage, surviving same-origin navigation — proven by the Phase 0 PoC). On stop
# (Enter / Ctrl-C) the buffer is drained ONCE and handed to build-flow.js. Same-origin journeys
# are the supported v1 scope (cross-origin top-level nav is a documented limitation).
# Test/CI hooks: AQA_CAPTURE_SECONDS=N auto-stops after N s; AQA_CAPTURE_SESSION pins the session.
capture() {
	local name="$1" starturl="$2"; shift 2
	local app="" secs="${AQA_CAPTURE_SECONDS:-0}"
	while [ $# -gt 0 ]; do
		case "${1:-}" in
			--app) app="${2:-}"; shift 2 ;;
			--seconds) secs="${2:-0}"; shift 2 ;;
			*) usage ;;
		esac
	done

	local capjs="${PROBE_ROOT}/bin/capture.js"
	[ -s "$capjs" ] || { echo "[probe] missing $capjs" >&2; exit 1; }
	local builder="${PROBE_ROOT}/bin/build-flow.js"
	[ -s "$builder" ] || { echo "[probe] missing $builder" >&2; exit 1; }

	local sess="${AQA_CAPTURE_SESSION:-capture-${name}-$$}"
	export AGENT_BROWSER_HEADED=1   # B3: capture is human-driven; config defaults headless

	# Cached login state for --app (replicate AB_AUTH; capture is standalone).
	local state_args=()
	if [ -n "$app" ]; then
		local state="${PROBE_ROOT}/fixtures/auth/${app}.state.json"
		[ -s "$state" ] || { echo "[probe] no cached state for '$app' ($state). Run setup/auth.sh first." >&2; exit 1; }
		state_args=(--state "$state")
	fi

	local recfile; recfile="$(mktemp)"; echo '[]' > "$recfile"
	local flushed=0
	# Drain the in-page buffer ONCE, then close. Judged via jq .success: a dead browser FAILS
	# LOUD (write nothing) rather than emitting an empty flow.json. Idempotent (Enter + Ctrl-C
	# + EXIT trap all funnel here).
	_flush_once() {
		[ "$flushed" = 1 ] && return 0
		flushed=1
		local out ok
		out="$(agent-browser --session "$sess" eval --json \
			"JSON.parse(sessionStorage.getItem('__aqa_buf')||'[]')" 2>/dev/null || true)"
		ok="$(printf '%s' "$out" | jq -r '.success // false' 2>/dev/null || echo false)"
		if [ "$ok" != "true" ]; then
			echo "[probe] FATAL: could not drain capture buffer (browser closed/unreachable). Nothing written." >&2
			agent-browser --session "$sess" close >/dev/null 2>&1 || true
			return 1
		fi
		printf '%s' "$out" | jq '.data.result' > "$recfile"
		agent-browser --session "$sess" close >/dev/null 2>&1 || true
	}
	trap '_flush_once || true' INT EXIT

	echo "[probe] opening $starturl (headed). DRIVE YOUR JOURNEY, then press Enter (or Ctrl-C) to stop."
	agent-browser --session "$sess" "${state_args[@]+"${state_args[@]}"}" --headed \
		open --init-script "$capjs" "$starturl" >/dev/null 2>&1 \
		|| { echo "[probe] open failed (is agent-browser healthy? try: agent-browser doctor)" >&2; exit 1; }

	if [ "$secs" -gt 0 ] 2>/dev/null; then
		echo "[probe] recording for ${secs}s, then auto-stop. Do your journey in the browser now..."
		sleep "$secs"
	elif [ -r /dev/tty ]; then
		# read from the controlling terminal, not stdin: when launched via record.cmd
		# (cmd -> bash) stdin is not interactive and a plain `read` returns EOF instantly,
		# closing the window before the user does anything.
		printf '\n>>> Recording. Do your journey in the browser window, then press ENTER here to stop...\n'
		read -r _ </dev/tty || true
	else
		read -r _ || true
	fi

	_flush_once || exit 1
	trap - INT EXIT

	local n; n="$(jq 'length' "$recfile" 2>/dev/null || echo 0)"
	echo "[probe] captured $n raw event(s) -> building flow..."
	node "$builder" "$name" "$starturl" "$app" "$recfile" "${PROBE_ROOT}/flows"
	rm -f "$recfile"
	echo "[probe] next: resolve any needs_review in flows/${name}.flow.json, then: bin/probe-record.sh compile flows/${name}.flow.json"
}

case "${1:-}" in
	scaffold) shift; [ $# -eq 2 ] || usage; scaffold "$1" "$2" ;;
	capture)  shift; [ $# -ge 2 ] || usage; capture "$@" ;;
	compile)  shift; [ $# -eq 1 ] || usage; compile "$1" ;;
	*) usage ;;
esac
