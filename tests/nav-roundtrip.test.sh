#!/usr/bin/env bash
# tests/nav-roundtrip.test.sh — COMPILED from flows/nav-roundtrip.flow.json by bin/probe-record.sh.
# Edit the .flow.json and recompile, or edit here directly (then this becomes the source).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DIR/lib/env.sh"
source "$DIR/lib/cleanup.sh"
source "$DIR/lib/assert.sh"

AB open https://example.com >/dev/null
AB record start "$ARTDIR/video.webm" >/dev/null

_VALUES_FILE="$DIR/flows/nav-roundtrip.values.json"
_VALUES_JSON="{}"; [ -s "$_VALUES_FILE" ] && _VALUES_JSON="$(cat "$_VALUES_FILE")"
_run_batch() {
	local _body
	_body="$(printf %s "$1" | base64 -d | jq -c --argjson v "$_VALUES_JSON" \
		'walk(if type=="string" then gsub("[{][{](?<k>[A-Za-z0-9_]+)[}][}]"; ($v[.k] // ("__AQA_MISSING__"+.k))) else . end)')"
	case "$_body" in
		*__AQA_MISSING__*) echo "  ✗ missing value(s) in $_VALUES_FILE — fill the gitignored sidecar before replay" >&2; exit 1 ;;
	esac
	BATCH --bail <<<"$_body"
}

_run_batch 'W1siZmluZCIsInRleHQiLCJMZWFybiBtb3JlIiwiY2xpY2siLCItLWV4YWN0Il1d'
wait_url '**/help/example-domains'
_run_batch 'W1siZmluZCIsInRleHQiLCJFeGFtcGxlIERvbWFpbnMiLCJob3ZlciIsIi0tZXhhY3QiXV0='

assert_url   '**/help/example-domains'
assert_text  'Example Domains'

echo "  ✓ nav-roundtrip.test.sh passed"
