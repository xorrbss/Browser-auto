#!/usr/bin/env bash
# tests/pw-record-dedup-unit.test.sh — browser-free unit for bin/pw-record.mjs dedupeByOrigin.
# Same-origin iframes SHARE the top frame's sessionStorage, so page.frames() drains the SAME capture
# buffer once per same-origin frame; a naive flatMap duplicates every event (and the per-frame health
# check still passes), so a duplicated click/submit lands in the built flow. dedupeByOrigin keeps ONE
# buffer per origin partition while preserving cross-origin frames. Pure; no browser. Part of run.sh.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module -e '
import { dedupeByOrigin } from "./bin/pw-record.mjs";
const assert = (c, m) => { if (!c) { console.error("  ✗ pw-record-dedup: " + m); process.exit(1); } };

// Two SAME-ORIGIN frames (top + iframe) expose the SAME shared buffer (2 events) — must collapse to 2, not 4.
const sharedBuf = [
  { seq: 1, timestamp_ms: 10, primary: { by: "text", value: "Open" }, action_type: "click" },
  { seq: 2, timestamp_ms: 20, primary: { by: "role", value: "button", name: "확인" }, action_type: "click" },
];
{
  const r = dedupeByOrigin([
    { url: "https://app.example.com/top", buf: sharedBuf, seq: 2, crossOriginFrame: false },
    { url: "https://app.example.com/iframe/inner", buf: sharedBuf, seq: 2, crossOriginFrame: false },
  ]);
  assert(r.buf.length === 2, "same-origin shared buffer is NOT duplicated (got " + r.buf.length + ")");
  assert(r.frameCount === 1, "frameCount = 1 distinct origin partition (got " + r.frameCount + ")");
  assert(r.buf[0].seq === 1 && r.buf[1].seq === 2, "events kept in timestamp/seq order");
}

// A CROSS-ORIGIN iframe has its OWN sessionStorage (distinct origin) — its events are preserved + merged.
{
  const xoBuf = [{ seq: 1, timestamp_ms: 15, frame_ref: { crossOrigin: true }, action_type: "input" }];
  const r = dedupeByOrigin([
    { url: "https://app.example.com/top", buf: sharedBuf, seq: 2, crossOriginFrame: false },
    { url: "https://app.example.com/iframe/inner", buf: sharedBuf, seq: 2, crossOriginFrame: false },
    { url: "https://other.example.net/widget", buf: xoBuf, seq: 1, crossOriginFrame: true },
  ]);
  assert(r.buf.length === 3, "cross-origin events merged on top of the deduped same-origin set (got " + r.buf.length + ")");
  assert(r.xoFrames === 1, "one cross-origin partition reported (got " + r.xoFrames + ")");
  assert(r.xoEvents === 1, "one cross-origin event flagged for review (got " + r.xoEvents + ")");
  assert(r.buf.map((e) => e.timestamp_ms).join(",") === "10,15,20", "merged events sorted by timestamp (got " + r.buf.map((e) => e.timestamp_ms).join(",") + ")");
}

// Single top frame only — passthrough, no change.
{
  const r = dedupeByOrigin([{ url: "https://app.example.com/", buf: sharedBuf, seq: 2, crossOriginFrame: false }]);
  assert(r.buf.length === 2 && r.frameCount === 1, "single frame passthrough");
}

console.log("  ✓ pw-record-dedup: same-origin shared-buffer dedupe + cross-origin preserve pass");
' )
