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
| 5 | contenteditable mis-captured as masked sensitive → fix or needs_review | med / low / low | coverage |
| 6 | `<select multiple>` → needs_review (only option#1 captured today) | med / low / low | coverage |
| 7 | verify-flow "Safe to compile" wording + testid `get count` cross-check | med / low / med | false-green |
| 8 | non-Enter key allowlist (Esc/Tab/Arrows/Space) as `press`; warn modifier combos | med / low / med | coverage |
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
