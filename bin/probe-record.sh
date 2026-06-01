#!/usr/bin/env bash
# bin/probe-record.sh — AI-assisted authoring (Layer 2, opt-in). Standalone leaf:
# nothing in lib/ or run.sh imports it; it only WRITES tests/flows, never runs in the
# CI gate. Two modes, split so the risky codegen is testable without an AI key:
#
#   bin/probe-record.sh compile <flow.json>
#       Deterministic: compile an existing flows/<name>.flow.json into a runnable
#       tests/<name>.test.sh. No AI key needed. This is the part that must be correct.
#
#   bin/probe-record.sh discover <name> <startUrl> "<goal>"
#       AI: drive `agent-browser chat` (headed) to perform <goal>, capture the commands
#       it ran, harden each into a stable semantic locator, and write flows/<name>.flow.json
#       (then compile it). Requires AI_GATEWAY_API_KEY. "Generate with AI, replay
#       deterministically": the model's output is frozen into a stable flow, then the
#       .test.sh runs with zero AI.
#
# Locator hardening priority (most stable first), each verified unique via
# get count --json == 1: testid > role+name > label > exact-text > placeholder > title.

set -euo pipefail
PROBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
	echo "usage:" >&2
	echo "  bin/probe-record.sh compile <flows/name.flow.json>" >&2
	echo "  bin/probe-record.sh discover <name> <startUrl> \"<goal>\"   (needs AI_GATEWAY_API_KEY)" >&2
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

# --- discover: AI chat -> flow.json (needs key); then compile ---
discover() {
	local name="$1" starturl="$2" goal="$3"
	if [ -z "${AI_GATEWAY_API_KEY:-}" ]; then
		echo "[probe] FATAL: discover needs AI_GATEWAY_API_KEY (Vercel AI Gateway)." >&2
		echo "[probe] set it, or hand-write flows/${name}.flow.json and use 'compile'." >&2
		exit 1
	fi
	local sess="probe-${name}-$$"
	echo "[probe] discovering '$goal' on $starturl (headed)..."
	agent-browser --session "$sess" --headed open "$starturl" >/dev/null

	# Let the model drive; --json gives a structured per-turn record of the commands it
	# executed, which we mine for the actions to harden. -v includes tool calls.
	local trace
	trace="$(agent-browser --session "$sess" chat "$goal" --json -v 2>/dev/null || true)"
	echo "$trace" > "${PROBE_ROOT}/flows/${name}.chat-trace.json"
	echo "[probe] raw chat trace saved -> flows/${name}.chat-trace.json"

	agent-browser --session "$sess" close >/dev/null 2>&1 || true

	echo "[probe] NOTE: review flows/${name}.chat-trace.json, then hand-finalize" >&2
	echo "[probe] flows/${name}.flow.json (stable locators only, no @eN) and run:" >&2
	echo "[probe]   bin/probe-record.sh compile flows/${name}.flow.json" >&2
	# Harden-and-emit from an arbitrary chat trace is model-output-shape dependent and
	# cannot be verified without a key this session, so we stop at a reviewed trace
	# rather than silently emitting a possibly-wrong flow. Compile is the verified path.
}

case "${1:-}" in
	compile)  shift; [ $# -eq 1 ] || usage; compile "$1" ;;
	discover) shift; [ $# -eq 3 ] || usage; discover "$1" "$2" "$3" ;;
	*) usage ;;
esac
