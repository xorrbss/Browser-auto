# Phase 2 — Guarded Approval Execution (design v4)

> ⚠ **THE SHIPPED CODE DIVERGES FROM THIS DESIGN (2026-06-07 owner override).** The system owner, shown the
> irreversible-financial risk in plain terms, **explicitly released the per-item human-approval gate**
> (memory `approve-gate-override`) and chose **full auto-approve — no human click.** So the code that ships
> is **NOT** this out-of-band trusted-content-ceremony design. It is a **full-auto Playwright trusted-click
> leaf** (`approve/approve-run.mjs` + `webui/routes-approve.js` + `recipes/<app>.approve`) whose
> **deterministic guards are the SOLE safety** (the human ceremony — the load-bearing safety here — is
> gone, so every guard fails closed). The red-team of the BUILT code is `REDTEAM-AUTO-APPROVE.md`; the
> operator-facing summary is README *Safety model → Phase 2 — auto-approve*. **This document is retained as
> (a) the record of the human-gated design and (b) the contingency to revert to if the owner re-imposes the
> gate.** Where the two disagree: the BUILT code + `REDTEAM-AUTO-APPROVE.md` are authoritative for *what
> runs*; this design is authoritative for the *human-gated model* and its invariants I1–I7. See §14.

**Status:** DESIGN-OF-RECORD for the human-gated (OOB-ceremony) model — **superseded at runtime** by the
full-auto build (see banner + §14). v4 supersedes v3 after `REDTEAM-v4.md` (the first **independent**
re-verification of the Gate-A PASS) returned **SAFE-TO-IMPLEMENT** (0 critical / 0 high) but surfaced
10 medium + 2 low spec-precision/completeness items. v4 folds the spec-level mediums in (PRESENCE-3
body-consent gap; RECON-SWEEP-1 §2↔§4 contradiction; AMOUNT-SHADOW-1 unguarded amount extraction;
FP-BODYDIGEST-TRUNC-1 silent body truncation; TOCTOU-I6-NOREFP-1 post-click fingerprint recompute;
AUTHORITY-2 "structural" wording; PRESENCE-4 attacker-timed habituation). v3 had superseded v2 after
`REDTEAM-v2.md` returned **REVISE-FIRST** on one gate-blocking HIGH (`PRESENCE-1`). v3/v4 keep the
stronger product/security direction:
approval is not merely serialized; every item requires a mandatory out-of-band **trusted content
approval ceremony** that same-origin page JavaScript cannot synthesize, suppress into a blind generic
prompt, or replay across another doc/session/fingerprint. The trusted surface must display the
doc binding (doc id, title, deterministic amount when available, and fingerprint/body digest) and
require an explicit per-item approval gesture. Windows native helper + OS credential/Windows Hello is
the v3 baseline; plain WebAuthn user verification without a trusted transaction display is not enough.
The old
`echoedDocNo` echo is retained only as a typo guard if useful; it is **not** a security presence factor.

> **GATE A — DESIGN v3 authored; third re-red-team REQUIRED.** Implementation stays **FORBIDDEN** until
> (a) this v3 design is re-red-teamed and returns **safe-to-implement** (zero confirmed critical/high),
> and (b) the mandatory staged capture in §12 is complete. Until both gates pass: **fail closed**.

> **HARD PREREQUISITE:** the approve path MUST NOT be implemented until the target app's real approve
> UI is captured on a *disposable staged document* (§12). Every guard below depends on empirically
> verified facts (is 문서번호 unique on the detail page? does the 승인 affordance disappear after
> approval? is there a native confirm dialog? a required comment?). Until captured: **fail closed.**

## 0. Non-negotiable invariants

1. **I1 Per-item explicit human approval of THIS document's CURRENT content.** Not "approved a
   doc_id" — the human must approve the *content they actually saw*, and that content must be the
   *live* document, re-proven unchanged at click time (§I-CONSENT). **The content the human approves
   must be shown on a surface page JS cannot rewrite.** The trusted display (§5) gives genuine
   content-consent for the displayed *scalars* (doc_id/title/amount); for an app whose load-bearing
   figure lives in the *body* (e.g. an amount-less form), the consented **body region must be rendered
   inside the trusted helper too, or the flow fails closed for high value** — a `body_digest` bound
   into the fingerprint proves the leaf re-verified the *same* body, but it is **not** human-verifiable
   informed consent for the body if the human only ever saw that body on the script-mutable modal
   (`PRESENCE-3`).
2. **I2 No batch / mass approve.** At most one approve in flight per server-anchored session, and
   every consent token is minted only after a fresh, per-item trusted content approval ceremony bound
   to this doc and fingerprint. No endpoint, queue path, nonce, or signer can approve >1 doc per human
   approval ceremony.
3. **I3 The model has ZERO authority — structurally, not by convention.** No model output is on the
   path to a click. `/api/agent` cannot call prepare/approve/sign. The consent signer is a separate
   trust boundary from the NL/read router and refuses to sign unless it receives a verified trusted
   content approval result for the exact doc+fingerprint; the bash leaf validates that signed consent
   before any click.
4. **I4 Deterministic click-time re-verification (identity + content fingerprint).** The live page's
   문서번호 must equal the confirmed doc_id (exactly-one, metadata-region) AND the title AND a
   content fingerprint of exactly-what-the-human-saw must match, else ABORT before any click.
5. **I5 Genuinely append-only, crash-tolerant audit; video best-effort on daemon-hard-failure.** A
   durable audit stage is the source of truth and is written before/after every attempt. Normal and
   bounded kill paths finalize video; a wedged daemon or uncatchable hard kill may lose/truncate video
   but must not lose the durable audit or leave audit↔status diverged.
6. **I6 Positive commit verification.** Success requires `.success==true` AND a POSITIVE per-doc
   state transition (this doc now shows 완료 on its own decision line) — never a negative/navigational
   signal. A login redirect or any unexpected URL ⇒ ABORT/uncertain, never success.
7. **I7 No shared host.** The loopback endpoint is reachable by any same-OS process; this design is
   only safe on a single-user, operator-controlled host. Stated, documented, enforced operationally.

If any invariant cannot hold for a given app/recipe → the path **refuses** (fail loud), never degrades.

## 1. Threat model → guard (post-red-team)

| # | Threat | Guard (v3) |
|---|--------|-----------|
| T1 | Approve a DIFFERENT doc than confirmed (wrong-row click, redirect, doc_id substring) | Open by a UNIQUE locator (list row 문서번호 cell `count==1 --exact`, or a doc_id-embedding detail URL whose urlGlob contains doc_id); abort on 0/≥2. NEVER `find text "$doc" click` (substring/first-match). |
| T2 | idLabel re-verify matches the wrong/ spoofed element | Reused guard asserts **exactly one** rowheader == idLabel, **confined to the metadata region** (lines before the body heading); a 문서 번호 rowheader inside the body subtree → abort. |
| T3 | Recycled/non-unique 문서번호 passes (title leg only claimed, not coded) | Implement explicit normalized **title-equality** vs the confirmed title in approve-doc.sh (abort on mismatch/empty); 문서번호 remains the load-bearing identity, hardened per T2. |
| T4 | **Informed-consent decoupling** — human saw STALE cached content; re-verify checks identity only; amount only in a poisonable LLM summary | prepare opens the **LIVE** page; the human reviews deterministically-extracted fields + raw body; the consent is bound to a **content fingerprint** (hash of 문서번호+제목+deterministic amount+body digest). At click time the same fields are re-extracted from the live page and must match. LLM summary is visually secondary/advisory. If no deterministic amount can be extracted for a high-value flow, fail closed or require an operator-entered deterministic amount field captured in §12; never make the summary the structured money signal. **Every fingerprint-bound field (incl. `amount`) is extracted with the T2 discipline — exactly-one rowheader, metadata region, abort on 0/≥2** (`AMOUNT-SHADOW-1`: a drafter must not be able to plant a duplicate `금액` rowheader that shadows the trusted figure). The `body_digest` is computed over an **explicit recipe-declared region** (heading→`untilMarker`, excluding the volatile 결재선/timestamps) and **fails closed on overflow** — never a silent truncation that drops the payment line out of both consent and re-verify (`FP-BODYDIGEST-TRUNC-1`). |
| T5 | **Nonce = CSRF token, not human/content consent** — a local/same-origin caller self-mints+consumes nonces in a loop or triggers a blind generic auth prompt → batch-approve | `echoedDocNo` is not a security factor. `/api/approve` must complete a mandatory **OOB trusted content approval ceremony** bound to (session, actor, doc_id, title, deterministic amount when available, fingerprint, nonce_hash). The trusted surface (v3 baseline: Windows native helper + OS credential/Windows Hello) must display the doc binding — and, for an app whose load-bearing figure lives in the body, the **consented body region** itself (`PRESENCE-3`), not only the scalars — and require an explicit approve gesture. Plain WebAuthn UV without trusted transaction display is insufficient. The signer mints consent only after this verified ceremony. Plus: reserve the single approve slot before OOB/sign/status mutation; ≤1 outstanding nonce per session; shared/multi-user hosts are out (I7). |
| T6 | **False success** — `.success==true` (exit-0-on-failure) or a navigational signal recorded as approved | I6: drop absentText/URL-change disjuncts; after a deterministic settle gate, POSITIVELY re-open the doc and assert its own 완료 transition (marker absent-before / present-after on the approver's line). Ambiguous ⇒ failed. |
| T7 | Double-approve via the 'fetched' window / no reconciliation | Atomically claim `status 'fetched'→'approving'` in the SAME transaction as nonce consume; prepare+approve refuse unless strictly 'fetched'; any non-terminal/ambiguous audit row HARD-BLOCKS the doc; forward-only reconciliation on startup and at each approve-job head. |
| T8 | CSRF via absent Origin (server's generic `if(origin)` lets absence through) | routes-approve requires a **present** Origin/Referer whose host is exactly 127.0.0.1:PORT / localhost:PORT BEFORE any nonce work, else 403 — never fall through on absence. (Anti-browser-CSRF: necessary, not sufficient — paired with T5.) |
| T9 | Kill path (watchdog/cancel/shutdown) loses audit + video for the highest-stakes attempt | Persist the job's session id; write a durable `interrupted` terminal audit BEFORE reaping; capture detail_after synchronously right after the click when reachable. Video finalization must use a dedicated approve recording session/daemon or direct ffmpeg flush where available; document wedged-daemon/hard-kill video as best-effort, never as the source of truth. |
| T10 | Replay / nonce leak | crypto.randomBytes(32), constant-time compare, single-use (atomic delete-before-await), TTL sweep, outstanding cap; persist only the **sha256** of the nonce in audit; never log it / put it in job labels, child argv, or SSE. |
| T11 | Model shapes the candidate set (omits/surfaces a doc) | Approve candidates come from a **deterministic** operator-driven query / the full 미결 list; any NL-narrowed view is labelled "AI가 좁힌 후보" and the unfiltered list is always offered. Regression test: `/api/agent` has no code path to prepare/approve/OOB/sign/enqueue approve. |
| T12 | TOCTOU verify→click + native confirm leg unmatchable | Acknowledge the full fingerprint re-verify is host-side, not in-batch. The batch immediately before click carries only a last-moment identity/visibility guard, and the binding authority is the consent fingerprint plus the post-click I6 re-open, which **RECOMPUTES the full content fingerprint and requires equality to consent** (`TOCTOU-I6-NOREFP-1` — not merely idLabel + 완료, so a same-doc content mutation across the verify→click window is caught after the fact). Disable/avoid auto-advance, capture URL before/after the click and abort on uninitiated URL delta, split confirm schema into `none|dom|native`, and fail closed unless §12 proves every confirm leg. |
| T13 | Poisoned summary → same-origin DOM injection in the confirm modal | Render ALL document/LLM-derived strings via `textContent`/safe element helpers only (never innerHTML); reject string-valued `on*` props; strict no-inline-script CSP; test markup inertness and CSP presence. Do not keep live nonce/OOB proof material in page JS longer than required. |

## 2. Flow (v3 — live content, OOB trusted content approval, content fingerprint, positive verify)

```
[결재 view]  미결 목록(결정론 쿼리)에서 1건 [승인 검토] 클릭
   │
   ▼ POST /api/approve/prepare { doc_id }        (browser job — opens the LIVE doc, read-only)
   • 서버 세션(§5) 확인; doc가 strictly status='fetched'인지; 미해결 감사행 없는지(있으면 거부)
   • 직렬 큐로 LIVE detail open(by unique locator) → idLabel/title 재검증 → 결정론 필드 추출
       (문서번호/제목/금액/본문 digest) + detail_before 스냅샷
   • content fingerprint = sha256(length-prefixed 문서번호|제목|amount|body_digest) 계산
   • nonce 발급: crypto.randomBytes(32), (sessionId, doc_id, fingerprint)에 바인딩, TTL 5분,
       세션당 미소비 nonce 1개만; sha256(nonce)만 audit에 'requested'로 INSERT
   • 사람에게 LIVE 내용 반환(결정론 필드 + 원문; AI요약은 접힌/보조 '참고용' 라벨)
   │
   ▼ [확인 모달]  사람이 LIVE 내용을 읽고, 승인 의견을 입력하고, [이 문서 승인] 클릭
        문서번호/금액 재입력은 오타 방지 UX일 뿐 보안 presence factor가 아님.
   │
   ▼ POST /api/approve { doc_id, nonce, comment, optionalTypedChecks }
   • Origin/Referer host 일치(없으면 403); server session present; nonce 유효·미사용·doc_id·fingerprint 일치;
     doc strictly 'fetched'; optional typed checks 불일치 시 거부
   • approve slot reserve: 이 세션에 approve queued/running/reserved가 있으면 409.
     예약 실패는 OOB prompt 전에 반환; 취소/실패 시 예약 해제.
   • **Mandatory OOB trusted content approval ceremony**:
       - v3 baseline: Windows native helper displays doc_id/title/amount-or-"no deterministic amount"/
         fingerprint/body digest, then requires explicit [Approve this document] + OS credential/Hello
       - challenge = random(32) bound to (sessionId, actor, doc_id, title, amount, fingerprint,
         nonce_hash, expires_at)
       - bearer proof/signing material은 HTTP response body, DOM, SSE, logs, argv에 노출 금지
       - plain WebAuthn UV without trusted transaction display ⇒ unsupported/fail closed
       - ceremony 실패/취소/timeout/unsupported ⇒ terminal `abandoned`/`failed` audit or requested expiry,
         no nonce consume, no status mutation, no consent, no enqueue, reserve release
   • 같은 트랜잭션에서: nonce 소비(delete-before-await) + status 'fetched'→'approving'
   • signer trust boundary가 trusted ceremony proof를 검증한 뒤, 서명된 1회용 consent 토큰
     (doc_id+fingerprint+session+actor+challenge_hash 바인딩)을 approve 잡에 파일/stdin으로 전달
       (단, 이 세션의 approve가 queued/running이면 409 거부)
   │
   ▼ [approve 잡]  bin/approve-doc.sh --app A --doc D --consent-file f --comment-file c
     0. consent 공개키 검증 + single-use DB claim 확인 없으면 ABORT
     1. 'clicked' 단계 감사 INSERT를 HARD GATE로 (.success 실패 시 ABORT, 절대 `|| true` 아님)
     2. AB_AUTH open → open D by UNIQUE locator → wait_url(detail urlGlob containing doc_id when available)
     3. 재검증(I4): exactly-one idLabel(metadata region)==doc_id + title 일치
        + 결정론 필드 재추출 → fingerprint == consent의 fingerprint (불일치 ABORT)
        + 이미 완료 상태면 idempotent no-op ABORT
        + 승인 버튼 snapshot-parse count==1 + semantic exact click target
     4. click 직전 배치: weak identity/visibility 재확인 → 의견 입력 → 승인 클릭 → confirmKind 처리
        (confirmKind=native는 §12에서 accept primitive가 입증되지 않으면 빌드 거부)
     5. settle 게이트: reliable `wait_url` helper + in-batch wait --text(긍정 완료 마커);
        click 전후 get-url delta가 recipe/capture에 없는 자동 이동이면 ABORT
     6. 성공검증(I6): server-fresh 재오픈/cache-bust 또는 미결함 이탈 cross-check →
        doc_id로 재오픈 → idLabel 재확인 → **content fingerprint 재계산 후 consent와 일치 확인**
        (TOCTOU-I6-NOREFP-1; 불일치 ⇒ ABORT/uncertain) → 이 문서가 자기 결재선에 완료 마커
        '전엔 없음 / 후엔 있음' 전이 확인. 로그인 리다이렉트/예상외 URL ⇒ ABORT(uncertain)
     7. detail_after 동기 캡처; terminal audit + status를 **하나의 트랜잭션**:
        confirmed→approved, failed/interrupted→approve_failed. 재조정은 outcome-aware(§4): 'approving +
        confirmed audit'는 approved로 수습(절대 approve_failed 아님), 'approving + 실패-terminal'은
        approve_failed, 'approving + non-terminal crash gap'만 재오픈·긍정 재검증한다.
   │
   ▼ [UI] 결과 + 영상 링크(영상은 증거 보조; audit/status가 source of truth)
```

## 3. Recipe `approve` block (v3)

```json
"approve": {
  "openBy": { "by": "cell", "field": "doc_id", "exact": true },   // unique row-open; OR a urlTemplate
  "urlTemplate": "https://…/document/view/{doc_id}",              // preferred: doc_id in the URL
  "ready":   { "text": "결재 정보" },
  "amount":  { "label": "금액", "exactlyOne": true, "region": "metadata" },  // DETERMINISTIC (no LLM); T2 discipline: exactly-one rowheader in the metadata region, abort 0/≥2
  "body":    { "fromHeadingLevel": 2, "untilMarker": "결재선" },    // hash exactly what the human sees; fail closed on overflow (never silent-truncate)
  "comment": { "label": "의견", "required": false },
  "button":  { "by": "role", "role": "button", "name": "승인", "exact": true },
  "confirm": { "kind": "dom", "by": "role", "role": "button", "name": "확인", "exact": true },
  "success": { "completeMarker": "결재완료", "scope": "self-line", "fresh": "cache-bust-or-inbox-departure" }
}
```
- All click targets: semantic, `--exact`, asserted unique by snapshot/ARIA parse at click time. No
  `@ref`, no substring, no host `get count` claim for semantic locators.
- `success` is positive-only (a completeMarker transition on this doc's line). The v1 `absentText`/URL
  disjuncts are **removed** (T6). `success.fresh` must be proven in §12 or the recipe refuses.
- `confirm.kind` is `none | dom | native`. `native` is fail-closed unless §12 proves an agent-browser
  accept primitive for that app/version.
- `amount` is mandatory for any high-value flow. It — and **every fingerprint-bound field** — is
  extracted with the T2 discipline (exactly-one rowheader, metadata region, abort 0/≥2) so a drafter
  cannot shadow it with a duplicate `금액` rowheader (`AMOUNT-SHADOW-1`). If the app lacks a
  deterministic amount field, the approve modal must make raw body primary, collapse/de-emphasize AI
  summary, and either fail closed for high value or require a §12-pinned deterministic operator-entered
  amount check (itself bound into the fingerprint).
- `body_digest` is computed over the explicit `fromHeadingLevel`→`untilMarker` region only (excluding
  the volatile 결재선/timestamps) and **fails closed when the region exceeds the captured bound** —
  never a silent `MAX_BODY` slice that drops the payment line out of both consent and re-verify
  (`FP-BODYDIGEST-TRUNC-1`). For an app whose load-bearing figure lives in the body, that body region is
  also rendered inside the trusted helper (or the flow fails closed for high value), per I1/`PRESENCE-3`.

## 4. Data model (v3)

**Genuinely append-only** `approval_audit` — one immutable INSERT per stage (never UPDATE-in-place):
```sql
CREATE TABLE IF NOT EXISTS approval_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app TEXT NOT NULL, doc_id TEXT NOT NULL, session TEXT, actor TEXT,
  nonce_hash TEXT NOT NULL,        -- sha256(nonce); the live token is NEVER stored/logged
  fingerprint TEXT,                -- sha256 of the exact content the human confirmed
  challenge_hash TEXT,             -- sha256(OOB challenge); proof/secret is NEVER stored/logged
  consent_id TEXT,                 -- opaque single-use consent id, not the token body
  stage TEXT NOT NULL,             -- requested | abandoned | clicked | confirmed | failed | interrupted
  detail TEXT,                     -- stage snapshot (before/after as appropriate)
  video_path TEXT, error TEXT, at TEXT NOT NULL
);
```
- Writer connection uses `PRAGMA synchronous=FULL` (the existing store stays NORMAL); or write the
  pre-click record to an fsync'd append log that is the crash-tolerant source of truth, reconciled
  into sqlite on startup.
- `approvals.status` lifecycle: `fetched → approving (claim, same txn as nonce consume + OOB proof
  consume) → approved (same txn as the 'confirmed' audit) | approve_failed` (same txn as terminal
  `failed`/`interrupted`). The reconciliation pass is **outcome-aware** (`RECON-SWEEP-1` — the v3
  blanket "approving + terminal audit → approve_failed" wrongly flipped a verifiably-`confirmed` doc to
  failed under the fsync'd-log crash variant; §2 step 7 and §4 now agree):
  - `approving` + a **`confirmed`** audit → `approved` (the success terminal — **never** `approve_failed`);
  - `approving` + a **failure-terminal** (`failed`/`interrupted`) audit → `approve_failed`;
  - `approving` + only a **non-terminal** audit (real crash/kill gap) → re-open by doc_id, positively
    re-verify (idLabel + fingerprint recompute + 완료 transition), then `approved`/`approve_failed`,
  all before the doc can ever be re-offered. `status` is already excluded from the list-resync COALESCE.
- A `requested` preview audit is not an approval claim. If the operator cancels, OOB fails, or the
  nonce expires before consume, append `abandoned`/`failed` (or expire the request) and leave
  `approvals.status='fetched'`; only `approving` or terminal/ambiguous approval-stage rows hard-block
  re-offer.

## 5. Identity, OOB trusted content approval, consent token, session, nonce

- **Server-anchored session is mandatory:** GET `/` mints an `HttpOnly; SameSite=Strict` session cookie.
  All nonce, challenge, queue, and approve caps key on this cookie. If the cookie cannot be added, the
  approve feature remains unimplemented/fail-closed.
- **OOB trusted content approval is mandatory per item:** `/api/approve` starts or verifies a native
  approval ceremony that same-origin JavaScript cannot reduce to a blind generic auth prompt. The v3
  baseline is a Windows native helper: it receives a server-signed challenge, displays doc_id, title,
  deterministic amount or "no deterministic amount", fingerprint/body digest, and the requested action,
  then requires an explicit per-item approval plus OS credential/Windows Hello. Plain WebAuthn UV alone
  is not acceptable unless a future authenticator/OS flow provides a trusted transaction display with
  the same doc binding. The ceremony must bind
  `(session, actor, doc_id, title, amount, fingerprint, nonce_hash, expires_at)` and return only a
  server-verifiable result to the signer. It is never optional, never high-amount-only, and never
  replaced by `echoedDocNo`.
- **Typo checks:** retyping 문서번호 or amount may remain as UX checks. They are not security factors and
  must not be described as presence.
- **Nonce:** crypto.randomBytes(32); bound to (session, doc_id, fingerprint); single-use with the Map/DB
  consume as the FIRST synchronous statement after validation (no await between — unit-tested);
  TTL+sweep; ≤1 outstanding per session; only sha256 persisted.
- **Consent token / signer boundary:** the signer receives a verified trusted ceremony result and
  issues a single-use, doc_id+fingerprint+session+actor+challenge_hash bound token. Use an in-memory
  asymmetric keypair minted at server start: signer holds the private key, `approve-doc.sh` receives
  only the public key. Never put signing secrets in `process.env`; pass consent via a `0600` temp file
  or stdin, never argv/log/SSE. `approve-doc.sh` refuses to click without validating the token for the
  exact doc and fingerprint. A regression test asserts `/api/agent` cannot reach prepare/approve/OOB/sign
  or enqueue a `kind:'approve'` job.
  - **What is structural vs convention (`AUTHORITY-2`):** in a single node process the in-memory keypair
    structurally blocks only the **out-of-process** bash leaf / stray spawns (they hold only the public
    key); it does **not** by itself stop in-process mis-wiring. The genuinely *structural* authority
    barrier is the **mandatory OOB OS-credential ceremony** (§13-Q1) — no token is minted without a
    verified per-item human ceremony the in-process code cannot synthesize. So I3 rests on the OOB
    ceremony (+ the §9 regression test that the read/NL router imports no signer/approve/enqueue path),
    not on the keypair alone.
- **CSRF:** present, host-matching Origin/Referer required before any nonce/OOB work (T8).

## 6. Queue / kill-path (v3)

- `kind:'approve'` is gated in the queue: refuse enqueue (409) if any approve for this session is
  queued, running, or OOB-reserved (T2). The reserve/check happens before OOB ceremony, nonce consume,
  status claim, signer call, or enqueue. If enqueue cannot be committed, the claim rolls back and the
  reserve is released; no doc may be stranded in `approving`.
- Kill path (T9/I5): the job record carries its agent-browser session id and audit context. Any
  cancel/watchdog/shutdown for an approve job writes an `interrupted` audit + `approve_failed` status
  BEFORE reaping when the process is reachable. Server shutdown awaits a bounded approve cleanup for
  SIGINT/SIGTERM/SIGHUP/console-control events that can be caught on the host. Uncatchable hard kills
  rely on pre-click audit + startup reconciliation.
- Video is evidence-supporting, not source-of-truth. Prefer a dedicated approve recording session/daemon
  or direct ffmpeg flush; if the shared agent-browser daemon is wedged, video finalization is explicitly
  best-effort while audit/status remain durable.

## 7. Explicitly OUT (v1)
Batch/"approve all"; LLM-initiated or LLM-gated-candidate approve; 반려/대결; unattended/scheduled
approve; running on a shared/multi-user host.

## 8. Integration points
New: `bin/approve-doc.sh`, `recipes.approve`, `lib/db.js` (append-only audit + nonce/OOB/consent
helpers + `synchronous=FULL` writer + the 'approving' claim + reconciliation), `webui/routes-approve.js`
(prepare/approve, session cookie, present Origin gate), an OOB trusted approval adapter, an isolated
consent signer, a confirm-modal (textContent-only) + strict CSP. Reused + HARDENED: `extract-detail.js`
guard (exactly-one + metadata region + title + full body-region digest), `lib/assert.sh` (.success +
positive settle), the serial queue (approve gating + kill-path audit). Unchanged: the model/NL path
(candidates only, deterministically sourced; explicit test that it cannot call approve authority).

## 9. Testing (deterministic; the click is staged, never a real approval)
Browser-free units:
- nonce: randomness, single-use atomic consume, TTL, replay-reject, outstanding cap, hash-only
  persistence;
- OOB trusted approval: missing/canceled/expired/mismatched challenge rejects; a same-origin caller with
  doc_id/nonce/typed checks but no trusted content approval ceremony cannot mint consent; a generic
  WebAuthn/OS UV prompt that does not display doc binding is rejected; proof is bound to
  session+actor+doc+title+amount+fingerprint+nonce;
- authority: `/api/agent` cannot reach prepare/approve/OOB/sign/enqueue approve; signer private key is
  not in `process.env`; leaf gets public key only; consent via file/stdin, not argv/log/SSE;
- content: fingerprint mismatch aborts; no deterministic amount on high-value flow fails closed unless
  §12 pins an operator-entered deterministic amount check; summary injection cannot become the
  structured amount signal;
- guards: exactly-one idLabel via snapshot/ARIA parse, body-region 문서번호 abort, title mismatch abort,
  doc-open 0/≥2 abort, full consented body hashed or fail closed on truncation/ambiguous bounds;
- audit/status: per-stage append-only rows, confirmed+approved in one txn, failed/interrupted+
  approve_failed in one txn, crash-stage visible, `approving + terminal audit` sweep, requested
  cancel/timeout expires or appends `abandoned` without blocking future fetched docs;
- CSRF/queue: Origin-absent → 403; second approve while one pending/reserved → 409 before OOB prompt
  and before nonce/status mutation;
- kill/video: wedged `record stop` still writes interrupted audit/status; missing/truncated video is
  tolerated only on documented wedged/hard-kill paths;
- modal/CSP: document markup inert; string-valued `on*` props rejected; CSP header has no
  `unsafe-inline`.

Staged integration uses a disposable doc only, never a real financial approval, and exercises
success/abort/false-success branches with crafted snapshots/offline fixtures before any live staged
click.

## 10. Residual risks (accepted with controls)
- **Local code-exec as the same OS user always reaches loopback** — irreducible on a no-auth localhost
  design (I7). Controls: threat-model it, forbid shared/multi-user hosts, require OOB trusted content approval
  for every item. This does not protect against malware that can operate as the same OS user and satisfy
  or proxy the operator credential prompt.
- **Adversarial-but-truthful documents** can still mislead a human. Controls: always show raw body, AI
  summary advisory-only/collapsed, deterministic amount or fail-closed high-value policy.
- **Attacker-timed habituation / prompt-fatigue (`PRESENCE-4`).** A same-origin script cannot complete
  the ceremony, but it can choose a `doc_id` and time `/api/approve` to *race* a legitimate approval the
  operator is about to make, exploiting reflexive "just click approve" authentication. Software-unbreakable
  (the per-item ceremony stays mandatory); controls are human-factors: the trusted helper surfaces the
  full action context + any in-flight approval, and the endpoint rate-limits ceremony prompts.
- **agent-browser 0.27.0 quirks** (exit-0-on-failure, native-dialog invisibility, per-app layout) must
  be empirically captured per recipe (§12); fail closed on anything uncaptured.
- **External assumptions** (stable unique 문서번호 on detail; approve affordance hidden/changed after
  approval) must be verified per app and re-verified on app upgrades.
- **WAL durability** is best-effort; an OS crash at the worst instant can desync audit↔reality until
  reconciliation — accept with `synchronous=FULL`/fsync'd log + startup reconciliation.
- **Plain WebAuthn UV is presence, not content consent.** JS may carry challenge/assertion objects and
  may trigger a generic user-verification prompt. v3 therefore requires a trusted transaction display
  (baseline: native helper) that shows the doc binding before the human approves; WebAuthn UV alone is
  explicitly insufficient.

## 11. Changelog

### v1 → v2 (what the first red-team broke → what v2 improved)
- **CRIT nonce=CSRF-not-presence** → v2 added serialization/nonce caps/Origin handling, but its
  `echoedDocNo` presence claim was later broken by `REDTEAM-v2.md` as `PRESENCE-1`; v3 replaces it
  with mandatory OOB trusted content approval (§5,T5).
- **CRIT stale-content consent** → live-content prepare + content fingerprint re-verified at click + deterministic amount + advisory-labelled summary (T4,§2).
- **CRIT false-success gate** → positive per-doc 완료-transition re-verify; drop absent/URL disjuncts; redirect=abort (I6,T6,§3).
- **HIGH double-approve/window** → 'approving' claim in consume txn + hard-block on non-terminal audit + reconciliation (T7).
- **HIGH kill-path loses audit+video** → persist session id + bounded `record stop` + 'interrupted' audit before reap + shutdown grace (T9).
- **HIGH weak idLabel guard** → exactly-one + metadata-region + explicit title-equality (T2,T3).
- **HIGH substring doc-open** → unique locator / doc_id-embedding URL, abort 0/≥2 (T1).
- **HIGH Origin-absent bypass** → require present host-matching Origin, 403 on absence (T8).
- **HIGH unbounded approve queue** → queue gates kind:'approve' (T2,§6).
- **HIGH no settle gate / circular URL proof** → wait_url + in-batch wait --text before assertion (T6).
- **HIGH audit not a hard gate** → pre-click 'clicked' write aborts on failure, never `|| true` (I5).
- **MED** session cookie / atomic consume / hash-only nonce / deterministic candidates / synchronous=FULL / genuinely append-only — folded into §4,§5,T11.
- **LOW** crypto nonce + consent-token-in-the-leaf + textContent-only modal + CSP — folded into §5,T13.

### v2 → v3 (what `REDTEAM-v2.md` required)
- **HIGH PRESENCE-1 / content-consent** → `echoedDocNo` downgraded to typo guard; mandatory per-item
  OOB trusted content approval is required before nonce consume, status claim, consent signing, or
  enqueue (§2,§5,T5). Plain WebAuthn/OS UV without doc-binding display is insufficient.
- **MED FP-SUMMARY-2** → raw body primary, summary advisory/collapsed; deterministic amount required
  for high value or fail closed / §12-pinned operator-entered amount check (T4,§3,§9,§12).
- **MED AUTHORITY-1** → signer/verifier/native approval trust boundary specified; `/api/agent` cannot reach
  prepare/approve/OOB/sign and is covered by regression tests (§5,§8,§9,T11).
- **MED WATCHDOG-WEDGED-1** → audit/status is the source of truth; video is best-effort on wedged
  daemon/hard-kill paths (§6,§9,§10).
- **MED IDOPEN-5** → full fingerprint reverify acknowledged as host-side; last-moment batch is a weak
  identity/visibility guard, with URL-delta abort and I6 re-open as binding authority (§2,T12,§12).
- **LOW fixes** → semantic count via snapshot/ARIA parse, confirmKind split, recipe-pinned body region,
  server-fresh success check, terminal audit/status transaction, asymmetric consent key handling, and
  strict CSP/string-`on*` rejection (§3-§9,§12).

### v3 → v4 (what `REDTEAM-v4.md`, the first independent re-verify, surfaced — verdict SAFE-TO-IMPLEMENT)
The independent Gate-A re-verification confirmed **0 critical / 0 high** (PRESENCE-1 stays closed) and
returned 10 medium + 2 low. The spec-level mediums are folded in here; the four implementation-prescribed
mediums (ORIGIN-FALLTHROUGH-T8, KILLPATH-AUDIT-T9, SHUTDOWN-EXIT-1, RECORDSTOP-WEDGED-T9) the design
already covered (doesV3Close=yes / explicitly accepted) and stay as build-time TODOs + §9 tests.
- **MED PRESENCE-3** *(strongest)* → trusted display gives content-consent only for the displayed
  scalars; the consented **body region must render inside the trusted helper** (or fail closed for high
  value) for body-load-bearing apps; `body_digest` is not human-verifiable body consent on its own
  (I1, T4, T5, §12).
- **MED RECON-SWEEP-1** → outcome-aware reconciliation sweep (`approving+confirmed→approved`, never
  `approve_failed`); §2 step 7 and §4 reconciled.
- **MED AMOUNT-SHADOW-1** → T2 exactly-one+metadata-region discipline extended to `amount` and every
  fingerprint-bound field (T4, §3).
- **MED FP-BODYDIGEST-TRUNC-1** → `body_digest` fails closed on overflow (no silent slice), explicit
  `untilMarker`-bounded region (T4, §3).
- **MED TOCTOU-I6-NOREFP-1** → the I6 post-click re-open recomputes the fingerprint and requires
  equality to consent (T12, §2 step 6).
- **MED AUTHORITY-2** → "structural" re-attributed to the OOB ceremony; the keypair "blocks
  out-of-process spawns"; regression test extended to "no `kind:'approve'` enqueue" (§5, §9).
- **LOW PRESENCE-4** → attacker-timed habituation/prompt-fatigue added to §10.
- **LOW FP-SUMMARY-2-RECHECK** → re-verified closed; confirm at implementation (summary collapsed/advisory,
  operator-entered amount bound into the fingerprint).

## 12. MANDATORY prerequisite before any implementation
Capture the target app's REAL approve UI on a **disposable staged document** and record, per recipe:
is 문서번호 unique on the detail page and outside the body? is there a native confirm dialog / required
comment / re-auth at approve time? what is the exact positive completion marker and is it per-doc? does
the 승인 affordance disappear after approval? Additionally for v3/v4: can the Windows native helper display
the doc binding (doc_id/title/amount-or-no-amount/fingerprint/body digest/action) **and the consented
body region itself** (PRESENCE-3 — not only the scalars; if it cannot, the high-value flow fails closed)
outside same-origin page JS and require explicit per-item approve + OS credential/Windows Hello? if WebAuthn is considered,
does the authenticator/OS provide a trusted transaction display (not merely UV)? is deterministic 금액
present, or does amount live only in body text? what exact body start/end bounds are consented and hashed? is doc_id present in the
detail URL? does click auto-advance or mutate URL unexpectedly? can the post-click re-open be made
server-fresh/cache-busted or cross-checked by pending-inbox departure? is the confirm leg `none|dom|native`,
and if native, is an accept primitive empirically proven? Until these are captured and pinned into
`recipe.approve` + tests, the path stays **fail-closed** and unimplemented.

## 13. Open questions (post-v3)
1. Native trusted approval helper shape for Windows first: exact doc-binding display fields, OS
   credential/Windows Hello API, and how its signed result reaches the signer.
2. `actor` identity beyond the OS user — is there a configured operator id to record and bind into OOB
   assertions?
3. High-value policy when no deterministic amount field exists: fail closed always, or require a
   §12-pinned operator-entered deterministic amount check plus body-digest consent?

## 14. Built path (2026-06-07 owner override) — what actually ships vs. this design

The owner released the per-item-human gate (banner; memory `approve-gate-override`). The shipped path is
**full auto-approve via a Playwright trusted-click leaf**, NOT this OOB-ceremony design. The mapping:

| This design (human-gated) | What SHIPS (full-auto) |
|---|---|
| I1 per-item human content-consent (OOB trusted display) | **REMOVED by the owner.** Replaced by deterministic content binding: live 문서번호 (unique cell, all pages) + idLabel + **title bound to the synced DB** + label-anchored **amount ceiling** + **form-type** match/homogeneity. No human, no OOB helper, no consent signer, no nonce/challenge. |
| I2 no batch / one ceremony per item | **Bounded batch** instead: a positive `--max` clicks cap (counts the irreversible click), dry-run default, value ceiling, kill-switch. |
| I3 model has zero authority | **Kept (structural).** `/api/agent` returns candidates only; the leaf is a separate deterministic route; the model is never on the click path. |
| I4 click-time re-verify (identity + content fingerprint) | **Kept in spirit, not the fingerprint:** unique-cell open → urlGlob → exactly-one idLabel → title binding → amount ceiling → decision radio asserted-checked. (No cryptographic content fingerprint.) |
| I5 append-only crash-tolerant audit | **Kept:** fsync'd JSONL `data/approve-audit.jsonl` + startup crash reconciliation of `clicked`-without-terminal. |
| I6 positive commit verification | **Kept + strengthened:** a NEW today-dated 승인 stamp on the doc's own 결재선 line AND 대기 departure (either alone ⇒ fail-closed). |
| I7 no shared host | **Kept** + a present-Origin/Referer + session-cookie gate on the route; unattended LIVE schedule **forbidden** (`bin/scheduled-task.sh` refuses `--live`). |

The full-auto safety rests ENTIRELY on these deterministic guards (each fail-closed), red-teamed across
four rounds in `REDTEAM-AUTO-APPROVE.md`. Residual conditions before **unattended-at-scale** live use: a
live end-to-end approval verification, a **Gate B amount-cell capture** (so the ceiling is exact, not
heuristic), and agreed auto-approve criteria. Until then: **supervised + bounded** (README *Phase 2 —
auto-approve*). If the owner re-imposes the human gate, revert to the I1–I7 design above.
