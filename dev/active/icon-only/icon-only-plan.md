# icon-only (aria-label) — Plan & Progress

Branch: `feat/icon-only` (off `master`). Hand-maintained (no dev-docs skill).

Backlog item #3: **reduce needless `needs_review` for icon-only buttons whose only accessible
name is `aria-label`.** Today such a button captures a single role+name candidate → `insufficient`
(top.length<2) → `needs_review`, even though that primary resolves fine at replay.

## Empirical findings (local file:// fixture + agent-browser `find … hover --json`)

`find role <r> --name <ariaLabel>` resolution on agent-browser 0.27.0 is **element-shape specific**,
NOT role-name specific (this corrects/refines the old "role --name is unreliable" footgun, which had
only tested native heading + link):

- **RESOLVES (true):** native `<button>` + aria-label; ANY explicit `role="…"` (button/link/checkbox/
  radio/tab/menuitem/menuitemcheckbox/menuitemradio/switch/option/treeitem/combobox/slider/heading) +
  aria-label; native button works even though it is an implicit role.
- **FAILS (false):** native `<a href>` (link), native `<input type=checkbox|radio>`, native heading,
  and ANY element whose name comes from `aria-labelledby` (the engine does not resolve the referenced
  name).
- `title`, `text`, `testid` all resolve (an earlier "false" was my probe arg-order bug).
- `file://` sessionStorage is opaque ⇒ capture.js's in-page buffer is empty there; live capture tests
  MUST use an http(s) page (example.com, as the other capture-* tests do).

## Design (locked — conservative)

Only the **engine-VERIFIED-reliable** role+name form may become an auto-primary; everything else
stays `needs_review` (no primary that would silently fail replay — the framework's "needs_review over
a fragile guess" rule). In `bin/capture.js emit()`:

1. **Role-primary gate** — a `role` candidate is eligible as PRIMARY only via
   `roleAriaLabelButton(el,c)`: role is `button`, the element is a native `<button>` OR carries an
   explicit `role="button"`, the name comes from a direct `aria-label` (NOT `aria-labelledby`), and
   that aria-label equals the captured accessible name. Any other role+name is skipped as a primary
   and remains a `needs_review` candidate only. (Native button + explicit role=button are the only
   two forms I verified; native `<input type=button>` / `<summary>` are conservatively excluded.)
2. **`insufficient` = no trustworthy primary** (was `top.length < 2`). A single UNIQUE resolvable
   primary — an icon-only aria-label button, or a lone unique text — is now sufficient and is NOT
   forced to `needs_review`. The candidate ladder (`top`) is still emitted for verify/replay-fallback;
   a `needs_review` step keeps its non-empty ladder (C1 unchanged). Non-role locators
   (testid/text/label/placeholder/alt/title) are always resolvable.

Net effect:
- icon-only `<button aria-label="Close">` → CLEAN `role button --name Close` primary (was needs_review).
- icon-only link / native checkbox / aria-labelledby / duplicate-aria-label → still `needs_review` (honest).
- WKIND/score unchanged: a button WITH visible text still prefers `text` (40 > role 24); only PURE
  icon-only (no text) falls to the role+name primary.
- No new false-green vector: count==1 + engine-resolvable is the same bar as any text/testid primary.

## Verification gates (autonomous unless flagged)

1. `node --check bin/capture.js`, `bash -n` on changed tests.
2. **Unit (browser-free)**: extend tests/build-flow-unit.test.sh — a record with a role-button primary
   (count==1, no `insufficient`) → CLEAN find step (by=role,value=button,name=…), NOT needs_review.
3. **Live capture (http, example.com)**: new tests/capture-iconbutton.test.sh — inject capture.js,
   build an icon-only `<button aria-label>` + a sibling, synthetic-click, drain `__aqa_buf`, assert the
   recorded action has a role+name primary and NO `insufficient`; then build-flow ⇒ a clean (non
   needs_review) step. Plus a negative: an aria-LABELLEDBY icon button (or an icon link) must STAY
   needs_review.
4. `bash run.sh` ⇒ all GREEN (existing 11 + capture-iconbutton). Watch for any capture-* regression
   from the `insufficient` redefinition (predicted low: capture-domswap uses text buttons w/ ≥2 cands;
   capture-newtab/healthcheck don't assert locator selection; build-flow-unit feeds synthetic flags).
5. Adversarial read-only review (constrained READ-ONLY this time — last review's verify-agent ran a
   browser test), each finding verified, then fixed.

HUMAN-ONLY (FLAG): a real headed re-capture of an app with genuine icon-only toolbar buttons to
confirm the role+name primary resolves in the wild; the example.com synthetic fixture covers the
code paths and the engine resolution is probe-verified, but live behaviour wants a person.

## Progress log

- 2026-06-04: SSOT re-read (capture.js emit/candidatesFor/score); engine role-resolution matrix
  probed (file:// fixture); root cause = single-candidate `insufficient` → needs_review; design
  locked; branch + plan created. Implementing capture.js.
- 2026-06-04: Implemented on `feat/icon-only`:
  - `bin/capture.js`: added `roleAriaLabelButton(el,c)` gate; emit() now (a) accepts a role+name
    PRIMARY only for an aria-label button, skipping every other role+name, and (b) sets
    `insufficient` iff NO trustworthy primary exists (was `top.length < 2`). `node --check` OK, 0 NUL,
    402 lines.
  - `tests/capture-iconbutton.test.sh` (live, example.com) — **GREEN (21s) in isolation**: icon
    aria-label button → clean `role/button/CloseDialogQ` primary, NOT insufficient; aria-labelledby
    button + icon link → needs_review; build-flow chain (clean step0, needs_review steps 1&2) verified.
  - `README.md`: rewrote the icon-only limitation note (aria-label buttons now clean; link/native-input/
    labelledby still needs_review).
  - First full `bash run.sh` = **12/12 GREEN** (no capture-* regression from the insufficient change).
  - Adversarial review (4 dims → refute, run AFTER the suite so no concurrent browser): **12 raised,
    5 confirmed (2 HIGH, 1 MED, 2 LOW), 7 refuted.** The 2 HIGH were real and made me REDESIGN:
    - HIGH-1 claimed accName/engine diverge on `aria-hidden` (engine excludes per W3C) → capture
      under-counts → wrong-element false-green. **Probe REFUTED the premise**: 0.27.0 does NOT exclude
      aria-hidden (`--exact zzMenuQ`→true, `--exact MenuQ`→false), so capture's textContent accName
      AGREES with the engine. BUT the finding's *conclusion* (capture under-counts) is real for a
      different reason I then found: **role `--name` is a SUBSTRING match without `--exact`**, while
      capture counts EXACT — so a compiled `find role button --name "Close"` could match "Close dialog"
      etc. → false-green. **Fix: compile role with `--exact`** (findcmd + verify `_exactflag`); committed
      flows have 0 role steps so byte-identity holds; verified the role command now bakes `--exact`.
    - HIGH-2: `insufficient = !primary` removed the backstop that kept a single AUTO-generated locator
      (looksAuto) in needs_review. **Fix: `looksAuto` bar in roleAriaLabelButton + reverted insufficient
      to the `<2 candidates` backstop with ONLY a role-button exception** (so a lone non-role/auto
      candidate is never auto-promoted).
    - MED-3 (LBB negative didn't isolate the aria-labelledby guard) + LOW-4 (native `<input type=button>`
      exclusion untested): **fixed the test** — LBB now has aria-label==labelledby-name (isolates the
      guard), added an `<input type=button>` and an auto-label negative; 5 click targets now.
    - LOW-5 (SCHEMA "usually ≥2" stale; replay-fallback "no count==1 candidate" now imprecise):
      **softened both SCHEMA.md lines** + refreshed the README icon-only note (--exact, looksAuto).
  - Bug caught & fixed in the fixes: `looksAuto("CloseDialogQ")` tripped the Shannon-ENTROPY heuristic
    (3.25>3.2) → ICON wrongly needs_review. Entropy over-flags legitimate multi-word/camelCase labels
    (e.g. "Toggle navigation menu") → introduced `looksAutoName()` = STRUCTURAL patterns only (no
    entropy); a dynamic label that slips past at worst FLAKES red (--exact won't match), never
    false-greens. node-sanity: CloseDialogQ→false, menu_a1b2c3→true, "Toggle navigation menu"→false.
  - **Post-fix full `bash run.sh` = 12/12 GREEN** (capture-* all pass; verify-flow passes with
    --exact-for-role in _exactflag; byte-identity preserved).
  - Focused 2nd review of the fixes (3 dims → refute): **3 raised, 1 confirmed (MED, no live bug).**
    The confirmed: capture-iconbutton's engine probe HAND-WRITES `--exact` and no test exercised the
    compile→role→`--exact` path (compile-fallback only covered text/label/placeholder) — so a regression
    dropping `role` from the compile regex would go uncaught. **Fixed**: added a browser-free
    role-primary `--exact` assertion to compile-fallback.test.sh + made the capture-iconbutton probe
    comment honest. (Refuted: the fixture-has-no-substring-collision nit — true but no false-green; and
    a normalize-divergence claim — capture normalizes names the same way.)
  - Post-fix: compile-fallback GREEN standalone (new role assertion); framework code byte-identical to
    the 12/12 run, capture-iconbutton change is comment-only ⇒ suite holds at **12/12**.
  - **DONE — merged to master via `--no-ff`** (3 logical commits: feat / test / docs). Track complete.

## Status: COMPLETE & MERGED

Demoable: record/inject-capture an icon-only `<button aria-label="Close">` — it now captures a clean
`find role button --name "Close" --exact` step (no needs_review) that replays reliably. Icon links,
native checkbox/radio, `<input type=button>`, aria-labelledby controls, and auto-generated labels
correctly STAY needs_review (the engine won't resolve them as a primary, or they're fragile).

HUMAN-ONLY follow-up (FLAG): a headed re-capture of a real app's icon-only toolbar buttons to confirm
the role+name+--exact primary resolves in the wild — the example.com synthetic fixture + the engine
probes cover every code path, but live behaviour on a real component-library UI wants a person.
