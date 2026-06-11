#!/usr/bin/env bash
# Browser-free tests for Docker entrypoint noVNC boundary parsing.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"

cleanup() {
	rm -rf "$TMP"
}
trap cleanup EXIT

run_entrypoint() {
	local out="$1"; shift
	set +e
	(
		cd "$DIR"
		env -i PATH="$PATH" "$@" bash docker/entrypoint.sh --check-config
	) >"$out" 2>&1
	local code=$?
	set -e
	return "$code"
}

assert_contains() {
	local out="$1" needle="$2" msg="$3"
	if ! grep -Fq "$needle" "$out"; then
		echo "  docker-entrypoint-unit: $msg" >&2
		echo "  expected to find: $needle" >&2
		cat "$out" >&2
		exit 1
	fi
}

assert_not_contains() {
	local out="$1" needle="$2" msg="$3"
	if grep -Fq "$needle" "$out"; then
		echo "  docker-entrypoint-unit: $msg" >&2
		cat "$out" >&2
		exit 1
	fi
}

assert_success() {
	local name="$1"; shift
	local out="$TMP/$name.out"
	if ! run_entrypoint "$out" "$@"; then
		echo "  docker-entrypoint-unit: expected success for $name" >&2
		cat "$out" >&2
		exit 1
	fi
	assert_not_contains "$out" "starting Xvfb" "$name should validate config without starting Xvfb"
	echo "$out"
}

assert_failure() {
	local name="$1"; shift
	local out="$TMP/$name.out"
	if run_entrypoint "$out" "$@"; then
		echo "  docker-entrypoint-unit: expected failure for $name" >&2
		cat "$out" >&2
		exit 1
	fi
	assert_not_contains "$out" "starting Xvfb" "$name should fail before starting Xvfb"
	echo "$out"
}

out="$(assert_success local-default)"
assert_contains "$out" "config ok: external_mode=0 novnc=local-passwordless" "local default should keep localhost-only noVNC available"

out="$(assert_failure external-default WEBUI_EXTERNAL_MODE=1)"
assert_contains "$out" "external mode refuses passwordless noVNC" "external default must refuse passwordless noVNC"

out="$(assert_failure external-alias-default AQA_EXTERNAL_MODE=1)"
assert_contains "$out" "external mode refuses passwordless noVNC" "AQA_EXTERNAL_MODE must also refuse passwordless noVNC"

out="$(assert_failure service-mode-default WEBUI_SERVICE_MODE=1)"
assert_contains "$out" "external mode refuses passwordless noVNC" "WEBUI_SERVICE_MODE must refuse passwordless noVNC"

out="$(assert_failure durable-mode-default WEBUI_REQUIRE_DURABLE_JOBS=1)"
assert_contains "$out" "external mode refuses passwordless noVNC" "durable service mode must refuse passwordless noVNC"

out="$(assert_failure deployment-production-default WEBUI_DEPLOYMENT_MODE=production)"
assert_contains "$out" "external mode refuses passwordless noVNC" "production deployment mode must refuse passwordless noVNC"

out="$(assert_success external-novnc-disabled WEBUI_EXTERNAL_MODE=1 NOVNC_DISABLE=1)"
assert_contains "$out" "config ok: external_mode=1 novnc=disabled" "external mode should allow NOVNC_DISABLE=1"

out="$(assert_success external-novnc-disabled-bool WEBUI_EXTERNAL_MODE=true NOVNC_DISABLE=true)"
assert_contains "$out" "config ok: external_mode=1 novnc=disabled" "external mode should parse NOVNC_DISABLE=true"

out="$(assert_success service-novnc-disabled WEBUI_SERVICE_MODE=1 NOVNC_DISABLE=1)"
assert_contains "$out" "config ok: external_mode=1 novnc=disabled" "service mode should allow NOVNC_DISABLE=1"

out="$(assert_failure external-authenticated-proxy-missing-tls WEBUI_EXTERNAL_MODE=yes NOVNC_AUTH_BOUNDARY=authenticated-proxy)"
assert_contains "$out" "NOVNC_AUTH_BOUNDARY=authenticated-proxy requires NOVNC_PROXY_TLS=1" "authenticated proxy boundary should require TLS declaration"

out="$(assert_failure external-authenticated-proxy-missing-auth WEBUI_EXTERNAL_MODE=yes NOVNC_AUTH_BOUNDARY=authenticated-proxy NOVNC_PROXY_TLS=1)"
assert_contains "$out" "NOVNC_AUTH_BOUNDARY=authenticated-proxy requires NOVNC_PROXY_AUTH=tenant-session" "authenticated proxy boundary should require tenant/session auth declaration"

out="$(assert_failure external-authenticated-proxy-missing-root WEBUI_EXTERNAL_MODE=yes NOVNC_AUTH_BOUNDARY=authenticated-proxy NOVNC_PROXY_TLS=1 NOVNC_PROXY_AUTH=tenant-session)"
assert_contains "$out" "WEBUI_NOVNC_BROWSER_ROOT is required when external noVNC is enabled" "authenticated proxy boundary should require a browser-session root"

out="$(assert_success external-authenticated-proxy WEBUI_EXTERNAL_MODE=yes NOVNC_AUTH_BOUNDARY=authenticated-proxy NOVNC_PROXY_TLS=1 NOVNC_PROXY_AUTH=tenant-session WEBUI_NOVNC_BROWSER_ROOT=/app/data/browser-sessions)"
assert_contains "$out" "config ok: external_mode=1 novnc=authenticated-proxy proxy_tls=1 proxy_auth=tenant-session" "external mode should allow explicit authenticated TLS tenant/session proxy boundary"
assert_contains "$out" "browser_root=/app/data/browser-sessions" "external mode should report the dedicated browser root"
assert_contains "$out" "profile_template=/app/data/browser-sessions/{tenantId}/jobs/{jobId}/sessions/{sessionId}/profile" "external mode should report the scoped profile template"

out="$(assert_success external-authenticated-proxy-url WEBUI_EXTERNAL_MODE=yes NOVNC_AUTH_BOUNDARY=authenticated-proxy NOVNC_PROXY_TLS=true NOVNC_PROXY_AUTH=tenant-session NOVNC_PROXY_URL=https://novnc.example.test WEBUI_NOVNC_BROWSER_ROOT=/app/data/browser-sessions)"
assert_contains "$out" "config ok: external_mode=1 novnc=authenticated-proxy proxy_tls=1 proxy_auth=tenant-session" "authenticated proxy boundary should allow an HTTPS proxy URL"

out="$(assert_failure external-browser-root-relative WEBUI_EXTERNAL_MODE=1 NOVNC_AUTH_BOUNDARY=authenticated-proxy NOVNC_PROXY_TLS=1 NOVNC_PROXY_AUTH=tenant-session WEBUI_NOVNC_BROWSER_ROOT=browser-sessions)"
assert_contains "$out" "WEBUI_NOVNC_BROWSER_ROOT must be an absolute path" "relative browser roots should fail closed"

out="$(assert_failure external-browser-root-too-broad WEBUI_EXTERNAL_MODE=1 NOVNC_AUTH_BOUNDARY=authenticated-proxy NOVNC_PROXY_TLS=1 NOVNC_PROXY_AUTH=tenant-session WEBUI_NOVNC_BROWSER_ROOT=/app/data)"
assert_contains "$out" "dedicated browser-session root" "shared application data roots should fail closed"

out="$(assert_failure external-shared-profile-root WEBUI_EXTERNAL_MODE=1 NOVNC_AUTH_BOUNDARY=authenticated-proxy NOVNC_PROXY_TLS=1 NOVNC_PROXY_AUTH=tenant-session WEBUI_NOVNC_BROWSER_ROOT=/app/data/browser-sessions WEBUI_NOVNC_PROFILE_ROOT=/app/data/profile)"
assert_contains "$out" "shared browser profile/download roots are not allowed in external mode" "shared profile roots should fail closed in external mode"

out="$(assert_failure external-shared-download-root WEBUI_EXTERNAL_MODE=1 NOVNC_AUTH_BOUNDARY=authenticated-proxy NOVNC_PROXY_TLS=1 NOVNC_PROXY_AUTH=tenant-session WEBUI_NOVNC_BROWSER_ROOT=/app/data/browser-sessions WEBUI_NOVNC_DOWNLOAD_ROOT=/app/data/downloads)"
assert_contains "$out" "shared browser profile/download roots are not allowed in external mode" "shared download roots should fail closed in external mode"

out="$(assert_failure invalid-disable NOVNC_DISABLE=maybe)"
assert_contains "$out" "NOVNC_DISABLE must be one of" "invalid NOVNC_DISABLE should fail closed"

out="$(assert_failure invalid-external-mode WEBUI_EXTERNAL_MODE=enabled)"
assert_contains "$out" "WEBUI_EXTERNAL_MODE must be one of" "malformed external-mode flag must fail closed, not silently disable external guards"

out="$(assert_failure invalid-proxy-tls WEBUI_EXTERNAL_MODE=1 NOVNC_AUTH_BOUNDARY=authenticated-proxy NOVNC_PROXY_TLS=maybe NOVNC_PROXY_AUTH=tenant-session)"
assert_contains "$out" "NOVNC_PROXY_TLS must be one of" "invalid NOVNC_PROXY_TLS should fail closed"

out="$(assert_failure invalid-proxy-auth WEBUI_EXTERNAL_MODE=1 NOVNC_AUTH_BOUNDARY=authenticated-proxy NOVNC_PROXY_TLS=1 NOVNC_PROXY_AUTH=proxy-only)"
assert_contains "$out" "NOVNC_PROXY_AUTH must be empty or tenant-session" "invalid NOVNC_PROXY_AUTH should fail closed"

out="$(assert_failure insecure-proxy-url WEBUI_EXTERNAL_MODE=1 NOVNC_AUTH_BOUNDARY=authenticated-proxy NOVNC_PROXY_TLS=1 NOVNC_PROXY_AUTH=tenant-session NOVNC_PROXY_URL=http://novnc.example.test)"
assert_contains "$out" "NOVNC_PROXY_URL must start with https:// when set" "plain HTTP noVNC proxy URL should fail closed"

out="$(assert_failure invalid-boundary WEBUI_EXTERNAL_MODE=1 NOVNC_AUTH_BOUNDARY=password)"
assert_contains "$out" "NOVNC_AUTH_BOUNDARY must be empty or authenticated-proxy" "invalid boundary should fail closed"

out="$(assert_failure invalid-novnc-port NOVNC_PORT=abc)"
assert_contains "$out" "NOVNC_PORT must be an integer TCP port" "invalid noVNC port should fail closed"

out="$(assert_failure duplicate-vnc-novnc-port VNC_PORT=6080 NOVNC_PORT=6080)"
assert_contains "$out" "VNC_PORT and NOVNC_PORT must be distinct" "raw VNC and noVNC ports should not collide"

echo "  docker-entrypoint-unit: noVNC entrypoint boundary checks passed"
