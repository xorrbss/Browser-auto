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
export PROBE_ROOT

ensure_authoring_daemon() {
	[ "${AQA_DAEMON_ENSURED:-0}" = "1" ] && return 0
	# shellcheck source=../lib/daemon.sh
	source "$PROBE_ROOT/lib/daemon.sh"
	ensure_daemon
	export AQA_DAEMON_ENSURED=1
}

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

	# FAIL-LOUD on iframe (frame-scoped) steps: the agent-browser TEST path cannot scope into an iframe (a
	# documented ceiling — flows/SCHEMA.md). A `frame` step is replayable ONLY via the Playwright flow-runner
	# (the effectful path), never compiled to a test.sh — refuse rather than silently run the find on the TOP
	# frame (a wrong-element false-green).
	if ! jq -e '[.steps[] | select(.frame!=null)] | length==0' "$flow" >/dev/null 2>&1; then
		jq -r '.steps | to_entries[] | select(.value.frame!=null)
			| "  iframe step #\(.key): frame \(.value.frame.by):\(.value.frame.value)"' "$flow" >&2
		echo "[probe] compile refused: $flow has iframe (frame) step(s) — the agent-browser test path can't scope into frames; replay via the Playwright flow-runner (effectful path) instead." >&2
		exit 1
	fi

	# FAIL-LOUD on any UNRECOGNIZED step/assert kind. The step/assert jq below both end in `else
	# empty`, which would silently DROP an unknown (typo'd or future) kind and compile a green-but-
	# incomplete test — the exact false-green this framework forbids. Refuse instead of dropping.
	local bad_kinds
	bad_kinds="$(jq -r '
		[ (.steps[]?   | select((.kind|tostring) | test("^(find|wait|press|scroll)$") | not)             | "step:"   + (.kind|tostring)),
		  (.asserts[]? | select((.kind|tostring) | test("^(url|text|value|visible|count|absent)$") | not) | "assert:" + (.kind|tostring)) ]
		| unique | .[]' "$flow")"
	if [ -n "$bad_kinds" ]; then
		echo "[probe] compile refused: $flow has unrecognized kind(s) (the compiler would silently drop them):" >&2
		printf '  %s\n' $bad_kinds >&2
		exit 1
	fi

	local name app starturl
	name="$(jq -r '.name' "$flow")"
	app="$(jq -r '.app // empty' "$flow")"
	starturl="$(jq -r '.startUrl' "$flow")"
	local out="${PROBE_ROOT}/tests/${name}.test.sh"

	# REPLAY FALLBACK (opt-in: flow.replayFallback==true). Build a per-step ladder of
	# capture-time-UNIQUE sibling candidates from the gitignored candidates sidecar so a transient
	# PRIMARY-locator failure at replay retries down the ladder instead of going red (flake
	# reduction). Absent/false => fb_json stays "{}" and the body jq below is byte-identical to the
	# no-fallback path (existing flows unchanged by construction). The eligibility filter is the
	# SAME bar capture applied to a primary (count==1, not overLong, engine-supported locator, not
	# the primary itself), so a fallback is never weaker than the primary it stands in for. The
	# residual wrong-element risk (cardinality!=identity at replay) is surfaced LOUDLY by _find_fb;
	# see flows/SCHEMA.md. This only helps RESOLVED steps: needs_review steps have no count==1
	# candidate by definition, so this is resilience, not a needs_review reducer.
	local replay_fallback fb_json="{}"
	replay_fallback="$(jq -r '.replayFallback // false' "$flow")"
	if [ "$replay_fallback" = "true" ]; then
		local candfile="${PROBE_ROOT}/flows/${name}.candidates.json"
		[ -s "$candfile" ] || { echo "[probe] compile refused: replayFallback set but no candidates sidecar ($candfile). Re-capture (or remove replayFallback)." >&2; exit 1; }
		local cand_steps flow_steps
		cand_steps="$(jq -r '._steps // empty' "$candfile" 2>/dev/null || true)"
		flow_steps="$(jq -r '.steps | length' "$flow")"
		{ [ -n "$cand_steps" ] && [ "$cand_steps" = "$flow_steps" ]; } || { echo "[probe] compile refused: candidates sidecar stale/unreadable (sidecar steps='${cand_steps:-?}' != flow steps=$flow_steps). Re-capture before compiling with replayFallback." >&2; exit 1; }
		fb_json="$(jq -c --slurpfile cand "$candfile" '
			($cand[0].byStep // {}) as $by
			| [ .steps | to_entries[] | .key as $i | .value as $s
			    | select($s.kind=="find" and ($s.needs_review|not) and ($s.by!=null))
			    | { key: ($i|tostring),
			        value: ( ($by[($i|tostring)] // [])
			                 | map(select(
			                     (.count==1)
			                     and ((.value|length) <= 80)
			                     and ((.name==null) or ((.name|length) <= 80))
			                     and (.by != "role")
			                     and ((.by != $s.by) or (.value != $s.value) or (((.name // "")) != ($s.name // ""))) ))
			                 | map({by, value} + (if .name then {name} else {} end)) ) }
			    | select(.value | length > 0) ]
			| from_entries
		' "$flow")"
		[ "$fb_json" = "{}" ] && echo "[probe] NOTE: replayFallback set but no step had a usable (count==1, engine-supported, <=80c) fallback candidate -- compiling without fallback." >&2 || true
	fi

	# Build the runnable body lines. Steps become agent-browser `batch` commands EXCEPT
	# `wait until:url`, which compiles to a `wait_url` poll (lib/assert.sh) because 0.27.0
	# `wait --url` hangs on glob patterns. So the body is a sequence of batch SEGMENTS split at
	# every url-wait: jq coalesces consecutive batch commands into one segment, base64-encodes
	# each (survives quotes/spaces/tokens), and emits `_run_batch '<b64>'` / `wait_url '<glob>'`.
	local body_lines
	body_lines="$(jq -r --argjson fb "$fb_json" '
		def findcmd($s):
			["find", $s.by, $s.value, $s.action]
			+ (if $s.action == "select"
			     then (if $s.val then [$s.val] elif $s.text then [$s.text] else [] end)
			     else (if $s.text then [$s.text] elif $s.val then [$s.val] else [] end) end)
			+ (if $s.name then ["--name", $s.name] else [] end)
			+ (if ($s.by | test("^(text|label|placeholder|alt|title|role)$")) then ["--exact"] else [] end);
		.steps
		| to_entries
		| map(.key as $i | .value as $s |
			if $s.kind == "find" then
				( ($fb[$i|tostring]) as $flist |
				  if ($flist | type) == "array" and ($flist | length) > 0
				  then {t:"f", v:( [findcmd($s)] + ($flist | map(findcmd(. + {action:$s.action} + (if $s.text then {text:$s.text} else {} end) + (if $s.val then {val:$s.val} else {} end)))) )}
				  else {t:"c", v:findcmd($s)} end )
			elif $s.kind == "wait" and $s.until == "url" then {t:"w", v:$s.value}
			elif $s.kind == "wait" then {t:"c", v:["wait", ("--" + $s.until), $s.value]}
			elif $s.kind == "press" then {t:"c", v:["press", $s.value]}
			elif $s.kind == "scroll" then {t:"s", v:[$s.dir, ($s.px|tostring)]}
			else empty end)
		| reduce .[] as $s ([];
			if $s.t == "w" then . + [{w:$s.v}]
			elif $s.t == "f" then . + [{f:$s.v}]
			elif $s.t == "s" then . + [{s:$s.v}]
			elif (length > 0 and (.[-1] | has("b"))) then (.[0:-1] + [{b:(.[-1].b + [$s.v])}])
			else . + [{b:[$s.v]}] end)
		| .[]
		| if has("w") then ("wait_url " + (.w | @sh))
		  elif has("f") then ("_find_fb " + ((.f | @json | @base64) | @sh))
		  elif has("s") then ("AB scroll " + (.s[0]|@sh) + " " + (.s[1]|@sh))
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
		# Runtime helpers baked into the test. _run_batch decodes a base64 batch template and
		# substitutes {{input_N}} tokens from the gitignored values sidecar (PII never enters the
		# committed test/flow), failing loud on any unfilled token. _find_fb (opt-in replayFallback)
		# tries a primary locator then capture-time-unique fallbacks, logging loudly on any fallback.
		# Both read $_VALUES_JSON, so define it once if EITHER helper appears. Order: values, then
		# helpers, then a trailing blank — kept byte-identical to the pre-fallback output whenever no
		# _find_fb is present (so existing flows recompile unchanged).
		if printf '%s' "$body_lines" | grep -Eq '_run_batch|_find_fb'; then
			echo "_VALUES_FILE=\"\$DIR/flows/${name}.values.json\""
			cat <<'HELPEOF'
_VALUES_JSON="{}"; [ -s "$_VALUES_FILE" ] && _VALUES_JSON="$(cat "$_VALUES_FILE")"
HELPEOF
		fi
		if printf '%s' "$body_lines" | grep -q '_run_batch'; then
			cat <<'HELPEOF'
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
		fi
		if printf '%s' "$body_lines" | grep -q '_find_fb'; then
			cat <<'HELPEOF'
_find_fb() {
	# Opt-in replay fallback (flow.replayFallback). $1 = base64 of [primaryCmd, fallbackCmd...],
	# each a `find` argv array. Substitute {{input_N}} tokens (fail-loud on missing), then try each
	# command as a SINGLE-command `batch --json` (same stdin-JSON path as _run_batch — dodges the
	# shell token-splitting trap for values with spaces) judging .[0].success: the FIRST success
	# returns 0; a fallback (index>0) is logged LOUDLY; if every command fails the step FAILS
	# (return 1) — never a silent false-green.
	local _cmds _n _i _suc _primary _desc _one _out _err=""
	_cmds="$(printf %s "$1" | base64 -d | jq -c --argjson v "$_VALUES_JSON" \
		'walk(if type=="string" then gsub("[{][{](?<k>[A-Za-z0-9_]+)[}][}]"; ($v[.k] // ("__AQA_MISSING__"+.k))) else . end)')"
	case "$_cmds" in
		*__AQA_MISSING__*) echo "  ✗ missing value(s) in $_VALUES_FILE — fill the gitignored sidecar before replay" >&2; exit 1 ;;
	esac
	_primary="$(printf %s "$_cmds" | jq -r '.[0] | join(" ")')"
	_n="$(printf %s "$_cmds" | jq 'length')"
	for (( _i=0; _i<_n; _i++ )); do
		_one="$(printf %s "$_cmds" | jq -c "[.[$_i]]")"
		_out="$(AB batch --json <<<"$_one" 2>/dev/null || true)"
		_suc="$(printf %s "$_out" | jq -r '.[0].success // false' 2>/dev/null || echo false)"
		[ "$_i" = 0 ] && _err="$(printf %s "$_out" | jq -r '.[0].error // empty' 2>/dev/null || true)"
		if [ "$_suc" = "true" ]; then
			if [ "$_i" -gt 0 ]; then
				_desc="$(printf %s "$_cmds" | jq -r ".[$_i] | join(\" \")")"
				echo "  ⚠ FALLBACK: primary [$_primary] failed; replayed via capture-time-unique fallback #$_i [$_desc]. Verify the page did not drift to a wrong element." >&2
			fi
			return 0
		fi
	done
	echo "  ✗ _find_fb: no locator resolved — primary [$_primary]${_err:+ -> $_err} ($((_n-1)) fallback(s) also failed)" >&2
	return 1
}
HELPEOF
		fi
		if printf '%s' "$body_lines" | grep -Eq '_run_batch|_find_fb'; then echo ''; fi
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
	ensure_authoring_daemon
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
		# SAME-ORIGIN iframes SHARE the top sessionStorage (empirically verified), so the top-frame drain
		# ALREADY collects their (frame_ref-tagged) events — no per-frame merge. CROSS-ORIGIN iframes have
		# separate, unreadable storage: count them (sessionStorage access throws) to WARN that any actions
		# inside them were NOT captured (the documented cross-origin ceiling).
		out="$(agent-browser --session "$sess" eval --json \
			"({buf:JSON.parse(sessionStorage.getItem('__aqa_buf')||'[]'),seq:(parseInt(sessionStorage.getItem('__aqa_seq')||'0',10)||0),xoFrames:(function(){var n=0;for(var i=0;i<window.frames.length;i++){try{window.frames[i].sessionStorage.getItem('__aqa_buf');}catch(e){n++;}}return n;})()})" 2>/dev/null || true)"
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
		local xo_frames; xo_frames="$(printf '%s' "$out" | jq -r '.data.result.xoFrames // 0' 2>/dev/null || echo 0)"
		if [ "$xo_frames" -gt 0 ] 2>/dev/null; then
			echo "[probe] NOTE: $xo_frames cross-origin iframe(s) present — actions performed INSIDE them were NOT" >&2
			echo "[probe]   captured (same-origin iframes ARE captured; cross-origin is a ceiling). If your journey" >&2
			echo "[probe]   used a cross-origin iframe, that part is missing — review the flow before relying on it." >&2
		fi
		agent-browser --session "$sess" close >/dev/null 2>&1 || true
	}

	echo "[probe] opening $starturl (headed). DRIVE YOUR JOURNEY, then press Enter (or Ctrl-C) to stop."
	ensure_authoring_daemon
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
