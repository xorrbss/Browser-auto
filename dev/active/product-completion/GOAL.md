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
  layout is metadata → **결재선 → body**, so DESIGN's `untilMarker:"결재선"` is wrong (결재선 precedes the
  body); completion marker = self-line `button "결재"` → `cell "결재 <date>"`+image. Draft `recipe.approve`
  pinned in the capture doc.
  **Phase 2 (effectful 결재 click) LEFT FAIL-CLOSED (2026-06-07, operator decision).** No disposable,
  non-effectful doc was available in the operator's 대기 box: the candidates offered were either
  drafted-by-operator (not in 대기 — `IB-지출-20260607-0001`, `IB-품의(기안)-20260528-0001`) or a **real
  financial doc** (`IB-지출(거래처)-20260518-0001` — refused per the "never a real financial approval"
  gate). So the click-only §12 facts (confirm leg, required-comment, completion transition, affordance
  disappearance, URL behavior) stay UNDETERMINED. **Gate B is incomplete → approve implementation
  remains forbidden / fail-closed.** Read-only Phase-1 facts stand (`GATE-B-CAPTURE.md`).
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
