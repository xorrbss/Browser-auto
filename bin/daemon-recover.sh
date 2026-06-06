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

AB_DIR="${AGENT_BROWSER_HOME:-$HOME/.agent-browser}"

echo "[recover] agent-browser daemon stop (best-effort)…"
agent-browser daemon stop >/dev/null 2>&1 || true

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

echo "[recover] done. The next agent-browser op will start a fresh daemon."
