# Phase 2 approve — Gate B staged capture (Hiworks 지출결의서)

Empirical capture of the REAL Hiworks approve UI, required by DESIGN §12 before any approve
implementation. **Phase 1 (read-only) is DONE.** **Phase 2 (the effectful 결재 click) was EXERCISED on
an operator-authorized disposable test doc (2026-06-07) and revealed a FAIL-CLOSED BLOCKER**: the approve
cannot be completed on agent-browser 0.27.0. The test doc was **left UNAPPROVED**. Approve implementation
therefore **remains forbidden** on this stack — see *Phase 2 findings* below.

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

### Still undetermined (blocked by the above)
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
