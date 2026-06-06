#!/usr/bin/env bash
# docker/entrypoint.sh — bring up the virtual display + remote-VNC bridge, then the webui.
#
# Ordering matters: the X server must be ready BEFORE anything that opens a window (fluxbox,
# and later agent-browser --headed for record/auth). We probe with xdpyinfo rather than sleeping
# a fixed time so a slow host can't race the WM/Chrome onto a not-yet-listening display.
#
# Lifecycle: the webui runs in the FOREGROUND (exec) as PID 1's child so `docker stop` delivers
# SIGTERM to it — webui/server.js's SIGTERM handler tree-kills any in-flight job (POSIX group
# kill, see webui/spawn.js) and exits cleanly. The Xvfb/x11vnc/websockify helpers are backgrounded
# daemons; the container's lifetime is the webui's.
set -euo pipefail

DISPLAY="${DISPLAY:-:99}"
SCREEN="${SCREEN:-1280x800x24}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
export DISPLAY

echo "[entrypoint] starting Xvfb on $DISPLAY ($SCREEN)"
# A container restart reuses the writable layer, so a leftover lock/socket from a previously
# crashed boot makes Xvfb fail with "Server is already active for display NN". Clear them first
# (DISPLAY ":99" / ":99.0" -> X server number "99") so every (re)start gets a clean display.
_xnum="${DISPLAY#:}"; _xnum="${_xnum%%.*}"
rm -f "/tmp/.X${_xnum}-lock" "/tmp/.X11-unix/X${_xnum}" 2>/dev/null || true
Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp &

# Wait for the display to accept connections (max ~5s) before launching anything that draws.
for _ in $(seq 1 50); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
    sleep 0.1
done
xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 || { echo "[entrypoint] FATAL: Xvfb never came up on $DISPLAY" >&2; exit 1; }

echo "[entrypoint] starting fluxbox (window manager)"
fluxbox >/dev/null 2>&1 &

# x11vnc shares the virtual display; websockify bridges it to noVNC's web client.
# -nopw: no VNC password ON PURPOSE — access MUST be gated upstream (auth proxy / private tunnel),
# never by exposing these ports to the internet directly. The webui itself also has no auth.
echo "[entrypoint] starting x11vnc on :$VNC_PORT and noVNC on :$NOVNC_PORT"
x11vnc -display "$DISPLAY" -forever -shared -nopw -quiet -rfbport "$VNC_PORT" &
websockify --web=/usr/share/novnc "$NOVNC_PORT" "localhost:$VNC_PORT" &

echo "[entrypoint] noVNC: open http://<host>:$NOVNC_PORT/vnc.html  (drive the recorder's Chrome)"
echo "[entrypoint] webui: http://<host>:${WEBUI_PORT:-4310}  (start/stop record, compile, run, results)"

# Foreground: receives SIGTERM from `docker stop` for a clean shutdown (see header).
exec node webui/server.js
