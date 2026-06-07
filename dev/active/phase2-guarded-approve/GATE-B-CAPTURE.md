# Phase 2 approve — Gate B staged capture (Hiworks 지출결의서)

Empirical capture of the REAL Hiworks approve UI, required by DESIGN §12 before any approve
implementation. **Phase 1 (read-only) is DONE.** **Phase 2 update (2026-06-07, HEADED verification): the
earlier "agent-browser 0.27.0 cannot complete the approve = native-dialog blocker" conclusion is
RETRACTED as a likely misdiagnosis** — see *Phase 2 HEADED verification* below. A headed operator run on
the disposable test doc showed the post-`확인` step is **NOT a separate native dialog**; the approve
completes directly from the DOM modal, which has a **승인/협의/반려 radio my agent-browser drive never
selected** (the likely real cause of non-completion). ⇒ **Playwright is probably UNNECESSARY** (pending a
radio-confirmation test on the existing stack). The test doc IS now approved (operator, headed).

## How this was captured
- **Phase 1 — read-only (no click):** opened a real *pending* 지출결의서(거래처) doc's detail page with
  cached auth and snapshotted it. Viewing changes no approval state; the structural facts are identical
  across docs of this form. **No 결재/반려/확인 was clicked.** (The doc itself is a real financial
  document — it must NEVER be approved by a test; Phase 2 requires a disposable doc.)
- `@refeN` ids below are transient capture artifacts for evidence only — they **never** go into a recipe.

## Confirmed §12 facts (Phase 1, read-only)

| § question | finding |
|---|---|
| Approve affordance + exact label | **`button "결재"`** — label is **결재, NOT 승인** (DESIGN assumed 승인). On the current approver's line inside the `table "결재선"`. **Exactly one** `role=button name="결재"` on the page (the other "결재" hits are a `rowheader` and a completed-line `cell` — different roles), so `find role button --name "결재" --exact` resolves uniquely. |
| 문서번호 unique on the detail page? | **YES** — the value (`IB-지출(거래처)-YYYYMMDD-NNNN`) appears in **exactly one** `cell`. The label is the `rowheader "문서 번호"` (note the **space**) in the metadata `table "전자결재 문서보기"`. |
| 문서번호 outside the body? | **YES** — it is in the metadata table, which is **above** the body content. idLabel guard = the "문서 번호" rowheader → adjacent value cell (exactly one). |
| doc_id in the detail URL? | **NO** — URL is `/approval/document/view/<internalId>/condition/<base64 "&list_mode=W">` (e.g. `/view/984261/...`). The 문서번호 is **not** in the URL. ⇒ `openBy` must be the unique **list-row 문서번호 cell click**; no `urlTemplate`, and `urlGlob` is doc-agnostic (confirms red-team IDOPEN-2). |
| Deterministic 금액 field? | **NO metadata amount.** The amount lives only in the **body** (the 거래내역 table: `cell "총 금액 (부가세포함)"`). ⇒ confirms PRESENCE-3 / FP-SUMMARY-2 / FP-BODYDIGEST empirically: for this flagship form the load-bearing figure is **body-only**, so the trusted display must render the **consented body region** (or fail closed for high value); a metadata-amount field cannot be relied on. |
| Body region bounds | Body = the **level-2 heading** (the subject + " 요약") → through the 거래내역 table, **ending before the `link "의견"` / 댓글 footer**. Layout order is: metadata table → **결재선 table → body**. ⇒ DESIGN's `untilMarker: "결재선"` is **WRONG** for this app (결재선 precedes the body). Use `fromHeadingLevel: 2` → `untilMarker: "의견"` (tentative — re-confirm the exact end marker). |
| 제목 (title) source for T3 | Ambiguous: the `heading level=1` is the **form type** ("지출결의서(거래처)"), not a per-doc subject; the per-doc subject is the **level-2 heading** (with a trailing " 요약"). The list `columns.title` is the clean subject. T3 title-equality must pin a stable detail-side title (likely the h2 minus " 요약") — **decide + re-confirm**. |
| Completion marker (positive, per-doc, self-line) | Completed approver lines render as **`cell "결재 YYYY-MM-DD"` + `image "결재"`** (observed for the already-approved approvers, e.g. "결재 2026-06-04", "결재 2026-06-05"). The current approver's line shows the **`button "결재"`** instead. ⇒ I6 success = the operator's own decision line transitions `button "결재"` → `cell "결재 <date>"`+image (absent-before / present-after). **Transition itself needs Phase 2 to confirm.** |
| Comment (의견) required? | A general **댓글 thread** at the bottom (`textbox "댓글을 남겨주세요." [ref=e43]` + `button "등록"`), separate from the 결재 action — appears **optional**. Whether clicking 결재 opens a **required-opinion modal** is **UNKNOWN (Phase 2)**. |

## Phase 2 findings (2026-06-07) — exercised on an operator-authorized disposable test doc
Test doc `IB-지출(거래처)-20260518-0001` (operator declared it test data, made to look real; approving
it has no real effect). Identity guard passed (문서번호 cell == doc, exactly one). Sequence + results:
- **`결재` button click → a DOM confirm modal opens** (URL **unchanged** `/view/964488/...`; `get title`
  responsive ⇒ **not a top-level native dialog at this step**). The modal contains:
  - a **`textbox "의견을 입력하세요."`** (opinion) — appears **required**,
  - buttons **`확인`** (confirm), **`취소`** (cancel), and **`확인 후 다음 문서`** (confirm-**and-auto-advance**
    to the next pending doc). ⇒ to AVOID auto-advance, use `확인`, never `확인 후 다음 문서` (T12/IDOPEN-5).
- **BLOCKER — the approval cannot be completed on agent-browser 0.27.0.** With the opinion filled and
  `확인` clicked (tried twice: a single op, then an **atomic** `[fill, 확인]` batch — both returned
  `success:true`), the **modal stayed open and nothing was approved** (`button "결재"` still present, the
  completed-line set unchanged at just the prior approver). The step **after** `확인` (most likely a native
  `confirm()` — DOM frozen, page still responsive to CDP reads) is **unhandleable on 0.27.0** (no native
  accept primitive; CLAUDE.md footgun). `취소` cleanly closed the modal; **the doc was left UNAPPROVED.**
- **Correct agent-browser find syntax** (the README hard-rules example has the wrong token order):
  the action comes **before** `--name`/`--exact` — `find role button click --name "결재" --exact`
  (verify-flow.sh `_exec` builds it this way). `find role button --name "결재" --exact click` →
  `Unknown subaction: --name`. (Worth fixing the README example.)

### Conclusion: confirm leg = **effectively `native`/unhandleable on this stack → FAIL-CLOSED**
Reproduced **3×** (single click; atomic `[fill,확인]` batch; a fresh clean run with an 8s settle) — the
approval never commits and the modal never closes. Corroborating evidence: `agent-browser --help` exposes
only **`--no-auto-dialog`** ("Disable automatic dismissal of **alert/beforeunload** dialogs") and a
`confirm <id>` for its OWN action-gate — there is **no page-dialog *accept* primitive**. So a native
`confirm()` at the approve step is, by default, **auto-dismissed (= Cancel)**, which is exactly the
observed "click 확인 → nothing approved, modal stays". (The definitive `--no-auto-dialog` probe was
deliberately NOT run: a non-dismissed native dialog wedges the session, and `timeout` cannot kill the
native exe here — reboot-level risk for no new decision value.)

Per DESIGN §3/§12, `confirm.kind = native` must **not** be built unless an agent-browser accept primitive
is empirically proven — it is **not** (0.27.0 can only *dismiss* native dialogs, never *accept* them). So
the Hiworks approve path is **not implementable on agent-browser 0.27.0**. The missing capability is a
**native-dialog accept** primitive; building approve requires a driver/version that provides it (or a
different automation surface). This is a TOOLING limit, independent of consent (the operator authorized
approving the disposable test doc). Until then: **fail-closed.** The test doc was left UNAPPROVED.

> ⚠ **SUPERSEDED 2026-06-07 by the HEADED verification below.** The "native confirm / not implementable on
> 0.27.0" conclusion in this section was a **misdiagnosis** (red-team `BLOCKER-ASSUMED-1`). A headed
> operator run showed **no native dialog** after `확인`; the real miss was an unselected `승인` radio. See
> *Phase 2 HEADED verification*.

## Phase 2 HEADED verification (2026-06-07) — SUPERSEDES the native-dialog conclusion above
A **headed operator run** on the disposable test doc (`IB-지출(거래처)-20260518-0001`, operator-confirmed
test data) positively identified the post-`확인` mechanism via screenshots — confirming the red-team's
`BLOCKER-ASSUMED-1`:
- **The 결재 modal has a `승인 / 협의 / 반려` RADIO group** (action choice; 승인 = approve), the prompt
  **"승인하시겠습니까?"** *inside the DOM modal*, an opinion textarea (default "승인 합니다"), and buttons
  `취소 / 확인 / 확인 후 다음 문서`. **There is NO separate native browser dialog after `확인`** — the
  operator (explicitly asked to watch for a native popup) reported none; clicking `확인` **completed the
  approval directly**.
- **Completion marker (corrected):** the approver's line shows a **승인 stamp (도장 image) + date + name**
  (verified: 대표이사 **김택균 / 2026-06-07 / 승인**, newly added). **AND** the doc **left the 대기 inbox**
  (verified read-only: `STILL_IN_대기 = false`). Both are positive I6 signals — supersedes the earlier
  guess "button 결재 → cell 결재 <date>".
- **Revised diagnosis of the agent-browser non-completion:** NOT a native dialog. The drive filled the
  opinion + clicked `확인` but **never selected the `승인` radio** (and may also face a controlled-input/
  synthetic-gesture issue). The unselected radio is the parsimonious cause.
- **Implication — Playwright is probably UNNECESSARY** (`DRIVER-PLAYWRIGHT.md` loses its native-dialog
  premise). agent-browser already does every DOM step; the only missing one is the radio. **Next: a FRESH
  disposable-doc test** — agent-browser: open → 결재 → **select 승인 radio** → fill 의견 → 확인 → verify the
  승인-stamp transition + inbox-departure. If it completes, the approve path is buildable on the EXISTING
  stack (no new dependency).
- **`recipe.approve` corrections:** add `decision: { by:"role", role:"radio", name:"승인", exact:true }`
  (select before `확인`); `confirm.kind` is **`dom`** (the modal IS the confirmation), NOT native;
  `success` = 승인-stamp on the approver's self-line (date == today, name == operator) OR departure from
  the 대기 inbox on a fresh fetch.

### Radio hypothesis — TESTED & REFUTED (2026-06-07); agent-browser still cannot complete the submit
Follow-up agent-browser run on a fresh disposable test doc (`IB-품의-20260508-0001`, operator-confirmed
test data): the modal's `승인` is a **native `<input type=radio>`** (name " 승인" w/ leading space) and
`find role radio --name 승인` returns **"Element not found"** (the CLAUDE.md native-input locator footgun).
Clicking it **via its transient `@ref`** (`success:true`) + filling 의견 + clicking `확인` (`success:true`)
**STILL did not complete** the approval (modal stayed open, 결재 button present, no today stamp). So **the
승인 radio is NOT the blocker.** Net (honest re-correction of the "Playwright probably unnecessary" note
above): **agent-browser 0.27.0 genuinely cannot complete the Hiworks final approve submit** — every step
returns `success` but the approval never commits, regardless of the radio.
- **Remaining candidate causes (narrowed):** (A) a native `confirm()` after `확인` that agent-browser
  auto-dismisses (= Cancel), or (B) Hiworks' submit requires a **trusted (`isTrusted`) user gesture** that
  agent-browser's synthetic click does not provide. The operator reported **no native popup**, weakly
  favoring (B).
- **Implication (revised back):** a driver that emits **trusted events** (Playwright dispatches
  `isTrusted=true` via CDP **and** can accept native dialogs) — or the **headed-manual path (E)** where the
  operator does the final click — is required. `DRIVER-PLAYWRIGHT.md` is **un-shelved**, its rationale
  broadened from "native-dialog accept" to **"trusted-gesture + dialog handling."** Either Playwright or
  (E) still needs a positive completion test. **`recipe.approve.decision{radio 승인}` requires an `@ref`/
  CSS or label-text locator** (native radios aren't reachable by `find role --name`).

### DEFINITIVE conclusion (2026-06-07 headed `--no-auto-dialog` experiment) — it is (B), a trusted-gesture requirement
Ran the decisive experiment on `IB-품의-20260508-0001` (operator test data): a **headed** daemon with
`AGENT_BROWSER_NO_AUTO_DIALOG=1`, drove 결재 → 승인 radio(@ref) → 의견(filled, visible in the operator's
screenshot) → and **agent-browser clicked `확인`** (`success:true`, **did not hang, no native dialog
appeared**) → **approval did NOT commit** (modal open, 결재 button present). Then the **operator clicked
the SAME `확인` by hand → it approved** (verified read-only: the doc **left the 대기 inbox**). Same modal,
same filled opinion, same radio — only the *clicker* differed.
- ⇒ **It is (B): Hiworks' final submit requires a trusted (`isTrusted`) real user click.** agent-browser's
  synthetic click is silently ignored. **(A) native dialog is fully REFUTED** (NO_AUTO_DIALOG produced no
  hang and no popup; operator saw none). The `confirm.kind` is **`dom`** (the modal IS the confirmation).
- ⇒ **agent-browser 0.27.0 cannot perform the terminal approve click. Playwright is NOT required and its
  native-dialog handler is moot** — what's needed is a *trusted* click, which any of {Playwright/Puppeteer/
  raw CDP `Input.dispatchMouseEvent`} **or a real human click** provides.
- ⇒ **Recommended path — (E)-hybrid, and it is SAFER not just simpler:** since DESIGN v4 already mandates a
  per-item human OOB ceremony, let the **human's own `확인` click BE the per-item approval** (the purest
  form of "the human approves the content they saw"). The deterministic tool drives everything up to it
  (open by unique cell → idLabel/title/fingerprint re-verify → 결재 → select 승인 → fill the operator's
  의견), the **operator clicks `확인`** (trusted = the approval), then the tool verifies completion
  (승인-stamp on the self-line, today, operator name + 대기-departure) and writes the audit. **No new
  dependency, no native-dialog handling, no dual-stack.** A fully-automated trusted-click (Playwright)
  would actually be *in tension* with "the human performs the approval", so it is not recommended.

### Still undetermined — now RESOLVED by the above
The completion marker (승인-stamp self-line + 대기-departure), the confirm kind (dom), and the mechanism
(trusted gesture, no dialog) are all captured. Remaining for a real build: a `recipe.approve` update +
the (E)-hybrid wiring in `webui/routes-approve.js` + a re-red-team of that (simpler) flow.

### (Historical) earlier still-undetermined list — superseded
- the exact **completion-marker transition** (`button "결재"` → `cell "결재 <date>"`+image) and **affordance
  disappearance** — could not be observed because approval never completed;
- **server-fresh / inbox-departure** cross-check;
- **PRESENCE-3 trusted-display feasibility** (native helper rendering the consented body region).

## Draft `recipe.approve` (Phase 1 facts; UNKNOWNs marked — do NOT build until Phase 2 fills them)
```json
"approve": {
  "openBy":  { "by": "cell", "field": "doc_id", "exact": true },   // doc_id NOT in URL → unique list-row cell click; no urlTemplate
  "ready":   { "text": "결재선" },                                  // detail settle marker (present on the detail page)
  "idLabel": "문서 번호",                                           // metadata rowheader (note the SPACE); value cell is unique
  "amount":  null,                                                  // NO deterministic metadata amount — body-only → PRESENCE-3 body-render / high-value fail-closed
  "body":    { "fromHeadingLevel": 2, "untilMarker": "의견" },      // body = h2 → 의견 footer; 결재선 is ABOVE the body (NOT a trailing marker). re-confirm end marker
  "button":  { "by": "role", "role": "button", "name": "결재", "exact": true },  // count==1 verified; label 결재 NOT 승인
  "confirm": { "kind": "dom-then-native", "modalOpinion": "의견을 입력하세요. (required)", "accept": "확인", "avoid": "확인 후 다음 문서", "BLOCKER": "post-확인 step NOT completable on agent-browser 0.27.0 → fail-closed" },
  "success": { "completeMarker": "결재 <date>", "scope": "self-line", "fresh": "UNDETERMINED (blocked)" }  // self-line button→cell+image transition; could not observe (approval never completed)
}
```

## Phase 2 timeline + final status (2026-06-07) — FAIL-CLOSED at the STACK level
1. Candidate docs that **couldn't** drive Phase 2: `IB-지출-20260607-0001`, `IB-품의(기안)-20260528-0001`
   — **not in the 대기 box** (operator is the *drafter*; they sit in 기안/진행, no 결재 affordance).
2. `IB-지출(거래처)-20260518-0001` — **is** in 대기. Initially **refused** (it looks like a real
   vendor-expense financial doc; the gate forbids approving a real financial doc in a test). The operator
   then **explicitly clarified it is test data made to look real**, with no real effect, and authorized
   it — a valid per-item owner consent for a disposable doc (DESIGN §9), so Phase 2 was exercised on it.
3. **Outcome:** the flow ran up to the DOM confirm modal but **could not be completed on agent-browser
   0.27.0** (the post-`확인` step is unhandleable — see *Phase 2 findings*). The doc was **left
   UNAPPROVED** (`취소`). **So Phase 2 fails closed not for lack of a doc, but because the approve click
   is not completable on this stack.**

Net: Gate B Phase 1 (read-only) is fully captured; Phase 2 reached the confirm modal and then hit a
**0.27.0 stack blocker**. **Approve implementation remains forbidden** — and now we know it is **not
buildable on agent-browser 0.27.0** regardless of the design (a native-dialog-capable driver/version, or
a different automation surface, would be a prerequisite). The completion-transition / inbox-departure /
PRESENCE-3 facts stay undetermined behind that blocker.

## Phase 2 prerequisite (what the operator must provide, if/when resumed)
A **disposable** document that is **pending the operator's own approval** — i.e. it must appear in the
**대기(승인 대기 / `lists/W`) box** with a live `button "결재"` on the operator's line. A document the
operator merely **drafted** sits in the 기안/진행 box and shows **no** approve affordance, so it cannot
drive Gate B (the staged doc `IB-지출-20260607-0001` is in that state — not found in the 대기 box).
Route a trivial disposable doc so the operator is an approver on its line; then Phase 2 can click 결재 on
that one doc to capture the confirm leg, the completion transition, affordance disappearance, and URL
behavior. **Never approve a real financial document in a test.**
