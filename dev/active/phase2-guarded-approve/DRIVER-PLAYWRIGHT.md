# Phase 2 approve — driver design for the native-dialog leg (Playwright approve leaf) — v2

> ⚠ **SHELVED (2026-06-07) — premise likely refuted.** §0.1 was executed (headed operator run, see
> `GATE-B-CAPTURE.md` *Phase 2 HEADED verification*): the post-`확인` step is **NOT a native dialog** — the
> approve completes directly from the DOM modal; the real miss was an **unselected `승인` radio**. So the
> native-dialog-accept rationale for Playwright no longer holds. **Do the cheap agent-browser radio-test
> first** (open → 결재 → select 승인 radio → 의견 → 확인 → verify 승인-stamp + 대기 departure). This whole
> Playwright design stays only as a **contingency** if that test still cannot complete on agent-browser.

**Status: DESIGN ONLY. Implementation forbidden.** v2 supersedes v1 after `REDTEAM-DRIVER.md` returned
**REVISE-FIRST** (1 HIGH `PW-TRACE-COOKIE-LEAK-1` + 11 med + 7 low). The biggest correction (the
red-team grounded it in KISS/YAGNI/기존-구조/확장-전-검토): **do NOT adopt Playwright until two cheaper
prerequisites are met** — see §0. This addends `DESIGN.md` v4; all v4 invariants (I1–I7) still bind.

## 0. Gating order — cheapest first (REVISE: BLOCKER-ASSUMED-1, SIMPLER-PATH-1)
The Playwright stack is justified ONLY by the inference "the post-`확인` step is a native `confirm()`",
which `GATE-B-CAPTURE.md` never positively confirmed (the definitive `--no-auto-dialog` headed probe was
deliberately skipped). So adopt Playwright **only after**:
1. **Positively identify the post-`확인` mechanism (headed, manual).** Open the disposable doc headed,
   click 결재 → 의견 → 확인, and observe what the post-`확인` step actually is — native `confirm()`, a DOM/
   iframe modal, a custom overlay, or a sync XHR. If it is **not** a native dialog, Playwright buys
   nothing and a different fix applies. Capture the exact dialog message too (for `nativePattern`).
2. **Test the simpler existing-structure path first — alternative (E):** *headed agent-browser + the
   operator manually clicks OK on that one native dialog.* The OOB ceremony already mandates per-item
   operator presence, and the ONLY thing agent-browser 0.27.0 cannot do is *accept* one confirm — which a
   present human can do by hand. If (E) completes a staged approval safely, **it is preferred** (no new
   dependency, no second stack, no dual-stack fingerprint problem) and this Playwright design is shelved.

Only if (1) confirms a native dialog **and** (2) shows the headed-manual path is insufficient (e.g. the
operator must not touch the machine, or the dialog can't be reached deterministically) does the Playwright
leaf below become warranted. The rest of this doc specifies that leaf **for that contingency**, with the
REVISE-FIRST fixes folded in.

## 1. Why a different driver (the Gate B blocker)
Gate B (`GATE-B-CAPTURE.md`) proved the Hiworks 결재 finishes with a **native browser `confirm()`** after
the in-page DOM modal's `확인`. **agent-browser 0.27.0 cannot *accept* a native dialog** — its only dialog
control is `--no-auto-dialog` (turns *dismissal* off) and a `confirm <id>` action-gate; there is **no
page-dialog accept primitive**. So the native confirm is auto-dismissed (= Cancel) and the approval never
commits (reproduced 3×). The read/sync/enrich paths never hit this, so **only the effectful approve leg
needs a driver that can accept native dialogs.**

## 2. Driver choice — Playwright (Node), and alternatives considered (확장-전-검토)
- **(E) Headed agent-browser + operator manually accepts the one native dialog — PREFERRED if it works
  (test FIRST, §0).** Zero new dependency, no second stack, no dual-stack fingerprint problem; leans on
  the operator presence the OOB ceremony already requires. Only the single native-confirm OK is manual;
  everything else stays the existing agent-browser path. Untested as of the v1 red-team — prove or refute
  it on a staged doc before anything below.
- **(A) Playwright for the approve leaf only — CONTINGENT (only if §0 (1) confirms native AND (E)
  fails).** Playwright has first-class dialog handling (`page.on('dialog', d => d.accept())`) and is
  **already shipped by this project**: the Docker image is `mcr.microsoft.com/playwright:v1.49.1-jammy`
  (Chromium included). It is the same Chromium-automation class agent-browser wraps, so this is *using the
  engine the project already ships*, not importing a foreign stack.
- (B) Newer/patched agent-browser with a dialog-accept flag — **rejected for now**: not available in the
  pinned 0.27.0; depends on upstream; would still need the same per-item safety wiring. Revisit if
  upstream adds `--accept-dialog`.
- (C) Avoid the native dialog (HTTP/API approve, or a non-dialog UI path) — **rejected**: the Hiworks
  approval API was REFUTED (no list/approve endpoint); the native confirm is the product's real path.
- (D) Drive the OS dialog (AutoHotkey/UIA) — **rejected**: brittle, OS-coupled, racy, unsafe for an
  irreversible action.

**Trade-off + containment (REVISE: LEAF-CONTAINMENT-1, PW-SUPPLYCHAIN-1):** Playwright is a **real new
dependency** and a **second browser stack** for one leaf. The webui stays *zero-dependency*. The dep
lives in the approve leaf's **OWN top-level directory `approve/`** (its own `package.json`+`node_modules`+
committed lockfile) — **NOT** in `bin/`. `bin/*.js` are **CJS** (`require`/`module.exports`); a
`bin/package.json` (esp. `type:module`) would reparse them as ESM and break them (the CLAUDE.md hoist
footgun). `webui/` works only because it is clean ESM; `bin/` is not, so the "mirror webui/" analogy is
unsound. Never add a `bin/package.json`; never hoist Playwright to repo root. Pin Playwright to an exact
version + committed lockfile and the browser download to a verified checksum. On Windows the leaf needs a
one-time `npm i playwright && npx playwright install chromium`.

## 3. Scope & structure (저결합 / 단방향 / 기존 구조 우선)
Unchanged: webui (Node), the OOB trusted-content ceremony, the isolated consent signer, `lib/db.js`
(append-only audit + nonce/claim/reconciliation), and **all read/sync/enrich on agent-browser**. The
model path stays read/candidate-only (I3). The ONLY new browser code is the approve leaf, kept as a
leaf consistent with the existing bash-orchestrates-node split (cf. `extract-detail.js` called by bash):

```
webui/routes-approve.js  (session cookie, present-Origin gate, OOB ceremony, signer)   [DESIGN v4, unchanged]
        │  enqueue kind:'approve' (serial queue)
        ▼
bin/approve-doc.sh        — bash ENTRY: validates the signed consent token + the DB single-use claim,
        │                    writes the pre-click 'clicked' audit as a HARD GATE (lib/db.js), then calls:
        ▼
approve/approve-drive.mjs     — Playwright: ONLY the browser sequence (§4). Returns a STRICT JSON result
                            {opened, idLabelOk, fingerprintOk, dialogAccepted, completed, urlBefore,
                             urlAfter, completionMarker, error}. The bash leaf treats this exactly like
                            the agent-browser `.success` contract: any false/ambiguous field ⇒ ABORT,
                            terminal failed/interrupted audit + status=approve_failed in one txn.
```
`approve-drive.mjs` (in `approve/`, not `bin/`) imports Playwright + (read-only) the recipe; it does
**not** import the signer, the model, or `lib/db.js` writers — it receives the validated consent + recipe
as args/stdin and returns data. Audit/status mutations stay in the bash leaf + `lib/db.js` (one trust
boundary for state). **Env scrub (REVISE: ENV-PROPAGATE-LEAF-1):** `spawn.js:23` spreads the full
`process.env` (incl. model-endpoint config) into the whole child tree. The approve child must run with a
**minimal scrubbed env**; consent passes ONLY as the `0600` file path in argv (never `extraEnv`/env); the
signer keypair stays in-memory in the webui. Regression test: the approve child env holds no consent
token / private key / model credential.

## 4. The approve sequence in `approve-drive.mjs` (maps Gate B facts + v4 invariants)
Inputs (from the bash leaf, after consent validation): `app`, `doc_id`, confirmed `title`, consent
`fingerprint`, recipe `approve` block, a `0600` consent file. Steps:

1. **Context with reused auth** (§6) and tracing/video ON (§7).
2. **Open the doc by a UNIQUE locator** (Gate B: doc_id is NOT in the URL). Use the list row's 문서번호
   cell: `page.getByRole('cell', { name: doc_id, exact: true })` → assert `count() === 1` → click.
   Abort on 0/≥2 (T1). Paginate via the page-number `<select>` if needed (same combobox the enrich/sync
   path proved), never the app's auto-advance.
3. **Re-verify identity + content (I4)** on the live detail: exactly-one metadata 문서 번호 rowheader →
   value `=== doc_id`; normalized `title` equality (T3); re-extract the deterministic fields + the
   recipe-bounded body region and recompute `fingerprint`; **must equal the consent fingerprint** else
   ABORT (T2/T4/AMOUNT-SHADOW-1/FP-BODYDIGEST-TRUNC-1: exactly-one+metadata-region for every bound
   field, fail closed on body overflow). Snapshot `detail_before`. Capture `urlBefore`.
4. **Open the approve modal:** `getByRole('button', { name: '결재', exact: true })` → assert
   `count() === 1` (Gate B verified) → click. Confirm the DOM modal appeared (의견 textbox + 확인/취소).
5. **Required opinion:** fill `의견을 입력하세요.` (Gate B: appears required) with the operator's
   reviewed comment (bound into the audit). Use Playwright `fill` (dispatches real input events).
6. **Arm the one-shot, validated dialog accept (THE crux — §5), then click `확인`** — NEVER
   `확인 후 다음 문서` (Gate B: that auto-advances; T12/IDOPEN-5 forbids auto-advance). Capture `urlAfter`.
7. **Positive completion verify (I6):** re-open the doc by doc_id (server-fresh / cache-bust), re-assert
   exactly-one idLabel, **recompute the fingerprint and require equality** (TOCTOU-I6-NOREFP-1), and
   assert the operator's own decision line transitioned `button "결재"` → `cell "결재 <date>"`+image
   (absent-before / present-after). Also cross-check the doc left the 대기 inbox on a fresh fetch
   (SUCCESS-4). Any login redirect / unexpected URL delta ⇒ ABORT/uncertain, never success (T6).
8. Return the strict JSON result + `detail_after`. The bash leaf writes the terminal audit + status in
   one transaction.

### 4a. Dual-stack fingerprint parity (REVISE: CANON-1 / FP-PREIMAGE / DUAL-FP-PARITY / REF-CONTRADICTS-V4)
v4 got fingerprint byte-parity **for free** because prepare and click-time re-verify both ran
`lib/aria.js`+`extract-detail.js` (identical bytes). Splitting prepare (agent-browser) from re-verify
(Playwright) **destroys that parity**: `aria.clean` is trim-only (`lib/aria.js:32-35`) while Playwright's
ARIA-name computation collapses internal whitespace; `bodyFromHeading`'s dedup (`extract-detail.js:136`)
is tied to the agent-browser tree shape. Result: chronic fail-closed (DoS) OR pressure to relax I6 back to
idLabel+완료 — reopening the hole v4 closed. **Mandatory:**
- Define ONE **stack-independent canonical preimage**: byte-pinned (UTF-8, explicit length-prefix per
  field, fixed null-amount sentinel, fixed separators) → `sha256` hex. Ship ONE shared encoder both paths
  call; commit a **known-answer-test vector** both stacks must reproduce. Normalization is **never**
  relaxed to force a match.
- Harden ONE **shared extractor** (used by both paths) that implements the v4 guards the current
  `extract-detail.js` still violates (verified): exactly-one rowheader with **abort on 0/≥2** for idLabel
  AND every fingerprint-bound field (`AMOUNT-SHADOW-1`; `:97-109/:76-82` first-match today); honor an
  explicit `untilMarker` excluding the volatile 의견/댓글 footer (`:125-142` reads start→END today);
  **fail closed on body overflow, never `slice(0,8000)`** (`FP-BODYDIGEST-TRUNC-1`; `:141` today). Either
  bind both stacks to this shared module, or have the Playwright leaf emit agent-browser's exact dump and
  run the same extractor. Fixtures (duplicate rowheader, over-bound body) must ABORT on **both** stacks.

## 5. Native-dialog handling — the new safety-critical guard (REVISE-hardened)
A blanket `page.on('dialog', d => d.accept())` is **forbidden** — it would auto-accept *any* dialog,
defeating I1/I6. The v1 `page.once` was also wrong: the FIRST dialog (a stray beforeunload/validation)
would consume the one-shot and the real confirm would then auto-dismiss (`ONESHOT-EARLIER-DIALOG-1`), and
reading flags after `click()` raced the async handler (`DIALOG-FLAG-RACE-1`). v2 uses a **persistent,
counting handler over the approve window + a deterministic await**, with an **exact, anchored,
Gate-B-captured** message (`NATIVE-PATTERN-LOOSE-1`):

```js
// nativeExpected = the EXACT confirm string captured in the Gate B re-run (§0.1), e.g. "결재하시겠습니까?".
// Build REFUSES a missing/loose/alternation pattern. Compare by exact equality, not a loose regex.
let dialogs = 0, accepted = 0, seen = [];
const onDialog = async d => {
  dialogs++; seen.push(d.message());
  const ok = d.type() === 'confirm' && d.message().trim() === recipe.approve.confirm.nativeExpected.trim();
  if (ok && accepted === 0) { accepted++; await d.accept(); } else { await d.dismiss(); } // anything else ⇒ Cancel
};
page.on('dialog', onDialog);                     // persistent for the whole approve window
const [, ] = await Promise.all([                 // deterministic: the dialog event is delivered, not raced
  page.waitForEvent('dialog'), confirmButton.click()  // 확인 (NEVER 확인 후 다음 문서)
]);
page.off('dialog', onDialog);
// abort unless EXACTLY one matching confirm was accepted and NO other dialog appeared:
if (dialogs !== 1 || accepted !== 1) return { completed:false, error:`dialogs=${dialogs} accepted=${accepted} seen=${JSON.stringify(seen)}` };
// record seen[] into the audit (exact message is evidence; never a secret).
```
- `recipe.approve.confirm` = `{ "kind":"dom-then-native", "domAccept":"확인", "avoid":"확인 후 다음 문서",
  "nativeExpected":"<EXACT Gate-B-captured confirm string>" }` — **§12-captured per app**; build refuses
  if absent, a placeholder, or a loose alternation (fail-closed; never accept an unknown/ambiguous dialog).
  `d.message()` is recorded into the append-only audit for an exact-equal evidentiary trail.
- The handler is deterministic leaf code (I3: no model on this path), scoped to a **single** approve and
  caps `accepted` at 1 (I2: can never batch-accept).
- **No doc binding on the native confirm (`NATIVE-DIALOG-NOBIND-1`):** the confirm OK is generic, so a
  same-origin script *inside the leaf's authenticated page* could swap the doc between verify and click.
  Mitigations (load-bearing, documented): run a **fresh, clean Playwright context per item** (no
  extensions, no persisted profile); the no-in-leaf-script assumption is stated; step-7 I6 re-open by the
  intended doc_id + fingerprint recompute blocks a false-SUCCESS report. If the Gate-B confirm message
  echoes the doc_id, pin `nativeExpected` to include it.

## 6. Auth state reuse (REVISE: AUTH-DUP-2STACK-1, STORAGESTATE-IDENTITY-1)
`fixtures/auth/<app>.state.json` has top keys `[cookies, origins]` — it *looks* like a Playwright
`storageState`, **but its cookies are CDP-shaped** (`name,value,domain,path,expires,size,httpOnly,secure,
session` — `sameSite` ABSENT, extra `size`/`session`), which Playwright `storageState` import rejects or
silently mis-imports → auth failure or a subtly-different approve session. **So do NOT assume reuse.**
Standardize on a **Playwright-native capture** `setup/auth-pw.mjs` (headed login → `context.storageState({
path })` → `fixtures/auth/<app>.pw.json`), or a **validated converter** (inject `sameSite`, strip CDP-only
fields) with a parse/shape assertion. One refresh/expiry policy; the leaf **fails loud** if state is
missing/expired/wrong-shape (never run logged-out); I6 login-redirect ⇒ ABORT covers mid-run expiry.
**Actor binding:** nothing today ties the reused session's Hiworks web identity to the OOB ceremony actor
(audit misattribution; DESIGN §13-Q2 open). The leaf must read the live logged-in Hiworks identity at
approve time and **bind it into the audit** (assert equality to a configured operator id if one exists);
require the fixture be the operator's own account.

## 7. Evidence (video/trace) — ⚠ HIGH-fixed, do NOT leak the reused credential
**`PW-TRACE-COOKIE-LEAK-1` (HIGH, gate-blocking — the v1 reason this design was REVISE-FIRST):** a
Playwright **trace captures request headers/cookies by default**. The approve context is loaded with the
reused `fixtures/auth/<app>.state.json` (**21 transferable Hiworks session cookies**). `webui/server.js`
serves `GET /artifacts/*` gated **only by a Host allowlist, with NO Origin check** (explicit code comment;
`.zip` falls through to octet-stream). So if the trace landed under `artifacts/`, an **in-scope same-origin
script** (XSS/extension/bookmarklet) could `fetch('/artifacts/<run>/trace.zip')`, lift the cookie, and take
over the Hiworks session to approve arbitrary docs — **bypassing the entire OOB ceremony**. Mandatory v2 rules:
- **Do NOT enable network/HAR capture** in the approve trace (`tracing.start({ snapshots:true, screenshots:true,
  sources:false })` with network OFF), OR scrub `Cookie`/`Set-Cookie`/`Authorization` and the storageState
  from any retained artifact.
- **Write trace/video to a NON-served, `0600` evidence dir** (e.g. `data/approve-evidence/<RUN_ID>/`, never
  under the loopback-served `artifacts/`), gated by an **unguessable per-run token** — an Origin/Sec-Fetch
  check cannot exclude a same-origin script, so the dir must simply not be reachable over the webui.
- `.gitignore` that dir + `*.zip` belt-and-suspenders; build-time assert the leaf refuses to write evidence
  anywhere else. The **Gate B re-run must confirm exactly what the trace captures** before the leaf ships.

**Daemon-coupling (REVISE: KILLPATH-PW-VIDEO-1, downgraded):** per-context video does **remove the
shared-agent-browser-daemon coupling** (a real improvement over the wedged-daemon residual) — but it does
**not "resolve"** the hard-kill case: `jobs.js` watchdog/cancel `killTree → taskkill /T /F`, so the leaf
never runs `tracing.stop`/`context.close` on a hard kill. Audit/status remains the I5 source of truth;
video stays best-effort on hard kill (the accepted residual). Optional: a bounded graceful stop before killTree.

## 8. Testing (still: disposable docs only, never a real financial approval)
- Browser-free units (DESIGN §9) unchanged (nonce/OOB/consent/authority/audit).
- New leaf units: the dialog handler accepts ONLY a pattern-matching `confirm` and dismisses+aborts an
  unexpected dialog; fingerprint-mismatch aborts; `count()!==1` on open/button aborts; `확인 후 다음 문서`
  is never used.
- Staged Playwright integration on a **disposable** doc that lands in the operator's 대기 box — this is
  also the **Gate B Phase 2 re-run**: prove `확인`→accepted native confirm→**완료 transition** + affordance
  disappearance + inbox-departure. Until that staged run passes, the leaf stays unbuilt/fail-closed.

## 9. What this does NOT change / what stays gated
- No change to read/sync/enrich, the webui zero-dep property, the model's zero authority, or any v4
  invariant.
- **Red-team status:** `REDTEAM-DRIVER.md` returned **REVISE-FIRST** (1 HIGH + 11 med + 7 low); the HIGH
  and the spec-level mediums are folded into this v2. A **re-red-team of v2** is needed to clear Gate A for
  the driver surface.
- **Gating order to implementation (cheapest first, §0):**
  1. Headed manual capture that **positively identifies the post-`확인` mechanism** (is it really native?)
     + the exact confirm message.
  2. Test **alternative (E)** (headed + operator manually accepts) on a staged doc — if it works, **prefer
     it** and shelve Playwright.
  3. Only if (1)=native and (2) insufficient: re-red-team this v2 → safe; then re-run Gate B Phase 2 **on
     Playwright** (completion transition, affordance disappearance, inbox-departure, trace-contents audit).
  Implementation begins only after the applicable gates pass. Until then: **fail-closed.**

## 10. Open questions
1. **§0.1 — is the post-`확인` step actually a native dialog?** (the whole Playwright case rests on this;
   currently an unconfirmed inference — `BLOCKER-ASSUMED-1`.)
2. **Does alternative (E) (headed + manual accept) complete a staged approval?** If yes, Playwright is
   unnecessary (`SIMPLER-PATH-1`).
3. Exact native confirm message for `nativeExpected` (anchored, exact-equal) — capture in §0.1.
4. `fixtures/auth/<app>.state.json` is CDP-shaped (no `sameSite`) → assume NON-compatible; use a
   Playwright-native capture or validated converter (§6).
5. Headed vs headless for the leaf — headed aligns with per-item human presence (I1) and is the natural
   home for (E).
6. Confirm Playwright can drive the combobox pagination off page 1 (`selectOption` equivalent of the
   proven agent-browser mechanism).
