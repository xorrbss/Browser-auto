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

for tool in jq node; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "[preflight] FATAL: required tool '$tool' was not found on PATH." >&2
		exit 1
	fi
done

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

echo "[preflight] OK."
