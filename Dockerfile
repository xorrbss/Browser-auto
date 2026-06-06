# Dockerfile — Linux recording server for agent-qa (remote-human capture).
#
# Why this base: Chromium's Linux system libraries are the painful part of running a headed
# browser in a container. The Playwright image ships Node 20 + Chromium + every one of those
# libs preinstalled, so we only add the remote-interactive-display + media stack on top.
#
# What runs inside (see docker/entrypoint.sh):
#   Xvfb :99            virtual display so agent-browser --headed (record/auth) has a screen
#   fluxbox             minimal WM so the Chrome window is managed/maximized in the VNC view
#   x11vnc + websockify expose that display to the browser as noVNC (remote human drives Chrome)
#   node webui/server.js  the control plane (start/stop record, resolve, compile, run, results)
#
# Replay (run.sh) stays headless (agent-browser.json headless=true) and ignores the display.
FROM mcr.microsoft.com/playwright:v1.49.1-jammy

# Remote-interactive display + media stack. x11-utils gives xdpyinfo for the readiness probe.
# DEBIAN_FRONTEND=noninteractive (inline, build-only) stops tzdata from opening an interactive
# "select your timezone" prompt that would hang the TTY-less build forever.
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
        xvfb x11vnc novnc websockify fluxbox x11-utils ffmpeg jq curl ca-certificates xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Upgrade Node to 24. The Playwright base ships Node 22, where node:sqlite is still flag-gated;
# the approval feature's lib/db.js does require('node:sqlite'), which is UNFLAGGED from Node 24
# (matches the host runtime, 24.16.0). Install to /usr/local (ahead of /usr/bin in PATH) BEFORE the
# global npm install so agent-browser lands under Node 24's prefix.
RUN ARCH="$(dpkg --print-architecture)"; \
    case "$ARCH" in amd64) NODEARCH=x64 ;; arm64) NODEARCH=arm64 ;; *) echo "unsupported arch $ARCH" >&2; exit 1 ;; esac; \
    curl -fsSL "https://nodejs.org/dist/v24.16.0/node-v24.16.0-linux-$NODEARCH.tar.xz" -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && node --version

# The framework's engine. Pinned to 0.27.0 — the whole test contract (assert.sh, the wait_url
# footgun, capture.js probing) is verified against exactly this version. `install` provisions the
# browser agent-browser drives.
RUN npm install -g agent-browser@0.27.0 && agent-browser install

WORKDIR /app
COPY . /app

# spawn.js already falls back to `bash` on non-Windows, but pin it so a custom base can't surprise
# the recorder. DISPLAY/SCREEN/ports are read by docker/entrypoint.sh.
ENV WEBUI_BASH=/bin/bash \
    WEBUI_PORT=4310 \
    DISPLAY=:99 \
    SCREEN=1280x800x24 \
    VNC_PORT=5900 \
    NOVNC_PORT=6080

EXPOSE 4310 6080

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
