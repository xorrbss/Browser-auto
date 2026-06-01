#!/usr/bin/env bash
# lib/cleanup.sh — EXIT trap for tests. Sourced after env.sh by every test.
#
# Guarantees two things happen no matter how the test ends (pass, failed assert,
# crash, Ctrl-C): the video is finalized and the isolated session is closed. Without
# this, a failed test would lose its video (the most useful artifact for debugging a
# failure) and leak a daemon session. record stop is best-effort — a test that never
# started recording will just no-op, and we never let cleanup errors mask the real
# test exit code.

# _probe_cleanup: runs on EXIT. Preserves the real exit code of the test ($?) so the
# trap is observability-only and never changes pass/fail.
_probe_cleanup() {
	local rc=$?
	# Finalize video if one was being recorded; ignore "no recording in progress".
	agent-browser --session "$S" record stop >/dev/null 2>&1 || true
	# Close just this test's isolated session (not --all; other tests may share daemon).
	agent-browser --session "$S" close >/dev/null 2>&1 || true
	return $rc
}

trap _probe_cleanup EXIT
