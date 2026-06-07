# Phase 2 approve — driver design for the native-dialog leg (Playwright approve leaf)

**Status: DESIGN ONLY. Implementation forbidden** until (a) this driver surface is red-teamed
(Gate-A-equivalent for the new code path) and (b) Gate B Phase 2 is **re-run on this driver** to prove
the dialog-accept actually completes the approve and to capture the completion-marker transition that
`GATE-B-CAPTURE.md` could not observe. This addends `DESIGN.md` v4; all v4 invariants (I1–I7) still bind.

## 1. Why a different driver (the Gate B blocker)
Gate B (`GATE-B-CAPTURE.md`) proved the Hiworks 결재 finishes with a **native browser `confirm()`** after
the in-page DOM modal's `확인`. **agent-browser 0.27.0 cannot *accept* a native dialog** — its only dialog
control is `--no-auto-dialog` (turns *dismissal* off) and a `confirm <id>` action-gate; there is **no
page-dialog accept primitive**. So the native confirm is auto-dismissed (= Cancel) and the approval never
commits (reproduced 3×). The read/sync/enrich paths never hit this, so **only the effectful approve leg
needs a driver that can accept native dialogs.**

## 2. Driver choice — Playwright (Node), and alternatives considered (확장-전-검토)
- **(A) Playwright for the approve leaf only — CHOSEN.** Playwright has first-class dialog handling
  (`page.on('dialog', d => d.accept())`) and is **already shipped by this project**: the Docker image is
  `mcr.microsoft.com/playwright:v1.49.1-jammy` (Chromium included). It is the same Chromium-automation
  class agent-browser wraps, so this is *using the engine the project already ships*, not importing a
  foreign stack.
- (B) Newer/patched agent-browser with a dialog-accept flag — **rejected for now**: not available in the
  pinned 0.27.0; depends on upstream; would still need the same per-item safety wiring. Revisit if
  upstream adds `--accept-dialog`.
- (C) Avoid the native dialog (HTTP/API approve, or a non-dialog UI path) — **rejected**: the Hiworks
  approval API was REFUTED (no list/approve endpoint); the native confirm is the product's real path.
- (D) Drive the OS dialog (AutoHotkey/UIA) — **rejected**: brittle, OS-coupled, racy, unsafe for an
  irreversible action.

**Trade-off to accept (stated, not hidden):** Playwright is a **real new dependency** and a **second
browser stack** for one leaf. The webui stays *zero-dependency* (`webui/package.json`) — the dep lives
**only** with the approve leaf (its own `package.json`/`node_modules`, mirroring how `webui/` scopes its
own `type:module`; never hoist it to repo root — that would change how `bin/*.js` parse, per CLAUDE.md).
On Windows the leaf needs a one-time `npm i playwright && npx playwright install chromium`.

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
bin/approve-drive.mjs     — Playwright: ONLY the browser sequence (§4). Returns a STRICT JSON result
                            {opened, idLabelOk, fingerprintOk, dialogAccepted, completed, urlBefore,
                             urlAfter, completionMarker, error}. The bash leaf treats this exactly like
                            the agent-browser `.success` contract: any false/ambiguous field ⇒ ABORT,
                            terminal failed/interrupted audit + status=approve_failed in one txn.
```
`approve-drive.mjs` imports Playwright + (read-only) the recipe; it does **not** import the signer, the
model, or `lib/db.js` writers — it receives the validated consent + recipe as args/stdin and returns
data. Audit/status mutations stay in the bash leaf + `lib/db.js` (one trust boundary for state).

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

## 5. Native-dialog handling — the new safety-critical guard
A blanket `page.on('dialog', d => d.accept())` is **forbidden** — it would auto-accept *any* dialog
(including an unexpected one), defeating I1/I6. Instead:

```js
let dlg = { fired:false, accepted:false, message:'' };
page.once('dialog', async d => {                 // ONE-SHOT, armed immediately before the 확인 click
  dlg.fired = true; dlg.message = d.message();
  const ok = d.type() === 'confirm' &&           // must be a confirm…
             recipe.approve.confirm.nativePattern && // …whose text matches a recipe-PINNED pattern
             new RegExp(recipe.approve.confirm.nativePattern).test(d.message()); // e.g. "결재" / "승인하시겠"
  if (ok) { dlg.accepted = true; await d.accept(); }
  else    { await d.dismiss(); }                 // unexpected dialog ⇒ Cancel, leave UNAPPROVED
});
await confirmButton.click();                     // 확인
// abort unless EXACTLY this expected dialog fired and was accepted:
if (!dlg.fired || !dlg.accepted) return { completed:false, error:`dialog ${dlg.fired?'unexpected:'+dlg.message:'never fired'}` };
```
- `recipe.approve.confirm` becomes `{ "kind": "dom-then-native", "domAccept":"확인", "avoid":"확인 후 다음 문서",
  "nativePattern":"결재|승인" }` — the native message pattern is **§12-captured per app** and the build
  refuses if absent (fail-closed; never accept an unknown dialog).
- The handler is deterministic leaf code (I3: no model on this path). It is armed **per single approve**
  and disarmed after (one-shot), so it can never batch-accept (I2).

## 6. Auth state reuse
agent-browser caches login at `fixtures/auth/<app>.state.json`. **Open question (verify, don't assume):**
is that file already a Playwright `storageState` (cookies+origins)? If yes →
`browser.newContext({ storageState })` reuses it directly. If not → add a one-time Playwright-native
`setup/auth-pw.mjs` (headed login → `context.storageState({ path })`) producing a sibling
`fixtures/auth/<app>.pw.json`, or a converter. Either way the approve leaf must fail loud if its state
is missing/expired (never run logged-out).

## 7. Bonus: this also fixes the red-team video/kill-path residual
Playwright records video + a trace **per context**, independent of the shared agent-browser daemon. This
**resolves WATCHDOG-WEDGED-1 / RECORDSTOP-WEDGED-T9** (red-team: approve video lost when the shared
daemon wedges): the approve leaf finalizes its own `context.close()` / `tracing.stop({path})` directly,
so durable audit (lib/db.js) + best-effort-but-daemon-independent video both hold (I5).

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
- **Still gated:** (1) red-team this driver surface (new dialog-accept + Playwright auth/context) for
  confirmed critical/high; (2) re-run Gate B Phase 2 on Playwright to capture what the agent-browser run
  couldn't (completion marker, dialog message pattern). Implementation begins only after both.

## 10. Open questions
1. Is `fixtures/auth/<app>.state.json` Playwright-`storageState`-compatible (reuse) or does the leaf need
   its own auth capture (§6)?
2. Exact native confirm message (for `nativePattern`) — capture in the Gate B re-run.
3. Should the approve leaf run **headed** (operator sees the real click, matching the OOB ceremony) or
   headless? Headed aligns better with per-item human presence (I1) and Windows operation.
4. Confirm Playwright can drive the same combobox pagination if the target doc is off page 1 (the
   agent-browser path already proved the mechanism; Playwright `selectOption` is the equivalent).
