# Phase 2 approve — Gate B staged capture (Hiworks 지출결의서)

Empirical capture of the REAL Hiworks approve UI, required by DESIGN §12 before any approve
implementation. **Phase 1 (read-only) is DONE.** **Phase 2 (the effectful 결재 click) is LEFT
FAIL-CLOSED / NOT COMPLETED** (2026-06-07, operator decision) — see *Phase 2 status* below. Approve
implementation therefore **remains forbidden** (Gate B incomplete).

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

## STILL UNKNOWN — require Phase 2 (the effectful 결재 click on a DISPOSABLE doc)
- **confirm leg** `none | dom | native`: does 결재 pop a DOM modal, a native dialog, or commit directly?
  If native, is an agent-browser 0.27.0 accept primitive provable? (else fail-closed per DESIGN.)
- **required comment / opinion** at approve time?
- **affordance disappearance** (does `button "결재"` vanish after approval?) + the exact completion-marker transition.
- **auto-advance / URL mutation** across the click (capture `get url` before/after; abort on uninitiated delta).
- **server-fresh / inbox-departure** cross-check (does the doc leave the 대기 box on a fresh fetch?).
- **PRESENCE-3 trusted-display feasibility**: can a Windows native helper render the consented **body
  region** (where the amount lives) + doc binding outside same-origin page JS with OS credential/Hello?

## Draft `recipe.approve` (Phase 1 facts; UNKNOWNs marked — do NOT build until Phase 2 fills them)
```json
"approve": {
  "openBy":  { "by": "cell", "field": "doc_id", "exact": true },   // doc_id NOT in URL → unique list-row cell click; no urlTemplate
  "ready":   { "text": "결재선" },                                  // detail settle marker (present on the detail page)
  "idLabel": "문서 번호",                                           // metadata rowheader (note the SPACE); value cell is unique
  "amount":  null,                                                  // NO deterministic metadata amount — body-only → PRESENCE-3 body-render / high-value fail-closed
  "body":    { "fromHeadingLevel": 2, "untilMarker": "의견" },      // body = h2 → 의견 footer; 결재선 is ABOVE the body (NOT a trailing marker). re-confirm end marker
  "button":  { "by": "role", "role": "button", "name": "결재", "exact": true },  // count==1 verified; label 결재 NOT 승인
  "confirm": { "kind": "UNKNOWN" },                                 // Phase 2: none|dom|native (+ native accept primitive proof)
  "success": { "completeMarker": "결재 <date>", "scope": "self-line", "fresh": "UNKNOWN" }  // self-line button→cell+image transition; Phase 2
}
```

## Phase 2 status — LEFT FAIL-CLOSED (2026-06-07)
Phase 2 was attempted but **correctly stopped**. The 대기(`lists/W`) box was full-scanned (12/12 pages,
177 docs); the candidate docs offered could not drive Phase 2:
- `IB-지출-20260607-0001` and `IB-품의(기안)-20260528-0001` — **not in the 대기 box** (operator is the
  *drafter*; they sit in 기안/진행 and show no 결재 affordance).
- `IB-지출(거래처)-20260518-0001` — **is** in 대기, but it is a **real vendor-expense (지출) financial
  document** awaiting the operator's genuine approval. Approving it would commit a real, irreversible
  financial approval → **refused** per the inviolable safety gate ("never a real financial approval in a
  test"). A general "proceed with all" autonomy grant does **not** override that gate.

No disposable, **non-effectful** document (one whose approval has no real consequence) was available in
the operator's 대기 box, so Phase 2 ends fail-closed. The click-only §12 facts (confirm leg none|dom|
native + native accept primitive; required-comment; completion transition; affordance disappearance;
URL/auto-advance; server-fresh/inbox-departure) remain **UNDETERMINED**. **Approve implementation stays
forbidden** until a genuinely disposable doc allows Phase 2 to complete. The read-only Phase-1 facts
above stand and need no re-capture.

## Phase 2 prerequisite (what the operator must provide, if/when resumed)
A **disposable** document that is **pending the operator's own approval** — i.e. it must appear in the
**대기(승인 대기 / `lists/W`) box** with a live `button "결재"` on the operator's line. A document the
operator merely **drafted** sits in the 기안/진행 box and shows **no** approve affordance, so it cannot
drive Gate B (the staged doc `IB-지출-20260607-0001` is in that state — not found in the 대기 box).
Route a trivial disposable doc so the operator is an approver on its line; then Phase 2 can click 결재 on
that one doc to capture the confirm leg, the completion transition, affordance disappearance, and URL
behavior. **Never approve a real financial document in a test.**
