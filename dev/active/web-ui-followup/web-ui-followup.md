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
- [ ] D1 Jobs view
- [ ] D2 auth-delete + artifacts-retention + run-diff
- [ ] webui-extras review + merge
- [ ] C1 long-text candidates (engine pre-check first)
- [ ] C2 DOM-swap wait gate
- [ ] capture-improve review + merge + re-validate
