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
	echo "  bin/probe-record.sh verify   <flows/name.flow.json>      # re-drive + verify/repair locators (optional)" >&2
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
	} | tr -d '\r' > "$out"   # generated scripts are LF (.gitattributes enforces *.sh eol=lf)

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
			--app) [ $# -ge 2 ] || usage; app="$2"; shift 2 ;;
			--seconds) [ $# -ge 2 ] || usage; secs="$2"; shift 2 ;;
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
	# Web-drivable GRACEFUL stop: the interactive /dev/tty stop is unreachable from a non-tty spawn
	# (the web UI), so the UI signals a normal early finish by creating AQA_CAPTURE_STOPFILE. The
	# watch loops below break on it and fall through to the SAME drain path as --seconds auto-stop —
	# a COMPLETE capture, unlike a taskkill cancel (which yields a partial/degraded flow). We do NOT
	# delete a pre-existing file at startup: webui uses a FRESH timestamped path per recording and
	# removes it when the job ends, so there is never a stale file; deleting here would instead race a
	# stop click that landed in the sub-second window before this line runs (review: lost-signal race).
	# Standalone record.cmd leaves AQA_CAPTURE_STOPFILE unset → stopfile empty → the helper is never true.
	local stopfile="${AQA_CAPTURE_STOPFILE:-}"
	local flushed=0 degraded=0 cap_seq=0 cap_recovered=0 orig_tab="" newtab=0 _stopped=0 crossorigin=0 start_origin=""
	# Drain the in-page buffer ONCE, then close. Judged via jq .success: a dead browser FAILS
	# LOUD (write nothing) rather than emitting an empty flow.json. Idempotent (Enter + Ctrl-C
	# + EXIT trap all funnel here).
	#
	# Health-check (P1.3): the drain also reads __aqa_seq — the monotonic counter capture.js
	# bumps once per recorded action. In the happy path it equals the buffer length (every
	# record() advances seq AND pushes to the buffer). If sessionStorage.setItem silently threw
	# (quota / private mode), the buffer stops growing while seq keeps advancing, so seq >
	# recovered => events were lost. We surface that loudly and make capture() exit non-zero,
	# instead of quietly writing an incomplete flow.json. (design.md OPEN RISKS: sessionStorage quota.)
	_flush_once() {
		[ "$flushed" = 1 ] && return 0
		flushed=1
		local out ok
		# Drain the ORIGINAL tab (P1.4): a new tab/popup steals the active context and `eval`
		# targets the active tab, so without switching back we would read the (empty) new tab's
		# storage and lose the whole recording. Best-effort switch to the tab capture opened.
		[ -n "$orig_tab" ] && agent-browser --session "$sess" tab "$orig_tab" >/dev/null 2>&1 </dev/null || true
		out="$(agent-browser --session "$sess" eval --json \
			"({buf:JSON.parse(sessionStorage.getItem('__aqa_buf')||'[]'),seq:(parseInt(sessionStorage.getItem('__aqa_seq')||'0',10)||0)})" 2>/dev/null || true)"
		ok="$(printf '%s' "$out" | jq -r '.success // false' 2>/dev/null || echo false)"
		if [ "$ok" != "true" ]; then
			echo "[probe] FATAL: could not drain capture buffer (browser closed/unreachable). Nothing written." >&2
			agent-browser --session "$sess" close >/dev/null 2>&1 || true
			return 1
		fi
		printf '%s' "$out" | jq '.data.result.buf' > "$recfile"
		cap_seq="$(printf '%s' "$out" | jq -r '.data.result.seq // 0')"
		cap_recovered="$(jq 'length' "$recfile" 2>/dev/null || echo 0)"
		if [ "$cap_seq" -gt "$cap_recovered" ] 2>/dev/null; then
			degraded=1
			echo "[probe] WARNING: capture health-check FAILED — recorder advanced seq=$cap_seq but only" >&2
			echo "[probe]   $cap_recovered event(s) persisted ($(( cap_seq - cap_recovered )) lost — likely sessionStorage" >&2
			echo "[probe]   quota or private-mode). The recording is INCOMPLETE; re-record before trusting it." >&2
		fi
		agent-browser --session "$sess" close >/dev/null 2>&1 || true
	}

	echo "[probe] opening $starturl (headed). DRIVE YOUR JOURNEY, then press Enter (or Ctrl-C) to stop."
	agent-browser --session "$sess" "${state_args[@]+"${state_args[@]}"}" --headed \
		open --init-script "$capjs" "$starturl" >/dev/null 2>&1 \
		|| { echo "[probe] open failed (is agent-browser healthy? try: agent-browser doctor)" >&2; exit 1; }
	# Install the drain trap only AFTER a successful open: before this point there is no buffer
	# to drain, so an INT/EXIT here would print the misleading "could not drain" FATAL.
	trap '_flush_once || true; _stopped=1' INT EXIT

	# Remember the tab capture opened so we drain IT even if a new tab/popup later steals focus.
	orig_tab="$(agent-browser --session "$sess" tab list --json 2>/dev/null </dev/null \
		| jq -r '[.data.tabs[]? | select(.active==true) | .tabId][0] // "t1"' 2>/dev/null || echo t1)"

	# F6: clear any stale in-page capture state so a reused AQA_CAPTURE_SESSION cannot replay
	# stale events from a prior recording.
	agent-browser --session "$sess" eval "sessionStorage.setItem('__aqa_buf','[]');sessionStorage.setItem('__aqa_seq','0');sessionStorage.setItem('__aqa_prevurl',location.href);1" >/dev/null 2>&1 </dev/null || true

	# F5: a top-level cross-origin nav moves sessionStorage to a new empty origin, silently
	# losing events AND defeating the seq health-check. Remember the start origin to detect it.
	start_origin="$(printf '%s' "$starturl" | sed -E 's#^([a-zA-Z][a-zA-Z0-9+.-]*://[^/]+).*#\1#')"

	# Watch (ONE tab list --json call) for either an out-of-scope condition while waiting for the
	# stop signal (Enter / Ctrl-C / --seconds): a new tab/popup (single tab, single top-frame), or
	# a top-level cross-origin nav (sessionStorage moves origin, losing events). Either stops us so
	# we drain the original tab, write the partial flow, and fail loud — better than silently
	# missing actions.
	# True once the web UI has requested a graceful stop (file-based signal; tty-free).
	_stopfile_hit() { [ -n "$stopfile" ] && [ -f "$stopfile" ]; }
	_watch() {
		local out cnt aurl aorig
		out="$(agent-browser --session "$sess" tab list --json 2>/dev/null </dev/null || true)"
		cnt="$(printf '%s' "$out" | jq -r '[.data.tabs[]? | select(.type=="page")] | length' 2>/dev/null || echo 1)"
		[ "${cnt:-1}" -gt 1 ] 2>/dev/null && { newtab=1; return 0; }
		aurl="$(printf '%s' "$out" | jq -r '[.data.tabs[]? | select(.active==true) | .url][0] // ""' 2>/dev/null || echo "")"
		aorig="$(printf '%s' "$aurl" | sed -E 's#^([a-zA-Z][a-zA-Z0-9+.-]*://[^/]+).*#\1#')"
		case "$aorig" in http://*|https://*) [ -n "$start_origin" ] && [ "$aorig" != "$start_origin" ] && { crossorigin=1; return 0; } ;; esac
		return 1
	}

	if [ "$secs" -gt 0 ] 2>/dev/null; then
		echo "[probe] recording for ${secs}s, then auto-stop. Do your journey in the browser now..."
		local _end=$(( $(date +%s) + secs ))
		while [ "$(date +%s)" -lt "$_end" ]; do
			[ "$_stopped" = 1 ] && break
			_stopfile_hit && { echo "[probe] stop signal received — finishing capture." >&2; break; }
			if _watch; then break; fi
			sleep 1
		done
	elif [ -r /dev/tty ]; then
		# read from the controlling terminal, not stdin: when launched via record.cmd
		# (cmd -> bash) stdin is not interactive and a plain `read` returns EOF instantly,
		# closing the window before the user does anything. read -t 1 lets us also poll for tabs.
		printf '\n>>> Recording. Do your journey in the browser window, then press ENTER here to stop...\n'
		while :; do
			[ "$_stopped" = 1 ] && break
			_stopfile_hit && { echo "[probe] stop signal received — finishing capture." >&2; break; }
			if _watch; then break; fi
			if read -t 1 -r _ </dev/tty; then break; fi
		done
	else
		read -r _ || true
	fi
	[ "$newtab" = 1 ] && echo "[probe] new tab/popup detected — stopping (out of scope: single tab)." >&2 || true
	[ "$crossorigin" = 1 ] && echo "[probe] cross-origin navigation detected — out of scope (single origin)." >&2 || true

	_flush_once || exit 1
	trap - INT EXIT

	local n; n="$(jq 'length' "$recfile" 2>/dev/null || echo 0)"
	# F8: an empty capture must fail loud — build-flow.js would otherwise emit a vacuous
	# always-green flow with no steps. (Degraded recordings still build their partial flow so it
	# can be quarantined below.)
	if [ "${n:-0}" -eq 0 ] 2>/dev/null && [ "$degraded" != 1 ]; then
		echo "[probe] FATAL: captured 0 events — nothing to build (cross-origin nav, or init-script did not install?). Re-record." >&2
		exit 1
	fi
	echo "[probe] captured $n raw event(s) -> building flow..."
	node "$builder" "$name" "$starturl" "$app" "$recfile" "${PROBE_ROOT}/flows"
	rm -f "$recfile"
	# F7: build-flow.js writes flows/<name>.flow.json unconditionally; on each fatal branch
	# rename it first so a later `compile` can never accept an incomplete artifact as clean.
	if [ "$degraded" = 1 ]; then
		mv -f "${PROBE_ROOT}/flows/${name}.flow.json" "${PROBE_ROOT}/flows/${name}.flow.json.incomplete" 2>/dev/null || true
		echo "[probe] FATAL: capture health-check failed (see WARNING above) — flows/${name}.flow.json.incomplete is" >&2
		echo "[probe]   INCOMPLETE (events lost to sessionStorage quota/private-mode). Re-record before use." >&2
		exit 1
	fi
	if [ "$crossorigin" = 1 ]; then
		mv -f "${PROBE_ROOT}/flows/${name}.flow.json" "${PROBE_ROOT}/flows/${name}.flow.json.incomplete" 2>/dev/null || true
		echo "[probe] FATAL: a top-level cross-origin navigation occurred during recording (out of scope: single origin)." >&2
		echo "[probe]   flows/${name}.flow.json.incomplete holds only the ORIGINAL origin's actions; events after the" >&2
		echo "[probe]   cross-origin nav were NOT recorded. Re-record the journey within a single origin." >&2
		exit 1
	fi
	if [ "$newtab" = 1 ]; then
		mv -f "${PROBE_ROOT}/flows/${name}.flow.json" "${PROBE_ROOT}/flows/${name}.flow.json.incomplete" 2>/dev/null || true
		echo "[probe] FATAL: a new tab/popup opened during recording (out of scope: single tab)." >&2
		echo "[probe]   flows/${name}.flow.json.incomplete holds only the ORIGINAL tab's actions; new-tab steps were" >&2
		echo "[probe]   NOT recorded. Re-record the journey within a single tab if those steps are needed." >&2
		exit 1
	fi
	echo "[probe] next: resolve any needs_review in flows/${name}.flow.json, then: bin/probe-record.sh compile flows/${name}.flow.json"
}

case "${1:-}" in
	scaffold) shift; [ $# -eq 2 ] || usage; scaffold "$1" "$2" ;;
	capture)  shift; [ $# -ge 2 ] || usage; capture "$@" ;;
	verify)   shift; [ $# -eq 1 ] || usage; exec bash "${PROBE_ROOT}/bin/verify-flow.sh" "$1" ;;
	compile)  shift; [ $# -eq 1 ] || usage; compile "$1" ;;
	*) usage ;;
esac
