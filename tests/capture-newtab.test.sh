#!/usr/bin/env bash
# tests/capture-newtab.test.sh — regression for new-tab/popup handling (bin/probe-record.sh, P1.4).
#
# A new tab/popup is OUT OF SCOPE (single tab, single top-frame). capture() must (a) DETECT one
# via `tab list --json` and (b) still drain the ORIGINAL tab: a new tab steals the active
# context, and `eval` targets the active tab, so a naive drain would read the new tab's EMPTY
# sessionStorage and silently lose the whole recording. This test seeds the original tab's
# buffer, opens a 2nd tab, then asserts: page-tab count exceeds 1 (detection); the new tab's
# buffer is empty (the trap we must avoid); and a drain after switching back to the original tab
# recovers the ORIGINAL 3 events. Deterministic + headless. Mirrors capture()'s _extra_tab +
# the original-tab switch in _flush_once — keep in sync.
#
# It ALSO structurally guards the production switch line: capture() forces a HEADED browser
# (undesirable in this suite), so we cannot exercise _flush_once directly. Instead we read
# bin/probe-record.sh and assert the original-tab switch (`tab "$orig_tab"`) EXISTS and appears
# BEFORE the drain eval (the `__aqa_buf` read) — catching a deleted/misordered switch headlessly.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DIR/lib/env.sh"
source "$DIR/lib/cleanup.sh"
source "$DIR/lib/assert.sh"

AB open "https://example.com" >/dev/null

# Original tab id + seed its capture buffer (3 events, seq 3 — a clean recording).
ORIG="$(AB_JSON tab list | jq -r '[.data.tabs[]? | select(.active==true) | .tabId][0]')"
[ -n "$ORIG" ] && [ "$ORIG" != "null" ] || { echo "  ✗ could not read original tabId" >&2; exit 1; }
AB_JSON eval "sessionStorage.setItem('__aqa_buf',JSON.stringify([{seq:1},{seq:2},{seq:3}]));sessionStorage.setItem('__aqa_seq','3');1" >/dev/null

# Open a 2nd tab (becomes active, like a popup) and assert detection (>1 page tab).
AB tab new "https://www.iana.org/" >/dev/null
pages="$(AB_JSON tab list | jq -r '[.data.tabs[]? | select(.type=="page")] | length')"
[ "${pages:-0}" -gt 1 ] || { echo "  ✗ new tab not detected (page-tab count=$pages)" >&2; exit 1; }

# eval now targets the NEW (active) tab — confirm it does NOT see the original buffer (the trap).
newlen="$(AB_JSON eval "(JSON.parse(sessionStorage.getItem('__aqa_buf')||'[]')).length" | jq -r '.data.result')"
[ "$newlen" = "0" ] || { echo "  ✗ expected new tab to have an empty buffer, got len=$newlen" >&2; exit 1; }

# Switch back to the original tab and drain — must recover the ORIGINAL 3 events, not 0.
AB tab "$ORIG" >/dev/null
DRAIN="({buf:JSON.parse(sessionStorage.getItem('__aqa_buf')||'[]'),seq:(parseInt(sessionStorage.getItem('__aqa_seq')||'0',10)||0)})"
buflen="$(AB_JSON eval "$DRAIN" | jq -r '.data.result.buf | length')"
[ "$buflen" = "3" ] || { echo "  ✗ original-tab drain recovered $buflen events, expected 3 (recording lost!)" >&2; exit 1; }

# Structural regression guard (headless): the assertions above validate agent-browser's tab-switch
# semantics, but they MIRROR the switch+drain inline, so deleting the production switch in
# _flush_once would not fail them. Read bin/probe-record.sh directly and require that the
# original-tab switch line (`tab "$orig_tab"`) EXISTS and appears BEFORE the drain eval line (the
# `__aqa_buf` read) — this is the exact ordering that prevents draining the wrong (new) tab.
PROBE="$DIR/bin/probe-record.sh"
[ -s "$PROBE" ] || { echo "  ✗ cannot find bin/probe-record.sh to guard ($PROBE)" >&2; exit 1; }
switch_ln="$(grep -n 'tab "\$orig_tab"' "$PROBE" | head -n1 | cut -d: -f1)"
drain_ln="$(grep -n '__aqa_buf' "$PROBE" | head -n1 | cut -d: -f1)"
[ -n "$switch_ln" ] || { echo "  ✗ _flush_once is missing the original-tab switch line (tab \"\$orig_tab\") — drain would read the wrong tab" >&2; exit 1; }
[ -n "$drain_ln" ] || { echo "  ✗ could not locate the drain eval line (__aqa_buf) in bin/probe-record.sh" >&2; exit 1; }
[ "$switch_ln" -lt "$drain_ln" ] || { echo "  ✗ original-tab switch (line $switch_ln) must come BEFORE the drain eval (line $drain_ln) — recording would be lost" >&2; exit 1; }

echo "  ✓ capture-newtab.test.sh passed"
