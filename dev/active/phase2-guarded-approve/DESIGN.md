# Phase 2 — Guarded Approval Execution (design v2)

**Status:** DESIGN ONLY (no code). v2 supersedes v1 after an adversarial red-team broke all six v1
invariants (3 critical + 9 high). v2 closes those; §11 is the v1→v2 changelog. Approval is an
*effectful, irreversible* action (real 결재 가 승인됨) — implementation stays gated on (a) a second
red-team of THIS doc and (b) the mandatory empirical capture in §12.

> **GATE A — second re-red-team DONE → verdict REVISE-FIRST (see `REDTEAM-v2.md`).** 28 claims triaged →
> 13 confirmed-real: **0 critical, 1 HIGH (PRESENCE-1), 4 medium, 8 low**; 15 refuted. v2 held well
> (CRIT-2/CRIT-3 closed, browser-CSRF blocked, positive-commit verify robust), but the **sole blocker
> PRESENCE-1** is gate-blocking: the `echoedDocNo` "human-presence" factor is **vacuous** — on the 결재
> path 문서번호 == doc_id, which is already in the `/api/approve` body and returned to every same-origin
> caller (`queryApprovals SELECT *`), so it carries zero presence entropy and a same-origin script can
> self-approve. **Implementation stays FORBIDDEN** until **DESIGN v3** closes PRESENCE-1 (a real OOB
> human-only factor, e.g. OS-credential/WebAuthn per item — OR an honest restatement that approve is
> serialized-not-software-gated and rests on the operator's manual click + I7) AND a **third re-red-team**
> returns safe-to-implement AND §12 staged capture is done. The 4 mediums + 8 lows are the v3 changelog
> seed (`REDTEAM-v2.md` final section). Until then: **fail-closed.**

> **HARD PREREQUISITE:** the approve path MUST NOT be implemented until the target app's real approve
> UI is captured on a *disposable staged document* (§12). Every guard below depends on empirically
> verified facts (is 문서번호 unique on the detail page? does the 승인 affordance disappear after
> approval? is there a native confirm dialog? a required comment?). Until captured: **fail closed.**

## 0. Non-negotiable invariants

1. **I1 Per-item explicit human approval of THIS document's CURRENT content.** Not "approved a
   doc_id" — the human must approve the *content they actually saw*, and that content must be the
   *live* document, re-proven unchanged at click time (§I-CONSENT).
2. **I2 No batch / mass approve.** At most one approve in flight per server-anchored session; no
   endpoint, queue path, or nonce scheme can approve >1 doc per human action.
3. **I3 The model has ZERO authority — structurally, not by convention.** No model output is on the
   path to a click, AND the effectful leaf refuses to act without cryptographic proof a human
   consumed a doc-bound nonce (§5), so a future mis-wiring cannot yield a model/script-driven approve.
4. **I4 Deterministic click-time re-verification (identity + content fingerprint).** The live page's
   문서번호 must equal the confirmed doc_id (exactly-one, metadata-region) AND the title AND a
   content fingerprint of exactly-what-the-human-saw must match, else ABORT before any click.
5. **I5 Genuinely append-only, crash-tolerant audit + video for every attempt**, with a durable
   terminal record written even on a SIGKILL kill path, and audit↔status that cannot diverge.
6. **I6 Positive commit verification.** Success requires `.success==true` AND a POSITIVE per-doc
   state transition (this doc now shows 완료 on its own decision line) — never a negative/navigational
   signal. A login redirect or any unexpected URL ⇒ ABORT/uncertain, never success.
7. **I7 No shared host.** The loopback endpoint is reachable by any same-OS process; this design is
   only safe on a single-user, operator-controlled host. Stated, documented, enforced operationally.

If any invariant cannot hold for a given app/recipe → the path **refuses** (fail loud), never degrades.

## 1. Threat model → guard (post-red-team)

| # | Threat | Guard (v2) |
|---|--------|-----------|
| T1 | Approve a DIFFERENT doc than confirmed (wrong-row click, redirect, doc_id substring) | Open by a UNIQUE locator (list row 문서번호 cell `count==1 --exact`, or a doc_id-embedding detail URL whose urlGlob contains doc_id); abort on 0/≥2. NEVER `find text "$doc" click` (substring/first-match). |
| T2 | idLabel re-verify matches the wrong/ spoofed element | Reused guard asserts **exactly one** rowheader == idLabel, **confined to the metadata region** (lines before the body heading); a 문서 번호 rowheader inside the body subtree → abort. |
| T3 | Recycled/non-unique 문서번호 passes (title leg only claimed, not coded) | Implement explicit normalized **title-equality** vs the confirmed title in approve-doc.sh (abort on mismatch/empty); 문서번호 remains the load-bearing identity, hardened per T2. |
| T4 | **Informed-consent decoupling** — human saw STALE cached content; re-verify checks identity only; amount only in a poisonable LLM summary | prepare opens the **LIVE** page; the human reviews deterministically-extracted fields + raw body; the nonce is bound to a **content fingerprint** (hash of 문서번호+제목+deterministic amount+body digest); at click time re-extract the same fields from the live page and abort unless the hash matches. LLM summary is labelled advisory, never the sole monetary signal. |
| T5 | **Nonce = CSRF token, not human presence** — a local/same-origin caller self-mints+consumes nonces in a loop → batch-approve | Add a **server-verifiable human-presence factor**: prepare renders the live 문서번호; /api/approve must echo a value the human had to **read/type from that rendered page**. Plus: ≤1 outstanding (issued-unconsumed) nonce per session; refuse to enqueue an approve while any approve is queued/running. Documented: local code-exec as the OS user defeats this class (I7). |
| T6 | **False success** — `.success==true` (exit-0-on-failure) or a navigational signal recorded as approved | I6: drop absentText/URL-change disjuncts; after a deterministic settle gate, POSITIVELY re-open the doc and assert its own 완료 transition (marker absent-before / present-after on the approver's line). Ambiguous ⇒ failed. |
| T7 | Double-approve via the 'fetched' window / no reconciliation | Atomically claim `status 'fetched'→'approving'` in the SAME transaction as nonce consume; prepare+approve refuse unless strictly 'fetched'; any non-terminal/ambiguous audit row HARD-BLOCKS the doc; forward-only reconciliation on startup and at each approve-job head. |
| T8 | CSRF via absent Origin (server's generic `if(origin)` lets absence through) | routes-approve requires a **present** Origin/Referer whose host is exactly 127.0.0.1:PORT / localhost:PORT BEFORE any nonce work, else 403 — never fall through on absence. (Anti-browser-CSRF: necessary, not sufficient — paired with T5.) |
| T9 | Kill path (watchdog/cancel/shutdown) loses audit + video for the highest-stakes attempt | Persist the job's session id; on any approve kill path issue an explicit bounded `agent-browser --session <S> record stop` and write a durable `interrupted` terminal audit BEFORE reaping; capture detail_after synchronously right after the click; bounded grace on server shutdown for an in-flight approve. |
| T10 | Replay / nonce leak | crypto.randomBytes(32), constant-time compare, single-use (atomic delete-before-await), TTL sweep, outstanding cap; persist only the **sha256** of the nonce in audit; never log it / put it in job labels, child argv, or SSE. |
| T11 | Model shapes the candidate set (omits/surfaces a doc) | Approve candidates come from a **deterministic** operator-driven query / the full 미결 list; any NL-narrowed view is labelled "AI가 좁힌 후보" and the unfiltered list is always offered. |
| T12 | TOCTOU verify→click + native confirm leg unmatchable | Re-assert identity in the SAME batch as the click (no intervening round-trip); disable auto-advance; explicitly configure+assert native-dialog acceptance; a declared confirm/comment locator must be `count==1` and its click `.success==true` or ABORT. |
| T13 | Poisoned summary → same-origin DOM injection in the confirm modal | Render ALL document/LLM-derived strings via `textContent`/`util.el()` only (never innerHTML); strict no-inline-script CSP; test that markup renders inert. |

## 2. Flow (v2 — live content, human-presence, content fingerprint, positive verify)

```
[결재 view]  미결 목록(결정론 쿼리)에서 1건 [승인 검토] 클릭
   │
   ▼ POST /api/approve/prepare { doc_id }        (browser job — opens the LIVE doc, read-only)
   • 서버 세션(§5) 확인; doc가 strictly status='fetched'인지; 미해결 감사행 없는지(없으면 거부)
   • 직렬 큐로 LIVE detail open(by unique locator) → idLabel/title 재검증 → 결정론 필드 추출
       (문서번호/제목/금액/본문 digest) + detail_after-style 스냅샷
   • content fingerprint = sha256(문서번호|제목|amount|body_digest) 계산
   • nonce 발급: crypto.randomBytes(32), (sessionId, doc_id, fingerprint)에 바인딩, TTL 5분,
       세션당 미소비 nonce 1개만; sha256(nonce)만 audit에 'requested'로 INSERT
   • 사람에게 LIVE 내용 반환(결정론 필드 + 원문; AI요약은 '참고용' 라벨)
   │
   ▼ [확인 모달]  사람이 LIVE 내용을 읽고 → 화면의 문서번호를 직접 입력(human-presence)
        + (필요 시) 승인 의견 입력 → [이 문서 승인]
   │
   ▼ POST /api/approve { doc_id, nonce, echoedDocNo, comment }
   • Origin/Referer host 일치(없으면 403); nonce 유효·미사용·doc_id·fingerprint 일치;
     echoedDocNo == 렌더된 문서번호(human-presence); doc strictly 'fetched'
   • 같은 트랜잭션에서: nonce 소비(delete-before-await) + status 'fetched'→'approving'
   • 서명된 1회용 consent 토큰(doc_id+fingerprint 바인딩) 발급 → approve 잡 enqueue
       (단, 이 세션의 approve가 queued/running이면 409 거부)
   │
   ▼ [approve 잡]  bin/approve-doc.sh --app A --doc D --consent <signed> --comment-file f
     0. 'clicked' 단계 감사 INSERT를 HARD GATE로 (.success 실패 시 ABORT, 절대 `|| true` 아님)
     1. AB_AUTH open → open D by UNIQUE locator → wait_url(detail urlGlob containing doc_id)
     2. 재검증(I4): exactly-one idLabel(metadata region)==doc_id + title 일치
        + 결정론 필드 재추출 → fingerprint == consent의 fingerprint (불일치 ABORT)
        + 이미 완료 상태면 idempotent no-op ABORT
        + 승인 버튼 count==1 --exact
     3. (옵션) 의견 입력; 동일 배치에서 identity 재확인 직후 "승인" 클릭; 확인 다이얼로그 count==1 + .success
     4. settle 게이트: wait_url + in-batch wait --text(긍정 완료 마커)  (URL변경을 증거로 쓰지 않음)
     5. 성공검증(I6): doc_id로 재오픈 → idLabel 재확인 → 이 문서가 자기 결재선에 완료 마커
        '전엔 없음 / 후엔 있음' 전이 확인. 로그인 리다이렉트/예상외 URL ⇒ ABORT(uncertain)
     6. detail_after 동기 캡처; 'confirmed' 감사 INSERT + status='approved'를 **하나의 트랜잭션**;
        실패/모호 → 'failed'/'interrupted' (status는 'approving'으로 두고 재조정이 해소)
   │
   ▼ [UI] 결과 + 영상 링크
```

## 3. Recipe `approve` block (v2)

```json
"approve": {
  "openBy": { "by": "cell", "field": "doc_id", "exact": true },   // unique row-open; OR a urlTemplate
  "urlTemplate": "https://…/document/view/{doc_id}",              // preferred: doc_id in the URL
  "ready":   { "text": "결재 정보" },
  "amount":  { "label": "금액" },                                  // DETERMINISTIC amount extraction (no LLM)
  "comment": { "label": "의견", "required": false },
  "button":  { "by": "role", "role": "button", "name": "승인", "exact": true },
  "confirm": { "by": "role", "role": "button", "name": "확인", "exact": true, "nativeDialog": false },
  "success": { "completeMarker": "결재완료", "scope": "self-line" } // POSITIVE, per-doc transition only
}
```
- All click targets: semantic, `--exact`, asserted `count==1` at click time. No `@ref`, no substring.
- `success` is positive-only (a completeMarker transition on this doc's line). The v1 `absentText`/URL
  disjuncts are **removed** (T6). `amount` is mandatory for any high-value flow (T4).

## 4. Data model (v2)

**Genuinely append-only** `approval_audit` — one immutable INSERT per stage (never UPDATE-in-place):
```sql
CREATE TABLE IF NOT EXISTS approval_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app TEXT NOT NULL, doc_id TEXT NOT NULL, session TEXT, actor TEXT,
  nonce_hash TEXT NOT NULL,        -- sha256(nonce); the live token is NEVER stored/logged
  fingerprint TEXT,                -- sha256 of the exact content the human confirmed
  stage TEXT NOT NULL,             -- requested | clicked | confirmed | failed | interrupted
  detail TEXT,                     -- stage snapshot (before/after as appropriate)
  video_path TEXT, error TEXT, at TEXT NOT NULL
);
```
- Writer connection uses `PRAGMA synchronous=FULL` (the existing store stays NORMAL); or write the
  pre-click record to an fsync'd append log that is the crash-tolerant source of truth, reconciled
  into sqlite on startup.
- `approvals.status` lifecycle: `fetched → approving (claim, same txn as consume) → approved (same txn
  as the 'confirmed' audit) | approve_failed`. A doc in `approving` with only a non-terminal audit is
  re-resolved by the reconciliation pass (re-open by doc_id, positively verify, then confirmed/failed)
  before it can ever be re-offered. `status` is already excluded from the list-resync COALESCE.

## 5. Identity, human-presence, consent token, session, nonce

- **Server-anchored session:** GET `/` mints an `HttpOnly; SameSite=Strict` session cookie (the UI is
  currently sessionless — a client-supplied id is not a session). All per-session limits key on it. If
  a real session is not added, the "session-bound" claim is dropped and the human-presence challenge is
  the sole per-item anchor (stated, not silently relied upon).
- **Human-presence:** /api/approve requires `echoedDocNo` that the human read/typed from the LIVE
  rendered 문서번호 (T5). (Stronger option for high-amount: re-type the amount too.)
- **Nonce:** crypto.randomBytes(32); bound to (session, doc_id, fingerprint); single-use with the Map
  delete as the FIRST synchronous statement after validation (no await between — unit-tested);
  TTL+sweep; ≤1 outstanding per session; only sha256 persisted.
- **Consent token (I3 structural):** on consume, /api/approve issues a single-use, doc_id+fingerprint
  bound, server-signed token; `approve-doc.sh` REFUSES to click without validating it for the exact
  doc — so the NL path, future code, or a stray spawn cannot drive an approve without proof of human
  consumption. The model can neither mint nor present this token.
- **CSRF:** present, host-matching Origin/Referer required before any nonce work (T8).

## 6. Queue / kill-path (v2)

- `kind:'approve'` is gated in the queue: refuse enqueue (409) if any approve for this session is
  queued or running (T2); optionally a dedicated single-depth approve slot.
- Kill path (T9/I5): the job record carries its agent-browser session id; cancel/watchdog/shutdown for
  an approve job runs a bounded `record stop` + writes an `interrupted` audit BEFORE reaping; server
  shutdown gets a bounded grace for an in-flight approve instead of fire-and-forget kill+exit.

## 7. Explicitly OUT (v1)
Batch/"approve all"; LLM-initiated or LLM-gated-candidate approve; 반려/대결; unattended/scheduled
approve; running on a shared/multi-user host.

## 8. Integration points
New: `bin/approve-doc.sh`, `recipes.approve`, `lib/db.js` (append-only audit + nonce/consent helpers +
`synchronous=FULL` writer + the 'approving' claim + reconciliation), `webui/routes-approve.js`
(prepare/approve, session cookie, Origin gate), a confirm-modal (textContent-only) + CSP. Reused +
HARDENED: `extract-detail.js` guard (exactly-one + region + title), `lib/assert.sh` (.success + positive
settle), the serial queue (approve gating + kill-path audit). Unchanged: the model/NL path
(candidates only, now also deterministically sourced).

## 9. Testing (deterministic; the click is staged, never a real approval)
Browser-free units: nonce (randomness, single-use atomic consume, TTL, replay-reject, outstanding cap,
hash-only persistence); human-presence echo mismatch → reject; content-fingerprint mismatch → abort;
the hardened guard (exactly-one idLabel, body-region 문서번호 → abort, title mismatch → abort, doc-open
0/≥2 → abort); append-only audit (per-stage rows, confirmed+status in one txn, crash-stage visible);
reconciliation (approving + non-terminal → resolve before re-offer); Origin-absent → 403; queue
approve-gating (second approve while one pending → 409); modal renders markup inert. Staged integration
on a disposable doc only, with the success/abort/false-success branches exercised by crafted snapshots
offline.

## 10. Residual risks (accepted with controls)
- **Local code-exec as the same OS user always reaches loopback** — irreducible on a no-auth localhost
  design (I7). Controls: threat-model it, forbid shared/multi-user hosts, optional OS credential prompt
  for high-amount.
- **Adversarial-but-truthful documents** can still mislead a human. Controls: always show raw body, AI
  summary advisory-only, typed amount confirmation for high value.
- **agent-browser 0.27.0 quirks** (exit-0-on-failure, native-dialog invisibility, per-app layout) must
  be empirically captured per recipe (§12); fail closed on anything uncaptured.
- **External assumptions** (stable unique 문서번호 on detail; approve affordance hidden/changed after
  approval) must be verified per app and re-verified on app upgrades.
- **WAL durability** is best-effort; an OS crash at the worst instant can desync audit↔reality until
  reconciliation — accept with `synchronous=FULL`/fsync'd log + startup reconciliation.

## 11. v1 → v2 changelog (what the red-team broke → how v2 closes it)
- **CRIT nonce=CSRF-not-presence** → human-presence echo + ≤1 outstanding nonce/session + refuse-enqueue-while-pending + I7 (§5,§6,T5).
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
- **MED** session cookie / atomic consume / hash-only nonce / deterministic candidates / TOCTOU same-batch + native dialog / synchronous=FULL / genuinely append-only — all folded into §4,§5,T11,T12.
- **LOW** crypto nonce + consent-token-in-the-leaf (structural I3) + textContent-only modal + CSP — §5,T13.

## 12. MANDATORY prerequisite before any implementation
Capture the target app's REAL approve UI on a **disposable staged document** and record, per recipe:
is 문서번호 unique on the detail page and outside the body? is there a native confirm dialog / required
comment / re-auth at approve time? what is the exact positive completion marker and is it per-doc? does
the 승인 affordance disappear after approval? Until these are captured and pinned into `recipe.approve`
+ tests, the path stays **fail-closed** and unimplemented.

## 13. Open questions (post-v2)
1. Server session: add the HttpOnly cookie, or rely solely on the human-presence challenge? (affects
   how strong the per-session "≤1 outstanding" limit is.)
2. `actor` identity beyond the OS user — is there a configured operator id to record?
3. High-amount tier: require typed amount confirmation and/or an OS credential prompt above a threshold?
