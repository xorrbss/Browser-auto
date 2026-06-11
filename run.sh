#!/usr/bin/env bash
# run.sh — the suite runner and CI gate. `bash run.sh [test-name-glob]`.
#
# Orchestration only; it owns the run-level concerns that no single test should:
# preflight, a stable RUN_ID for artifact grouping, iterating tests/*.test.sh in
# isolated subshells, and aggregating pass/fail into a report. Exit 1 if ANY test
# failed - this is the CI gate.
#
# Dependency direction is one-way: run.sh -> lib/* (leaves) and run.sh spawns tests
# (which source lib/* themselves). Tests never import run.sh; lib/* never import run.sh.

set -euo pipefail

PROBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PROBE_ROOT

# RUN_ID groups every artifact from this invocation under artifacts/<RUN_ID>/.
# Timestamp-based; $$ disambiguates same-second runs. Passed explicitly to each test below.
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
export RUN_ID
RUN_DIR="${PROBE_ROOT}/artifacts/${RUN_ID}"
mkdir -p "$RUN_DIR"

AQA_PREFLIGHT_MANUAL=1 source "${PROBE_ROOT}/lib/preflight.sh"
preflight_run_suite
source "${PROBE_ROOT}/lib/report.sh"

REPORT_TSV="${RUN_DIR}/results.tsv"
: > "$REPORT_TSV"

# Select tests: optional glob arg (e.g. `bash run.sh login`) else all *.test.sh.
GLOB="${1:-*}"
EXPLICIT_GLOB=1
[ $# -gt 0 ] || EXPLICIT_GLOB=0
shopt -s nullglob
TESTS=( "${PROBE_ROOT}/tests/"${GLOB}".test.sh" )
shopt -u nullglob

# Drop scaffold tests: an underscore-prefixed name (tests/_*.test.sh) is a THROWAWAY compiled flow
# that a unit test (compile-engine-unit / build-flow-unit / play-flow-smoke) writes, runs, and deletes
# within its own run. Excluding them here means a hard-crash straggler can never be globbed as a real
# suite test (which would false-fail the gate). Real tests never start '_'.
_kept=()
for _t in "${TESTS[@]}"; do
	case "$(basename "$_t")" in _*) continue ;; esac
	_kept+=("$_t")
done
TESTS=( ${_kept[@]+"${_kept[@]}"} )

# Default suite policy: keep the portable CI gate local-only. Tests compiled
# from flows with an app require local Playwright auth state; flows labelled
# staging/live-readonly/live-action are manual lanes unless explicitly selected
# or opted in.
if [ "$EXPLICIT_GLOB" -eq 0 ]; then
	_kept=()
	_skipped_live_auth=()
	_skipped_nonlocal=()
	_skipped_unreadable=()
	_skipped_aggregate=()
	for _t in "${TESTS[@]}"; do
		_name="$(basename "$_t" .test.sh)"
		# security-p0-gate is an aggregator that re-runs other suite tests; its members already run
		# individually in the default suite, so running the bundle here would double-run ~48 tests.
		# It stays available as an explicit standalone gate: `bash run.sh security-p0-gate`.
		if [ "$_name" = "security-p0-gate" ]; then
			_skipped_aggregate+=("$_name")
			continue
		fi
		_flow="${PROBE_ROOT}/flows/${_name}.flow.json"
		if [ -s "$_flow" ]; then
			if ! _meta="$(jq -r '[ (.app // ""), (.environment // "local"), (.riskClass // "read") ] | @tsv' "$_flow" 2>/dev/null)"; then
				_skipped_unreadable+=("$_name")
				continue
			fi
			IFS=$'\t' read -r _app _env _risk <<EOF
$_meta
EOF
			if ! preflight_is_truthy "${AQA_INCLUDE_LIVE_AUTH:-}" && [ -n "$_app" ]; then
				_skipped_live_auth+=("$_name")
				continue
			fi
			if ! preflight_is_truthy "${AQA_INCLUDE_NONLOCAL:-}" && [ "$_env" != "local" ]; then
				_skipped_nonlocal+=("$_name($_env)")
				continue
			fi
		fi
		_kept+=("$_t")
	done
	if [ "${#_skipped_unreadable[@]}" -gt 0 ]; then
		printf '[run] skipped flow test(s) with unreadable metadata from default suite: %s\n' "${_skipped_unreadable[*]}"
		echo "[run] pass an explicit glob to run them and surface the flow error."
	fi
	if [ "${#_skipped_live_auth[@]}" -gt 0 ]; then
		printf '[run] skipped live-auth test(s) from default suite: %s\n' "${_skipped_live_auth[*]}"
		echo "[run] set AQA_INCLUDE_LIVE_AUTH=1 or pass an explicit glob to include them."
	fi
	if [ "${#_skipped_nonlocal[@]}" -gt 0 ]; then
		printf '[run] skipped non-local flow test(s) from default suite: %s\n' "${_skipped_nonlocal[*]}"
		echo "[run] set AQA_INCLUDE_NONLOCAL=1 plus the needed run-mode/auth env, or pass an explicit glob."
	fi
	if [ "${#_skipped_aggregate[@]}" -gt 0 ]; then
		printf '[run] skipped aggregator test(s) whose members run individually: %s\n' "${_skipped_aggregate[*]}"
		echo "[run] run the bundled gate explicitly with: bash run.sh security-p0-gate"
	fi
	TESTS=( ${_kept[@]+"${_kept[@]}"} )
fi

if [ "${#TESTS[@]}" -eq 0 ]; then
	echo "[run] no tests matched 'tests/${GLOB}.test.sh'" >&2
	exit 1
fi

echo "[run] RUN_ID=$RUN_ID  tests=${#TESTS[@]}"
overall_rc=0

for t in "${TESTS[@]}"; do
	name="$(basename "$t" .test.sh)"
	echo ""
	echo "[run] === $name ==="
	start="$(date +%s%3N)"
	# Each test runs in its own bash so a failed `set -e` aborts only that test.
	# We capture the exit code rather than letting it abort the suite.
	if RUN_ID="$RUN_ID" PROBE_ROOT="$PROBE_ROOT" bash "$t"; then
		status="pass"
	else
		status="fail"
		overall_rc=1
	fi
	end="$(date +%s%3N)"
	dur=$(( end - start ))
	printf '%s\t%s\t%s\t%s\n' "$name" "$status" "$dur" "${RUN_DIR}/${name}" >> "$REPORT_TSV"
	echo "[run] $name: $status (${dur}ms)"
done

report_emit "$REPORT_TSV" "$RUN_DIR"

exit $overall_rc
