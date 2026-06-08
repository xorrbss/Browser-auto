# General effectful-action RPA — generalize "approve" to ANY business action (DESIGN ONLY)

> **STATUS: DESIGN ONLY (no code).** This generalizes the *effectful* path so the tool can perform ANY
> deterministic business action (submit a form, reject/return, change a status, place an order, reply to a
> ticket, file a report), not just 결재 승인. It preserves EVERY non-negotiable invariant and **changes
> nothing live**; each action stays fail-closed until its own per-system capture + sign-off (like 결재's
> Gate B). Synthesized from a 4-lens design workflow (action model · safety generalization · executor &
> integration · scope/ceilings), grounded in `approve/approve-run.mjs`, `approve/guards.mjs`,
> `recipes/SCHEMA.md`, `flows/SCHEMA.md`, the recorder (`bin/capture.js`/`build-flow.js`/`probe-record.sh`),
> and `dev/active/phase2-guarded-approve/{DESIGN.md,UNATTENDED-CRITERIA.md}`.

## 0. The gap (honest)
- **READ side = already generic** (register ANY web system → recipe → sync → records → query → summarize).
- **EFFECTFUL side = approval-specific**: `recipe.approve` models exactly one action (open unique doc cell →
  `결재` → `승인` radio → `확인` → success = today 승인-stamp + leaves 대기). The guards are approval semantics.
- **A generic action engine already EXISTS but is wired to TESTING**: the recorder (`capture.js` → a
  declarative `flows/<name>.flow.json` of semantic steps → a deterministic, LLM-free replay). It records
  ARBITRARY journeys — the bones of a general action executor — but replays via agent-browser *synthetic*
  clicks (Hiworks proved the irreversible submit needs a *trusted* click → the approve leaf uses Playwright).

**Goal:** make the effectful path **action-general** by reusing the recorder as the action SOURCE and
generalizing the approval safety model into a reversibility-scaled, per-action safety model.

## 1. Core idea — approve becomes ONE instance of a general action
`recipe.approve` → **`recipe.actions.<name>`** (a map; `approve` is the first, reference action — backward
compatible). An action is a **pre-recorded/declared DETERMINISTIC sequence** (the `flow.json` step model)
wrapped in a general safety envelope. **The model NEVER authors or improvises steps** — at most it SELECTS a
pre-built action + parameterizes the target set (the existing `review`-intent pattern). At replay: NO LLM.

## 2. `recipe.actions.<name>` schema (generalizes `recipe.approve`)
```jsonc
"actions": {
  "approve": { /* the reference action; today's recipe.approve maps here 1:1 */ },
  "reject":  {
    "id": "reject", "description": "반려",
    "class": "irreversible",                     // irreversible | reversible-partial | reversible-full → scales rigor (§3)
    "enabled": false,                            // disabled → captured → tested-dry → tested-live → enabled
    "dryRunDefault": true,                        // dry-run is ALWAYS the default; --live is explicit
    "identity": {                                // generalize "open by unique 문서번호 cell" (red-team T1)
      "kind": "unique-cell",                     // unique-cell | url-param | list-row | form-field
      "locator": { "by": "role", "role": "cell", "value": "문서번호", "exact": true },
      "urlGlob": "**/document/view/**",          // assert after open or ABORT (DOCID-3)
      "idField": "doc_id"                         // the synced-DB field carrying the target identity
    },
    "content": {                                 // generalize TITLE binding + amount ceiling (red-team F1/T4)
      "bindings": [
        { "field": "title", "source": "db", "label": "제목", "expected": "{{target.title}}", "metadata": true },
        { "field": "amount", "source": "db", "label": "총 금액", "ceiling": 1000000, "parser": "krw", "metadata": true }
      ],
      "formType": { "allow": ["지출결의서(거래처)"], "deny": ["수의계약"] }
    },
    "steps": { "from": "flows/hiworks-reject.flow.json" },   // OR an inline declarative step list (flow.json model)
    "irreversible": { "atStep": "click:확인", "confirmKind": "dom", "trustedClick": true }, // the point-of-no-return
    "completion": {                              // generalize 승인-stamp + 대기-departure (POSITIVE, never absence-only)
      "kind": "marker-and-departure",            // marker | status-change | departure | marker-and-departure
      "marker": { "selfLine": true, "datedToday": true, "text": "반려" },
      "departure": { "fromList": true }
    },
    "policy": { /* per-action UNATTENDED-CRITERIA allowlist (§5) — optional; absent ⇒ reviewed/typed only */ },
    "capture": { "checklist": {/* empirical Gate-B facts */}, "date": null, "capturedBy": null, "notes": "" }
  }
}
```
- **`steps`** reuses the recorder: a captured `flows/<name>.flow.json` (semantic locators, no `@ref`) OR an
  inline equivalent. Steps are *executed*, never branched-on by a model.
- **`identity`/`content`/`completion`** are the generalized guards — the action-specific parts the operator
  pins at capture. **`class` (reversibility)** scales how much ceremony applies (§3).

## 3. Generalized safety model — 7 invariants + reversibility-scaled rigor
**Non-negotiable (all actions):**
1. **No LLM on the effectful/replay path** — steps are pre-recorded/declared; the model only selects+parameterizes.
2. **Fail-closed on any doubt** — any guard that can't be *positively* evaluated ⇒ skip the target, never act.
3. **Irreversible step uses a TRUSTED click** (Playwright `isTrusted`); reversible/read steps may use agent-browser.
4. **Per-system/per-action capture BEFORE live** (Gate-B equivalent, §6) — uncaptured ⇒ not offered, not even dry-run.
5. **Append-only fsync'd audit + crash reconciliation** (generalize `approve-audit.jsonl` → `action-audit.jsonl`, tagged `actionId`).
6. **Irreversible-commit cap + kill-switch + single-user host** (`clicksIssued`→`commitsIssued`; `data/act-STOP`).
7. **Positive completion verification** — a per-action success marker (never absence-only); ambiguous ⇒ failed/uncertain.

**Reversibility-scaled rigor (the one genuinely new dial):**
- **irreversible** (submit/pay/approve/reject): the FULL ceremony (identity + content + irreversible-step
  trusted click + positive completion + cap + audit + reconciliation). The default.
- **reversible-partial** (status change, assign): identity + completion + audit; looser caps; content binding
  if the change is value-bearing.
- **reversible-full** (save draft, reschedule, add a comment): identity + completion + audit only; minimal caps.
The recipe DECLARES `class`; an action with no clear completion marker is **HIGH-RISK → forced irreversible →
fail-closed** until a marker is captured.

## 4. Executor — promote the recorder to a trusted business-action runner
- **`approve/act-run.mjs`** generalizes `approve/approve-run.mjs`: refactor the per-doc guards into a shared
  `approve/guards.mjs` library (identity, content/parseKRW, pager, formType, completion, audit, cap,
  reconcile) — **refactor, not weaken** — and drive a `recipe.actions.<name>` instead of the hardcoded
  approve sequence. The reference `approve` action must produce byte-identical behavior (regression-pinned).
- **Trusted-click boundary**: the leaf uses Playwright (trusted) for the `irreversible.atStep` (and any step
  the capture marks `trustedClick`); other steps can use the cheaper agent-browser replay. The action's
  `steps` (from `flow.json`) are executed by a small **effectful flow runner** (the existing compile target,
  but driven by Playwright at the irreversible step).
- **Audit/route**: `/api/approve/run` generalizes to `/api/act/run {app, action, targets, dryRun, reviewed}`
  (approve stays as `action:"approve"`). Same session+Origin gate, same fail-closed validation, registry-driven.

## 5. Human modes + NL (generalized from approve, unchanged trust boundary)
- **Reviewed** (recommended): the operator reviews each target's summary on a checkbox screen and checks the
  ones to act on → the action runs on the checked set. The human is the content control. (Today's reviewed batch.)
- **Unattended**: the **UNATTENDED-CRITERIA** policy framework, **per action** (`actions.<name>.policy`), gates
  eligibility deterministically (shadow → sampled → bounded). Same fail-closed staging + sign-off.
- **NL**: extend the `review` intent → "**act**" intents that SELECT a pre-built action + parameterize the
  target set (e.g. "이 시스템에서 정기 지출 반려 준비해줘" → pick `action:reject`, surface the checkbox review).
  The model never authors steps; eligibility/execution stays deterministic.

## 6. Per-system/per-action capture (Gate-B equivalent — the operator gate)
For EACH action on EACH system, before live: **record the action on a disposable staged target** and pin the
empirical `capture.checklist`: is the target uniquely locatable? which step is irreversible (the point of no
return)? is the confirm `none|dom|native` (native ⇒ needs the trusted-click driver)? what is the EXACT
positive completion marker, and is it per-target/self-line? does the action auto-advance/mutate the URL? what
value field bounds the action (the Gate-B amount-cell equivalent)? Until captured + a clean dry-run + a clean
live-on-disposable + sign-off → the action is **fail-closed** (disabled). This is the per-action analogue of
`GATE-B-CAPTURE.md`.

## 7. Failure modes the design answers
- **No clear completion marker** → HIGH-RISK; forced irreversible + fail-closed; the action is not enabled
  until a positive marker is captured. (You cannot safely automate what you cannot verify completed.)
- **Multi-commit action** (several irreversible steps in one flow) → each commit is audited + capped
  individually; reconciliation must resolve a partial sequence; prefer decomposing into single-commit actions.
- **Wrong-target binding** → the unique-locator open (count===1, abort 0/≥2) + `urlGlob` + idLabel re-verify,
  exactly as approve. Never substring/first-match.
- **Off-screen/async effect** (the effect lands in another view/system) → the completion check must observe a
  POSITIVE on-page signal; an effect verifiable only off-screen ⇒ fail-closed (defer to Phase 3 cross-system).
- **Recorded-step drift** (the site changed → stale locator) → a step that doesn't resolve ⇒ ABORT (fail-loud),
  never guess; periodic `verify` re-drive (the existing flow-verify) detects drift; capture-version pinning.
- **Trusted-click requirement varies** → declared per action (`irreversible.trustedClick`); default true for
  irreversible.

## 8. Scope, ceilings, and a phased path (honest)
- **Phase 1 — same shape, more verbs (cheap, ~90% leaf reuse):** generalize approve → **reject/return +
  status-change** on the SAME "list of items, one action per item" shape. Reuses identity/content/completion/
  audit/cap wholesale; only the button/decision/marker differ (all already recipe fields). High value, low risk.
- **Phase 2 — arbitrary single-action recorded flows:** the recorder is the action source; any single-commit
  action with a captured completion marker, run via `act-run.mjs` with the general safety model + per-action capture.
- **Phase 3 (DEFERRED) — multi-step wizards / conditional / cross-system ("read A → write B"):** needs flow
  branching + cross-system orchestration + broader capture; out of scope now.
- **Capture ceilings (unchanged):** ARIA-table family only (no pure CSS div-grids), single top-frame/same-origin
  capture, native dialogs are driver-dependent, drag/file-upload excluded, SPA cross-origin recording unsolved.
- **REJECTED forever:** an open-ended **live LLM agent that improvises actions** (decides steps/clicks at
  runtime) — both the safety model (LLM off the effectful path) and feasibility reject it; the action is always
  a pre-recorded/declared deterministic sequence. Also rejected: any irreversible action with no verifiable
  positive completion, and any action whose effect cannot be deterministically confirmed.

## 9. Open questions (operator/owner decides)
- Content fingerprint depth for medium-risk actions (structural binding vs a cryptographic body digest).
- "Scale" for non-money actions (approve has 금액; what bounds a status-change or a ticket-reply?) — per-action
  policy must define the action's risk metric.
- Per-action unattended policy: when is a NON-approval action safe to auto-execute? (per-action sign-off).
- flow.json **parameterization at execution** (capture records a concrete journey; how to substitute the
  per-target values safely + deterministically — extend the existing `{{input_N}}` value-sidecar model).
- Action-drift detection + remediation cadence (scheduled `verify` re-drive + alert).

## 10. Roadmap (only after per-action capture + sign-off — not now)
- **Step A (refactor, no behavior change):** extract `approve-run.mjs` guards into `guards.mjs`; introduce
  `recipe.actions.approve` as the canonical form (approve maps 1:1; regression-pinned, suite green).
- **Step B (Phase 1):** add `reject`/`status-change` actions on the 결재 shape + the generalized
  `/api/act/run` route + the action picker in the reviewed surface; per-action capture + dry-run + adversarial review.
- **Step C (Phase 2):** the effectful flow runner (Playwright at the irreversible step) driving a captured
  `flow.json`; per-action capture for one non-approval action end-to-end (operator-accompanied).
- Each effectful step stays **DESIGN-fail-closed** until its per-action capture + live-on-disposable + sign-off.

**Net:** approve generalizes cleanly into a reversibility-scaled, capture-gated, deterministic action model
that REUSES the existing recorder as the action source and the proven approve guards as the safety library —
turning "그룹웨어 결재 RPA" into "**any-web-system, any-recorded-action** RPA", **without** an open LLM agent and
**without** weakening a single guard. The honest cost: each new action on each system is an operator-accompanied
capture (the irreducible safety price of an irreversible business action).
