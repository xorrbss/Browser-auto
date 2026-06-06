# Phase 2 approve — adversarial red-team of DESIGN v1 (verdict: REVISE-FIRST)

6 attack lenses (parallel) read DESIGN.md v1 + the real code and tried to break each safety invariant;
an adjudicator then classified each claimed attack as real vs already-mitigated and produced the
verdict. All six invariant lenses came back **BROKEN**. v2 of DESIGN.md was written to close these (see
DESIGN.md §11 changelog). This file is the durable record.

## Verdict: REVISE-FIRST — implementing v1 as-designed would be unsafe (irreversible financial action)

## CRITICAL (3, independently fatal in v1)
1. **Nonce is a per-doc CSRF token, not a human-presence factor.** A local same-OS process or a
   same-origin script can self-mint+consume nonces in a loop (no human), and server.js's `if(origin)`
   lets absent-Origin through → prepare+approve becomes an unbounded batch-approve machine. (I1/I2/I3-intent)
2. **Informed-consent decoupling.** prepare serves STALE DB-cached content (esp. amount, which is NOT
   deterministically extracted for Hiworks and lives only in the poisonable LLM summary), while
   click-time re-verify binds identity only → the human approves content they never saw.
3. **Post-click success gate accepts negative/navigational signals** (absent '승인 대기' OR '승인 완료'
   present-before OR URL change) that any login/error/list redirect satisfies → records 'approved' for
   a click that never committed. (I6)

## HIGH (9)
- Double-approve via the 'fetched' status window (status flips only at job end) + no reconciliation →
  ambiguous/killed/committed-but-unobserved docs re-offered forever.
- Kill path (SIGKILL: watchdog/cancel/shutdown) skips the bash EXIT trap → loses both the terminal
  audit AND the video for the highest-stakes attempt; reapDaemon never resolves the audit; on shutdown
  reapDaemon never even runs (process.exit before runJob's finally).
- Reused extract-detail idLabel guard is first-match with NO exactly-one check and NO region scoping
  over the attacker-controllable body, AND never compares title — so v1's claimed "문서번호 + 제목"
  re-verify is doc_id-only on a spoofable field.
- Doc-open reuses `find text "$doc" click` (substring, first-match, single-page, no count==1); urlGlob
  '**/document/view/**' is doc-agnostic → only backstop is the (weakened) idLabel guard.
- Origin-absent bypass: server.js generic POST guard runs `if(origin)` (absent proceeds), opposite to
  v1's "absent ⇒ reject"; a delegated routes-approve inherits absent⇒allow.
- Serial queue is an unbounded approve executor (no per-kind cap): N minted nonces → N approve jobs the
  chain walks unattended after the human closes the tab.
- No deterministic settle gate between click and success assertion; v1 even names 'URL 전환' as both
  the wait target and the proof (circular); `wait --url` is broken for globs.
- Audit write not specified as a hard gate on the click: the prevailing `|| true` idiom would let a
  click fire with only a 'requested' row (indistinguishable from an abandoned preview).
- (folded) TOCTOU verify→click + native confirm leg unmatchable by a role-button find.

## MEDIUM (7)
(doc_id, sessionId) binding vacuous (UI is sessionless); nonce consume-atomicity unspecified (await
between validate+delete → concurrent double-pass); live nonce persisted/loggable in cleartext;
model-derived candidate filter shapes the approval set; TOCTOU + native confirm; audit DB durability
NORMAL not FULL; "append-only" is actually UPDATE-in-place + a separate status flip that can diverge.

## LOW (3)
Nonce randomness/TTL/cap left to prose; I3 boundary is convention not structural (leaf trusts caller);
unbuilt confirm-modal could innerHTML a poisoned summary → same-origin DOM-driven approve.

## Strengths that HELD under attack
- Nonce↔doc_id binding + click-time idLabel re-verify genuinely defeat redirecting ONE nonce to a
  DIFFERENT document (the doc-substitution flavor is mitigated; the batch break is minting MANY
  legitimate per-doc nonces, not abusing one).
- LLM has no EXECUTION authority: NL approve returns candidates only, enqueues no job, cannot
  mint/consume a nonce; classifyIntent sends only the command (never bodies), allowlists the action,
  whitelists+clamps the filter, parameterized queries, degrades to clarify.
- Browser-CSRF + DNS-rebinding blocked for browser attackers (Origin host allowlist, CORS, preflight).
- `status` excluded from the SCRAPED_COLS COALESCE upsert → a re-sync can't un-approve a doc;
  summarize.js can only write `summary`.
- shell:false + array args (no shell interpretation); safeResolve refuses path traversal.
- Effectful surface isolated (routes-approve), semantic --exact count==1 on the click target, routes
  through .success (not $?), staged tests, explicitly DESIGN-ONLY pending review — the right posture.

## Irreducible residual risks (carried into DESIGN.md §10)
Local code-exec as the OS user always reaches loopback (no-auth localhost limit); adversarial-but-
truthful docs can mislead; agent-browser exit-0/native-dialog/per-app-layout must be captured per
recipe before guards are trustworthy; stable-unique-문서번호 + affordance-hidden-after-approval are
external assumptions to verify per app; WAL durability is best-effort.

_Workflow: phase2-approve-redteam, 7 agents, ~756k subagent tokens, 146 tool-uses._
