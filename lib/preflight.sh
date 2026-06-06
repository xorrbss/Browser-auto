#!/usr/bin/env bash
# lib/preflight.sh — environment gate. Run ONCE by run.sh before any test, and
# runnable standalone (`bash lib/preflight.sh`) to prove the riskiest assumption:
# that video actually records on this Windows box.
#
# Defuses three verified traps, each loudly (never silently green):
#  1. ffmpeg PATH: `record start` prints success even when ffmpeg is missing from the
#     DAEMON's PATH, then `record stop` silently writes no .webm. The user PATH is not
#     enough — a daemon spawned from a stale-PATH shell stays blind for life. So we
#     resolve ffmpeg.exe to an ABSOLUTE path and prepend its dir to PATH *before* the
#     first agent-browser command, then a 1-second record smoke-test HARD-FAILS if no
#     non-empty .webm appears.
#  2. exit-0 footgun contract: assert that `is`/`find` exit 0 on absent elements (the
#     premise all of assert.sh depends on). If a version bump changes it, fail loudly
#     so we revisit, rather than producing false results.
#  3. cold daemon (~12s): warm it once here so test timings are stable.
#
# Exits non-zero (failing the whole run) if any gate fails. Sources nothing from the
# framework — it is a leaf with no back-deps.

set -euo pipefail

PROBE_ROOT="${PROBE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

echo "[preflight] resolving ffmpeg..."

# Resolve ffmpeg.exe: explicit override -> PATH -> known winget Gyan.FFmpeg location.
_resolve_ffmpeg() {
	if [ -n "${FFMPEG_PATH:-}" ] && [ -x "$FFMPEG_PATH" ]; then echo "$FFMPEG_PATH"; return 0; fi
	if command -v ffmpeg >/dev/null 2>&1; then command -v ffmpeg; return 0; fi
	# Known winget Gyan.FFmpeg location. $USER is unset under Git Bash (set -u safe),
	# so derive the per-user WinGet Packages dir from LOCALAPPDATA/HOME instead.
	local local_appdata="${LOCALAPPDATA:-${HOME:-/c/Users/Default}/AppData/Local}"
	local winget_dir
	winget_dir="$(cygpath -u "$local_appdata" 2>/dev/null || printf '%s' "$local_appdata")/Microsoft/WinGet/Packages"
	local found
	found="$(ls "$winget_dir"/Gyan.FFmpeg*/ffmpeg-*-full_build/bin/ffmpeg.exe 2>/dev/null | head -1 || true)"
	if [ -n "$found" ] && [ -x "$found" ]; then echo "$found"; return 0; fi
	return 1
}

FFMPEG_BIN="$(_resolve_ffmpeg)" || {
	echo "[preflight] FATAL: ffmpeg not found (set FFMPEG_PATH, install via 'winget install Gyan.FFmpeg', or add to PATH)." >&2
	exit 1
}
# Prepend its directory so the agent-browser daemon we are about to spawn inherits it.
export PATH="$(dirname "$FFMPEG_BIN"):$PATH"
echo "[preflight] ffmpeg: $FFMPEG_BIN"

echo "[preflight] ensuring Chrome + warming daemon..."
agent-browser install >/dev/null 2>&1 || true
agent-browser --session preflight open about:blank >/dev/null 2>&1 || {
	echo "[preflight] FATAL: could not start agent-browser / Chrome." >&2; exit 1; }

# --- Gate 1: video smoke-test (HARD-FAIL if no real .webm) ---
echo "[preflight] video smoke-test..."
_SMOKE="${PROBE_ROOT}/artifacts/.preflight-smoke.webm"
rm -f "$_SMOKE"
agent-browser --session preflight open https://example.com >/dev/null 2>&1 || true
agent-browser --session preflight record start "$_SMOKE" >/dev/null 2>&1 || true
sleep 1
agent-browser --session preflight record stop >/dev/null 2>&1 || true
if [ ! -s "$_SMOKE" ]; then
	echo "[preflight] FATAL: video did NOT record (no non-empty .webm). ffmpeg/daemon PATH issue." >&2
	agent-browser --session preflight close >/dev/null 2>&1 || true
	exit 1
fi
rm -f "$_SMOKE"
echo "[preflight] video OK."

# --- Gate 2: --json contract (assert.sh's core premise still holds) ---
# Measured on 0.27.0: a failing SINGLE command (`is`/`find` on an absent element)
# exits 1 AND returns {"success":false,...} with --json. assert.sh judges via .success
# (not exit code) because `batch --json` wraps per-command failures and the batch call
# itself exits 0 — so the .success field is the portable signal across both shapes.
# This gate pins the single-command shape: .success must be false on an absent element.
echo "[preflight] --json contract..."
_IS_ABSENT_JSON="$(agent-browser --session preflight is visible "does-not-exist-xyz" --json 2>/dev/null || true)"
_IS_SUCCESS="$(printf '%s' "$_IS_ABSENT_JSON" | jq -r '.success' 2>/dev/null || echo "ERR")"
if [ "$_IS_SUCCESS" != "false" ]; then
	echo "[preflight] FATAL: --json contract broken (.success on an absent element = $_IS_SUCCESS, expected false)." >&2
	echo "[preflight] FATAL: assert.sh decides pass/fail from .success — if 'absent' is not false, every assert_* can false-green." >&2
	echo "[preflight] FATAL: aborting rather than running the suite against a broken contract (this file promises fail-loud)." >&2
	agent-browser --session preflight close >/dev/null 2>&1 || true
	exit 1
fi
echo "[preflight] contract OK."

agent-browser --session preflight close >/dev/null 2>&1 || true
echo "[preflight] OK."
