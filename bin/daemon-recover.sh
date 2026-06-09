#!/usr/bin/env bash
# bin/daemon-recover.sh — recover a wedged agent-browser daemon.
#
# Symptom: ops start failing with `os error 10060` (or hang ~34s then fail) because ~/.agent-browser
# holds STALE per-session state files from a daemon that died without cleaning up. The fix is the
# manual recovery documented in CLAUDE.md / README, encapsulated here so it is repeatable and safe:
#   1. `agent-browser daemon stop` (the official shutdown).
#   2. Stop ONLY the daemon PID named in *.pid (a targeted kill — never a blanket node.exe kill, which
#      would take down unrelated node processes including this very toolchain).
#   3. Remove the stale state files (*.engine/*.pid/*.port/*.stream/*.version) while PRESERVING
#      browsers/ (the multi-hundred-MB downloaded browser binaries — re-downloading is slow).
# The next agent-browser op then starts a fresh daemon. Idempotent and safe to run on a clean state.
#
#   bash bin/daemon-recover.sh
set -euo pipefail

PROBE_ROOT="${PROBE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export PROBE_ROOT
AB_DIR="${AGENT_BROWSER_HOME:-$HOME/.agent-browser}"

if [ "${DAEMON_RECOVER_NO_REAP:-0}" != "1" ] && [ -f "$PROBE_ROOT/lib/daemon.sh" ]; then
	# shellcheck source=../lib/daemon.sh
	source "$PROBE_ROOT/lib/daemon.sh"
	reap_browser_orphans || true
fi

echo "[recover] agent-browser daemon stop (best-effort, bounded)…"
# Bound the daemon-routed stop: a WEDGED daemon (the very thing this script cures) can hang the stop
# ~34s. timeout (coreutils, ships with Git Bash) caps it so the daemon-independent steps below still run.
timeout 8 agent-browser daemon stop >/dev/null 2>&1 || true

# Targeted kill: if a *.pid file names a daemon process, stop THAT pid only. Never a name/blanket kill.
if [ -d "$AB_DIR" ]; then
	for pf in "$AB_DIR"/*.pid; do
		[ -e "$pf" ] || continue
		pid="$(tr -dc '0-9' < "$pf" 2>/dev/null || true)"
		[ -n "$pid" ] || continue
		echo "[recover] stopping daemon pid $pid (from $(basename "$pf"))…"
		if command -v taskkill >/dev/null 2>&1; then
			MSYS_NO_PATHCONV=1 taskkill /PID "$pid" /F >/dev/null 2>&1 || true
		else
			kill "$pid" >/dev/null 2>&1 || true
		fi
	done
fi

# Remove stale session state, PRESERVE browsers/.
if [ -d "$AB_DIR" ]; then
	removed=0
	for ext in engine pid port stream version; do
		for f in "$AB_DIR"/*."$ext"; do
			[ -e "$f" ] || continue
			rm -f "$f" && removed=$((removed + 1)) && echo "[recover] removed $(basename "$f")"
		done
	done
	if [ -d "$AB_DIR/browsers" ]; then
		echo "[recover] removed $removed stale state file(s); browsers/ preserved."
	else
		echo "[recover] removed $removed stale state file(s). (note: no browsers/ — run 'agent-browser install' if browsers are missing.)"
	fi
else
	echo "[recover] $AB_DIR does not exist — nothing to clean."
fi

# Prime a fresh daemon so the operator's NEXT real op starts warm. agent-browser's very first op after a
# daemon (re)start can fail once with "Daemon version mismatch -> restarting" (os error 10060) while the
# daemon respawns -- exactly the failure this script exists to clear. Absorb it here on a THROWAWAY
# session (open about:blank -> navigate -> get url), retrying once, so a real script never eats that flake.
# Best-effort: a prime failure is reported but never fails recovery (the next op still starts a daemon).
# Set DAEMON_RECOVER_NO_PRIME=1 to skip (e.g. a headless box with no browser installed).
if [ "${DAEMON_RECOVER_NO_PRIME:-0}" = "1" ]; then
	echo "[recover] prime skipped (DAEMON_RECOVER_NO_PRIME=1)."
else
	PRIME_S="recover-prime-$$"
	primed=0
	for attempt in 1 2; do
		if agent-browser --session "$PRIME_S" open about:blank </dev/null >/dev/null 2>&1 \
			&& agent-browser --session "$PRIME_S" navigate https://example.com </dev/null >/dev/null 2>&1 \
			&& agent-browser --session "$PRIME_S" get url </dev/null >/dev/null 2>&1; then
			primed=1
			echo "[recover] daemon primed and warm (attempt $attempt)."
			break
		fi
		echo "[recover] prime attempt $attempt failed (expected on the first op after restart); retrying..."
	done
	# Deliberately DO NOT close $PRIME_S: a daemon with zero open sessions exits (verified), which would
	# discard the warmth we just established. Leaving the throwaway session open keeps the daemon alive at
	# the current version so the operator's next real op (on its own session) starts warm and flake-free.
	# The next `daemon-recover` (or run.sh's reaper) reaps this session; it never accumulates.
	[ "$primed" = "1" ] || echo "[recover] WARNING: prime did not succeed; the next real op will start the daemon (may eat one first-op flake)."
fi

echo "[recover] done."
