# needs-review batch (#5–#7) — Plan & Progress

Branch: `feat/needs-review-batch` (off `master`). The second batch from `dev/active/hardening-backlog/`
(items #5, #6, #7). Three independent items, separate logical commits, one suite gate + one adversarial
review + one `--no-ff` merge — same discipline as `hardening-top3`.

Every design decision below was **probe-verified** on agent-browser 0.27.0 first (가정 금지). Probe scripts
were throwaway (gitignored `artifacts/_probe-nr*.sh`); findings recorded inline.

## Probe ground-truth (0.27.0)

- **contenteditable is fillable**: `find <loc> fill <text>` on a `<div contenteditable>` returns
  `success:true` and the text lands in `textContent`. (`find … type` does NOT exist — "Unknown subaction".)
- **contenteditable has no `.value`**: `('value' in div)` is false, so the old `valueOf()` returned
  null and the typed text was LOST (probe: buffer never contained the typed string).
- **`<select multiple>`**: `el.value` / `el.selectedIndex` expose only the FIRST selected option
  (probe: 2 options selected → `value:"a"`, `selectedIndex:0`). A single-value `select` step silently
  drops the rest.
- **`get count <css>` contract**: returns `{success:true, data:{count:N,selector:…}}` — the count is at
  **`.data.count`** (NOT `.data.result`; that mistake made an earlier read look null). dup→2, uniq→1,
  none→0, `.z`→2 all correct. So a testid's CSS-equivalent uniqueness IS re-checkable at replay.
- **`data:` URLs HANG `open`** (Chrome stalls on the unencoded navigation, wedging the daemon) — the #7
  test uses a `file://` fixture (`pwd -W` → `file:///C:/…`) instead.

## #5 — contenteditable value capture (value-loss / sensitive-mislabel fix)

(Reclassified from "false-green": a needs_review/blank-token contenteditable fails LOUD at compile/replay,
so the real defects are lost text + a benign field mislabelled sensitive — a fidelity/coverage fix, not
a silent green. #6 and #7 ARE false-greens.)

`valueOf()` now reads `el.textContent` for a contenteditable lacking `.value`. Before: null →
build-flow's `input_value == null` branch treated it like a MASKED field and emitted a `{{input_N}}`
fill that no-ops at replay (the typed text neither recorded nor replayed = false-green). `sensitive()`
still gates first (a sensitive contenteditable stays masked). The value goes to the gitignored
`values.json` sidecar like any other input; replay fills it (probe-verified). Test:
tests/capture-contenteditable.test.sh — captures the value (not null), maps to a `fill` step, and
PROVES the value replays into a contenteditable (observable work, `.success` not exit code).

## #6 — `<select multiple>` → needs_review

The `change` handler flags `el.multiple` with `insufficient:true` so build-flow routes it to
needs_review: the single-value `select` action can't faithfully represent a multi-select (only option#1
is reachable via `el.value`), and silently selecting one of N is a false-green. build-flow's `select`
branch also skips tokenizing when insufficient (no misleading partial value written to the sidecar).
A human resolves the step explicitly (agent-browser `select <sel> <val…>` does accept multiple values,
so a hand-authored multi-value select is possible — out of scope for auto-capture, YAGNI). Test:
tests/capture-select-multiple.test.sh — a LOCATABLE multi-select (testid) is flagged needs_review
(proving it's the `multiple` flag, not a missing locator), while a single-select with the same locator
captures a clean `select` step (control: no over-flagging).

## #7 — verify-flow testid uniqueness cross-check + honest wording

`bin/verify-flow.sh` verified each step's locator RESOLVES and its action SUCCEEDS, then printed
"Safe to compile" — but it never re-checked replay-time UNIQUENESS, so a `testid` that drifted to match
2+ elements would still pass (find silently acts on the first = false-green). testid is the one locator
with a CSS equivalent, so for each resolved `testid` step verify now `get count`s the 4-attr selector
(`[data-testid="v"],[data-test-id="v"],[data-test="v"],[data-cy="v"]`) BEFORE acting:
`count >= 2` → promote to needs_review + fail loud; `0/1` → ok (0 = inconclusive: shadow DOM / other
data-* attr → not failed). Values with `"`/`\` skip the check (can't build a safe selector). The final
message is now honest: it verifies resolvability + action + (for testid) replay uniqueness, and states
that non-testid locators have no replay-count primitive on 0.27.0 (capture-time estimate only).
Test: tests/verify-flow.test.sh case 5 — a `file://` fixture with a duplicate testid promotes to
needs_review (exit != 0); a unique testid passes (control: no false-RED).

## Gates

1. `node --check bin/capture.js bin/build-flow.js`, `bash -n` tests. Byte-identity of committed flows.
2. Each new/changed test GREEN individually.
3. Full `bash run.sh` (target 18/18 — adds capture-contenteditable + capture-select-multiple).
4. Adversarial review → verify each finding (JSON/field, never exit code) → fix → `--no-ff` merge.

## Progress log

- 2026-06-05: branch + plan. Probes nr1–nr6 (ground-truth above; nr4/nr5 "hangs" were the cold-spawn-pipe
  footgun, not the URL scheme — file:// works when the first open is redirected, confirmed by nr6).
- #5 committed (e7db056): capture.js valueOf reads contenteditable textContent; capture-contenteditable
  GREEN (46.9s). Fixture uses role=textbox+aria-label+testid (a lone-testid div is needs_review by the
  <2-candidate backstop — realised via the first test failure).
- #6 committed (b66bcd9): capture.js change handler flags el.multiple insufficient; build-flow skips
  tokenizing an insufficient select; capture-select-multiple GREEN (46.2s).
- #7 committed (6cf7dd5): verify-flow.sh testid get-count cross-check (>=2 -> needs_review) + honest
  verdict; verify-flow GREEN (198.5s, +2 file:// cases). get count returns `.data.count` (not .result).
- Docs: SCHEMA.md (verify cross-check, select-multiple needs_review, contenteditable fill) + README
  (actions-covered, contenteditable, select-multiple bullets).
- NEXT: full `bash run.sh` gate (18/18) -> adversarial review -> fix -> --no-ff merge.
