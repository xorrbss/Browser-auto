# web-ui-followup — Plan / Tasks / Context

Last Updated: 2026-06-03

Follow-up batch after the P0–P3 web UI build (all merged to master). User-selected scope:
**C1, C2 (core capture.js), D1, D2 (webui)**. Run autonomously (ultracode): logical-unit
commits, `--no-ff` milestone merges, **`bash run.sh` GREEN gate on every change**, adversarial
review workflow after each subsystem's changes, verify empirically (parse fields, not exit codes).

Sequencing by risk: **webui extras (D1, D2) first** (isolated, low-risk) → then **core capture
(C1, C2)** (touches the verified framework — extra care, suite gate, re-validation).

## Constraints carried over (unchanged)
- Thin layer; browser jobs serial through the single-slot queue; localhost only; Git-Bash array
  args (NEVER `cmd.exe /c`); `.sh` LF; package.json stays inside webui/; never commit
  `.heartbeat`/`dev/process/`/`.claude/`. Disk C: ~97% — prune artifacts/Temp orphans as needed.

## Track D — webui extras (branch: feat/webui-extras)

### D1 — Jobs (history) view  [recommended]
- Frontend-ONLY (no backend change): a new "Jobs" nav view that uses the existing
  `GET /api/queue` (`{busy, running, pending, recent}`) to list running + pending + recent jobs
  (kind / label / status / exitCode / timing), each clickable to replay its log via the existing
  `GET /api/jobs/:id/stream` (SSE replay works for jobs still in the in-memory Map, last ~50).
- Acceptance: Jobs view renders the recent jobs; clicking one replays its log; auto-refreshes.

### D2 — webui small items
- **Auth state delete:** `DELETE /api/auth/:app` (or POST .../delete) → remove
  `fixtures/auth/<app>.state.json` (validApp-guarded); Auth view shows a delete button per
  cached app. (auth.js deleteAuthState.)
- **Artifacts retention:** auto-prune on server startup — keep newest N run dirs (env
  `WEBUI_KEEP_RUNS`, default e.g. 50), `log()` what was dropped. Disk hygiene (97%). Read/rm only
  under artifacts/, RUN_ID-pattern dirs only.
- **Run compare/diff:** pick two runs → show per-test pass↔fail changes (frontend, read-only,
  uses `GET /api/runs/:id`).

## Track C — core capture improvements (branch: feat/capture-improve)
Every change gated by `bash run.sh` GREEN (suite has build-flow-unit/capture-*/ianatour/
verify-flow) + adversarial review. capture.js facts confirmed: `pushCand` drops values >80 chars;
alt/title/aria-label already captured; pushState/replaceState/hashchange nav already captured.

### C1 — needs_review must never emit an EMPTY candidate list  [recommended]
- ROOT: `pushCand` `if (value.length > 80) return;` drops long values → empty candidate ladder
  (the ianatour #5 pain). 
- STEP 0 (empirical, BEFORE coding): drive agent-browser `find text "<long exact text>"` to learn
  whether the engine matches long exact text at all. 
  - If YES → include >80 values in the **candidate ladder** (for human/verify), but KEEP them out
    of the **auto-primary** selection (preserve the no-fragile-guess policy).
  - If NO → pivot: capture a stable short fallback (nearest labelled ancestor / short accessible
    name) so needs_review still offers a usable option.
- Check `tests/build-flow-unit.test.sh` expectations; update only if the contract genuinely changes.
- Acceptance: a long-text element yields ≥1 reviewable candidate (never empty); suite GREEN.

### C2 — SPA pure-DOM-swap wait gate
- Pure DOM-swap routers (no URL change, so no pushState/hash) currently emit no wait gate.
- Detect: a click that produces NO url change but a significant DOM mutation → emit a `wait`
  (until:load networkidle, or until:text on the next step's target) so replay settles.
- Acceptance: synthetic/sample DOM-swap click yields a wait gate; suite GREEN; no regression on
  the existing nav tests.

## STATUS
- [x] D1 Jobs view (frontend-only; lists /api/queue jobs, replays log via SSE)
- [x] D2 auth-delete (POST /api/auth/:app/delete) + artifacts-retention (pruneArtifacts on
      startup, WEBUI_KEEP_RUNS). run-diff SKIPPED (Trends test×run table already shows pass↔fail).
- [x] webui-extras review (7/7 confirmed) → fixes: cancelled-job stream now ends promptly
      (subscribe terminal check incl 'cancelled'); KEEP_RUNS parse+clamp (0 honored, negative
      can't wipe all) + pruneArtifacts(keep<0) guard; RUN_ID PID-numeric sort (same-second safe).
      All re-verified; suite 7/7 GREEN. **Merged to master.**
- [x] C1 long-text candidates (capture.js): `overLong()` helper; `pushCand` + P2 role+name no
      longer drop >80-char values (they enter the ladder); `emit()` auto-primary selection skips
      overLong → long text stays needs_review with a NON-EMPTY ladder; `score()` >80 penalty kept
      so short alternatives still rank first. Empirically verified by `tests/capture-longtext.test.sh`
      (in-page probe: 109-char button click → ladder non-empty + contains the long value, primary
      null, build-flow yields non-empty needs_review).
- [x] C2 DOM-swap wait gate: capture.js MutationObserver accumulates added/removed element subtree
      sizes; `armDomSwap()` after each click records a `dom_settle` if URL unchanged + mutation ≥
      DOM_SWAP_MIN within DOM_SWAP_SETTLE_MS. build-flow.js compiles `dom_settle` → `until:text` on
      next find (else `until:load networkidle`). Verified by `tests/capture-domswap.test.sh` (trivial
      click → none; big no-URL swap → exactly one, after the click) + deterministic dom_settle scenario
      in `build-flow-unit.test.sh`. Docs (README/SCHEMA) updated to match.
- [x] Track C committed (95d3935 on feat/capture-improve). **Full suite 9/9 GREEN** (baseline was
      7/7; +capture-longtext +capture-domswap).
- [x] capture-improve adversarial review (ultracode WF, 11 agents): 6 findings / **3 confirmed
      (all low)** after refute-by-default verify → all fixed:
      - c2-capture: two clicks inside the 350ms settle window over one swap recorded a DUPLICATE
        dom_settle → fixed with a `mutConsumed` high-water mark (records the marker exactly once,
        attributed to the first window that observes the fresh swap; never misses a genuine swap).
      - c2-buildflow: the dom_settle `until:text` look-ahead skipped a `navigate` boundary and
        borrowed POST-nav text (would wait on the old page) → now treats `navigate` as a terminator
        (falls back to until:load; the navigate's own url-wait gate settles it).
      - regression-contract: README:177 still said needs_review "(≥2 candidates)" → C1 makes a
        1-candidate ladder reachable → reworded to "non-empty … usually ≥2" (matches SCHEMA + code).
      - Regression guards added to build-flow-unit (browser-free, deterministic): a 1-candidate
        needs_review stays non-empty (never padded/dropped); navigate-after-dom_settle falls back to
        until:load with the url-wait AFTER it. (3 refuted findings were cosmetic/latent, not defects.)
- [x] re-gate **9/9 GREEN** after fixes → fix commit (4f21782) → **--no-ff merged to master
      (7ef4bc7)**. Track C COMPLETE.

## TRACK C — DONE (2026-06-03)
- master HEAD = 7ef4bc7. Full suite **9/9 GREEN** (build-flow-unit, capture-domswap,
  capture-healthcheck, capture-longtext, capture-newtab, ianatour, login, nav-roundtrip,
  verify-flow). capture.js 375 lines (<500); zero new deps; thin layer preserved.
- New permanent regression tests: `tests/capture-longtext.test.sh` (C1 in-page probe),
  `tests/capture-domswap.test.sh` (C2 in-page probe), + 4 deterministic build-flow-unit scenarios
  (dom_settle→wait, 1-candidate non-empty, navigate-after-dom_settle look-ahead).
- **HUMAN-only validation flagged (cannot be automated):** a live headed re-record via
  `record.cmd <name> <url> --seconds N` driving real Chrome on (a) a >80-char descriptive link and
  (b) a pure client-side DOM-swap SPA, then `verify` + `compile` + `run.sh`, to confirm C1/C2
  end-to-end on a real page. All in-page mechanisms are verified autonomously; only the real headed
  capture needs a person.
- The whole web-ui-followup batch (D1, D2, C1, C2) is now complete and on master.
- [ ] HUMAN-only: a live headed re-record (record.cmd driving real Chrome on a real long-text link +
      a pure-DOM-swap SPA) to confirm C1/C2 end-to-end. Every autonomously-verifiable mechanism is
      covered; only the real headed capture needs a person.
