# record-capture-mode — Hardened Design (WF-1 synthesis)

Last Updated: 2026-06-02
Source: ultracode WF-1 adversarial design fan-out (23 agents, 2.16M tok). Raw result was
in a temp file (volatile); this is the distilled, load-bearing design. Supersedes the
seed where they conflict (the seed's blockers below were empirically wrong).

## BLOCKER corrections to the seed (verified on agent-browser 0.27.0)

- **B1 uniqueness gate.** `agent-browser get count <sel>` accepts a **CSS selector only**
  (`li.item`, `#id`, `@e1`). The semantic by-grammar (role/text/label/placeholder/alt/title)
  exists **only on `find`**, which ACTS (no count/dry-run; defaults to click). So the
  seed's "verify unique via get count" is non-functional for every preferred locator.
  → Count uniqueness **IN-PAGE** in capture.js, mirroring how replay `find` matches; the
  count travels with each candidate. Host `get count '[data-testid="v"]'` is a redundant
  cross-check for the testid CSS-equivalent ONLY.
- **B2 injection.** Runtime `addinitscript <js>` is **absent from the 0.27.0 binary**
  (falls through to usage). Use `--init-script <ABS-path>` on the **first** open, threaded
  between `open` and `<url>`: `AB_AUTH "$app" open --init-script "$CAPJS" "$url"` /
  `agent-browser --session "$S" open --init-script "$CAPJS" "$url"`. Re-runs on every
  full-doc nav; guard idempotency with `window.__aqaInstalled`.
- **B3 headed.** agent-browser.json defaults headless:true. Capture is human-driven →
  force `export AGENT_BROWSER_HEADED=1` AND pass `--headed` (mirror setup/auth.sh).

## Locator algorithm — "stability-scored + in-page uniqueness" (winner)

1. **Resolve target**: `e.composedPath()[0]` (undo Shadow DOM retarget; not e.target).
   - Clicks: retarget to nearest interactive ancestor
     `closest('a,button,input,select,textarea,label,summary,[role],[tabindex],[onclick],[contenteditable]')`
     within <=4 hops; keep leaf text as a text-candidate source.
   - Label clicks: redirect to associated control (`label.control`/`label[for]`); suppress
     the synthetic label→input duplicate within a ~700ms window keyed by resolved control.
   - SVG: never read `.className` (SVGAnimatedString) — use `getAttribute`; climb to ancestor.
2. **Input coalescing + IME**: do NOT emit per `input`. Buffer latest value per element;
   commit ONE `fill` on `change`/`blur`/focus-move/pagehide. Ignore while `e.isComposing`;
   take value at `compositionend`. (5-char type → 1 fill; CJK composition → 1 fill.)
3. **Sensitive masking AT CAPTURE** (never write secret to buffer): input_value=null,
   masked:true when type==='password' OR autocomplete in
   {current-password,new-password,one-time-code,cc-number,cc-csc,cc-exp} OR
   (inputmode==='numeric' OR type in {tel,number}) with name/id/aria-label matching
   `/otp|cvv|cvc|ssn|card|account|routing|pin|secret|token|one-time/i`. Host re-masks (2nd gate).
4. **Candidate ladder** (schema by-values ONLY; never css/xpath/@eN). Walk element + <=5
   ancestors; stop at a P1 testid. P1 data-testid(+data-test/qa/cy/test-id) · P2 role+name
   (implicit-role map; name = aria-labelledby→aria-label→<label>→textContent(name-from-contents)
   →alt→title→placeholder) · P3 label(for/wrap/labelledby, form controls) · P4 exact visible
   text(name-from-contents, len 1..80) · P5 placeholder · P-alt(img/area/input[image]) · P6 title.
   De-dup identical (by,value,name). normalize() = NFC + whitespace-collapse, shared in-page & host.
5. **Dynamic-id / entropy rejection** (highest-leverage graft). Reject/demote values matching
   auto-generated patterns: `^\d{4,}$`, uuid/hex (`^[0-9a-f-]{16,}$`, 8-4-4-4-12), framework
   counters (`:r..:`, `^radix-`, `^mui-`, `^ember`, `^headlessui-`, `^ng-`, `ext-gen`, `cdk-`,
   `yui_`), css-module hashes (`[A-Za-z]+_[A-Za-z0-9]{5,}$`), >=2 long digit runs; subtract for
   Shannon entropy >3.2 bits/char. Only ever drops/demotes (never sole basis) → at worst forces
   an extra needs_review.
6. **Stability score** S = w_kind + w_entropy + w_len + w_unique. w_kind: testid+50,
   role+name+40, label+34, text+26, placeholder+18, alt+14, title+10, role-only+8. w_unique:
   count==1 +30, count>1 −8·log2(count), count==0 −1000(drop). w_len: +6 for 2..40, 0 for
   41..80, −12 else. Rank desc; tie-break w_kind then shorter value. Locale-independent axes
   (testid, role token) outrank localized text → i18n handled.
7. **In-page uniqueness count** (mirrors replay `find`): testid→querySelectorAll('[data-testid="'+CSS.escape(v)+'"]')
   (pierce open shadow roots recursively); role+name→walk elements, computed-role==value &&
   normalized-accname==name; label/text→visible elements with normalized text==value (exact);
   placeholder/alt/title→attribute-equals. Skip invisible (getBoundingClientRect+getComputedStyle).
   provisionally_unique := count==1 && matchedSet contains the resolved target.
8. **Assemble record**: primary = highest-scoring provisionally_unique candidate; candidates =
   ranked de-duped list (>=2; pad with role-only/leaf-text; if still <2 set insufficient:true).
   Push {seq, action_type(click|input|select|key|navigate), url_at_capture, primary, candidates,
   input_value(masked), masked?, is_navigation_boundary:false}. try/catch every handler.

## Navigation — defense-in-depth (layers A–E, all merged)

- **A** synchronous write-through of every action+nav marker to sessionStorage (the durable
  store; survives same-origin full-doc reset). Two keys: `__aqa_buf` (array), `__aqa_seq` (monotonic).
- **B** History API instrument: monkeypatch pushState/replaceState + popstate + hashchange →
  navigate marker on real href change (URL-equality gate to skip replaceState churn).
- **C** prevUrl sentinel: each init-script run compares location.href to stored prevUrl; mismatch
  = a full-doc nav committed (server 302, meta-refresh, JS-skipping link) → navigate marker.
- **D** teardown flush: pagehide(primary)+visibilitychange:hidden+beforeunload → commit pending input.
- **E** HOST poll `get url --json` ~250ms (ground-truth backstop; catches late init-script, CSP
  block, same-URL reload). Reconcile: in-page marker = CAUSE (which action preceded) + pre-nav URL;
  poll = settled post-nav URL (poll until stable ~1 interval; collapse redirect chains to final).
  Emit a boundary if EITHER source sees it; poll-only logged "in-page hooks missed it".

### Wait-gate + URL rules (spec fixes)
- **REPLAY (empirical, 2026-06-02): `wait until:url` must NOT compile to agent-browser `wait --url`.**
  0.27.0 `wait --url` is broken for GLOB patterns (`*`/`**`): `**/secure` hangs ~34s then fails with
  `os error 10060` ("Failed to read"), standalone AND in a batch; only plain substrings work (that is
  why login.test.sh's `wait --url "iana.org"` passed but build-flow's `**/glob` didn't). `get url` is
  reliable. → `compile` emits a `wait_url '<glob>'` poll (lib/assert.sh; shares `_url_match` with
  assert_url), splitting the batch at each url-wait. `until:text`/`until:load` work and stay in the batch.
  Validated by flows/nav-roundtrip (compiled multi-step nav, glob wait) replaying GREEN.
- Emit ONE `wait until:url` per reconciled boundary, right after the causing find step.
- ONLY when url_at_capture actually CHANGED (no-op/​hang otherwise; SPA same-path → emit nothing,
  let next find's implicit wait gate it).
- Glob: strip query+fragment, keep origin+path, replace volatile segments (numeric/uuid/long
  alnum) with `**` → `**/<stable-path>`. Volatile path itself → mark boundary needs_review.
- Trailing assert `{kind:url, value:<final-path glob>}` from last settled URL.

## Host (bash) finalization
- **Stop**: `trap flush_once INT EXIT`; idempotent guarded flush so Enter AND Ctrl-C hit the SAME
  path; snapshot buffer to host var BEFORE close; judge drain eval via `jq .success` — browser
  gone → FAIL LOUD (write nothing, exit !=0), never an empty flow.json.
- **Cross-origin**: drain buffer into a host accumulator on EVERY URL change (sessionStorage is
  per-origin). Same-origin = proven PoC; cross-origin top-level = best-effort/limitation.
- **New tab**: detect via host `tab list --json` poll; drain ORIGINAL tab first, WRITE partial
  flow.json, then warn+stop (don't lose a long recording).
- **Buffer cleanup**: clear `__aqa_buf/__aqa_seq/__aqa_prevurl` on each successful drain and at
  stop; ephemeral session `capture-<name>-$$`; capture and setup/auth.sh must NOT share session/profile.
- **Finalize each record**: accept primary if provisionally_unique (testid → optional host
  `get count '[data-testid=v]'`==1 cross-check); else first candidate with in-page count==1 &&
  matchesTarget; else emit `needs_review:true` + top >=2 candidates verbatim and CONTINUE. Never
  a positional/nth guess (schema has no index field).
- **select**: record BOTH option value AND visible text; verify against the actual 0.27.0
  `find ... select` matching (MEMORY: 0.9.5 select_option matched value only); flag if text!=value.

## Schema + compile (fail-loud, must ADD)
- SCHEMA.md: additive `needs_review`(bool) + `candidates`(array of >=2 {by,value,name?}) on a find
  step; a needs_review step carries no accepted top-level by/value. Absent == false (hand-written
  flows unaffected).
- compile(): early guard BEFORE batch_body — `jq -e '[.steps[]|select(.needs_review==true)]|length==0'`
  else list offending step indices+candidates to stderr and `exit 1`. (Existing `else empty` would
  SILENTLY DROP them.) Negative test in acceptance: needs_review flow → compile exits !=0.

## OPEN RISKS (residual, accept or mitigate)
- **accname divergence**: in-page accname is a trimmed subset of W3C accname-1.2; a role+name
  count==1 in-page may resolve differently under replay `find`. Mitigated by ranking testid>role+name
  and ladder degrade; not eliminable without the engine's accname as a host primitive (absent in 0.27.0).
- **record-time uniqueness only**: count==1 now ≠ durable; a future 2nd 'Save' breaks silently.
  Structural ceiling of any recorder; round-trip on same build is the backstop.
- **wrong-element-but-count==1**: cardinality ≠ identity; mutated SPA between action and drain.
  Mitigated by per-boundary drain (read while element exists) + matchesTarget at capture.
- **closed shadow roots / cross-origin iframes** unreachable → thin candidates → needs_review (not silent).
- **duplicate-text grids** (N 'Edit' rows, no testid) → every step needs_review (correct fail-loud;
  schema has no scope/index to auto-resolve).
- **pushState clobber / pure DOM-swap routers** (no URL signal at all) → missed; host poll is backstop
  but pure-DOM routers produce ZERO URL signal → no wait gate.
- **poll granularity ~250ms**: fast click→nav→click can misattribute the boundary.
- **sessionStorage quota/private-mode**: setItem throw is swallowed → silent loss. Needs host
  health-check (verify monotonic seq advanced between drains) to fail loud. (NOT yet specified — TODO.)
- **file size**: capture JS large → lives in bin/capture.js (OK). Bash capture dispatch + compile
  guard may push probe-record.sh over ~250 lines → may split the flow-json builder into a helper.
- **PoC**: workflow agents couldn't launch a browser (sandbox); but inline PoC brg25r4fo retired R1
  (capture + same-origin nav persistence) successfully. CLI-surface facts above are empirically confirmed.

## UNRESOLVED PRODUCT DECISION (needs user)
- **Non-sensitive input value handling in the committed flow.json.** flows/*.flow.json IS git-committed
  (not gitignored). Options: (a) verbatim values + loud end-of-capture warning; (b) parameterize —
  emit `{var}` tokens, keep real values in a gitignored `flows/<name>.values.json` sidecar (reusable,
  no PII in git, mirrors auth-state handling, but compile/replay must read the sidecar). Sensitive
  fields are masked regardless. → see decision in context.md once made.
