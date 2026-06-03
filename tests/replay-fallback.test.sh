#!/usr/bin/env bash
# tests/replay-fallback.test.sh — LIVE mechanism test for opt-in replay fallback (flow.replayFallback),
# headless on example.com (the project's stable live site, as in verify-flow.test.sh). It hand-authors
# a 1-step flow + a count==1 candidate ladder, compiles it WITH the flag to a throwaway _rfb_*.test.sh,
# RUNS that compiled test, and asserts the end-to-end _find_fb behaviour. The framework's core promise
# is "never a false green", so the load-bearing case is #2: when NO locator resolves the run MUST go red.
#   1. bogus primary + a UNIQUE real fallback ("Example Domain") -> green, with a LOUD FALLBACK log.
#   2. bogus primary + bogus fallback -> the step FAILS -> non-zero exit (a false-green here would defeat
#      the whole framework).
#   3. real primary -> green AND no fallback fired (the opt-in path must not perturb a healthy run).
# Throwaway PID-namespaced _rfb_*_$$ names live in flows/ + tests/ (cleaned by an EXIT trap); run.sh
# excludes '_'-prefixed tests from the suite so a straggler can never be picked up as a real gate test.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail(){ echo "  ✗ replay-fallback: $1" >&2; exit 1; }

FL="$DIR/flows"
FIRE="_rfb_fire_$$"; RED="_rfb_red_$$"; OK="_rfb_ok_$$"   # PID-namespaced: concurrent runs never collide
NAMES="$FIRE $RED $OK"
cleanup(){ for n in $NAMES; do rm -f "$FL/$n.flow.json" "$FL/$n.candidates.json" "$FL/$n.values.json" "$DIR/tests/$n.test.sh"; done; }
trap cleanup EXIT
cleanup   # start clean

# mkflow injects .name=<name> so the JSON body stays name-agnostic (the runtime name carries $$).
mkflow(){ printf '%s\n' "$2" | jq --arg n "$1" '.name=$n' > "$FL/$1.flow.json"; }
mkcand(){ printf '%s\n' "{\"_steps\":1,\"byStep\":{\"0\":$2}}" > "$FL/$1.candidates.json"; }
# compile_run <name> -> sets RUN_LOG (stdout+stderr of the compiled test) and RC (its exit code).
RUN_LOG=""; RC=0
compile_run(){
	bash "$DIR/bin/probe-record.sh" compile "$FL/$1.flow.json" >/dev/null 2>&1 || fail "$1: compile failed (unexpected)"
	grep -qE '^_find_fb ' "$DIR/tests/$1.test.sh" || fail "$1: compiled test has no _find_fb call (fallback not baked)"
	# Strip video recording from the throwaway test: it is irrelevant to the _find_fb behaviour under
	# test, and the ffmpeg start/finalize is the dominant per-run cost (and a flakiness source). Safe —
	# lib/cleanup.sh's `record stop` no-ops when nothing was recorded.
	sed -i '/AB record start/d' "$DIR/tests/$1.test.sh"
	RUN_LOG="$(PROBE_ROOT="$DIR" bash "$DIR/tests/$1.test.sh" 2>&1)" && RC=0 || RC=$?
}

# --- 1. primary BOGUS; capture-time-unique fallback ("Example Domain" h1) RESOLVES -> green + LOUD log ---
mkflow "$FIRE" '{"replayFallback":true,"startUrl":"https://example.com","steps":[{"kind":"find","by":"text","value":"NoSuchPrimary_zzz","action":"hover"}],"asserts":[]}'
mkcand "$FIRE" '[{"by":"text","value":"NoSuchPrimary_zzz","count":1},{"by":"text","value":"Example Domain","count":1}]'
compile_run "$FIRE"
[ "$RC" = 0 ] || { printf '%s\n' "$RUN_LOG" | sed 's/^/    /' >&2; fail "fallback-fire expected exit 0 (the unique fallback should rescue), got $RC"; }
case "$RUN_LOG" in *FALLBACK*) : ;; *) fail "fallback-fire: expected a loud FALLBACK log line on stderr" ;; esac

# --- 2. primary AND fallback both BOGUS -> step fails -> RED (the no-false-green invariant) ---
mkflow "$RED" '{"replayFallback":true,"startUrl":"https://example.com","steps":[{"kind":"find","by":"text","value":"NoSuchPrimary_zzz","action":"hover"}],"asserts":[]}'
mkcand "$RED" '[{"by":"text","value":"NoSuchPrimary_zzz","count":1},{"by":"text","value":"AlsoNoSuch_qqq","count":1}]'
compile_run "$RED"
[ "$RC" != 0 ] || { printf '%s\n' "$RUN_LOG" | sed 's/^/    /' >&2; fail "all-locators-fail MUST exit non-zero (false-green!) — got 0"; }
case "$RUN_LOG" in *"no locator resolved"*) : ;; *) fail "all-fail: expected the 'no locator resolved' fail-loud line" ;; esac

# --- 3. primary REAL ("Example Domain") -> green, and NO fallback fired (no spurious log) ---
mkflow "$OK" '{"replayFallback":true,"startUrl":"https://example.com","steps":[{"kind":"find","by":"text","value":"Example Domain","action":"hover"}],"asserts":[]}'
mkcand "$OK" '[{"by":"text","value":"Example Domain","count":1},{"by":"text","value":"More information...","count":1}]'
compile_run "$OK"
[ "$RC" = 0 ] || { printf '%s\n' "$RUN_LOG" | sed 's/^/    /' >&2; fail "happy-path expected exit 0, got $RC"; }
case "$RUN_LOG" in *FALLBACK*) fail "happy-path: primary resolved, must NOT log a fallback" ;; esac

echo "  ✓ replay-fallback.test.sh passed"
