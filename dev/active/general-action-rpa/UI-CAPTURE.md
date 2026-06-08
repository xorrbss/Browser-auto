# Web-UI approve capture / config (Gate-B in the browser) — DESIGN ONLY

> **STATUS: DESIGN ONLY (no code).** Lets a non-developer OPERATOR make a system/form approvable **in the web
> UI** — capture the approve UI, configure it, dry-run test it, and enable it — instead of the current
> operator-CLI + hand-edited `recipes/<app>.json`. It is a **thin orchestration layer over EXISTING proven
> components** (the recorder `bin/probe-record.sh`/`capture.js`/`build-flow.js`, the leaf `approve-run.mjs`, the
> pure `approve/guards.mjs`, the `flow.json` schema, `routes-approve.js`, `jobs.js`) — **no leaf/guard/schema
> change**. Synthesized from a design workflow (capture mechanism · safety/integration), grounded in
> `recipes/SCHEMA.md`, `flows/SCHEMA.md`, `GATE-B-CAPTURE.md`, `general-action-rpa/DESIGN.md`. This is the
> **UI for the per-action Gate-B capture** that Step C deferred to "operator-accompanied".

## 0. The pain this solves
Making a system/form approvable today is CLI + hand-editing the recipe's `actions.approve` (identity, title,
form-type, amount, button/radio/confirm, completion marker). Worse, **per-form/per-role layouts differ** — a
**합의(concurrence)** doc has a different detail layout than a primary-결재 doc (the 문서번호 identity cell count
differs, the 결재 button is on another line), so the identity guard correctly fail-closes and that form needs
its OWN capture. The operator wants to capture these scenarios **in the UI, watching, and see results** — not
guess at locators in a JSON file.

## 1. The feature — a "🔧 결재 액션 캡처 (Gate-B)" panel (in the 시스템/결재 tab)
A 5-step, operator-driven flow. The **operator is the author**; the model is absent from capture, dry-run, and
enable. Each captured action starts **`enabled:false`** and only an operator flips it on after a live verify.

1. **Setup** — pick `app` (cached recipes dropdown), `form-type` (e.g. `지출결의서(거래처)` / `합의` / null),
   and a **disposable `doc_id`** with a checkbox *"I confirm this is a throwaway test doc, safe to approve"*.
2. **Record (캡처)** — `POST /api/capture/record` enqueues the **existing** `bin/probe-record.sh` (headed
   Chrome via `--init-script capture.js`, the same pipeline as the 여정 녹화 panel) pointed at the doc's detail.
   The operator performs the action manually: **문서번호 → 결재 → 승인 라디오 → 의견**, and **STOPS BEFORE 확인**.
   `build-flow.js` compiles the recording to `flows/approve-<app>-<form>.flow.json` (semantic locators only, no
   `@ref`; `needs_review` on any unresolved step). **The test doc is left UNAPPROVED** (확인 never clicked).
3. **Configure (10-field Gate-B checklist)** — the panel maps the captured flow + operator-confirmed facts into
   a `recipe.actions.<form>` block (an editable form, raw-JSON as an escape hatch). Each field has a `[✓ verify]`:
   | # | field | req | source |
   |---|---|---|---|
   | 1 | **identity** (open by unique 문서번호 cell, count===1) | ✅ | operator clicks the 문서번호 cell → assert count===1 |
   | 2 | **title** binding field | ✅ | auto-fetch / enter |
   | 3 | **form-type** h1 | — | read the detail h1 |
   | 4 | **button** (결재) | ✅ | extracted from the recorded 결재-click step |
   | 5 | **decision radio** (승인) | ✅ | extracted from the recorded 승인 step (position before button) |
   | 6 | **opinion** placeholder | — | extracted from the fill step if present |
   | 7 | **confirm** (확인) + **`irreversible.atIndex`** | ✅ | PINNED here, **not** auto-clicked in capture |
   | 8 | **amount.label** | — | operator selects a visible label (or null) |
   | 9 | **completion marker** (승인-stamp text + 대기-departure) | ✅ | operator describes the success signal |
   | 10 | **pagination** mode | — | confirm combobox / none |
4. **Dry-run (미리보기)** — `POST /api/capture/dry-run` spawns `approve-run.mjs --dry-run` on the disposable
   doc with the captured block. The UI shows a **per-GUARD PASS/FAIL** (identity count==1 ✓/✗, title ✓/✗,
   form-type, button/radio/confirm reachable, **stopped before 확인**) — so the operator SEES exactly which step
   failed (the way the 합의 `idLabel` fail-closed surfaced). Fail-closed; iterate (re-capture/edit) until green.
5. **Live-verify → Enable** — on a **DIFFERENT** disposable doc (a fresh one, to avoid double-approving),
   `POST /api/capture/verify` runs the SAME leaf `--live --max 1`: the single real 확인 → verify the completion
   marker (승인-stamp on the operator's line + 대기-departure). The operator **visually confirms** + ticks the
   checklist (*"I watched the 승인 stamp appear and the doc left 대기"*), then `POST /api/capture/enable`
   **atomically** writes `recipes/<app>.json` with the `actions.<form>` block + `capture:{checklist,date,
   capturedBy}` + **`enabled:true`**.

## 2. Multi-form / 합의 — separate captures per layout (the direct fix)
Each form/role layout is captured **separately** → `actions.approve_지출결의서`, `actions.approve_합의`, … (or one
action per form with a `formType` pin). At run time the leaf reads the doc's form-type h1 and selects the
**matching** captured action; an unknown form ⇒ fail-closed (no guessing). The completion marker (#9) is
**form-aware** (합의's success signal differs from 결재's). This is exactly how the 합의 case becomes approvable —
its own capture, not a forced click on the wrong layout.

## 3. Non-negotiable invariants preserved (DESIGN §I1–I7)
- **I1 No LLM on replay.** The `flow.json` is RECORDED by the operator (operator = author); the model never
  touches capture / dry-run / enable. Replay is deterministic bash+Playwright. The model may (later, optional)
  *propose* a locator like 구조분석 does, but the operator confirms and replay stays LLM-free.
- **I2 Fail-closed.** Dry-run reuses the production leaf's guards **unmodified** (identity count==1, title bind,
  decision asserted, positive completion). Any structural mismatch / `needs_review` ⇒ refuse + show the error.
- **I3 Capture never approves.** It STOPS before 확인; the disposable-doc checkbox is required; the confirm is
  **pinned in the recipe**, not clicked during capture.
- **I4 Trusted click** for the irreversible 확인 (Playwright), only at live-verify / production.
- **I5 Operator is the enable gate.** No auto-enable, no model judgment; `enabled:false` until the operator
  ticks the verified checklist. Make the **활성화** button explicit; refuse to enable if the box is unticked.
- **I6 Append-only audit.** Dry-run/verify write `approve-audit.jsonl` (`dry_ok`/`failed`); enable appends a
  `stage:"capture-enabled"` line with the capture metadata. Atomic recipe write (fsync) ⇒ no half-state on crash.
- **I7 Single-user localhost.** UI-only, 127.0.0.1, the existing present-Origin + session gate; capture needs a
  human at the browser + the 결재 login — **unattended capture is impossible by design**.

## 4. Integration (thin layer; no leaf/guard/schema change)
- **New routes** (in `routes-approve.js`, behind the existing Origin+session gate): `POST /api/capture/record`
  (enqueue probe-record), `GET /api/capture/flows?app=`, `POST /api/capture/dry-run`, `POST /api/capture/verify`,
  `POST /api/capture/enable` (atomic recipe write + structural validation).
- **New module** `webui/capture.js`: list/read captured flows; spawn the leaf dry/verify (reuse `jobs.js`/spawn);
  `saveCaptureRecipe(app, form, facts)` (read recipe → merge `actions.<form>` → atomic write).
- **New UI** panel `#sys-capture-gate` (index.html + app.js).
- **Reused unchanged**: `probe-record.sh` + `capture.js` + `build-flow.js` (record), `approve-run.mjs` (dry/live
  replay), `approve/guards.mjs` (validation), `lib/db.js` (title/list-url), `jobs.js` (job stream), the recipe
  format (only an optional `capture:{}` field added).

## 5. Failure modes the design answers (adversarial)
- **Mis-captured identity** (non-unique / substring) → the flow is semantic+exact (no `@ref`); the dry-run
  re-verifies `count===1` (abort on 0/≥2).
- **Mis-captured completion** (the recorded last step isn't the real commit) → the operator watches the headed
  browser; completion is verified **positively** (stamp AND departure), never absence-only; ambiguous ⇒ failed.
- **Enable without a real verify** → unticked checklist ⇒ refuse `enabled:true` (no silent accept).
- **Double-approval race** → fresh disposable doc + `--max 1` cap + kill-switch + countDoc all-pages + reconcile.
- **Stale/tampered recipe** → git-versioned; the UI's only writer is the validated atomic enable step; the leaf
  re-validates every recipe at startup (`resolveAction`, `validateSteps`); no LLM re-generation.
- **Cross-origin/iframe form** → capture is single-top-frame only (ceiling); documented; Gate-B rules out iframes
  for Hiworks.

## 6. Phased rollout
- **Phase 1a (DRY-RUN TEST) — ✅ BUILT (2026-06-08):** test any action's locators on a disposable doc from the
  UI and see **per-guard PASS/FAIL**, never approving. `webui/capture.js` (`buildPreviewRecipe` — a NON-committed
  temp preview that strips `enabled:false` so an uncaptured action resolves for a DRY test; `listCaptureFlows`;
  `sweepOldPreviews`), `POST /api/approve/capture/dry-run` (temp preview recipe → leaf `--dry-run --action`,
  behind the approveGate; **no recipe write, no enable**) + `GET /api/approve/capture/flows`, the 🔧 결재 캡처 card
  in the 결재 tab (app/doc/action/title/optional-block → per-guard stages from the audit), `tests/capture-unit.test.sh`.
  Live-verified: a 지출 dry-run shows `✓ requested → ✓ identity_ok → ✓ dry_ok`; a mismatched form surfaces its
  failing guard (e.g. `✗ failed — idLabel …`) right in the UI. Suite 30/30.
- **Phase 1b (RECORD → block assembly) — ✅ BUILT (2026-06-08):** `assembleActionBlock(flow, facts)` (pure, in
  `webui/capture.js`) turns a RECORDED approve flow (button 결재 / decision 승인 / opinion — extracted from the
  flow) + an operator checklist (confirm 확인 / formType / amount label / success — `facts`) into a
  `recipe.actions.<form>` block, **`enabled:false`** (fail-closed), refusing if a required part is missing.
  `POST /api/approve/capture/assemble {app, flowName, facts}` reads `flows/<flowName>.flow.json` → returns the
  block; the 🔧 capture card's "📥 녹화 플로우 → 블록 조립" fills the block textarea → the operator reviews →
  dry-runs (1a). The RECORD itself REUSES the existing 플로우-tab recorder (the operator records the approve
  journey on a disposable doc, stopping before 확인) — no duplicate record path. Unit-tested + live-verified the
  full chain (recorded flow → assembled block → dry-run → `✓ identity_ok → ✓ dry_ok`). Still NO recipe write /
  enable (Phase 2). The headed recording needs a human at the browser (operator-accompanied).
- **Phase 2 (live-verify + atomic enable) — ✅ BUILT (2026-06-08):** `POST /api/approve/capture/verify` (the
  SINGLE real 확인 on a DISPOSABLE doc — `--live --max 1`; requires an explicit `confirm:true`, the operator's
  conscious live test) + `POST /api/approve/capture/enable` (`enableActionInRecipe` → **atomic** write of the
  block into `recipes/<app>.json` with `enabled:true` + capture metadata, gated on `confirmed:true` — the
  operator is the irreducible enable gate; refuses an incomplete block; appends a `capture-enabled` audit line)
  + the 🔓 라이브 검증 → 활성화 UI section. dry-run/verify share `_stageCapture` (the reference `approve` stays
  byte-identical; suite green). Verified: gating refuses verify without `confirm:true` and enable without
  `confirmed:true`/with an incomplete block; the atomic enable writes correctly (checked end-to-end on a
  throwaway recipe — hiworks untouched). The real verify (a live approval) + the real enable are the operator's
  UI actions on a disposable doc — never triggered autonomously.

## 7. Open questions (operator decides)
- Per-form capture (recommended, tight `formType` scope) vs one global action (relies on `--reviewed` for mixed).
- Amount-label: Phase 1 text input; Phase 2 auto-propose visible currency labels from the live detail.
- Operator identity in the audit: default OS user + optional override field (no UI login on localhost).
- Keep vs prune the captured `flows/approve-*.json` + video artifacts (recommend archive + gitignore).

## 8. Ceilings (out of scope)
Single-origin / same top-frame approve sequences; deterministic steps (find/wait/press/scroll, no branching);
ARIA-table list. **OUT:** iframes, conditional/branching flows, SPA mid-flow restructure, closed shadow DOM,
file-upload/drag, **unattended capture** (a human must watch the 결재 browser), native `confirm()` dialogs
(revisit per system — Hiworks's 확인 is a DOM modal, fine).

**Net:** the operator makes any system/form approvable **in the browser** — record the real approve UI on a
disposable doc, watch the per-guard dry-run, verify once live on a throwaway, and flip it on — reusing the
proven recorder + leaf + guards, with **no model on the approve path** and **every safety guard intact**. The
irreducible cost stays: a human, watching, capturing each form on a disposable doc.
