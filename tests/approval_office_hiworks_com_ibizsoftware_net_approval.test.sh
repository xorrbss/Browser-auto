#!/usr/bin/env bash
# tests/approval_office_hiworks_com_ibizsoftware_net_approval.test.sh — COMPILED from flows/approval_office_hiworks_com_ibizsoftware_net_approval.flow.json by bin/probe-record.sh.
# Edit the .flow.json and recompile, or edit here directly (then this becomes the source).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DIR/lib/env.sh"
source "$DIR/lib/cleanup.sh"
source "$DIR/lib/assert.sh"
source "$DIR/lib/flow-steps.sh"

AB_AUTH r45 open https://approval.office.hiworks.com/ibizsoftware.net/approval/document/lists/W >/dev/null
AB record start "$ARTDIR/video.webm" >/dev/null

_VALUES_FILE="$DIR/flows/approval_office_hiworks_com_ibizsoftware_net_approval.values.json"
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

aqa_open_record 'row_index' 'hiworks' '' '0'
wait_url '**/ibizsoftware.net/approval/document/view/**/condition/**'
_run_batch 'W1siZmluZCIsInRpdGxlIiwi66qp66Gd67O06riwIiwiY2xpY2siLCItLWV4YWN0Il1d'
wait_url '**/ibizsoftware.net/approval/document/lists/W'

assert_url   '**/ibizsoftware.net/approval/document/lists/W'

echo "  ✓ approval_office_hiworks_com_ibizsoftware_net_approval.test.sh passed"
