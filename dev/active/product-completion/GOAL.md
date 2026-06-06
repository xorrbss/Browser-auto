# GOAL — agent-qa RPA, to product completion

**One-line goal:** a general, deterministic, *AI-free-at-runtime* web-automation product where a
non-coder operator **registers ANY web system** (groupware / ERP / ticketing / …) through the webui and
the tool **fetches → summarizes → queries** its data, and (Phase 2) **approves** items under strong,
human-gated safety. Korean operator; **on-prem** model; Windows + Git Bash (and Linux/Docker).

**This file is the durable plan for continuing in a fresh session.** Read it + `CLAUDE.md` + `README.md`
+ the two Phase-2 notes in `dev/active/phase2-guarded-approve/` first.

---

## Where it is now (DONE — branch `feat/approval-automation`, NOT yet merged to `master`)

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
- **Phase 2 approve:** `dev/active/phase2-guarded-approve/DESIGN.md` is now **design v3** (mandatory
  per-item OOB trusted content approval; `echoedDocNo` is typo-guard only). `REDTEAM-v3.md` returns
  **Gate A PASS / safe-to-implement design** with 0 critical/high. **Gate B staged capture still NOT
  done; approval implementation remains forbidden/fail-closed.**

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

### M2 — Generic detail + summary (finish "fetch → 요약" for any system)  [P2]
- Generalize the 결재 detail-enrichment (`extract-detail` + `summarize`) onto the `records` path so any
  registered system can do "open each → extract body → on-prem summarize" (recipe `detail` seam already
  documented in `recipes/SCHEMA.md`).
- enrich pagination: summarize **all** synced docs (currently ~10 of 177).
- **Done when:** a registered system's records carry dept/body/summary; a digest works from the UI.

### M3 — Phase 2 guarded approve (the effectful feature)  [P1, SAFETY-GATED]
- **Gate A:** **PASSED** (`dev/active/phase2-guarded-approve/REDTEAM-v3.md`). `REDTEAM-v2.md` returned
  REVISE-FIRST on v2 (0 critical, **1 HIGH PRESENCE-1**, 4 medium, 8 low). DESIGN v3 closes
  PRESENCE-1 with mandatory per-item OOB trusted content approval (Windows native helper displays doc
  binding + OS credential/Windows Hello; bound to session+actor+doc_id+fingerprint+nonce_hash; plain
  WebAuthn UV alone is insufficient). v3 red-team found **0 critical / 0 high**. Gate A passing does
  **not** authorize implementation before Gate B.
- **Gate B:** §12 of DESIGN — capture the **real approve UI on a disposable staged doc** and pin
  `recipe.approve` (문서번호 uniqueness, native confirm dialog?, required comment?, positive completion
  marker, does the 승인 affordance disappear?). **Until A+B: fail-closed, do not implement.**
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
- README: full RPA registry + 시스템 UI + recipe SCHEMA + the safety model.
- Reconcile with **`feat/linux-docker-support`** (the branch the repo was on at session start) — decide
  merge order / rebase.
- PR `feat/approval-automation` → `master`, review, merge.
- **Done when:** `master` has the full product, `run.sh` green, docs complete.

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
- Phase 2: `dev/active/phase2-guarded-approve/{DESIGN.md,REDTEAM.md,REDTEAM-v2.md,REDTEAM-v3.md}`.
