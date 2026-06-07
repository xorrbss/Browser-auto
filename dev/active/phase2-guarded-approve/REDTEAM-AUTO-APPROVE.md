# P4 — red-team of the BUILT auto-approve code (verdict: REVISE-FIRST → fixed)

Adversarial red-team (5 lenses + adjudicator) of the actual auto-approve implementation after the owner
released the per-item-human gate (`approve-gate-override`). 23 findings, **all confirmed-real, 0 refuted**.

## Verdict: REVISE-FIRST — 1 CRITICAL + 8 HIGH (+ 10 medium, 4 low)
The owner's removal of the human gate is accepted; "no human review" is NOT itself a finding. But the
deterministic guardrails that were supposed to be the SOLE safety net were insufficient / partly
false-advertised. Decision rule: NOT safe-to-rely-on-live until 0 critical/0 high.

## CRITICAL (fixed)
- **F1 — approval by bare doc_id; no content/amount/title/value-ceiling.** A 1만원 and a 1억원 doc were
  approved identically; the body amount (the load-bearing 금액 for Hiworks, per Gate B) was never
  inspected; the line-7 `titleCheck` was a phantom (comment only). The deterministic replacement DESIGN
  I1/T3/T4 mandated for the removed human content-consent did not exist.
  **FIX:** the leaf now requires a per-doc **expected title (from the synced approvals DB)** and asserts
  it appears on the live detail (content binding); empty/missing title ⇒ skip. Optional **`--max-amount`
  ceiling**: extract the largest `…원` figure from the detail body, **fail-closed** (skip) if none found
  or > ceiling. Route refuses any doc not in the DB (can't content-verify).

## HIGH (all fixed) — deduped to 3 root causes
- **Page-1-only false-success** (DOCID-1, VERIFY-PAGE1-ASYMMETRY, F1-PAGE1, F2-PAGINATED): the leaf
  paginated to OPEN but verified completion on **page 1 only**, so any doc on page 2+ was reported
  `approved` + audited `confirmed` regardless of whether 확인 committed. **FIX:** completion now `countDoc`
  scans **ALL pages**; the doc must be absent everywhere.
- **Absence-as-success / no proof the list loaded** (VERIFY-ABSENCE-AS-SUCCESS): a session-redirect /
  late-XHR / filtered view made the doc "absent" ⇒ false `approved`. **FIX:** `listLoaded()` asserts the
  대기 list actually rendered (collection name / a table) before trusting absence; not-loaded ⇒ failed
  (uncertain), never approved.
- **Wrong-doc identity** (DOCID-2, F6, R2/F3-NO-CONTENT-AMOUNT-GUARD): open was substring/first-match
  `getByText(docId).first()` (forbidden by DESIGN T1) and the only gate was "any cell == doc_id".
  **FIX:** open by the **unique exact 문서번호 cell, counted across all pages (===1, abort 0/≥2)**, then
  assert the detail URL matches `recipe.detail.urlGlob`, then exactly-one idLabel cell, then the title
  binding above.

## MEDIUM/LOW — fixed in the same rewrite
- **F4 leaf-live-default** → leaf now defaults **dry-run**; live requires explicit `--live`.
- **F5 decision-radio fail-open** → the 승인 radio is **asserted checked** (`isChecked`) before 확인; abort if not.
- **F2/F5 no default cap** → **live requires a positive `--max`** (route 400s without it).
- **DOCID-3 urlGlob** → asserted after open (guard can't run against the list page).
- **F3 phantom titleCheck** → title-equality is now actually implemented.
- **DOCID-4 / VERIFY-SUBSTRING-COLLISION** → presence oracle is the exact cell count, not substring `getByText`.

## CARRY-FORWARD (not yet fixed)
- **R1 (medium) — CSRF absent-Origin fallthrough** (`server.js` `if(origin)` with no else). Adjudicated
  medium: browsers always attach Origin, so a remote page is blocked; the only absent-Origin caller is a
  local non-browser client = the accepted I7 residual. **TODO:** add a present-Origin 403 gate on
  `/api/approve/*` (DESIGN T8).
- **R4 (low)** — Origin compare ignores `WEBUI_ALLOWED_HOSTS` (fronted/0.0.0.0 deploys); out of the
  loopback single-user release scope.
- **F6-KILLSWITCH-PRE-DOC (low)** — kill-switch is checked between docs, not mid-doc; a single 확인 is
  atomic/irreversible. Accepted residual; bound by the `--max` cap.

## Validation after the fix
Hardened leaf dry-run via the webui (synced doc `IB-품의-20260508-0002`): audit
`requested → identity_ok (title✓) → dry_ok` with NO navigation race, and `live without --max → 400`.
Confirms the content binding + all-pages scan + fail-closed defaults work. A re-red-team of this revision
is the next gate before relying on it for live batches.

_Workflow: 5 lenses + adjudicator (6 agents); against the real code. REVISE-FIRST on 1 critical + 8 high;
all critical/high fixed in this revision, 1 medium + 2 low carried forward._

---

## v2 — re-red-team of the FIXED revision (verdict: REVISE-FIRST → fixed again)
A second pass on the post-fix code: **0 CRITICAL, 11 HIGH (→ 2 root causes), 4 medium, 8 low** (23, all
confirmed). Prior status: the 3 wrong-doc highs + the F1 *identity/title* prong are CLOSED; the page-1
false-success highs were structurally closed BUT the fix **relocated** the race; and F1's *amount* prong
was still open. The 11 highs collapse to:
- **Amount ceiling evadable / amount unbound** (AMT-CEILING-EVADE, AMOUNT-CEILING-EVASION-NO-WON, F-AMOUNT-
  UNBOUND, TITLE-PRESENCE-NOT-CONTENT, AMT-1): the old `max-of /…원/` under-read a real total printed
  without 원 (a smaller line-item 원 became the max ⇒ over-ceiling approve); the ceiling was optional.
  **FIX:** amount is now **label-anchored** (`recipe.approve.amount.label`="총 금액"): read the label's row
  and parse KRW (`parseKRW` handles `원`/`₩`/`억`/`만`, takes the region max). **FAIL-CLOSED**: no amount
  locator, or no parseable figure at the label ⇒ SKIP. The route now **requires a value ceiling
  (`maxAmount`) for live, OR an explicit `allowNoValueCeiling:true`** owner opt-out (no silent
  unbounded-value approve); the UI demands a second confirm for the no-ceiling path. (Verified: parseKRW
  reads "총 금액 100,000,000"→1e8, "₩50,000,000 수수료 500원"→5e7, "5억원"→5e8, no-amount→-1.)
- **Completion slow-page race** (VERIFY-SLOWPAGE-FALSE-APPROVED, COMPLETION-UNDERCOUNT-FIXED-TIMEOUT,
  F-COMPLETE-RACE, SETTLE-1): the fixed `waitForTimeout(1500)` per page let a slow page 2+ read 0 ⇒
  undercount ⇒ false `approved`+`confirmed`. **FIX:** every fixed post-`selectOption` sleep is replaced by
  a **positive page-change settle** (`waitSettled`: poll until the row-set signature changes) + a per-page
  `listLoaded` re-assert + a `waitRows` row-render poll; **a page that never settles ⇒ `countDoc` returns
  `total:-1` (UNCERTAIN) ⇒ completion fail-closed (never "left inbox"/approved)**.
- **MEDIUM listLoaded weak** (LISTLOADED-*): bare "any table" trusted a redirect/error page. **FIX:**
  `listLoaded` now **requires the `collection.name`** marker when the recipe declares it (table fallback
  only when none configured).

**Validated** (dry-run via webui on a synced doc, after the fix): settle-based scan + row-render poll +
title binding → `requested→identity_ok(title✓)→dry_ok`, no race; `live without maxAmount & no opt-out → 400`.

**Carry-forward / residual after v2:**
- **Amount label-anchor is best-effort** — Gate B did not pin the exact 총 금액 cell value-adjacency, so the
  label-region parse is heuristic (fail-closed on miss). A **Gate B amount-cell capture** would make the
  ceiling fully reliable; until then, `allowNoValueCeiling` is the owner's explicit unbounded-value choice.
- **R1 present-Origin gate** on `/api/approve/*` (medium) — still carry-forward (DESIGN T8).
- Lows: title substring (defense-in-depth; identity is pinned by the unique cell), title TOCTOU (sync-time
  snapshot), targets-file orphan on a pre-read crash, decision-radio unanchored regex, mid-doc kill-switch.
- A **third re-red-team** of this revision remains advisable before unattended live batches.

---

## v3 — 3rd re-red-team (ultracode: 8 lenses + adversarial refute-verify + adjudicate) → REVISE-FIRST → fixed
58 findings; refuter-checked each high/critical. **0 critical, 4 HIGH (→ 2 root causes), 12 medium, 40 low,
1 refuted.** (2 of 8 lenses rate-limited — identity/title + crash-reconcile — partially covered by others.)
**VERIFIED-CLOSED from v1/v2:** wrong-doc identity, double-approve (serial queue + post-commit absence),
`listLoaded` requires collection.name, the amount fail-closed *mechanism* + live value-ceiling gate, and
`확인` exact (blocks `확인 후 다음 문서`). 1 REFUTED: completion polarity (the 승인 radio IS asserted checked,
so the leaf can't submit 반려/협의 — downgraded high→low).

**The 4 HIGH (2 root causes) — fixed in `approve/approve-run.mjs`:**
- **A. Completion settle race RELOCATED, not eliminated** (APV-1, SETTLE-HALFLOAD-UNDERCOUNT): `countDoc`
  pages 2+ read `cellCount` after `waitSettled` (the FIRST row-set change — a loading/spinner intermediate)
  with NO data-render poll, unlike page 1 / `openDoc`; a half-rendered page undercounts ⇒ `total===0` ⇒
  false `approved`+`confirmed` (money-SAFE direction — under-reports, can't over-approve — but it's the sole
  post-commit oracle and v2 over-claimed the fix). **FIX:** new `settlePage()` — after the change, require
  data rows (`waitRows`) AND a **signature stable across two reads**; non-stable ⇒ `total:-1` (uncertain ⇒
  fail-closed). Applied to `countDoc` pages 2+ and `openDoc`.
- **B. `--max` counted CONFIRMED approvals, not irreversible clicks** (CAP-COUNTS-CONFIRMED-NOT-CLICKS,
  MAXCAP-…): `approvedCount++` ran only AFTER the post-approve verify, so a doc whose `확인` committed but
  whose verify returned `total:-1` was reported `failed`, consumed no budget, and the loop kept clicking ⇒
  real irreversible commits could exceed `--max` (the primary blast-radius control failed OPEN). **FIX:** a
  separate `clicksIssued` counter is incremented **at the irreversible click** (before it) and the cap gate
  binds `clicksIssued` — a committed-but-uncertain doc now consumes budget. (`approvedCount` stays for the report.)

**Validated:** dry-run via webui on a synced doc after the fix → `requested→identity_ok(title✓)→dry_ok`,
settlePage open path no regression. (Cap-on-clicks is live-only; verified by code review — counter moved to
the click site.)

**Carry-forward MEDIUM (not blocking the high scope; worth doing):**
- **Crash/SIGKILL between the 확인 commit and the `confirmed` audit ⇒ committed-but-recorded-`clicked`, no
  reconciliation** (F-CRASH-CONFIRM-RECONCILE et al.) — a startup pass should re-resolve `clicked`-without-
  terminal by re-opening the doc and checking the 승인-stamp.
- **Kill-switch unwired to the UI** (F-KILLSWITCH-UNWIRED) — only a hard SIGKILL stops a running batch; wire
  `data/approve-STOP` to a webui "중지" button.
- **`pageSelect` assumes option-count == page-count / picks the first numeric `<select>`** (PAGESELECT-*) —
  a windowed pager would under-scan ⇒ completion undercount; pin the page-control per recipe.
- **Completion is absence-from-대기, not the positive 승인-stamp self-line marker** (COMPLETION-ABSENCE-NOT-
  APPROVAL) — Gate B identified the positive stamp; implementing it is the most robust completion oracle.
- **Single recipe applied across form types** under `allowNoValueCeiling` (C-RECIPE-MISPIN-NO-FORMTYPE).

**Carry-forward LOW / accepted:** the amount `.first()`+`ancestor-tr[1]` under-read on a multi-total form
(the one fail-OPEN-on-money residual — best-effort pending a **Gate B amount-cell capture**); R1 absent-Origin
CSRF; targets-file orphan/PII + Windows-0600-no-op; decision-radio unanchored regex; title page-wide substring;
error-path PII; headed-window interactability; storageState mid-batch expiry; `allowNoValueCeiling` (owner's
explicit choice); OS-user I7.

**Honest status:** three rounds in, the highs are now narrow + money-SAFE-direction (a settle race that
under-reports; a cap that counts the wrong event) and were fixed. The remaining residuals are structural —
the **highest-leverage hardening** is (1) a **positive 승인-stamp completion marker** (replaces absence-based
verify), (2) **crash reconciliation** of `clicked`-without-`confirmed`, and (3) a **Gate B amount-cell
capture** for a reliable value ceiling. Until those, run **supervised + bounded** (dry-run first, small
`--max`, a value ceiling, single-user host), not unattended-at-scale.

---

## Hardening review — (1) marker + (2) reconcile + (3) kill-switch implemented; reviewed (4 lenses + refute) → SAFE-TO-RELY-ON (0C/0H) → reliability mediums fixed
The 3 unattended hardenings were adversarially reviewed: **0 critical, 0 high, 10 medium, 5 low, 0 refuted —
and NO regression to any v1/v2/v3-fixed item.** All mediums are **money-SAFE-direction** (false-negative /
audit-correctness; no false-positive `approved`, no money movement). The unattended-load-bearing ones were fixed:
- **TZ (STAMP-TZ-1):** `TODAY` was UTC; the 결재선 stamp renders **KST** dates, so the marker false-negatived
  during KST 00:00–08:59 and mis-audited a real overnight approval `failed`. Now `TODAY` = Asia/Seoul date.
  (Proven at fix time: KST 2026-06-08 ≠ UTC 2026-06-07 — the bug was active.)
- **Kill-switch halt-ALL (KILLSWITCH-QUEUED / F-STOP-CLEAR-RACE):** the leaf used to self-clear STOP at
  startup, so a QUEUED batch clobbered a just-pressed 일괄 중지. Now the leaf **REFUSES to start while STOP
  exists** (no self-clear); the **/api/approve/run route owns the clear** (an explicit new run). Proven:
  STOP→leaf refuses+exit 0; /run clears STOP→leaf proceeds.
- **reconcile (RECONCILE-DRY-RUN-MASKS / DEPARTURE-ONLY / CORRUPT-LINE):** `lastStage` is now built from
  **LIVE rows only** (a later dry-run can't mask a stranded `clicked`); the audit is parsed **per-line** (a
  torn final line no longer disables recovery); and a departed doc is **cross-checked for a click-day 승인
  stamp** at its recorded `detailUrl` — departure-without-stamp ⇒ `reconcile-uncertain` (distinguishes
  회수/반려 from an approval), not a blind `reconciled-approved`.
- **marker (F-MARKER-WEAK-PROXY):** the post-확인 stamp is now **polled**, not a single fixed-sleep read.

**Carry-forward LOW (accepted / deferred):** the stamp counts any today-dated cell rather than the approver
**self-line** (needs actor identity — M4 #10); audit/reconcile keyed globally by `doc_id` (fine for the
single shared inbox); `/api/approve/stop` inherits the Origin guard (folds into the **R1 present-Origin**
work — #9). The positive marker's **live end-to-end validation against a real fresh approval still needs a
disposable 대기 doc.**
