# Phase 2 approve — red-team of the Playwright driver design (verdict: REVISE-FIRST)

Adversarial red-team of `DRIVER-PLAYWRIGHT.md` (the proposed native-dialog-capable approve leaf), 5
lenses + adjudicator vs DESIGN v4 + GATE-B-CAPTURE + the real code. Decision rule (hard): safe-to-build
the design ⟺ zero confirmed-real CRITICAL **and** zero confirmed-real HIGH.

## Verdict: REVISE-FIRST — 1 confirmed HIGH (0 critical)
**Tally:** CRITICAL 0 · HIGH 1 · MEDIUM 11 · LOW 7 · refuted 0 (19 submitted; all at least partly real).

## HIGH (gate-blocking)
### PW-TRACE-COOKIE-LEAK-1 — the approve trace republishes the reused Hiworks session cookie through the no-Origin-check `/artifacts/` route
- **Invariant:** I1/I2 (full OOB-ceremony bypass).
- **Attack (in-scope same-origin script, NOT the I7 residual):** §7 turns a Playwright **trace ON per
  context** on a context loaded with `fixtures/auth/<app>.state.json` (**21 real HttpOnly Hiworks
  cookies** = transferable credentials). Playwright traces capture request headers/cookies by default.
  `webui/server.js:213-219` serves `GET /artifacts/*` gated **only by a Host allowlist** with the
  explicit comment *"GET routes serve artifacts/PII and have no Origin check"* (`:470-472` serves any
  file; a `.zip` → octet-stream). A same-origin XSS/extension/bookmarklet `fetch('/artifacts/<run>/trace.zip')`
  lifts the cookie → **Hiworks session takeover → approve arbitrary docs**, bypassing the whole ceremony.
- **New vs today:** only `.webm` (visual PII, no transferable token) reaches the loopback tree today;
  the cookie lives only in `fixtures/auth/` which is **not** served. The trace is the first artifact to
  republish a transferable cross-origin credential into a same-origin-readable location. "artifacts/ is
  gitignored" addresses commits, not the active read → **does not close it.**
- **Required (before build):** do NOT enable network/HAR capture in the approve trace, OR scrub
  `Cookie`/`Set-Cookie`/`Authorization` + storageState; write trace/video to a **non-served, 0600
  evidence dir gated by an unguessable per-run token** (Origin/Sec-Fetch cannot exclude a same-origin
  script); re-run Gate B to confirm exactly what the trace captures before the leaf exists.

## MEDIUM (11 — carry-forward, fix-in-spec or accept)
- **SIMPLER-PATH-1** *(process / KISS·YAGNI·기존구조·확장-전-검토)* — a whole second browser stack was
  adopted **before testing the simpler existing-structure path**: **headed agent-browser + the operator
  manually clicks OK on the one native dialog** (the OOB ceremony already mandates operator presence; the
  only thing 0.27.0 can't do is *accept* one confirm). The definitive `--no-auto-dialog` headed probe was
  deliberately NOT run (GATE-B-CAPTURE), so the cheapest path is **untested, not refuted**. Add it as
  alternative (E) and test it FIRST.
- **BLOCKER-ASSUMED-1** — "post-`확인` = native `confirm()`" is an **unconfirmed inference** (GATE-B
  "most likely"); if it is actually a DOM/iframe modal / custom overlay / sync XHR, `page.on('dialog')`
  fires never and Playwright buys nothing. The dependency is justified by an untested hypothesis → make
  the FIRST gating step a minimal headed capture that **positively identifies** the post-`확인` mechanism.
- **DUALSTACK-CANON-1 / DUAL-FP-PARITY-1 / DUALSTACK-FP-PREIMAGE-1** *(same gap, 3 lenses)* — v4 got
  fingerprint byte-parity for free (prepare + re-verify both ran `lib/aria.js`+`extract-detail.js`). The
  driver keeps prepare on agent-browser but moves click-time + I6 re-verify to Playwright (different
  parser): `aria.clean` is trim-only (`lib/aria.js:32-35`) while Playwright collapses internal
  whitespace; `bodyFromHeading` dedup is tied to the agent-browser tree. ⇒ chronic fail-closed (DoS) OR
  pressure to relax I6 back to idLabel+완료 (reopening the v4 hole). Fix: **one stack-independent
  canonicalization** (shared normalizer+hasher, or have the leaf emit agent-browser's exact format),
  gated by a cross-stack known-answer test.
- **DUALSTACK-REF-CONTRADICTS-V4** — `extract-detail.js` (the only reference) still: returns FIRST
  matching rowheader for idLabel + every field (violates exactly-one/AMOUNT-SHADOW-1, `:97-109/:76-82`);
  `bodyFromHeading` has no `untilMarker` and reads start→END folding the volatile 의견/댓글 footer in
  (`:125-142`); `:141` silently `slice(0,8000)` (FP-BODYDIGEST-TRUNC-1). Two independent reimplementations
  of guards the reference gets wrong → harden **ONE shared extractor** and have the leaf call it; fixtures
  asserting ABORT on duplicate-rowheader / over-bound body on **both** stacks.
- **ENV-PROPAGATE-LEAF-1** — `spawn.js:23` spreads full `process.env` (incl. the model-endpoint config)
  into the bash→node→Chromium tree; the new leaf must not become a consent/secret carrier. DESIGN §5
  already forbids env for secrets (file/stdin) so not exploitable, but the DRIVER never restates it and
  `extraEnv` is the obvious wrong place. Fix: consent ONLY via 0600 file in argv; minimal scrubbed child
  env; regression test that the child env holds no consent token / private key.
- **LEAF-CONTAINMENT-1** — §2's "give the leaf its own `package.json`, mirroring `webui/`" is unsound:
  `webui/` is clean ESM, but `bin/` is **CJS** (`extract-detail.js` etc. `require`/`module.exports`). A
  `bin/package.json` (esp. `type:module`) reparses the CJS `bin/*.js` as ESM and breaks them (the
  CLAUDE.md hoist footgun). Fix: put the leaf in its **own directory** (e.g. `approve/` at repo root)
  with its own `package.json`+`node_modules`; explicitly forbid a `bin/package.json`.
- **AUTH-DUP-2STACK-1** — `fixtures/auth/hiworks.state.json` has top keys `[cookies,origins]` (looks
  storageState-compatible → an implementer assumes yes), but the 21 cookies are **CDP-shaped**
  (`sameSite` ABSENT, extra `size`/`session`), which Playwright `storageState` rejects/mis-imports →
  auth failure or a subtly-different approve session. Fix: assume non-compat — Playwright-native capture
  (`setup/auth-pw.mjs`) or a validated converter (inject sameSite, strip CDP-only fields), one
  refresh/expiry policy, fail-loud on stale.
- **NATIVE-PATTERN-LOOSE-1** — `nativePattern "결재|승인"` is an unanchored match on the most common word
  on a 결재 page; a wrong-action confirm (delete/reject) could match. Capped at medium (type==='confirm'
  + I6 re-open block a false SUCCESS). Fix: pin the exact Gate-B-captured message, anchored `^…$`, refuse
  a placeholder/loose pattern at build, record `d.message()` into the audit for exact-equal comparison.
- **NATIVE-DIALOG-NOBIND-1** — the accepted native confirm binds no doc/fingerprint; a stored-XSS/
  same-origin script inside the leaf's authenticated context could swap the target doc between verify and
  click (step-7 only blocks a false-SUCCESS *report*). Bounded (needs in-leaf script execution). Fix:
  clean profile / no extensions / fresh context per item; document "no in-leaf script" as load-bearing;
  if the confirm echoes doc_id, pin `nativePattern` to it.

## LOW (7 — carry-forward)
- **ONESHOT-EARLIER-DIALOG-1** — `page.once` is consumed by the FIRST dialog; an earlier beforeunload/
  validation dialog steals the slot → real confirm auto-dismissed → fail-closed denial. Fix: persistent
  `page.on('dialog')` for the whole approve window; accept exactly one matching confirm, dismiss all
  else, count dialogs, abort unless exactly one matching + zero unexpected.
- **DIALOG-FLAG-RACE-1** — reading `dlg.*` after `click()` assumes handler-ran-first → fail-closed
  flakiness. Fix: `const [d]=await Promise.all([page.waitForEvent('dialog'), btn.click()])` + validate inside.
- **DUALSTACK-PREIMAGE-UNSPEC** — the fingerprint preimage (encoding, length-prefix width/endianness,
  separators, null-amount sentinel) is unspecified → two encoders diverge (fail-closed). Fix: pin UTF-8 +
  explicit length-prefix + fixed null sentinel + sha256 hex; ship one encoder + a committed KAT vector.
- **KILLPATH-PW-VIDEO-1** — §7 overstates "resolves" the wedged-daemon video residual: `killTree` →
  `taskkill /T /F` still skips `tracing.stop`/`context.close` on hard kill. It removes the *shared-daemon
  coupling* (real) but the hard-kill residual stands (accepted I5). Fix: soften §7 wording; keep
  audit/status as I5 source of truth; optional bounded graceful stop before killTree.
- **TRACE-GITIGNORE-COMMIT-1** — `.gitignore` covers `artifacts/`/`*.webm`/`*.har`/`*.state.json` but not
  `*.zip`; primary disclosure is the loopback read (the HIGH). Fix: pin trace path under the non-served
  evidence dir; add `*.zip` belt-and-suspenders; build-time assert the leaf refuses to write evidence
  outside the designated dir.
- **STORAGESTATE-IDENTITY-1** — nothing binds the reused web identity to the OOB actor (audit
  misattribution; §13-Q2 already open). Fix: read the live Hiworks identity at approve time, bind into
  audit, require the fixture be the operator's own account.
- **PW-SUPPLYCHAIN-1** — Playwright (large tree + `npx playwright install chromium` network fetch) on the
  one irreversible-action leaf of a zero-dep project. Incremental (agent-browser already wraps Chromium).
  Fix: pin exact version + committed lockfile in the leaf dir, pin browser download checksum/mirror; weigh
  against SIMPLER-PATH-1 (the headed manual-accept path needs no new dep).

## DRIVER v1 → v2 changelog seed
1. **[HIGH] PW-TRACE-COOKIE-LEAK-1** — no network/HAR trace or scrub cookies/storageState; evidence to a
   non-served token-gated 0600 dir; note the `server.js` /artifacts no-Origin-check gap. *(gate-blocking)*
2. **[MED] BLOCKER-ASSUMED-1 + SIMPLER-PATH-1** — reframe: FIRST positively identify the post-`확인`
   mechanism (headed), and add **(E) headed agent-browser + operator manually accepts the one native
   dialog**; only adopt Playwright if (E) is insufficient AND the step is confirmed native.
3. **[MED] dual-stack fingerprint (CANON/PREIMAGE/PARITY/REF)** — one shared byte-pinned canonicalization
   + KAT; harden ONE shared extractor (exactly-one, untilMarker, fail-closed-on-overflow) used by both.
4. **[MED] LEAF-CONTAINMENT-1** — leaf in its own dir (`approve/`), never `bin/package.json`.
5. **[MED] AUTH-DUP-2STACK-1** — Playwright-native auth capture / validated converter; one expiry policy.
6. **[MED] ENV-PROPAGATE-LEAF-1, NATIVE-PATTERN-LOOSE-1, NATIVE-DIALOG-NOBIND-1** — per-finding fixes.
7. **[LOW ×7]** — apply the per-finding fixes above.

_Workflow: driver red-team, 5 lenses + adjudicator (6 agents); no code implementation. Verdict
REVISE-FIRST on the single confirmed HIGH (PW-TRACE-COOKIE-LEAK-1)._
