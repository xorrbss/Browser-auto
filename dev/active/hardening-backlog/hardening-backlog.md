# agent-qa hardening backlog (generated 2026-06-04)

Produced by a read-only multi-facet analysis (6 analysts → synthesis) after the original priority
backlog (#1 replay-fallback, #2 action-coverage, #3 icon-only) was completed. Ranked best-first;
favors high value + low risk-to-stability + alignment with the no-false-green prime directive. Each
item is its own track: implement on a feat/* branch → `bash run.sh` GREEN → adversarial review → merge.

## Recommended top 3 — DONE (merged `6ee197e`, 2026-06-05)

Items #1–#3 below shipped as one batch (`feat/hardening-top3`): 16/16 suite GREEN + adversarial review
(8 raised, 3 confirmed test-only false-greens, 5 refuted; all fixed). Next track starts at #4.

1. **check/uncheck for checkbox/radio** — the clearest *live false-green*: capture.js emits a bare
   `click` for checkbox/radio, so replay TOGGLES; if the initial state differs the final state is
   wrong yet the run passes green. compile/SCHEMA already accept check/uncheck — only capture.js +
   build-flow.js need the branch (emit check/uncheck with the desired post-state).
2. **Pin `*.js`/`*.json`/`*.md` to `eol=lf` in `.gitattributes` + renormalize** — only `*.sh` is
   pinned today; capture.js is CRLF, build-flow.js is LF, and a build-flow.js edit already silently
   flipped LF→CRLF this session. Lowest effort/risk; freezes the one file injected into the browser
   and stops phantom-CRLF diffs from hiding gate-logic changes.
3. **Headless regression pinning `sensitive()` masking** — the PII mask is a prime guarantee whose
   only test feeds a synthetic `masked:true` record (it would stay green even if `sensitive()` were
   gutted to `return false`). Drive real password/OTP/cc fields + a benign email and assert the
   masking decisions executably.

## Full ranked backlog

| # | title | v / risk / eff | facet |
|---|-------|----------------|-------|
| 1 | ✓ DONE — check/uncheck for checkbox/radio (vs blind click toggle) | high / med / med | false-green |
| 2 | ✓ DONE — `.gitattributes` eol=lf for js/json/md + renormalize | high / low / low | structure |
| 3 | ✓ DONE — headless regression pinning `sensitive()` masking | high / low / med | security |
| 4 | verify+fix `<select>` value-vs-text matching on 0.27.0 (real regression) | high / low / med | open-risk |
| 5 | ✓ DONE — contenteditable mis-captured as masked sensitive → fix or needs_review | med / low / low | coverage |
| 6 | ✓ DONE — `<select multiple>` → needs_review (only option#1 captured today) | med / low / low | coverage |
| 7 | ✓ DONE — verify-flow "Safe to compile" wording + testid `get count` cross-check | med / low / med | false-green |
| 8 | ✓ DONE — non-Enter key allowlist (Esc/Tab/Arrows; Space excluded — redundant) as `press`; warn modifier combos | med / low / med | coverage |
| 9 | assert_text require VISIBLE text (or assert_text_visible for confirmation gates) | med / low / med | false-green |
| 10 | opt-in `assert_count==1` companion for testid steps (duplicate-drift) | med / low / med | open-risk |
| 11 | bounded settle poll on positive-presence asserts (text/visible/value) | med / med / med | flake |
| 12 | wait_url consecutive-match stability (don't return mid-redirect) | med / low / low | flake |
| 13 | optional per-flow `waitTimeout` threaded into wait_url | med / low / low | flake |
| 14 | bounded settle vs unbounded networkidle for dom_settle fallback | med / med / med | flake |
| 15 | bounded daemon-health probe + one-shot recovery in preflight | med / med / med | gate |
| 16 | disk-headroom preflight gate + opt-in orphan-profile reaper | med / low / med | gate |
| 17 | exempt author-chosen testids from Shannon-entropy auto-id demotion | med / low / low | open-risk |
| 18 | same-origin iframe interaction → explicit fail-loud exclusion | med / med / med | coverage |
| 19 | prune aria-hidden/display:none subtrees in accName name-from-contents | med / med / high | false-green |
| 20 | mandatory inline hover-probe when auto-accepting an aria-label-button role primary | med / med / med | open-risk |
| 21 | widen `sensitive()` with conservative value-shape heuristics (Luhn, bare OTP) | med / low / med | security |
| 22 | raise capture candidate cap 2→4-5 for richer fallback/repair ladders | med / med / low | flake |
| 23 | reap pre-existing `_`-prefixed scaffold-straggler tests at suite start | low / low / low | gate |
| 24 | boundary regression for sub-threshold dom_settle + document 12/350 magics | low / low / med | coverage |
| 25 | clear stale `.flow.json.incomplete` at capture start; NOTE at compile | low / low / low | structure |
| 26 | de-dup the {{input_N}} substitution shared by _run_batch and _find_fb | low / med / med | structure |
| 27 | split compile() out of probe-record.sh into bin/compile-flow.sh | med / med / med | structure |
| 28 | preserve replayable same-origin prefix on cross-origin/new-tab abort | low / med / high | open-risk |
| 29 | redact/gate values.json in webui getFlow (no plaintext over HTTP) | low / low / low | gate |

## Playwright-only reclassification (2026-06-11)

Status meanings:

- `implemented`: covered by current local code/tests.
- `non-blocking`: useful hardening or test coverage gap, but not a current deterministic-replay blocker from local evidence.
- `obsolete`: premise depended on the removed agent-browser/replay-fallback architecture or is superseded by fail-closed Playwright behavior.
- `blocking`: must be fixed before treating local deterministic replay as ready.

| # | status | current classification and local evidence |
|---|--------|--------------------------------------------|
| 4 | obsolete / rewritten non-blocking | The Browser 0.27.0 value-vs-text premise is obsolete. Playwright replay selects with `selectOption(resolveValue(...))` in `approve/flow-runner.mjs`; capture records the selected option value and `bin/build-flow.js` warns when option text differs from value. Keep only as a non-blocking Playwright smoke gap for a single-select whose label text differs from option value. Evidence: `approve/flow-runner.mjs`, `bin/capture.js`, `bin/build-flow.js`, `tests/capture-e2e.test.sh`, `tests/flow-runner-unit.test.sh`. |
| 9 | implemented | Text asserts read `page.locator('body').innerText()` in `bin/play-flow.mjs`, so hidden DOM text is not accepted as raw text content. Wait-text steps use Playwright `getByText(...).waitFor()` in `approve/flow-runner.mjs`. Evidence: `bin/play-flow.mjs`, `approve/flow-runner.mjs`, `flows/SCHEMA.md`. |
| 10 | implemented / superseded | Playwright replay enforces `count() === 1` for every effectful find locator, not only testid steps, and verify repair only accepts capture-time-unique candidates. Evidence: `approve/flow-runner.mjs`, `bin/play-flow.mjs`, `tests/flow-runner-unit.test.sh`. |
| 11 | non-blocking | Final positive-presence asserts do not have a dedicated settle poll. They run after bounded Playwright steps, but assert-specific polling remains a useful flake hardening item. Evidence checked: `bin/play-flow.mjs`. |
| 12 | non-blocking | URL waits still use Playwright `waitForURL` directly; redirect egress refusal is tested, but there is no consecutive-match URL-stability helper. Evidence: `approve/flow-runner.mjs`, `tests/play-flow-smoke.test.sh`. |
| 13 | implemented / rewritten | Rewritten as per-step `timeoutMs`, validated up to 10 minutes and passed into waits/actions. There is no separate per-flow timeout knob. Evidence: `approve/flow-runner.mjs`, `flows/SCHEMA.md`, `tests/flow-runner-unit.test.sh`, `tests/play-flow-smoke.test.sh`. |
| 14 | implemented | `networkidle` fallback is bounded by `waitForLoadState(..., { timeout })`, with default/per-step timeout. DOM-settle recording and wait-gate behavior are covered locally. Evidence: `approve/flow-runner.mjs`, `bin/build-flow.js`, `tests/build-flow-unit.test.sh`, `tests/capture-e2e.test.sh`. |
| 15 | obsolete | Agent-browser daemon health no longer applies. Preflight checks the local Playwright runtime, not a browser daemon service. Evidence: `lib/preflight.sh`, `README.md`, `AGENTS.md`. |
| 16 | non-blocking | No local implementation found for disk-headroom gating or orphan-profile reaping. This remains operational hardening, not a Playwright correctness blocker from local evidence. Evidence checked: `lib/preflight.sh`, `bin/play-flow.mjs`, `run.sh`. |
| 17 | implemented | The recorder keeps explicit dynamic-id patterns and the multi-number heuristic but drops Shannon-entropy demotion. Evidence: `bin/capture.js`. |
| 18 | implemented / rewritten | Rewritten from same-origin iframe exclusion to safe same-origin iframe support; cross-origin iframe actions become review evidence and fail closed. Evidence: `flows/SCHEMA.md`, `bin/capture.js`, `bin/build-flow.js`, `approve/flow-runner.mjs`, `tests/capture-e2e.test.sh`, `tests/flow-runner-unit.test.sh`, `tests/rpa-local-fixture-e2e.test.sh`. |
| 19 | non-blocking | Capture still derives name-from-contents from `textContent`; `visible()` exists but is not used to prune hidden subtree text in `accName`. Playwright replay remains fail-closed on locator mismatch, so this is authoring-quality hardening. Evidence: `bin/capture.js`. |
| 20 | non-blocking / partially covered | Capture auto-accepts explicit `aria-label` buttons; verify later hover-probes repaired locators before replay. There is no inline capture-time hover probe. Evidence: `bin/capture.js`, `bin/play-flow.mjs`, `tests/capture-e2e.test.sh`. |
| 21 | non-blocking | Current masking covers password, secret autocomplete values, and numeric/tel/number fields with sensitive hints. Bare value-shape heuristics such as Luhn-only card numbers or unlabeled OTPs are not present. Evidence: `bin/capture.js`, `tests/capture-e2e.test.sh`. |
| 22 | obsolete / rewritten non-blocking | Replay-time fallback is removed. Verify-time repair uses candidate sidecars and only capture-time-unique candidates; raising the capture cap is optional authoring UX rather than replay correctness. Evidence: `flows/SCHEMA.md`, `bin/capture.js`, `bin/build-flow.js`, `bin/play-flow.mjs`, `tests/build-flow-unit.test.sh`. |
| 23 | non-blocking | `run.sh` excludes `_*.test.sh` throwaway compiled flows from suite globbing but does not proactively delete them. Evidence: `run.sh`, `AGENTS.md`. |
| 24 | implemented | DOM-settle thresholds are named in recorder code and exercised through build/capture tests for settle marker and wait-gate behavior. Evidence: `bin/capture.js`, `bin/build-flow.js`, `tests/build-flow-unit.test.sh`, `tests/capture-e2e.test.sh`. |
| 25 | obsolete | Current Playwright capture writes records to a temp file and `build-flow.js` writes the final `.flow.json`; no `.flow.json.incomplete` path is present. Evidence: `bin/pw-record.mjs`, `bin/build-flow.js`; local grep found no `.flow.json.incomplete` implementation. |
| 26 | obsolete / implemented by rewrite | Removed shell runner/fallback premise. Token resolution is centralized in `bin/play-flow.mjs` and passed into `approve/flow-runner.mjs`. Evidence: `bin/play-flow.mjs`, `approve/flow-runner.mjs`, `tests/compile-engine-unit.test.sh`, `tests/flow-runner-unit.test.sh`. |
| 27 | non-blocking | Compile still lives in `bin/probe-record.sh` and emits a small Playwright wrapper. This is structural cleanup only. Evidence: `bin/probe-record.sh`, `tests/compile-engine-unit.test.sh`. |
| 28 | obsolete / intentionally rejected | The Playwright recorder fails loud and writes no flow artifacts for popup/new-tab or top-level cross-origin recording boundaries. Preserving a partial prefix would weaken that fail-closed behavior. Evidence: `README.md`, `flows/SCHEMA.md`, `bin/pw-record.mjs`, `tests/pw-record-guards-unit.test.sh`. |
| 29 | implemented | `getFlow()` returns value presence/status/storage metadata and blank values, not raw `.values.json` content; external/encrypted mode exposes opaque secret metadata only. Evidence: `webui/flows.js`, `tests/webui-flows-unit.test.sh`, `tests/webui-external-secret-mode-unit.test.sh`, `tests/webui-artifact-boundary-unit.test.sh`, `tests/webui-security-unit.test.sh`. |

Current summary:

- Blocking: none identified from local source/test evidence for items #4 and #9-29.
- Non-blocking: #4 rewritten Playwright select smoke, #11, #12, #16, #19, #20, #21, #22 authoring candidate depth, #23, #27.
- Obsolete: #15, #25, #26, #28; #4 and #22 have obsolete agent-browser/fallback premises with optional Playwright-era follow-ups.
- Implemented/superseded: #9, #10, #13, #14, #17, #18, #24, #29.

## Dropped (and why)

- Classified single-retry for transient daemon errors in _ab_data/_find_fb — too risky to no-false-green
  (a retry indistinguishable from a real success:false reintroduces false-green); fix the wedge at
  preflight (#15) instead.
- "replay-time uniqueness re-verification" (generic) — folded into #10 (testid count) + #7 (verify
  wording); the non-testid case has no count primitive on 0.27.0 (documented ceiling).
- "select round-trip never verified" — duplicate of #4.
- dom_settle-thresholds (generic) — folded into #24.
- accname-divergence (generic) — folded into #19 + #20.
- blanket `* text=auto` for EOL — KISS; #2 enumerates only the 3 text families that exist.
