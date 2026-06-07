#!/usr/bin/env bash
# bin/scheduled-task.sh — a locked, FAIL-CLOSED entrypoint for UNATTENDED periodic agent-qa tasks, meant to
# be called by the host scheduler (Windows Task Scheduler / cron). It reuses the EXISTING drivers (no new
# automation engine) and adds exactly two things they lack for unattended use:
#   1. SERIALIZATION — a mkdir lock so two ticks (or an overlapping long run) can't drive the single shared
#      agent-browser daemon at once (concurrency wedges it). A stale lock (a crashed tick) self-heals after 2h.
#   2. A SAFETY GATE — read/sync/enrich carry no financial risk and may be scheduled freely, but UNATTENDED
#      LIVE auto-approve is FORBIDDEN (any '--live' is REFUSED) until the operator-accompanied prerequisites
#      are met: live end-to-end verification + a Gate-B amount-cell capture + agreed auto-approve criteria.
#      So a scheduled approve can only ever be DRY-RUN; a live schedule fails closed here, by design.
#
# Usage (the driver is a repo-relative .sh or .mjs; args pass through):
#   bash bin/scheduled-task.sh bin/fetch-approvals.sh --app hiworks     # 결재 list sync
#   bash bin/scheduled-task.sh bin/sync-system.sh   --system hiworks     # generic RPA sync
#   bash bin/scheduled-task.sh bin/enrich-system.sh --system hiworks     # detail + on-prem summary
# Output is teed to data/scheduler.log. See README "Scheduling / unattended" for Task Scheduler + cron lines.
set -euo pipefail

PROBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"; cd "$PROBE_ROOT"
[ "$#" -ge 1 ] || { echo "usage: scheduled-task.sh <driver-rel-path.sh|.mjs> [args...]"; exit 2; }

# SAFETY GATE (fail-closed): refuse any '--live' anywhere in the command — unattended LIVE auto-approve is
# not permitted until the prerequisites above clear (an operator-accompanied step OUTSIDE this scheduler).
for a in "$@"; do
	case "$a" in --live) echo "[sched] REFUSED '--live': unattended LIVE auto-approve is fail-closed (pending live e2e verify + Gate B amount-cell capture + auto-approve criteria). Schedule reads/sync/enrich only." >&2; exit 3 ;; esac
done

mkdir -p data
LOCK="data/.scheduler.lock"
# Serialize ticks with a PID-AWARE lock (mkdir is atomic = the lock; the holder's PID is written inside).
# A new tick breaks the lock ONLY when the holder is no longer alive (a crash/SIGKILL recovers on the NEXT
# tick — not after a fixed timeout) and NEVER while a legitimate long task still holds it (an enrich batch
# can run hours) — fixing the red-team SIGKILL-permanent-lock + stale-break-TOCTOU findings, which a plain
# mtime breaker got wrong (it would either wait 2h or false-break a live multi-hour run). A 12h mtime
# backstop additionally clears a corrupt/unknown lock or a PID that was reused.
acquire_lock() {
	if mkdir "$LOCK" 2>/dev/null; then echo "$$" > "$LOCK/pid"; return 0; fi
	local holder ancient
	holder="$(cat "$LOCK/pid" 2>/dev/null || true)"
	ancient="$(find "$LOCK" -maxdepth 0 -mmin +720 2>/dev/null || true)" # >12h ⇒ definitely stale
	if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null && [ -z "$ancient" ]; then return 1; fi # holder ALIVE ⇒ busy
	if [ -z "$holder" ] && [ -z "$ancient" ]; then return 1; fi                                   # empty pid (fresh lock mid-write) ⇒ stay safe
	echo "[sched] breaking stale lock (holder ${holder:-unknown}${ancient:+, >12h old})"
	rm -rf "$LOCK" 2>/dev/null || true
	if mkdir "$LOCK" 2>/dev/null; then echo "$$" > "$LOCK/pid"; return 0; fi                       # atomic mkdir ⇒ only one racer wins
	return 1
}
if ! acquire_lock; then echo "[sched] busy (lock held) — another tick is running; skipping."; exit 0; fi
trap 'rm -rf "$LOCK" 2>/dev/null || true' EXIT
# Defense-in-depth (red-team WRAPPER-SCRIPT-INJECTION): mark every scheduled child so the approve leaf
# HARD-REFUSES a live approve even if a wrapper driver tried to append --live indirectly.
export AQA_SCHEDULED_NO_LIVE=1

LOG="data/scheduler.log"
stamp() { date +%Y-%m-%dT%H:%M:%S%z; }
echo "[$(stamp)] RUN: $*" | tee -a "$LOG"

drv="$1"; shift
set +e   # capture the driver's own exit code (PIPESTATUS[0]); don't let the tee pipeline trip set -e
case "$drv" in
	*.mjs) node "$drv" "$@" 2>&1 | tee -a "$LOG"; rc=${PIPESTATUS[0]} ;;
	*.sh)  bash "$drv" "$@" 2>&1 | tee -a "$LOG"; rc=${PIPESTATUS[0]} ;;
	*)     echo "[sched] driver must be a repo-relative .sh or .mjs (got: $drv)" | tee -a "$LOG"; rc=2 ;;
esac
set -e
echo "[$(stamp)] EXIT $rc" | tee -a "$LOG"
exit "$rc"
