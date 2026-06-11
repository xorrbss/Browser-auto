#!/usr/bin/env bash
# lib/preflight.sh - environment gate for the test suite.
#
# The CI runner no longer owns a browser service or video pipeline (no ffmpeg probing, no daemon
# warmup). It gates the tools the suite actually needs: jq + node for the unit tests, and the
# Playwright runtime (approve/ npm deps + a launchable browser channel) because real suite tests
# (play-flow-smoke, login, ianatour, nav-roundtrip, capture-e2e) launch a browser — failing HERE
# with one clear message beats failing mid-suite with a module/launch error.

set -euo pipefail

PROBE_ROOT="${PROBE_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
export PROBE_ROOT

preflight_is_truthy() {
	case "${1:-}" in
		1|true|TRUE|yes|YES|on|ON) return 0 ;;
		*) return 1 ;;
	esac
}

preflight_is_wsl() {
	[ "$(uname -s 2>/dev/null || true)" = "Linux" ] || return 1
	if [ -r /proc/version ] && grep -qi microsoft /proc/version 2>/dev/null; then return 0; fi
	if [ -r /proc/sys/kernel/osrelease ] && grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then return 0; fi
	return 1
}

preflight_print_tool_path_hint() {
	local tool="$1"
	if preflight_is_wsl; then
		echo "[preflight] This looks like WSL's bash, not Git Bash. This repo targets Windows + Git Bash." >&2
		echo "[preflight] From PowerShell, run: & 'C:\\Program Files\\Git\\bin\\bash.exe' ${AQA_PREFLIGHT_ENTRYPOINT:-run.sh}" >&2
		echo "[preflight] Or install the missing tool inside WSL if you intentionally run the WSL lane: $tool" >&2
		return
	fi
	case "$(uname -s 2>/dev/null || true)" in
		MINGW*|MSYS*)
			echo "[preflight] Git Bash is active; install '$tool' or reopen Git Bash after adding it to PATH." >&2
			if [ "$tool" = "node" ]; then echo "[preflight] Expected command to work: node -v" >&2; fi
			if [ "$tool" = "jq" ]; then echo "[preflight] Expected command to work: jq --version" >&2; fi
			;;
	esac
}

preflight_require_tool() {
	local tool="$1"
	if command -v "$tool" >/dev/null 2>&1; then
		return 0
	fi
	echo "[preflight] FATAL: required tool '$tool' was not found on PATH." >&2
	preflight_print_tool_path_hint "$tool"
	exit 1
}

preflight_require_core_tools() {
	preflight_require_tool jq
	preflight_require_tool node
}

preflight_require_playwright_stack() {
	# Prove the Playwright stack works on this box: module resolvable from approve/, and the configured
	# browser channel actually launches (headless, ~1s). AQA_PW_CHANNEL must match what the drivers use.
	if ! node -e '
const { createRequire } = require("node:module");
const path = require("node:path");
let chromium;
try { chromium = createRequire(path.join(process.env.PROBE_ROOT, "approve", "package.json"))("playwright").chromium; }
catch (e) { console.error("[preflight] FATAL: playwright is not installed under approve/ (run: cd approve && npm ci): " + String(e && e.message).split("\n")[0]); process.exit(1); }
(async () => {
	try {
		const b = await chromium.launch({ headless: true, channel: process.env.AQA_PW_CHANNEL || "chrome" });
		await b.close();
	} catch (e) {
		console.error("[preflight] FATAL: cannot launch the Playwright browser channel \"" + (process.env.AQA_PW_CHANNEL || "chrome") + "\": " + String(e && e.message).split("\n")[0]);
		console.error("[preflight] install Google Chrome, or set AQA_PW_CHANNEL=chromium after `cd approve && npx playwright install chromium`.");
		process.exit(1);
	}
})();
'; then
		exit 1
	fi
}

preflight_require_fixture_lane() {
	local lane="${1:-ci-fixture}"
	local prefix="$lane"
	local refused="${prefix}: refused:"

	if preflight_is_truthy "${AQA_INCLUDE_LIVE_AUTH:-}"; then echo "$refused AQA_INCLUDE_LIVE_AUTH enables live auth" >&2; exit 1; fi
	if preflight_is_truthy "${AQA_INCLUDE_NONLOCAL:-}"; then echo "$refused AQA_INCLUDE_NONLOCAL enables non-local targets" >&2; exit 1; fi
	if [[ -n "${AQA_RUN_MODE:-}" && "${AQA_RUN_MODE}" != "local" ]]; then echo "$refused AQA_RUN_MODE must be local or unset" >&2; exit 1; fi
	if [[ -n "${AQA_TARGET_ALLOWLIST:-}" ]]; then echo "$refused AQA_TARGET_ALLOWLIST is operator-only" >&2; exit 1; fi
	if [[ -n "${AQA_EGRESS_ALLOWLIST:-}" ]]; then echo "$refused AQA_EGRESS_ALLOWLIST is operator-only" >&2; exit 1; fi
	if [[ -n "${AQA_LIVE_ALLOWLIST:-}" ]]; then echo "$refused AQA_LIVE_ALLOWLIST is operator-only" >&2; exit 1; fi
	if [[ -n "${AQA_LIVE_DRY_RUN_PASSED:-}" ]]; then echo "$refused AQA_LIVE_DRY_RUN_PASSED is operator-only" >&2; exit 1; fi
	if [[ -n "${AQA_LIVE_ACTION_APPROVE:-}" ]]; then echo "$refused AQA_LIVE_ACTION_APPROVE is operator-only" >&2; exit 1; fi
	if [[ "${AQA_EGRESS_PROFILE:-}" == "on-prem" ]]; then echo "$refused AQA_EGRESS_PROFILE=on-prem is operator-only" >&2; exit 1; fi
}

preflight_run_suite() {
	preflight_require_core_tools
	preflight_require_playwright_stack
	echo "[preflight] OK."
}

if [ "${AQA_PREFLIGHT_MANUAL:-0}" != "1" ]; then
	preflight_run_suite
fi
