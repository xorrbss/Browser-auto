#!/usr/bin/env bash
# run.sh — the suite runner and CI gate. `bash run.sh [test-name-glob]`.
#
# Orchestration only; it owns the daemon lifecycle and the run-level concerns that no
# single test should: preflight (ffmpeg/contract), a stable RUN_ID for artifact
# grouping, iterating tests/*.test.sh in isolated subshells, aggregating pass/fail into
# a report, and reaping the daemon. Exit 1 if ANY test failed — this is the CI gate.
#
# Dependency direction is one-way: run.sh -> lib/* (leaves) and run.sh spawns tests
# (which source lib/* themselves). Tests never import run.sh; lib/* never import run.sh.

set -euo pipefail

PROBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PROBE_ROOT

# RUN_ID groups every artifact from this invocation under artifacts/<RUN_ID>/.
# Timestamp-based; $$ disambiguates same-second runs. Exported so env.sh picks it up.
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
export RUN_ID
RUN_DIR="${PROBE_ROOT}/artifacts/${RUN_ID}"
mkdir -p "$RUN_DIR"

# Gate the environment ONCE (ffmpeg absolute-path inject lives here and, because we
# `source` it, the prepended PATH propagates to the test subshells we spawn next).
source "${PROBE_ROOT}/lib/preflight.sh"
source "${PROBE_ROOT}/lib/report.sh"

REPORT_TSV="${RUN_DIR}/results.tsv"
: > "$REPORT_TSV"

# Select tests: optional glob arg (e.g. `bash run.sh login`) else all *.test.sh.
GLOB="${1:-*}"
shopt -s nullglob
TESTS=( "${PROBE_ROOT}/tests/"${GLOB}".test.sh" )
shopt -u nullglob

# Drop scaffold tests: an underscore-prefixed name (tests/_*.test.sh) is a THROWAWAY compiled flow
# that a unit test (compile-fallback / replay-fallback) writes, runs, and deletes within its own run.
# Excluding them here means a hard-crash straggler can never be globbed as a real suite test (which
# would false-fail the gate — e.g. _rfb_red is designed to exit non-zero). Real tests never start '_'.
_kept=()
for _t in "${TESTS[@]}"; do
	case "$(basename "$_t")" in _*) continue ;; esac
	_kept+=("$_t")
done
TESTS=( ${_kept[@]+"${_kept[@]}"} )

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
	# Each test runs in its own bash so a failed `set -e` aborts only that test, and
	# its EXIT trap (record stop + session close) fires in isolation. We capture the
	# exit code rather than letting it abort the suite.
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

# Reap any daemon sessions left behind (best-effort; never changes the gate result).
agent-browser close --all >/dev/null 2>&1 || true

exit $overall_rc
