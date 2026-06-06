# Phase 2 approve — re-red-team of DESIGN v3 (verdict: SAFE-TO-IMPLEMENT DESIGN; GATE B STILL REQUIRED)

This is the durable record of the third red-team pass over `DESIGN.md` v3. The review focused on the
v2 blocker (`PRESENCE-1`) plus the v2 carry-forward medium/low issues. No approval implementation was
written or authorized by this review.

## Verdict

**Gate A: PASS — safe-to-implement design.**

Confirmed-real tally for Gate A blocking severity: **CRITICAL 0, HIGH 0**.

Implementation remains **FORBIDDEN** until **Gate B** is complete: the target app's real approve UI must
be captured on a disposable staged document and pinned into `recipe.approve` + tests per DESIGN §12.
Until Gate B passes, the approve path remains fail-closed and unimplemented.

## What v3 closes

- **PRESENCE-1 / content-consent:** closed. `echoedDocNo` is typo-only, not a security factor. Consent
  signing now requires mandatory per-item OOB **trusted content approval**, not a generic user-verification
  prompt. The v3 baseline is a Windows native helper that displays doc binding
  (doc id, title, deterministic amount or no-amount, fingerprint/body digest, action) and requires an
  explicit approve gesture plus OS credential/Windows Hello. Plain WebAuthn UV without trusted
  transaction display is explicitly insufficient.
- **Authority boundary:** closed for design. `/api/agent` remains read/candidate-only and must not import
  or call prepare/approve/OOB/sign/enqueue. The signer/native approval boundary is separate from the
  NL/read router, uses asymmetric signing, and gives the bash leaf only public verification material.
- **Requested/OOB cancel orphaning:** closed for design. OOB cancel/fail/timeout happens before nonce
  consume/status mutation/enqueue, releases the approve reserve, and leaves `approvals.status='fetched'`
  with an `abandoned`/`failed` audit or expired request.
- **Approve queue ordering:** closed for design. The approve slot is checked/reserved before OOB,
  nonce consume, status claim, signer call, or enqueue; failed enqueue rolls back/releases the reserve.
- **Kill-path/video overclaim:** closed for design. Durable audit/status is the source of truth; video is
  best-effort on wedged-daemon/hard-kill paths.

## Carry-forward non-blocking items

- **Trusted display implementation detail:** §12 must prove the native helper is available and displays
  doc binding outside same-origin page JavaScript before any staged click.
- **TOCTOU residual:** full fingerprint re-verify is host-side; the final batch is an identity/visibility
  guard. §12 must capture auto-advance/URL mutation behavior, and implementation must keep the I6
  server-fresh re-open/inbox-departure check.
- **Extractor hardening:** approve must not reuse the current detail extractor unchanged; implementation
  needs exactly-one metadata idLabel, title equality, explicit body bounds, and full-body/no-truncation
  fail-closed behavior.
- **Modal/CSP:** implementation must reject string-valued `on*` props, use text-only rendering, and emit
  strict no-inline CSP before approve routes are exposed.
- **Origin gate:** `routes-approve` must own the stricter present Origin/Referer gate; the generic server
  POST guard that allows absent Origin is not sufficient for approval endpoints.

## Gate B remains mandatory

Capture the real approve UI on a disposable staged document and pin:

- doc_id uniqueness and metadata/body boundary;
- title and deterministic amount availability, or no-amount fail-closed policy;
- native helper transaction display and OS credential/Windows Hello behavior;
- confirm kind (`none|dom|native`) and any accept primitive;
- positive per-doc completion marker and server-fresh/inbox-departure proof;
- approve affordance disappearance or idempotent no-op behavior;
- URL auto-advance/mutation behavior across the click.

Only after Gate A **and** Gate B pass may implementation begin. Tests must still use staged/disposable
docs only; never a real financial approval.

_Workflow: v3 red-team, 3 parallel lenses + 1 focused retry; no code implementation._
