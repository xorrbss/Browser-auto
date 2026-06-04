# action-coverage (#2) — Plan & Progress

Branch: `feat/action-coverage` (off `master`). Hand-maintained.

Backlog #2 = drag / file-upload / explicit scroll. **Empirical research reframed it:** it is NOT the
low-risk additive item assumed.

## Findings (agent-browser 0.27.0 probes)

- `find <locator> <action>` supports only click/fill/type/hover/focus/check/uncheck. **drag / upload /
  scrollintoview are TOP-LEVEL commands taking a CSS selector or `@ref`** — both forbidden by the
  framework (no positional CSS, no stale `@eN`).
- The `find` marker (`[data-agent-browser-located]`) is **transient** (removed after the command) →
  `find → upload [marker]` fails. The canonical path is `snapshot → @eN → act`, but refs go stale on
  page change, and `snapshot -i` shows a file input only as a *button* (via its label) and **omits
  non-interactive `<div>`s entirely** — so drag targets (usually plain divs) have no semantic identity.
- `scroll <dir> <px>` needs **no selector** → fully principle-clean. `batch` does NOT accept `scroll`
  (returns an error object; scrollY stays 0) → scroll compiles to a STANDALONE `AB scroll` line.

So drag/upload collide with the semantic-only / no-CSS / no-@ref core (CLAUDE.md "원칙 충돌 → 중단·보고").
**User decision: scope #2 to explicit SCROLL only** (principle-clean); drag/upload stay excluded with
the documented empirical reason.

## Design (locked) — explicit page scroll

- **capture.js**: a `window` scroll listener (page scroll only — container scrolls don't change
  `window.scrollY`, so tracking scrollY inherently filters them out). Coalesce a gesture: debounce a
  settle timer (`SCROLL_SETTLE_MS`); on settle, net delta from the last committed scroll position;
  emit `{action_type:'scroll', dir, px}` (dominant axis, |Δ| ≥ `SCROLL_MIN`, else skip). FLUSH any
  pending scroll before a click/key (commitScroll at the top of those handlers) so seq order is
  preserved (scroll-then-click never reorders). Relative deltas compose at replay (scroll BY px).
- **build-flow.js**: `action_type:'scroll'` → `{kind:'scroll', dir, px}` step.
- **compile (probe-record.sh)**: a `scroll` step → a standalone `AB scroll <dir> <px>` line (not a
  batch — batch rejects scroll; like `wait_url`, it splits the surrounding batch).
- **flows/SCHEMA.md**: new `scroll` step kind (`dir` ∈ up/down/left/right, `px` int). **README.md**:
  scroll now captured (page-level); container-scroll + drag + upload documented as excluded with the
  empirical reason.

Honest scope: explicit scroll is *mostly redundant* (replay auto-scrolls to each element); its real
value is **lazy-load / infinite-scroll** journeys where a scroll reveals content the next step needs.

## Verification gates (autonomous unless flagged)

1. `node --check bin/capture.js bin/build-flow.js`, `bash -n bin/probe-record.sh`.
2. **Unit (browser-free)**: build-flow-unit — a synthetic `scroll` record → `{kind:scroll,dir,px}` step
   AND `compile` emits `AB scroll <dir> <px>` (standalone, not in a `_run_batch`).
3. **Live capture**: a new test — inject capture.js into a tall example.com page, programmatic
   `scrollTo`, wait the settle window, drain `__aqa_buf`, assert one coalesced `scroll` record with the
   right dir/px; then build-flow → scroll step; and `AB scroll down N` actually scrolls (engine).
4. `bash run.sh` ⇒ all GREEN (existing 12 + capture-scroll), committed flows byte-identical (no scroll
   steps in them).
5. Adversarial read-only review, each finding verified, then fixed.

HUMAN-ONLY (FLAG): a real lazy-load/infinite-scroll site to confirm a captured scroll reveals the
content the next step targets — the synthetic test covers the mechanism.

## Progress log

- 2026-06-04: empirical feasibility probed (drag/upload need CSS/@ref → out; scroll clean). User scoped
  to scroll-only. Design locked; branch + plan created. Implementing capture.js.
- 2026-06-04: Implemented on `feat/action-coverage`:
  - `bin/capture.js`: coalesced `window` scroll listener (settle 250ms, |Δ|≥80px), `commitScroll()`
    flushes pending input first + is called before click/key/nav and at teardown so seq order holds.
    448 lines, `node --check` OK.
  - `bin/build-flow.js`: `scroll` record → `{kind:scroll,dir,px}` step (defensive validation: bad dir
    / px≤0 dropped with a warning).
  - `bin/probe-record.sh compile`: `scroll` step → standalone `AB scroll <dir> <px>` line (new `t:"s"`
    segment; batch rejects scroll). Byte-identity ✓ (committed flows have no scroll steps).
  - `flows/SCHEMA.md` + `README.md`: documented the `scroll` step kind + why drag/upload are excluded.
  - `tests/build-flow-unit.test.sh` (+scroll section) — **GREEN**: record→step, malformed-drop, and the
    standalone `AB scroll` compile.
  - `tests/capture-scroll.test.sh` (live) — **GREEN (56s)**: two coalesced gestures (down 700, delta
    down 400), build-flow→steps, engine scroll primitive.
  - Disk incident: C: squeezed to 0.7G (ENOSPC footgun zone). Culprit = `%TEMP%\wsl-crashes` (1.8G WSL
    crash dumps, not ours) — user-approved delete recovered to 2.5G. (Memory updated.)
  - **Full `bash run.sh` = 13/13 GREEN** (no capture-* regression from the scroll listener).
  - Adversarial review (3 dims → refute): **7 raised, 5 confirmed, 2 refuted.** Confirmed + fixed:
    - **HIGH-1 (regression I introduced)**: teardown handlers changed commitPend→commitScroll, but
      commitScroll early-returns past its commitPend when no scroll is pending → a typed value is
      DROPPED on type-then-Enter-submit (the Enter path too). **Fix**: `flushAll()` (commitPend THEN
      commitScroll) bound to Enter + the three teardown handlers. New `tests/capture-input-enter.test.sh`
      guards it (type→Enter must capture the fill, ordered before the key; build-flow→fill then press).
    - **MED-2 (low impact)**: SPA nav leaves scrollBase stale → first post-nav scroll wrong dir/px
      (find auto-scroll compensates at replay, so not a false-green). **Fix**: `resetScrollBase()` in
      navMark re-anchors the delta to the current offset.
    - **LOW-3**: scroll runs via bare `AB` (no .success gate). **Document-rejected + noted in SCHEMA**:
      scroll is best-effort SETUP exactly like the bare-`AB` `open`/`record start`; a no-op scroll can't
      false-green (essential scroll → next find fails/gated; incidental → passes correctly).
    - **MED-4**: capture-scroll didn't exercise COALESCING (single instant scrolls). **Fix**: added a
      3rd gesture firing 3 scroll events in one settle window → asserts they collapse to ONE record.
    - **LOW-5**: build-flow-unit didn't assert the batch SPLIT. **Fix**: assert segment order B S B.
    (Refuted correctly: scroll-then-type-within-debounce reordering — rare, click commits input first;
    the replay `||true` — self-conceded not-a-false-green.)
  - capture.js now 459 lines (`node --check` OK); build-flow-unit GREEN with the new assertions.
  - Fixes validated: `capture-*` subset 7/7 GREEN (incl. capture-input-enter HIGH-1 guard + the
    coalescing gesture); build-flow.js LF restored (an Edit flipped it LF→CRLF — caught pre-commit).
  - **Post-fix full `bash run.sh` = 14/14 GREEN**; byte-identity ✓.
  - **DONE — merged to master via `--no-ff`** (3 logical commits: feat / test / docs). Track complete.

## Status: COMPLETE & MERGED

Demoable: capture a journey that scrolls (e.g. an infinite-scroll feed) — the page scrolls now compile
to `AB scroll <dir> <px>` steps (coalesced per gesture). drag/upload remain `needs_review`-free-zone
EXCLUSIONS (documented, empirical: no semantic replay path on 0.27.0). Bonus: type-then-Enter input
capture was hardened (a regression the review caught) and is now guarded by capture-input-enter.

HUMAN-ONLY (FLAG): a real lazy-load / infinite-scroll site to confirm a captured scroll reveals the
content the next step targets — the example.com synthetic test covers the mechanism + composition.

This was the LAST backlog item. #1 (replay-fallback), #3 (icon-only), #2 (action coverage) all merged.
