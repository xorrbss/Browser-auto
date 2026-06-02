#!/usr/bin/env bash
# tests/capture-healthcheck.test.sh — regression for the capture seq-advance health-check
# (bin/probe-record.sh capture::_flush_once, P1.3).
#
# capture.js bumps __aqa_seq once per recorded action AND pushes it to __aqa_buf. If
# sessionStorage.setItem silently throws (quota / private mode) the buffer stops growing
# while the seq counter keeps advancing, so a drain that sees seq > buffer-length means
# events were LOST. The host must flag that loudly (and exit non-zero) instead of writing a
# quietly-incomplete flow.json. This test seeds both a lossy state (seq > len => must flag)
# and a clean state (seq == len => must NOT flag) and asserts the SAME drain expression +
# comparison the host uses. Deterministic (eval-driven; no synthetic-click timing) and
# headless. KEEP $DRAIN and the seq>len rule IN SYNC with bin/probe-record.sh::_flush_once.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$DIR/lib/env.sh"
source "$DIR/lib/cleanup.sh"
source "$DIR/lib/assert.sh"

AB open "https://example.com" >/dev/null

# The exact drain expression from bin/probe-record.sh::capture::_flush_once.
DRAIN="({buf:JSON.parse(sessionStorage.getItem('__aqa_buf')||'[]'),seq:(parseInt(sessionStorage.getItem('__aqa_seq')||'0',10)||0)})"

# verdict <drain-json> -> "degraded" | "ok", applying the host's seq>recovered rule.
verdict() {
	local out="$1" seq rec
	[ "$(printf '%s' "$out" | jq -r '.success')" = "true" ] || { echo "  ✗ drain eval did not succeed" >&2; return 2; }
	seq="$(printf '%s' "$out" | jq -r '.data.result.seq // 0')"
	rec="$(printf '%s' "$out" | jq -r '.data.result.buf | length')"
	if [ "$seq" -gt "$rec" ] 2>/dev/null; then echo "degraded"; else echo "ok"; fi
}

# Case 1 — lossy buffer (buf len 2, seq 5): MUST be flagged degraded.
AB_JSON eval "sessionStorage.setItem('__aqa_buf',JSON.stringify([{seq:1},{seq:2}]));sessionStorage.setItem('__aqa_seq','5');1" >/dev/null
v="$(verdict "$(AB_JSON eval "$DRAIN")")"
if [ "$v" != "degraded" ]; then echo "  ✗ lossy state (seq=5,len=2) not flagged; got '$v'" >&2; exit 1; fi

# Case 2 — clean buffer (buf len 3, seq 3): MUST NOT be flagged (no false-positive).
AB_JSON eval "sessionStorage.setItem('__aqa_buf',JSON.stringify([{seq:1},{seq:2},{seq:3}]));sessionStorage.setItem('__aqa_seq','3');1" >/dev/null
v="$(verdict "$(AB_JSON eval "$DRAIN")")"
if [ "$v" != "ok" ]; then echo "  ✗ clean state (seq=3,len=3) false-flagged; got '$v'" >&2; exit 1; fi

echo "  ✓ capture-healthcheck.test.sh passed"
