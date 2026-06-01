#!/usr/bin/env bash
# bin/probe-record.sh — authoring helper (Layer 2, opt-in). Standalone leaf: nothing
# in lib/ or run.sh imports it; it only WRITES tests/flows, never runs in the CI gate.
#
# Authoring model (no AI API key needed): an AI coding agent (e.g. Claude Code) — or a
# human — inspects the site with `agent-browser --headed snapshot -i`, writes a
# flows/<name>.flow.json of STABLE semantic locators (the schema has no @eN ref field,
# so staleness is impossible), and compiles it to a runnable test. We deliberately do
# NOT shell out to agent-browser's `chat` (that requires a Vercel AI Gateway key, and a
# capable agent is already authoring here — a second in-loop LLM would be redundant and
# unverifiable). "Generate with AI, replay deterministically": the agent generates the
# flow once; the compiled .test.sh then runs through the verified harness with zero AI.
#
#   bin/probe-record.sh scaffold <name> <startUrl>
#       Open <startUrl> headed, save its interactive snapshot to flows/<name>.snapshot.txt
#       (so the author can pick stable locators), and write a flows/<name>.flow.json stub
#       to fill in. No AI, no key.
#
#   bin/probe-record.sh compile <flow.json>
#       Deterministic: compile flows/<name>.flow.json into a runnable tests/<name>.test.sh.
#       The load-bearing, fully-verified part.
#
# Locator priority when authoring (most stable first), each verified unique via
# `get count --json == 1`: testid > role+name > label > exact-text > placeholder > title.

set -euo pipefail
PROBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
	echo "usage:" >&2
	echo "  bin/probe-record.sh scaffold <name> <startUrl>      # snapshot + flow.json stub (no key)" >&2
	echo "  bin/probe-record.sh compile  <flows/name.flow.json> # flow.json -> runnable test.sh" >&2
	exit 2
}

# --- compile: flow.json -> test.sh (deterministic, the load-bearing part) ---
# Renders each step/assert into the exact lib/ helper calls a hand-written test uses,
# so a compiled test is indistinguishable from a hand-written one and runs through the
# same verified harness. Interaction steps become a single BATCH body (one daemon
# round-trip, --bail + .success checked by lib/env.sh); asserts become assert_* lines.
compile() {
	local flow="$1"
	[ -s "$flow" ] || { echo "[probe] no such flow: $flow" >&2; exit 1; }

	local name app starturl
	name="$(jq -r '.name' "$flow")"
	app="$(jq -r '.app // empty' "$flow")"
	starturl="$(jq -r '.startUrl' "$flow")"
	local out="${PROBE_ROOT}/tests/${name}.test.sh"

	# Build the BATCH JSON body from steps (jq maps each step to an agent-browser
	# command array — find/wait — exactly the shapes verified in lib docs).
	local batch_body
	batch_body="$(jq -c '[.steps[] |
		if .kind == "find" then
			(["find", .by, .value]
			 + (if .name then ["--name", .name] else [] end)
			 + [.action]
			 + (if .text then [.text] elif .val then [.val] else [] end))
		elif .kind == "wait" then
			["wait", ("--" + .until), .value]
		else empty end ]' "$flow")"

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
		echo 'BATCH --bail <<JSON'
		echo "$batch_body"
		echo 'JSON'
		echo ''
		echo "$assert_lines"
		echo ''
		echo "echo \"  ✓ ${name}.test.sh passed\""
	} > "$out"

	echo "[probe] compiled -> $out"
}

# --- scaffold: capture a snapshot + emit a flow.json stub to author against ---
# No AI, no key. Opens the page headed so the author can see it, dumps the interactive
# accessibility tree (the menu of stable locators) to a .snapshot.txt, and writes a
# minimal flow.json stub. The author (a coding agent or human) then fills in steps using
# locators read off the snapshot, and runs `compile`.
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
	echo "[probe] verify each is unique:  agent-browser get count '<sel>' --json  (.data.count == 1)"
}

case "${1:-}" in
	scaffold) shift; [ $# -eq 2 ] || usage; scaffold "$1" "$2" ;;
	compile)  shift; [ $# -eq 1 ] || usage; compile "$1" ;;
	*) usage ;;
esac
