#!/usr/bin/env bash
# lib/daemon.sh - agent-browser daemon health and bounded orphan cleanup.
#
# This is shared by run.sh and the web UI queue. It only touches agent-browser's
# own daemon state and browsers under ~/.agent-browser; it never targets the
# user's installed Chrome in Program Files.

set -euo pipefail

PROBE_ROOT="${PROBE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export PROBE_ROOT

AB_DIR="${AGENT_BROWSER_HOME:-$HOME/.agent-browser}"
AB_BROWSERS_DIR="${AB_DIR}/browsers"

_daemon_timeout() {
	local seconds="$1"; shift
	if command -v timeout >/dev/null 2>&1; then
		timeout "$seconds" "$@"
	else
		"$@"
	fi
}

_daemon_probe() {
	local s="${AQA_DAEMON_HEALTH_SESSION:-aqa-daemon-health}" out ok
	_daemon_timeout "${AQA_DAEMON_PROBE_TIMEOUT:-8}" agent-browser --session "$s" open about:blank </dev/null >/dev/null 2>&1 || return 1
	out="$(_daemon_timeout "${AQA_DAEMON_PROBE_TIMEOUT:-8}" agent-browser --session "$s" get url --json </dev/null 2>/dev/null)" || return 1
	ok="$(printf '%s' "$out" | jq -r '.success // false' 2>/dev/null || echo false)"
	[ "$ok" = "true" ]
}

ensure_daemon() {
	if _daemon_probe; then
		echo "[daemon] healthy"
		return 0
	fi

	echo "[daemon] unhealthy or wedged; recovering agent-browser daemon..."
	recover_daemon || true

	if _daemon_probe; then
		echo "[daemon] healthy after recovery"
		return 0
	fi

	echo "[daemon] FATAL: agent-browser daemon still unhealthy after recovery" >&2
	return 1
}

recover_daemon() {
	reap_browser_orphans || true
	DAEMON_RECOVER_NO_REAP=1 bash "$PROBE_ROOT/bin/daemon-recover.sh"
}

reap_browser_orphans() {
	[ -d "$AB_BROWSERS_DIR" ] || return 0

	if command -v powershell.exe >/dev/null 2>&1; then
		local win_root
		win_root="$(cygpath -w "$AB_BROWSERS_DIR" 2>/dev/null || printf '%s' "$AB_BROWSERS_DIR")"
		AQA_AB_BROWSERS_WIN="$win_root" powershell.exe -NoProfile -ExecutionPolicy Bypass -Command '
$root = [IO.Path]::GetFullPath($env:AQA_AB_BROWSERS_WIN).TrimEnd("\")
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -match "^(chrome|chromium|msedge)\.exe$" -and
    (
      ([string]$_.ExecutablePath).StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or
      ([string]$_.CommandLine).IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0
    )
  } |
  ForEach-Object {
    Write-Output ("[daemon] reaping agent-browser browser pid " + $_.ProcessId)
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
' 2>/dev/null || true
		return 0
	fi

	# POSIX/Docker fallback: only kill commands containing the agent-browser browsers dir.
	local pids
	pids="$(ps -eo pid=,args= 2>/dev/null | awk -v root="$AB_BROWSERS_DIR" 'index($0, root) { print $1 }' || true)"
	[ -n "$pids" ] || return 0
	printf '%s\n' "$pids" | while IFS= read -r pid; do
		[ -n "$pid" ] || continue
		echo "[daemon] reaping agent-browser browser pid $pid"
		kill "$pid" >/dev/null 2>&1 || true
	done
}
