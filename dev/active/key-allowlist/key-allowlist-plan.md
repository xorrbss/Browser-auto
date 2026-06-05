# key allowlist (#8) — Plan & Progress

Branch: `feat/key-allowlist` (off `master`). Backlog item #8: capture a non-Enter navigation key
allowlist (Esc/Tab/Arrows) as `press`; warn on modifier combos. Single-item track, one suite gate +
one adversarial review + one `--no-ff` merge.

## Probe ground-truth (0.27.0)

- **`press` accepts ANY key name** — Escape/Tab/ArrowUp/Down/Left/Right/Space/' '/Enter/Shift+Tab/
  Control+a/Control+s/Meta+k/Alt+ArrowDown, AND the non-standard `Esc`/`Spacebar`, ALL returned
  `success:true`. So `press` does NOT validate names; it is **best-effort like `scroll`** — a no-op
  press cannot false-green (the next locator gates correctness), and the engine will not flag a wrong
  name, so capture must emit correct names.
- `e.key` already yields the exact names `press` wants (Escape/Tab/ArrowUp/...). Combos use the
  `Control+`/`Meta+`/`Alt+`/`Shift+` prefixes (probe-confirmed). So **no key-name mapping is needed.**
- `compile` (probe-record.sh:121) already maps `press` -> `["press", value]` as a generic batch command,
  so any value (Escape, Shift+Tab, Control+s) replays with NO compile change; `press Enter` already runs
  through batch today.

## Design (capture.js keydown handler + build-flow.js)

- **Allowlist captured as `press`:** Enter (existing) + Escape, Tab, ArrowUp/Down/Left/Right.
- **Excluded — Space** (and all bare printable keys): in a text field Space is text (the input listener
  already captures it); on a button/checkbox it fires a synthetic click (the click handler captures it).
  Capturing it as a press would DUPLICATE. Bare letters/digits are text too. Documented exclusion
  (consistent with the drag/upload/container-scroll exclusions).
- **Modifier combos:** a ctrl/meta/alt shortcut — on an allowlist key (Ctrl+ArrowDown) OR a single
  printable key (Ctrl+S) — is captured as a combo press (`Control+...`) but FLAGGED `modifier:true`, so
  build-flow emits the press AND a WARNING (its effect is app-specific and may not replay
  deterministically). **Shift is NOT a shortcut modifier** (Shift+Tab / Shift+Arrow are normal
  navigation) — a Shift-only combo is captured but not flagged/warned.
- **Ordering:** flushAll() commits any pending input/scroll BEFORE emitting the key, so the buffer order
  is fill-then-press (the same guarantee Enter has; pins the type-then-Tab case).
- No false-green risk: a captured key is a best-effort press (like scroll); an extra/no-op press is
  harmless and the next locator gates correctness. The modifier WARNING surfaces shortcuts for review.

## Gates

1. `node --check bin/capture.js bin/build-flow.js`; `bash -n` test. Committed flows byte-identical.
2. capture-keys GREEN.
3. Full `bash run.sh` (target 19/19 — adds capture-keys). 4. Adversarial review -> fix -> --no-ff merge.

## Progress log

- 2026-06-05: branch + plan. Probe (press accepts any name; best-effort). capture.js keydown allowlist +
  build-flow modifier-warn + capture-keys.test.sh written.
