#!/usr/bin/env bash
# Phase 0 PoC runner. Proves an --init-script-injected listener (a) captures a real
# CDP click, (b) persists events across a same-origin navigation via sessionStorage,
# (c) keeps capturing after navigation. Uses FILE redirection (never a pipe / $()) so
# the cold-spawned daemon inheriting our stdout fd can't wedge the shell.
set -u
export PATH="/c/Users/dream/AppData/Roaming/npm:$PATH"
S="poc$$"
JS="/c/project/agent-qa/dev/active/record-capture-mode/poc-capture.js"
T="$(mktemp -d)"
run() {  # run <label> <agent-browser args...>
	local label="$1"; shift
	agent-browser --session "$S" "$@" >"$T/o" 2>&1 </dev/null
	local rc=$?
	echo "--- $label (exit=$rc) ---"
	cat "$T/o"
	echo
}
trap 'agent-browser --session "$S" close >/dev/null 2>&1 || true; rm -rf "$T"' EXIT

run "1 open A + init-script"   open "https://example.com" --init-script "$JS"
run "2 listener installed?"    eval --json "window.__agentqa_installed===true"
run "3 click h1 (page A)"      click "h1"
run "4 buffer on A"            eval --json "JSON.parse(sessionStorage.getItem('__agentqa_cap')||'[]')"
run "5 nav to B (same origin)" open "https://example.com/?nav=1"
run "6 re-injected on B?"      eval --json "window.__agentqa_installed===true"
run "7 buffer survived nav"    eval --json "JSON.parse(sessionStorage.getItem('__agentqa_cap')||'[]')"
run "8 click h1 (page B)"      click "h1"
run "9 buffer grew post-nav"   eval --json "JSON.parse(sessionStorage.getItem('__agentqa_cap')||'[]')"
echo "=== PoC DONE ==="
