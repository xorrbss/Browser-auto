#!/usr/bin/env bash
# docker/entrypoint.sh: bring up the virtual display + remote-VNC bridge, then the webui.
#
# Ordering matters: the X server must be ready before anything that opens a window, including
# fluxbox and later Playwright headed record/auth. We probe with xdpyinfo rather than sleeping.
#
# Lifecycle: the webui runs in the foreground so `docker stop` delivers SIGTERM to it. The
# Xvfb/x11vnc/websockify helpers are backgrounded display helpers; the container's lifetime is
# the webui's.
set -euo pipefail

DISPLAY="${DISPLAY:-:99}"
SCREEN="${SCREEN:-1280x800x24}"
VNC_PORT="${VNC_PORT:-5900}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
export DISPLAY

lower() {
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

is_true() {
    case "$(lower "$1")" in
        1|true|yes|on) return 0 ;;
        *) return 1 ;;
    esac
}

is_production_like_mode() {
    local mode
    if is_true "${WEBUI_EXTERNAL_MODE:-}" || is_true "${AQA_EXTERNAL_MODE:-}" || \
       is_true "${WEBUI_SERVICE_MODE:-}" || is_true "${AQA_SERVICE_MODE:-}" || \
       is_true "${WEBUI_REQUIRE_DURABLE_JOBS:-}"; then
        return 0
    fi
    for mode in "${WEBUI_MODE:-}" "${AQA_MODE:-}" "${WEBUI_DEPLOYMENT_MODE:-}"; do
        case "$(lower "$mode")" in
            external|service|prod|production) return 0 ;;
        esac
    done
    return 1
}

parse_bool() {
    local name="$1" default="$2" raw="${!1:-}"
    if [ -z "$raw" ]; then
        printf '%s' "$default"
        return 0
    fi
    case "$(lower "$raw")" in
        1|true|yes|on) printf '1' ;;
        0|false|no|off) printf '0' ;;
        *)
            echo "[entrypoint] FATAL: $name must be one of 1,true,yes,on,0,false,no,off" >&2
            exit 1
            ;;
    esac
}

fail() {
    echo "[entrypoint] FATAL: $*" >&2
    exit 1
}

validate_port() {
    local name="$1" value="$2"
    if ! [[ "$value" =~ ^[0-9]+$ ]] || [ "$value" -lt 1 ] || [ "$value" -gt 65535 ]; then
        fail "$name must be an integer TCP port from 1 to 65535"
    fi
}

is_abs_path() {
    case "$1" in
        /*|[A-Za-z]:/*|[A-Za-z]:\\*) return 0 ;;
        *) return 1 ;;
    esac
}

validate_browser_root() {
    local name="$1" value="$2" lower_value base
    if [ -z "$value" ]; then
        fail "$name is required when external noVNC is enabled"
    fi
    if ! is_abs_path "$value"; then
        fail "$name must be an absolute path"
    fi
    case "$value" in
        *"/../"*|*"\\..\\"|../*|..\\*|*/..|*\\..) fail "$name must not contain parent-directory segments" ;;
    esac
    lower_value="$(lower "$value")"
    case "$lower_value" in
        /|/app|/app/|/app/data|/app/data/|/tmp|/tmp/|/app/fixtures|/app/fixtures/*|/app/artifacts|/app/artifacts/*|/app/flows|/app/flows/*)
            fail "$name must point at a dedicated browser-session root, not a shared application/data directory"
            ;;
    esac
    base="${value##*/}"
    case "$(lower "$base")" in
        profile|profiles|download|downloads|default|"user data"|userdata|chrome-user-data|chromium-user-data)
            fail "$name must be a browser-session root; profile/download roots are derived per tenant/job/session"
            ;;
    esac
}

validate_port VNC_PORT "$VNC_PORT"
validate_port NOVNC_PORT "$NOVNC_PORT"
if [ "$VNC_PORT" = "$NOVNC_PORT" ]; then
    fail "VNC_PORT and NOVNC_PORT must be distinct"
fi

external_mode=0
if is_production_like_mode; then external_mode=1; fi

novnc_disable="$(parse_bool NOVNC_DISABLE 0)"
novnc_auth_boundary="$(lower "${NOVNC_AUTH_BOUNDARY:-}")"
novnc_proxy_tls="$(parse_bool NOVNC_PROXY_TLS 0)"
novnc_proxy_auth="$(lower "${NOVNC_PROXY_AUTH:-}")"
novnc_proxy_url="${NOVNC_PROXY_URL:-}"
novnc_browser_root="${WEBUI_NOVNC_BROWSER_ROOT:-${AQA_NOVNC_BROWSER_ROOT:-}}"
novnc_profile_root="${WEBUI_NOVNC_PROFILE_ROOT:-${AQA_NOVNC_PROFILE_ROOT:-${NOVNC_PROFILE_ROOT:-}}}"
novnc_download_root="${WEBUI_NOVNC_DOWNLOAD_ROOT:-${AQA_NOVNC_DOWNLOAD_ROOT:-${NOVNC_DOWNLOAD_ROOT:-}}}"
case "$novnc_auth_boundary" in
    ""|authenticated-proxy) ;;
    *)
        fail "NOVNC_AUTH_BOUNDARY must be empty or authenticated-proxy"
        ;;
esac
case "$novnc_proxy_auth" in
    ""|tenant-session) ;;
    *)
        fail "NOVNC_PROXY_AUTH must be empty or tenant-session"
        ;;
esac
if [ -n "$novnc_proxy_url" ]; then
    case "$novnc_proxy_url" in
        https://*) ;;
        *)
            fail "NOVNC_PROXY_URL must start with https:// when set"
            ;;
    esac
fi

if [ "$external_mode" = "1" ] && [ "$novnc_disable" != "1" ] && [ "$novnc_auth_boundary" != "authenticated-proxy" ]; then
    fail "external mode refuses passwordless noVNC; set NOVNC_DISABLE=1 or NOVNC_AUTH_BOUNDARY=authenticated-proxy"
fi
if [ "$external_mode" = "1" ] && [ "$novnc_disable" != "1" ] && [ "$novnc_auth_boundary" = "authenticated-proxy" ]; then
    if [ "$novnc_proxy_tls" != "1" ]; then
        fail "NOVNC_AUTH_BOUNDARY=authenticated-proxy requires NOVNC_PROXY_TLS=1"
    fi
    if [ "$novnc_proxy_auth" != "tenant-session" ]; then
        fail "NOVNC_AUTH_BOUNDARY=authenticated-proxy requires NOVNC_PROXY_AUTH=tenant-session"
    fi
    if [ -n "$novnc_profile_root$novnc_download_root" ]; then
        fail "shared browser profile/download roots are not allowed in external mode; set WEBUI_NOVNC_BROWSER_ROOT and let sessions derive tenant/job/session roots"
    fi
    validate_browser_root WEBUI_NOVNC_BROWSER_ROOT "$novnc_browser_root"
fi
if [ -n "$novnc_browser_root" ]; then
    validate_browser_root WEBUI_NOVNC_BROWSER_ROOT "$novnc_browser_root"
    export WEBUI_NOVNC_BROWSER_ROOT="$novnc_browser_root"
fi

if [ "${1:-}" = "--check-config" ]; then
    if [ "$novnc_disable" = "1" ]; then
        novnc_mode="disabled"
    elif [ "$novnc_auth_boundary" = "authenticated-proxy" ]; then
        novnc_mode="authenticated-proxy proxy_tls=$novnc_proxy_tls proxy_auth=$novnc_proxy_auth browser_root=$novnc_browser_root profile_template=$novnc_browser_root/{tenantId}/jobs/{jobId}/sessions/{sessionId}/profile downloads_template=$novnc_browser_root/{tenantId}/jobs/{jobId}/sessions/{sessionId}/downloads"
    else
        novnc_mode="local-passwordless"
    fi
    echo "[entrypoint] config ok: external_mode=$external_mode novnc=$novnc_mode"
    exit 0
fi

echo "[entrypoint] starting Xvfb on $DISPLAY ($SCREEN)"
# A container restart reuses the writable layer, so a leftover lock/socket from a previously
# crashed boot makes Xvfb fail with "Server is already active for display NN". Clear them first.
_xnum="${DISPLAY#:}"; _xnum="${_xnum%%.*}"
rm -f "/tmp/.X${_xnum}-lock" "/tmp/.X11-unix/X${_xnum}" 2>/dev/null || true
Xvfb "$DISPLAY" -screen 0 "$SCREEN" -nolisten tcp &

for _ in $(seq 1 50); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
    sleep 0.1
done
xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 || { echo "[entrypoint] FATAL: Xvfb never came up on $DISPLAY" >&2; exit 1; }

echo "[entrypoint] starting fluxbox (window manager)"
fluxbox >/dev/null 2>&1 &

if [ "$novnc_disable" = "1" ]; then
    echo "[entrypoint] noVNC disabled (NOVNC_DISABLE=1)"
else
    if [ "$novnc_auth_boundary" = "authenticated-proxy" ]; then
        echo "[entrypoint] noVNC boundary: authenticated TLS proxy with tenant-session authorization declared"
    fi
    # x11vnc shares the virtual display; websockify bridges it to noVNC's web client.
    # Raw VNC is loopback-only inside the container. noVNC itself is a separate port from the
    # WebUI and must stay loopback-published or be gated by an authenticated upstream proxy.
    echo "[entrypoint] starting x11vnc on :$VNC_PORT and noVNC on :$NOVNC_PORT"
    x11vnc -display "$DISPLAY" -forever -shared -nopw -quiet -localhost -rfbport "$VNC_PORT" &
    websockify --web=/usr/share/novnc "$NOVNC_PORT" "localhost:$VNC_PORT" &
    echo "[entrypoint] noVNC: open http://<host>:$NOVNC_PORT/vnc.html  (drive the recorder's Chrome)"
fi
echo "[entrypoint] webui: http://<host>:${WEBUI_PORT:-4310}  (start/stop record, compile, run, results)"

exec node webui/server.js
