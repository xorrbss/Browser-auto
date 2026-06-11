#!/usr/bin/env bash
# bin/probe-record.sh - Playwright-only authoring dispatcher.
#
# One bash file still equals one user journey, but generated test bodies are now
# thin deterministic wrappers over bin/play-flow.mjs. Browser recording is owned
# by bin/pw-record.mjs; this file only validates arguments and routes modes.

set -euo pipefail
PROBE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PROBE_ROOT

usage() {
	echo "usage:" >&2
	echo "  bin/probe-record.sh scaffold <name> <startUrl>                     # Playwright aria snapshot + flow.json stub" >&2
	echo "  bin/probe-record.sh capture  <name> <startUrl> [--app a] [--seconds N] # Playwright live journey -> flow.json" >&2
	echo "  bin/probe-record.sh verify   <flows/name.flow.json>                # Playwright re-drive + repair/promote" >&2
	echo "  bin/probe-record.sh compile  <flows/name.flow.json>                # flow.json -> thin Playwright test.sh" >&2
	exit 2
}

valid_name() {
	[[ "${1:-}" =~ ^[A-Za-z0-9_-]+$ ]]
}

default_environment() {
	case "${1:-}" in
		data:*|file:*|about:*|http://localhost*|https://localhost*|http://127.*|https://127.*|http://\[::1\]*|https://\[::1\]*) echo local ;;
		*) echo staging ;;
	esac
}

flow_engine() {
	local flow="$1" engine
	engine="$(jq -r '.engine // "playwright"' "$flow")"
	case "$engine" in
		playwright) printf '%s' "$engine" ;;
		*) echo "[probe] invalid flow.engine '$engine' in $flow (expected playwright)" >&2; exit 2 ;;
	esac
}

compile() {
	local flow="$1"
	[ -s "$flow" ] || { echo "[probe] no such flow: $flow" >&2; exit 1; }
	flow_engine "$flow" >/dev/null

	local name out
	name="$(jq -r '.name // empty' "$flow")"
	valid_name "$name" || { echo "[probe] compile refused: flow.name must match [A-Za-z0-9_-]" >&2; exit 1; }
	out="${PROBE_ROOT}/tests/${name}.test.sh"

	node "${PROBE_ROOT}/bin/play-flow.mjs" --flow "$flow" --validate-only >/dev/null
	{
		echo '#!/usr/bin/env bash'
		echo "# tests/${name}.test.sh - COMPILED from flows/${name}.flow.json by bin/probe-record.sh."
		echo '# Edit the .flow.json and recompile, or edit here directly (then this becomes the source).'
		echo 'set -euo pipefail'
		echo 'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"'
		echo "node \"\$DIR/bin/play-flow.mjs\" --flow \"\$DIR/flows/${name}.flow.json\""
	} | tr -d '\r' > "$out"
	chmod +x "$out" 2>/dev/null || true
	echo "[probe] compiled -> $out"
}

scaffold() {
	local name="$1" starturl="$2"
	valid_name "$name" || { echo "[probe] invalid flow name (use [A-Za-z0-9_-])" >&2; exit 2; }
	local snap="${PROBE_ROOT}/flows/${name}.snapshot.txt"
	local stub="${PROBE_ROOT}/flows/${name}.flow.json"

	echo "[probe] capturing Playwright aria snapshot for $starturl ..."
	node --input-type=module - "$starturl" "$snap" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [, , startUrl, snap] = process.argv;
const root = process.env.PROBE_ROOT;
const pwRequire = createRequire(pathToFileURL(path.join(root, 'approve', 'package.json')).href);
const chromium = pwRequire('playwright').chromium;
const browser = await chromium.launch({ headless: process.env.AQA_PW_HEADLESS !== '0', channel: process.env.AQA_PW_CHANNEL || 'chrome' });
try {
	const page = await browser.newPage();
	await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
	await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
	const snapshot = await page.locator('body').ariaSnapshot({ timeout: 10000 });
	fs.writeFileSync(snap, snapshot + '\n');
} finally {
	await browser.close();
}
NODE
	echo "[probe] snapshot -> $snap"

	if [ -s "$stub" ]; then
		echo "[probe] $stub already exists; left untouched."
	else
		local env
		env="$(default_environment "$starturl")"
		jq -n --arg name "$name" --arg url "$starturl" --arg env "$env" \
			'{name:$name, engine:"playwright", environment:$env, riskClass:"read", startUrl:$url, steps:[], asserts:[]}' > "$stub"
		echo "[probe] flow stub -> $stub"
	fi
}

capture() {
	local name="" starturl="" app="" secs="${AQA_CAPTURE_SECONDS:-0}" stopfile="${AQA_CAPTURE_STOPFILE:-}"
	while [ $# -gt 0 ]; do
		case "${1:-}" in
			--app) [ $# -ge 2 ] || usage; app="$2"; shift 2 ;;
			--seconds) [ $# -ge 2 ] || usage; secs="$2"; shift 2 ;;
			--stop-file) [ $# -ge 2 ] || usage; stopfile="$2"; shift 2 ;;
			--engine)
				[ $# -ge 2 ] || usage
				[ "$2" = "playwright" ] || { echo "[probe] capture refused: only Playwright is supported." >&2; exit 1; }
				shift 2 ;;
			*)
				if [ -z "$name" ]; then name="$1"; shift
				elif [ -z "$starturl" ]; then starturl="$1"; shift
				else usage
				fi ;;
		esac
	done
	[ -n "$name" ] && [ -n "$starturl" ] || usage
	valid_name "$name" || { echo "[probe] invalid flow name (use [A-Za-z0-9_-])" >&2; exit 2; }

	local args=(--name "$name" --url "$starturl" --seconds "$secs")
	[ -n "$app" ] && args+=(--app "$app")
	[ -n "$stopfile" ] && args+=(--stop-file "$stopfile")
	exec node "$PROBE_ROOT/bin/pw-record.mjs" "${args[@]}"
}

verify_dispatch() {
	local flow="$1"
	[ -s "$flow" ] || { echo "[probe] no such flow: $flow" >&2; exit 1; }
	flow_engine "$flow" >/dev/null
	exec node "$PROBE_ROOT/bin/play-flow.mjs" --flow "$flow" --verify
}

case "${1:-}" in
	scaffold) shift; [ $# -eq 2 ] || usage; scaffold "$1" "$2" ;;
	capture)  shift; [ $# -ge 2 ] || usage; capture "$@" ;;
	verify)   shift; [ $# -eq 1 ] || usage; verify_dispatch "$1" ;;
	compile)  shift; [ $# -eq 1 ] || usage; compile "$1" ;;
	*) usage ;;
esac
