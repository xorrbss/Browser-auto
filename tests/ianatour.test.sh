#!/usr/bin/env bash
# tests/ianatour.test.sh — COMPILED from flows/ianatour.flow.json by bin/probe-record.sh.
# Edit the .flow.json and recompile, or edit here directly (then this becomes the source).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DIR/lib/env.sh"
source "$DIR/lib/cleanup.sh"
source "$DIR/lib/assert.sh"

AB open https://www.iana.org/ >/dev/null
AB record start "$ARTDIR/video.webm" >/dev/null

_VALUES_FILE="$DIR/flows/ianatour.values.json"
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

_run_batch 'W1siZmluZCIsInRleHQiLCJEb21haW4gTmFtZXMiLCJjbGljayIsIi0tZXhhY3QiXV0='
wait_url '**/domains'
_run_batch 'W1siZmluZCIsInRleHQiLCJSb290IFpvbmUgTWFuYWdlbWVudCIsImNsaWNrIiwiLS1leGFjdCJdXQ=='
wait_url '**/domains/root'
_run_batch 'W1siZmluZCIsInRleHQiLCJUb3AtTGV2ZWwgRG9tYWlucyIsImNsaWNrIiwiLS1leGFjdCJdXQ=='
wait_url '**/domains/root/db'
_run_batch 'W1siZmluZCIsInRleHQiLCIuYWJhcnRoIiwiY2xpY2siLCItLWV4YWN0Il1d'
wait_url '**/domains/root/db/abarth.html'

assert_url   '**/domains/root/db/abarth.html'

echo "  ✓ ianatour.test.sh passed"
