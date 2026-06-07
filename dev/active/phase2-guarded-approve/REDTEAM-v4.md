# Phase 2 approve — independent re-red-team of DESIGN v3 (verdict: SAFE-TO-IMPLEMENT; GATE B STILL REQUIRED)

Fourth pass, and the first **independent** re-verification of the `REDTEAM-v3.md` Gate-A PASS: 6
adversarial lenses (presence/OOB-consent · model/authority boundary · informed-consent/fingerprint/amount/TOCTOU
· success-gate/audit/reconciliation · CSRF/Origin/nonce/kill-path/video · implementability vs
agent-browser 0.27.0) re-read **DESIGN.md v3 + the real code** and tried to confirm a critical/high
against every invariant. An adjudicator then classified each claim confirmed-real vs refuted, adjusted
severity against the accepted §10/I7 residual (local code-exec as the OS user is OUT of scope), and
applied the hard gate rule. No approval code was written or authorized.

## Verdict: SAFE-TO-IMPLEMENT (design-level) — independently confirms REDTEAM-v3

Decision rule (hard): safe-to-implement ⟺ **zero confirmed-real CRITICAL and zero confirmed-real HIGH**.

**Confirmed-real tally:** CRITICAL 0 · HIGH 0 · MEDIUM 10 · LOW 2 · refuted 0 (12 submitted, all
confirmed-real but none above medium).

PRESENCE-1 (consent minted with no human / blind generic prompt — the v2 gate-blocker) stays **closed**:
v3's mandatory per-item OOB trusted-content ceremony before nonce consume / status claim / sign /
enqueue is sound, and the design correctly attributes real authority to it. Every item tops out at
medium — design-precision corrections, spec-completeness gaps on a fail-closed/unimplemented path, one
safe-direction internal contradiction, and implementation reminders the design already prescribes.

> **GATE A: PASS (independently re-confirmed).** Implementation remains **FORBIDDEN** until **Gate B**
> (§12 staged capture on a disposable doc) is complete AND the spec-level mediums below are folded into
> the design (→ DESIGN v4). Until then: **fail closed.**

## Confirmed-real findings (all medium/low — carry-forward, fix-in-spec or explicitly accept)

| id | sev | invariant | finding | doesV3Close | fix |
|----|-----|-----------|---------|-------------|-----|
| **PRESENCE-3** | MED | I1, T4, T5 | **Strongest item.** The trusted display shows identity scalars (doc_id/title/amount-or-"no amount"/digest) but **not the BODY**; the operator reviews the body on the script-mutable page-JS modal. For amount-less apps the load-bearing figure lives only in the body (`recipes/hiworks.json`, `extract-detail` body blob), so a same-origin extension/bookmarklet (NOT the I7 OS-code-exec residual) can rewrite the modal body to benign content while the TRUE body binds into the fingerprint and re-verifies consistently → a faithfully-"approved" doc was never accurately reviewed. Overstates I1 against the very class the display defeats. | no (for body) | Render the **consented body region INSIDE the native helper**, or **fail closed for high value**; stop claiming `body_digest` closes body informed-consent. Resolve the circularity (the "high-value" fail-closed trigger itself depends on the spoofable body). Prove at Gate B. |
| **RECON-SWEEP-1** | MED | I5 | **Internal contradiction.** §4 L163 lists `confirmed` as a terminal SUCCESS stage; §4 L175-176 blanket-sweeps `approving + terminal audit → approve_failed` with no `confirmed` exception; §2 step 7 says reconciliation handles "non-terminal crash gap only". Under the optional fsync'd append-log variant, `approving+confirmed` is reachable across a crash → flips a verifiably-approved doc to `approve_failed` (an I5 audit↔status divergence). Safe direction (never double-approve), but a real contradiction the implementer must resolve first. | partial | **Outcome-aware sweep:** `approving+confirmed→approved`; `approving+failure-terminal→approve_failed`; `approving+non-terminal→re-open & positively verify`. Reconcile §2 with §4; add forced-state reconciliation unit tests. |
| **AMOUNT-SHADOW-1** | MED | I4, T2, T4 | Deterministic `amount` is extracted by first-match `labelValue` with **no exactly-one / metadata-region guard** (`extract-detail.js:97-109`), unlike the hardened `idLabel` (`:76-82`). v3 elevates `amount` to THE trusted money signal, yet a drafter rendering a duplicate `금액` rowheader first spoofs the trusted amount panel; the same wrong value binds into the fingerprint and re-verifies consistently (no code-exec). (Inactive on Hiworks — no amount field.) | partial | Apply **T2 discipline (exactly-one + metadata-region, abort 0/≥2) to `amount` and EVERY fingerprint-bound field**; add the §9 duplicate-amount-aborts test. |
| **FP-BODYDIGEST-TRUNC-1** | MED | I4, T4 | `body_digest` silently truncates at `MAX_BODY=8000` (`extract-detail.js:28,141`) over a first-heading→END span (`:125-128`). For amount-less Hiworks the digest is the only binding on the money figure; >8000 chars of padding pushes the real payment line outside both consent and the identically-lossy re-verify; to-END also pulls volatile 결재선/timestamps (flap). | partial (§9 promises it) | Honor §9 literally: **fail closed on overflow (never silent slice)**, honor `untilMarker` to exclude 결재선, hash exactly the bounded region; add the `>MAX_BODY → abort` unit test. |
| **TOCTOU-I6-NOREFP-1** | MED | I4, T12 | T12 names the I6 re-open the "binding authority," but §2 step 6 specifies only `idLabel` + 완료 transition, **not a fingerprint recompute** → a same-doc content mutation across the step3→step4 window is neither caught in-batch (weak guard) nor re-bound post-click. Narrow: the re-extract runs in the bash leaf against the live server page (not the operator's DOM), so the mutation must be server-side mid-flight. | partial | Make the **I6 re-open recompute the fingerprint and require equality** to consent; pin auto-advance disable + get-url delta abort in §12. |
| **AUTHORITY-2** | MED | I3, T11 | "structural, not convention" overstates in-process isolation: in one node process the in-memory keypair isolates only the **out-of-process** bash leaf/stray spawns, not in-process mis-wiring; the genuinely-structural barrier is the OOB OS-credential ceremony (§13-Q1, Gate-B-gated). *(The finding's "/api/agent enqueues approve today" headline is refuted — T11/§9 scope the guard to "enqueue APPROVE"; `routes-rpa.js` only enqueues sync/summarize and `agent.js` imports no signer/approve fn, so the regression guard is accurate and assertable.)* | partial | Re-word §5/I3/§11: keypair "blocks out-of-process spawns"; attribute **structural** authority to the OOB ceremony. Keep the "/api/agent reaches no approve-enqueue/sign" regression test. |
| **ORIGIN-FALLTHROUGH-T8** | MED | T8 | Current-code: `server.js:227 if(origin){…}` host-checks only inside the block → absent-Origin POSTs fall through. Approve routes inherit it unless `routes-approve` adds its own gate. | **yes** (design overrides) | Implement the design's present, host-matching Origin/Referer gate (403 on absence) in `routes-approve` before any nonce work; add the §9 Origin-absent→403 test. |
| **KILLPATH-AUDIT-T9** | MED | I5, T9 | Current-code: `killTree` = SIGKILL/`taskkill /F` → the bash EXIT trap can't run; no server-side audit on a hard kill. | **yes** (design overrides) | Implement the design's server-side durable `interrupted`+`approve_failed` write BEFORE reaping + pre-click `clicked` hard-gate audit + startup reconciliation (`node:sqlite` is synchronous → implementable). |
| **SHUTDOWN-EXIT-1** | MED | I5 | Current-code: `server.js:499-505` reaps then `process.exit(0)` with no awaited cleanup/audit; only SIGINT/SIGTERM registered. | **yes** (design overrides) | Implement §6's bounded approve cleanup + synchronous audit on catchable SIGINT/SIGTERM/SIGHUP/console-control; uncatchable kills → pre-click audit + reconciliation. |
| **RECORDSTOP-WEDGED-T9** | MED | I5, T9 | `record stop`/`reapDaemon` route through the single shared daemon; a wedged daemon loses approve **video** (≡ v2 WATCHDOG-WEDGED-1). | partial (explicitly accepted) | Audit/status is source of truth; video best-effort. Implementation must either prove a dedicated recording daemon/direct-ffmpeg path (Gate-B open) or document+test approve video as best-effort while audit/status stay durable. |
| **PRESENCE-4** | LOW | I1 | Human-factors residual: a same-origin script can't complete the ceremony but can **choose doc_id and time `/api/approve` to race a legitimate approval**, exploiting reflexive/habituated authentication. §10 lists "adversarial-but-truthful documents" but not attacker-timed habituation. | n/a | Add to §10. Mitigate: surface action context + in-flight approvals in the helper; rate-limit. |
| **FP-SUMMARY-2-RECHECK** | LOW | T4, I1 | Re-verified the v2 carry-forward FP-SUMMARY-2 is **closed at design level**: summary is UNTRUSTED/advisory/collapsed, raw body primary, fail-closed (or operator-entered amount) for high-value amount-less flows. | **yes** | Implementation must render the summary collapsed/advisory and bind any operator-entered amount into the fingerprint. |

## v3 → v4 changelog seed (fold into DESIGN before any implementation)

1. **[MED] PRESENCE-3** *(most important)* — trusted display delivers content-consent only for the
   displayed scalars; for apps whose load-bearing figure is in the body, render the consented body
   region INSIDE the native helper or fail closed for high value; drop the claim that `body_digest`
   closes body informed-consent; resolve the amount-less circularity.
2. **[MED] RECON-SWEEP-1** — outcome-aware reconciliation sweep (`approving+confirmed→approved`);
   reconcile §2 vs §4.
3. **[MED] AMOUNT-SHADOW-1** — T2 exactly-one+metadata-region discipline for `amount` and every
   fingerprint-bound field; duplicate-amount-aborts test.
4. **[MED] FP-BODYDIGEST-TRUNC-1** — fail closed on body overflow (no silent slice); honor
   `untilMarker`; hash exactly the bounded region; `>MAX_BODY` abort test.
5. **[MED] TOCTOU-I6-NOREFP-1** — I6 re-open recomputes + requires the fingerprint; auto-advance
   disable + get-url delta abort in §12.
6. **[MED] AUTHORITY-2** — re-word "structural" (keypair blocks out-of-process spawns; structural
   authority = the OOB ceremony); keep the no-approve-enqueue/sign regression test.
7. **[MED ×4 implementation-prescribed]** ORIGIN-FALLTHROUGH-T8, KILLPATH-AUDIT-T9, SHUTDOWN-EXIT-1,
   RECORDSTOP-WEDGED-T9 — the design already covers these (doesV3Close=yes / explicitly accepted);
   they are implementation TODOs + §9 tests, not spec changes.
8. **[LOW ×2]** PRESENCE-4 (add attacker-timed habituation to §10), FP-SUMMARY-2-RECHECK (confirm at
   implementation).

## Gate B remains mandatory (unchanged)
Capture the real approve UI on a disposable staged doc and pin: doc_id uniqueness + metadata/body
boundary; title + deterministic amount availability (or no-amount fail-closed policy); **whether the
native helper can display the consented BODY region (PRESENCE-3), not only scalars**; native confirm
kind + accept primitive; positive per-doc completion marker + server-fresh/inbox-departure proof;
affordance disappearance / idempotent no-op; URL auto-advance/mutation across the click. Tests use
disposable docs only — never a real financial approval.

_Workflow: independent v4 re-red-team — 6 lenses + adjudicator (7 agents); no code implementation.
Confirms REDTEAM-v3's Gate A PASS and supplies the v3→v4 design changelog._
