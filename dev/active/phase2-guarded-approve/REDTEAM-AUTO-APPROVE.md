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
