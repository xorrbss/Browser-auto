# GOAL — agent-qa RPA, to product completion

**One-line goal:** a general, deterministic, *AI-free-at-runtime* web-automation product where a
non-coder operator **registers ANY web system** (groupware / ERP / ticketing / …) through the webui and
the tool **fetches → summarizes → queries** its data, and (Phase 2) **approves** items under strong,
human-gated safety. Korean operator; **on-prem** model; Windows + Git Bash (and Linux/Docker).

**This file is the durable plan for continuing in a fresh session.** Read it + `CLAUDE.md` + `README.md`
+ the two Phase-2 notes in `dev/active/phase2-guarded-approve/` first.

---

## Where it is now (DONE — on `master`; `feat/approval-automation` + `feat/linux-docker-support` ALREADY MERGED)

**Git topology (corrected 2026-06-07 — earlier notes said "unmerged"; that is stale):** work is on
`master`. `feat/approval-automation` (eaa84b6) was merged into master (`ce7ff3a`), and
`feat/linux-docker-support` was merged (`6487e3d`, PR #1) — so **M5's "reconcile with linux-docker" is
already done**. M2 work (16e1b76, cf99053) is committed directly on master after the merge. Local
`master` is **22 commits ahead of `origin/master`, 0 behind** — pushing to origin is the external ship
step (needs user approval). Continuing commits land on `master` (matching the post-merge pattern).

Commits (newest first): `9017850` file-split <500 · `433d39f` enrich fail-loud + queue daemon reaper ·
`2e46258` NL spans records · `d3f8a8d` lib/aria.js dedup · `cabdb4e` generic goldens + recipe SCHEMA ·
`eac141d` data-integrity + transport-governance · `74c4447` sync-system navigate · `0c3df69` RPA
generalization (systems/records) · `271c9b2` 결재 sync + summary + NL + generic store.

Verified working:
- **결재 (Hiworks):** login (cached state) → paginated 대기 sync (177/177) → per-doc detail + on-prem
  summary → DB. Live-verified.
- **Generic RPA path:** `sync-system --system hiworks` live-synced 177 into `records` via the registry
  recipe (no per-site code). `extract-list`/`db`/`aria` pinned by browser-free goldens in `run.sh`.
- **webui:** 결재 dashboard, NL command box (on-prem model classifies → sync/summarize/query; spans
  approvals **and** registered-system records), 시스템 registry view (register/auth/analyze/sync/query).
- **Design review (scorecard 77→ fixes applied)** and **Phase-2 red-team** done; all fix-rounds committed.
- **M1 generic UI verification:** DONE in this session on a brand-new non-Hiworks local system
  `m1demo`: webui register → auth state → live analyze/propose (`proposedBy:model`) → recipe save →
  sync → UI query. `bash run.sh` passed **24/24** on run `20260607-071848-18029`.
- **Phase 2 approve:** `dev/active/phase2-guarded-approve/DESIGN.md` is now **design v4** (mandatory
  per-item OOB trusted content approval; `echoedDocNo` is typo-guard only). Gate A was confirmed by
  `REDTEAM-v3.md` and **independently re-verified by `REDTEAM-v4.md`** (first independent pass, 6
  lenses+adjudicator) → **SAFE-TO-IMPLEMENT, 0 critical / 0 high**, 10 med + 2 low all carry-forward.
  v4 folds the spec-level mediums into DESIGN (PRESENCE-3 body-consent gap; RECON-SWEEP-1 §2↔§4
  contradiction; AMOUNT-SHADOW-1; FP-BODYDIGEST-TRUNC-1; TOCTOU-I6-NOREFP-1; AUTHORITY-2 wording;
  PRESENCE-4). **Gate B staged capture still NOT done; approval implementation remains
  forbidden/fail-closed.**

Recovery note (env): agent-browser daemon wedge (os 10060) = stale `~/.agent-browser` session files;
fix = `agent-browser daemon stop` + kill procs + `rm ~/.agent-browser/*.{engine,pid,port,stream,version}`
(keep `browsers/`), then run as the first op. Re-auth via `setup/auth.sh` when the session expires.

---

## Milestones to completion

### M1 — Close the read/RPA verification gaps  [P1]  **DONE**
- Verified the **full registration flow for a NON-hiworks system** through the UI: register → 인증
  → **구조분석(analyze + propose-recipe LIVE)** → review/edit recipe → 저장 → 동기화 → 조회.
- `propose-recipe.js` live path produced `proposedBy:model` for a reachable ARIA table and mapped
  headers→field names without falling back.
- `bash run.sh` fully green on a healthy daemon: **24/24 passed**, run `20260607-071848-18029`.
- **Done evidence:** brand-new `m1demo` system registered + synced + queried entirely from the UI, no
  product-code edits.

### M2 — Generic detail + summary (finish "fetch → 요약" for any system)  [P2]  **CORE DONE (live-verified)**
- `bin/enrich-system.sh` generalizes the 결재 detail-enrichment onto the `records` path: per record →
  open detail (recipe `detail`) → `extract-detail --generic` (arbitrary fields + body, mandatory
  idLabel==key guard) → on-prem `summarize` → `store-records` (merge data + summary). webui 📝 상세·요약
  button (`/api/systems/:name/enrich`). Commits `0acbbb1`/`b3cd07b`/`9d68be2`/`16e1b76`.
- **LIVE-VERIFIED (2026-06-07):** `enrich-system --key IB-지출(거래처)-20260604-0001` (hiworks) opened the
  detail, extracted dept=관리팀 + 628-char body, summarized on-prem (exaone3.5:32b — accurate: 4.5억
  대출보증료 4,502,670원, 납부 2026.06.05), stored dept+raw_text+summary into `records`. exit 0.
- Footguns fixed live: `--exact` breaks the doc-id click (rendered inside a cell → substring); a chained
  `find…click` exits NON-ZERO on not-found → `|| true` guard so an off-page/transient doc skips (not
  aborts the batch). Added `--key` targeting.
- **Enrich pagination — DONE (code + mechanism live-verified, 2026-06-07):** `enrich-system.sh` now
  scans ALL list pages (combobox `@ref` per page, mirroring `sync-system.sh`), so a record on any of the
  12 pages is reachable, not just page 1. Verified with ZERO model egress (hiworks = 12 pages; select
  page 2 changes the key set). **Remaining = the full summarize RUN itself** (177 × browser-open +
  on-prem inference): a deliberate heavy batch, and because the bodies are confidential it is
  **transport-gated** — run only against a private/TLS endpoint (`LLM_REQUIRE_PRIVATE=1`); the current
  endpoint is public-IP plain HTTP (M4 infra). Detail-only enrich (no `SUMMARY_MODEL`) has no egress.
- **Done when:** a registered system's records carry dept/body/summary [✓ proven]; a digest works from
  the UI [webui button + summary rendering wired; full-batch is the pagination scale step].

### M3 — Phase 2 guarded approve (the effectful feature)  [P1, SAFETY-GATED]
- **Gate A:** **PASSED + independently re-confirmed** (`REDTEAM-v3.md`, then `REDTEAM-v4.md` — the first
  independent re-verify — both SAFE-TO-IMPLEMENT, 0 critical/0 high; DESIGN is now **v4** with v4's 10
  med folded in). `REDTEAM-v2.md` returned
  REVISE-FIRST on v2 (0 critical, **1 HIGH PRESENCE-1**, 4 medium, 8 low). DESIGN v3 closes
  PRESENCE-1 with mandatory per-item OOB trusted content approval (Windows native helper displays doc
  binding + OS credential/Windows Hello; bound to session+actor+doc_id+fingerprint+nonce_hash; plain
  WebAuthn UV alone is insufficient). v3 red-team found **0 critical / 0 high**. Gate A passing does
  **not** authorize implementation before Gate B.
- **Gate B:** §12 — see `dev/active/phase2-guarded-approve/GATE-B-CAPTURE.md`.
  **Phase 1 (read-only) DONE (2026-06-07):** captured the real Hiworks 지출결의서 approve UI without any
  click. Key empirical facts: approve label is **"결재" NOT "승인"** (`role button --name 결재 --exact`,
  count==1); **문서번호 unique + in the metadata region, NOT in the URL** (`/view/<internalId>/...`) → open
  by the unique list-row cell, no urlTemplate; **NO metadata 금액** (body-only → PRESENCE-3 confirmed);
  layout is metadata → **결재선 → body**. Draft `recipe.approve` pinned in the capture doc.
  **Phase 2 — HEADED verification (2026-06-07) RETRACTS the earlier "native-dialog blocker".** First an
  agent-browser drive of `IB-지출(거래처)-20260518-0001` (operator-confirmed test data) appeared to stall
  at `확인` → I wrongly inferred an unhandleable native `confirm()`. A **headed operator run** then showed
  the truth (red-team `BLOCKER-ASSUMED-1` was right): the 결재 modal has a **`승인/협의/반려` radio** + the
  in-DOM prompt "승인하시겠습니까?" + 의견; **clicking `확인` completes directly — NO native dialog.** The
  real miss was that my drive **never selected the `승인` radio**. The operator completed the approval
  headed (대표이사 김택균 / 2026-06-07 / **승인 stamp**); read-only AFTER confirms the doc **left the 대기
  inbox** (positive I6). ⇒ **completion marker = 승인-stamp(self-line, today, operator) + 대기-departure**
  (supersedes the 결재-cell guess). **Then the radio hypothesis was TESTED & REFUTED** on a fresh test doc
  (`IB-품의-20260508-0001`): the `승인` radio is a native `<input>` unreachable by `find role --name`;
  clicking it via `@ref` + 의견 + `확인` (all success) **STILL did not complete** the approval. So **the
  radio is NOT the fix and agent-browser 0.27.0 genuinely cannot complete the final submit.** A decisive
  **headed `--no-auto-dialog` experiment** (2026-06-07, on `IB-품의-20260508-0001`) then resolved it to
  **(B): Hiworks' final submit requires a trusted (`isTrusted`) real click.** agent-browser's synthetic
  `확인` was ignored (no commit, **NO native dialog** — no hang/popup); the **operator's own `확인` click
  approved it** (verified: doc left the 대기 inbox). `confirm.kind = dom`; **(A) native-dialog is fully
  refuted.** ⇒ **agent-browser cannot perform the terminal click; Playwright is NOT required (and its
  native-dialog handler is moot)** — a trusted click comes from {Playwright/Puppeteer/CDP} OR a **real
  human**. **RECOMMENDED PATH = (E)-hybrid (also safer):** since per-item human approval is already
  mandatory, the **operator's own `확인` click IS the approval**; the tool drives everything up to it
  (open by unique cell → idLabel/title/fingerprint re-verify → 결재 → select 승인 → fill 의견) and verifies
  completion (승인-stamp self-line + 대기-departure) + audit. No new dependency, no native-dialog handling.
  `DRIVER-PLAYWRIGHT.md` is re-shelved (contingency only). **Approve implementation still forbidden**
  until the (E)-hybrid `recipe.approve` + `webui/routes-approve.js` wiring + a re-red-team of that flow.
- **Driver path for the native-dialog leg — DESIGN ONLY, now v2 (`DRIVER-PLAYWRIGHT.md` + `REDTEAM-DRIVER.md`).**
  v1 designed the approve leaf on **Playwright** (the project's Docker base; first-class dialog accept).
  **Red-team → REVISE-FIRST** (1 HIGH + 11 med + 7 low): the gate-blocking **HIGH PW-TRACE-COOKIE-LEAK-1**
  (Playwright trace captures the reused Hiworks session cookie → exfil via the no-Origin-check
  `GET /artifacts/*` route) is fixed in v2 (no network/HAR or scrub; evidence to a non-served token-gated
  0600 dir; flag the server.js artifact-route gap). Two strategic mediums reshaped it: **BLOCKER-ASSUMED-1**
  ("post-확인 = native confirm()" is unproven) + **SIMPLER-PATH-1** (a cheaper existing-structure path was
  untested). So v2 §0 reorders the gates **cheapest-first**: (1) headed capture to POSITIVELY identify the
  post-확인 mechanism, (2) test **alternative (E) = headed agent-browser + operator manually clicks OK on
  the one native dialog** (preferred if it works — no new dep), (3) only then Playwright (re-red-team v2 +
  Gate B re-run). Other med fixes folded: one shared byte-pinned cross-stack fingerprint canonicalization
  + hardened shared extractor (CANON/REF), leaf in its OWN dir not `bin/` (LEAF-CONTAINMENT), CDP-shaped
  auth → native capture (AUTH-DUP), persistent counting dialog handler + exact anchored message (dialog
  lows/meds), scrubbed child env (ENV-PROPAGATE). **Approve implementation still forbidden.**
  **⚠ RE-SHELVED / NOT THE PATH (2026-06-07):** the headed experiment resolved the cause to **(B)
  trusted-gesture, NO native dialog** (operator's real `확인` approved; agent-browser's synthetic didn't).
  So the §5 native-dialog handler is **moot** and Playwright's only value (trusted clicks) is already
  provided by the human. **(E)-hybrid is recommended instead** (human's `확인` = the approval; aligns with
  the mandatory OOB ceremony; full-auto trusted-click would be in tension with "the human approves").
  This design stays only as a contingency (e.g. a future unattended mode the safety model doesn't permit).
- **[2026-06-07] OWNER RELEASED the per-item-human gate → building FULL auto-approve** (memory
  `approve-gate-override`; reverses the prior "no auto-approve" gate, owner's informed decision). Stack =
  isolated `approve/` Playwright leaf (pinned 1.49.1, **system Chrome via `channel:'chrome'`** — no browser
  download; the ms-playwright download stalled). Auth = `approve/auth-pw.mjs` headed login →
  `approve/hiworks.pw-state.json` (gitignored; agent-browser's CDP-shaped state is NOT reused per AUTH-DUP).
  **P0 PROVEN:** `approve/poc-approve.mjs` auto-approved disposable `IB-품의-20260429-0001`
  (`POC_RESULT=APPROVE_COMPLETED`; Playwright trusted 확인 click committed it; doc left 대기) — confirms (B)
  and that full auto-approve works. **Build plan:** P1 production leaf (idLabel+title+fingerprint re-verify,
  deterministic caps, dry-run default, kill-switch, append-only audit, positive completion verify) → P2
  `recipe.approve` (decision=승인 radio, confirm=dom, success=승인-stamp/대기-departure) → P3 scenario UI
  (input→run→results) → P4 re-red-team of the auto-approve flow. Guardrails are MAXIMAL since the human
  gate is gone (they only catch errors, never block the auto-approve).
  **[2026-06-07] STATUS: P0–P3 DONE + validated, P4 pending.** P0 (trusted-click auto-approve proven) ·
  P1 (`approve/approve-run.mjs` production leaf: recipe-driven batch, idLabel exactly-one guard, --dry-run,
  --max cap, kill-switch `data/approve-STOP`, append-only fsync'd JSONL audit `data/approve-audit.jsonl`,
  positive completion verify) · P2 (`recipes/hiworks.json` approve block) · P3 (scenario UI:
  `webui/routes-approve.js` POST `/api/approve/run` + GET `/api/approve/state`, `spawn.js nodeLeaf`,
  server wiring, and the "⚡ 자동 승인 시나리오" panel in the 결재 view — doc_ids + dry-run(default) +
  max + 실행 → job log → parsed results table). **Validated end-to-end via dry-run through the webui**
  (route 202 → leaf ran → audit requested/idLabel_ok/dry_ok → job done). **Remaining: P4 re-red-team of the
  auto-approve flow** (the new effectful surface — present-Origin gate on /api/approve, audit-as-SoT,
  amount-cap, fingerprint re-verify depth) + optional CSS polish + headless option. Live auto-approve
  requires an explicit `dryRun:false` (UI confirm dialog) — default is dry-run.
  **[2026-06-07] P4 DONE → REVISE-FIRST → all critical/high FIXED (`REDTEAM-AUTO-APPROVE.md`).** The
  red-team of the BUILT code found **1 CRITICAL + 8 HIGH** (all 23 confirmed): (CRIT) approval by bare
  doc_id, no content/amount/title/value guard; (HIGH) page-1-only completion verify → false-success for
  page 2+; absence-as-success with no list-loaded proof; substring/first-match open → wrong-doc.
  **Fixed in `approve/approve-run.mjs` + `webui/routes-approve.js`:** open by the UNIQUE exact 문서번호
  cell across ALL pages (count===1, abort 0/≥2) → urlGlob assert → exactly-one idLabel → **title content
  binding** (expected title from the synced approvals DB must appear on the live detail; unsynced docs
  refused) → optional **`--max-amount` ceiling** (body 원 figure, fail-closed) → **decision radio asserted
  checked** before 확인 → completion verify scans **ALL pages + asserts the list loaded**. Live now
  requires explicit `--live` + a positive `--max`. **Validated** (dry-run: requested→identity_ok(title✓)→
  dry_ok, no race; live-without-max → 400). **Carry-forward:** R1 present-Origin gate on /api/approve
  (medium), R4 fronted-origin + mid-doc kill-switch (low), and a **re-red-team of this revision** before
  relying on live batches.
  **[2026-06-08] P4 v2 re-red-team → REVISE-FIRST (0C, 11H→2 root causes) → fixed again** (`REDTEAM-AUTO-APPROVE.md`
  v2 section). (a) **amount**: label-anchored (`recipe.approve.amount.label`="총 금액") + `parseKRW`
  (원/₩/억/만, region max), **fail-closed** when no locator/figure; route requires a `maxAmount` ceiling
  for live OR an explicit `allowNoValueCeiling:true` opt-out (no silent unbounded-value approve). (b)
  **completion race**: fixed per-page sleeps → positive `waitSettled` page-change poll + per-page
  `listLoaded` + `waitRows`; a non-settling page ⇒ `countDoc total:-1` ⇒ fail-closed. (c) `listLoaded`
  requires `collection.name`. Validated (dry-run identity_ok(title✓)→dry_ok no race; live w/o ceiling→400;
  parseKRW closes the 원-less-total evasion). Residual: amount label-anchor best-effort (a **Gate B
  amount-cell capture** makes the ceiling fully reliable), R1 present-Origin carry-forward, 3rd re-red-team
  advisable before unattended live.
  **[2026-06-08] P4 v3 re-red-team (ultracode: 8 lenses + refute-verify) → REVISE-FIRST (0C, 4H→2 roots) →
  fixed.** v1/v2 closures VERIFIED (identity, double-approve, listLoaded, amount-mechanism, confirm-exact).
  Fixed: (A) `countDoc` pages 2+ undercount on a half-rendered page → new `settlePage()` (change THEN stable
  render: waitRows + signature stable across 2 reads; non-stable ⇒ total:-1 fail-closed); (B) `--max`
  counted confirmed approvals not clicks → new `clicksIssued` cap incremented AT the irreversible 확인 click
  (committed-but-uncertain now consumes budget). Validated (dry-run settlePage no regression). **Carry-forward
  (med):** crash-reconciliation of `clicked`-without-`confirmed`, kill-switch→UI wiring, pageSelect windowed
  pager, **positive 승인-stamp completion marker** (vs absence-based), recipe-per-form-type. Highest-leverage
  hardening = 승인-stamp marker + crash reconciliation + a **Gate B amount-cell capture**. Until then: run
  **supervised + bounded** (dry-run first, small --max, value ceiling, single-user host), not unattended-at-scale.
- After Gate A+B only, implement per DESIGN v3: `bin/approve-doc.sh`, `webui/routes-approve.js`
  (session cookie, present Origin gate, mandatory OOB trusted content approval, content-fingerprint
  re-verify, isolated asymmetric consent signer), append-only `approval_audit` (`synchronous=FULL`),
  `fetched→approving` claim + reconciliation pass, terminal failed/interrupted→`approve_failed`,
  kill-path durable audit with best-effort video on wedged daemon, confirm-modal (textContent-only) +
  strict CSP, queue approve-gating.
- Tests: browser-free units (DESIGN §9) + staged integration on a disposable doc — **never** a real
  financial approval in a test.
- **Done when:** a staged doc is approved with every guard firing, and invariants I1–I7 hold under a
  fresh red-team.

### M4 — Hardening / productionization  [P2]
- **Transport [SECURITY]:** move the on-prem model endpoint off **public-IP plain HTTP** → VPN / SSH
  tunnel / TLS. The `lib/llm.js` guard only *warns*; the real fix is infra. (Set `LLM_REQUIRE_PRIVATE=1`
  once a private/TLS endpoint exists.)
- Server **session cookie** (HttpOnly + SameSite=Strict) — also a Phase-2 dependency.
- **Daemon-recovery helper:** script the `~/.agent-browser` stale-file cleanup + document in README.
- `actor` identity for the audit; an audit-viewer UI; clearer analyze/sync error UX in the webui.

### M5 — Ship  [P1]
- README: full RPA registry + 시스템 UI + recipe SCHEMA + the safety model. **IN PROGRESS** — added
  the "RPA — register any web system (generic data collection)" section (register→인증→구조분석→동기화→
  상세·요약→조회 table + CLI) and the "Safety model" section (no-LLM-in-gate, on-prem bodies, Phase-2
  I1–I7 + Gate A/B status). recipe SCHEMA already in `recipes/SCHEMA.md`.
- ~~Reconcile with `feat/linux-docker-support`~~ — **DONE** (already merged into master, PR #1 `6487e3d`).
- ~~PR `feat/approval-automation` → `master`~~ — **DONE locally** (merged `ce7ff3a`). Remaining external
  step: **`git push origin master`** (22 ahead) — needs user approval (publishes the work).
- **Done when:** `master` has the full product, `run.sh` green, docs complete, pushed to origin.

---

## Non-negotiable safety gates (carry forward)
1. **Phase 2 approve:** no implementation before re-red-team **safe-to-implement** AND staged capture.
   Fail-closed on anything uncaptured.
2. **Confidential bodies stay on-prem;** harden transport (M4) before any non-local model use in prod.
3. **The model never** touches the pass/fail gate or the approve click path (structural, not convention).
4. **Per-item human approval only; no batch auto-approve; no shared/multi-user host** for the approve path.

## Suggested order
M1 + M3-Gate A (re-red-team) first → M2 / M4 → M3 implementation (after both gates) → M5 ship.

## File map (orient fast)
- Engine: `lib/db.js` (approvals + systems/records), `lib/aria.js` (shared parser), `lib/llm.js`
  (on-prem client + transport guard), `lib/env.sh`/`assert.sh`.
- Extractors: `bin/extract-approvals.js`, `extract-list.js` (generic), `extract-detail.js`,
  `propose-recipe.js`. Drivers: `fetch-approvals.sh`, `enrich-approvals.sh`, `sync-system.sh`,
  `analyze-system.sh`. Stores: `store-approvals.js`, `store-records.js`.
- Recipes: `recipes/<app>.json` + `recipes/SCHEMA.md` (hiworks, daou).
- webui: `server.js`, `routes-rpa.js`, `agent.js` (NL), `systems.js`, `jobs.js`, `spawn.js`,
  `public/{app,flows,systems-view,util}.js`.
- Tests (gate): `tests/extract-approvals.test.sh`, `extract-list-unit.test.sh`, `db-unit.test.sh`.
- Phase 2: `dev/active/phase2-guarded-approve/{DESIGN.md (v4),REDTEAM.md,REDTEAM-v2.md,REDTEAM-v3.md,REDTEAM-v4.md}`.
