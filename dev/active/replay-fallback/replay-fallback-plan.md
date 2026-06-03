# replay-fallback — Plan & Progress

Branch: `feat/replay-fallback` (off `master`). Hand-maintained (no dev-docs skill).

Backlog item #1: a per-step **replay fallback ladder** so a transient primary-locator
failure at replay retries down a ladder of capture-time-unique candidates instead of going
red — reducing flake. **This collides head-on with the framework's reason for existing
(no false-green), so the design is deliberately conservative.**

## Honest scoping

- This is a **flake / replay-resilience** feature, NOT a `needs_review` reducer. A
  `needs_review` step has, by definition, no capture-time count==1 candidate (otherwise
  capture would have made it the primary), so its ladder holds only count>1 / overLong /
  role entries — none usable as a safe fallback. So fallback only ever applies to
  ALREADY-RESOLVED find steps.

## Design (locked)

- **Opt-in, per-flow.** New OPTIONAL top-level flow.json field `"replayFallback": true`.
  Absent/false ⇒ compile output is **byte-identical** to before ⇒ existing 9 flows
  gate-safe by construction. `build-flow.js` never sets it; a human opts a flow in.
- **Source of the ladder = the existing gitignored `flows/<name>.candidates.json`**
  (already written by build-flow; already consumed by verify). `compile` reads it with the
  SAME staleness guard verify uses (`._steps == flow.steps|length`); missing/stale + flag
  set ⇒ **fail loud** (never silently downgrade).
- **Fallback eligibility (all must hold)** — the same uniqueness bar capture applied to a
  primary, so a fallback can never be weaker than the primary it replaces:
  - `count == 1` (capture-time unique — never a count>1 ambiguous match),
  - value ≤ 80 chars and name ≤ 80 chars (not overLong — too fragile to auto-use),
  - `by != "role"` (role+name is unreliable on 0.27.0 — engine won't resolve it),
  - not equal to the step's own primary (that is tried first).
- **Self-contained output.** `compile` bakes the primary + fallback `find` commands into
  the committed `.test.sh` as a base64 `_find_fb '<b64>'` call. The runnable artifact needs
  NO sidecar at run time (sidecar is only an authoring-time input, like verify).
- **`_find_fb` runtime helper** (emitted into the test, mirrors verify-flow `_exec`):
  decode → substitute `{{input_N}}` tokens (same walk as `_run_batch`, fail-loud on missing)
  → try each command via `AB_JSON` reading `.success`; first success returns 0; **if it was a
  fallback (index>0) print a loud `⚠ FALLBACK` line to stderr**; if ALL fail, print the failed
  primary + fallback count and return 1 (fails the test — NO false-green).
- A find step with no qualifying fallback compiles exactly as today (coalesced `_run_batch`).
  If the flag is set but NO step has a usable fallback, compile notes it and emits no
  `_find_fb` (output identical to off-path).

## Residual risk (documented, inherent)

`cardinality ≠ identity`: a candidate that was count==1 at capture can resolve to a
DIFFERENT single element at replay (page drift) → a fallback could act on the wrong element
→ false-green. 0.27.0 has no semantic-count primitive at replay, so we cannot re-verify
uniqueness there. Mitigations: count==1-only + non-role + opt-in + loud log + the flow's
downstream steps/asserts as a partial backstop. This residual risk is why the feature is
opt-in and loudly surfaced; documented in SCHEMA.md.

## Verification gates (autonomous unless flagged)

1. `bash -n bin/probe-record.sh`, `node --check bin/build-flow.js` (unchanged but checked).
2. **Byte-identity**: recompile the two committed flows (nav-roundtrip, ianatour) and assert
   `git diff --quiet tests/*.test.sh` ⇒ off-path provably unchanged.
3. **Unit** (browser-free, deterministic): synthetic flow + sidecar with a count==1 fallback
   AND a count>1 / overLong / role sibling; assert the compiled test contains `_find_fb` with
   ONLY the count==1 fallback baked in, and a non-flag flow contains NO `_find_fb`.
4. **Live mechanism** (headless, example.com — no human): primary-OK path green; primary-fails
   + count==1 fallback resolves ⇒ green + loud log; primary-fails + no fallback ⇒ RED.
5. `bash run.sh` ⇒ **10/10 GREEN** (9 existing + new replay-fallback live test).
6. Adversarial ultracode review (read-only WF), each finding verified, then fixed.

HUMAN-ONLY (flag): a real headed capture of a drift-prone site to see fallback fire in the
wild is out of autonomous scope; the example.com mechanism test covers the code paths.

## Progress log

- 2026-06-04: SSOT read end-to-end; design locked; branch + plan created. Implementing compile.
- 2026-06-04: Implemented on `feat/replay-fallback`:
  - `bin/probe-record.sh compile()`: opt-in `replayFallback` path — reads candidates sidecar
    (staleness-guarded `_steps==len`, fail-loud), `fb_json` filters to count==1 / ≤80c / non-role /
    non-primary siblings; shared `findcmd()` jq + `to_entries`; new `t:f` segment → baked `_find_fb`
    helper (single-command `AB batch --json`, `.[0].success`, loud `⚠ FALLBACK`, RED on all-fail).
  - **Off-path proven BYTE-IDENTICAL**: recompiling nav-roundtrip + ianatour ⇒ zero git diff.
  - `run.sh`: excludes `_`-prefixed scaffold tests (throwaway compiled flows can't false-fail gate).
  - `tests/compile-fallback.test.sh` (browser-free unit) — **GREEN**: emission, candidate filtering
    (Edit/role/overLong excluded), action+token propagation, stale-sidecar refusal, no-eligible NOTE.
  - `tests/replay-fallback.test.sh` (live, example.com, video stripped for speed) — **GREEN 3/3**:
    bogus-primary+unique-fallback ⇒ green+loud log; all-bogus ⇒ RED (no false-green); real primary ⇒
    green+no spurious fallback. (One run hit 603s from daemon degradation; steady state ~27s/scenario,
    cut further by stripping video.)
  - `flows/SCHEMA.md` + `README.md`: documented opt-in field, eligibility, loud log, residual risk.
  - Gates checked: `bash -n` + `node --check` OK; NUL-byte mishap (early `` attempt) caught & removed.
  - **Full `bash run.sh` = 11/11 GREEN** (9 original + compile-fallback + replay-fallback; 0 failed).
    replay-fallback 302s ≈ pre-existing verify-flow 289s (both heavy live tests; daemon slow late in
    suite) — acceptable, not a new outlier.
  - Adversarial review workflow (5 dims → per-finding refute): **5 raised, 3 confirmed real, 2 refuted.**
    All 3 confirmed were LOW (none a false-green — the core guarantee held under attack):
    1. `compile-fallback.test.sh` header cited a byte-identity proof that wasn't encoded as an assertion
       → ADDED a real assertion (absent vs `replayFallback:false` ⇒ `cmp` byte-identical) + honest header.
    2. Both new tests used fixed throwaway names → race/straggler under concurrent runs → **PID-namespaced**
       (`_rfb_*_$$`, `_cfb_*_$$`; still `_`-prefixed so run.sh excludes them).
    3. `_find_fb` swallowed the engine `.error` on total failure (RED, but diagnostic regression vs the
       fail-loud-WITH-WHY convention of `_batch_check`/`_exec`) → now surfaces `.[0].error`.
    Refuted (correctly): stale-guard "only checks exit code" (the `_steps=99` mutation can only break the
    guard itself, which the test catches — but I still adopted its cheap message-check), and a
    comment-wording nuance ("never weaker than primary" — the filter is strictly *stricter*, conservative).
  - **Process footgun (new)**: a verify-agent in the review workflow EXECUTED the live browser test to
    reproduce a finding — running a browser job concurrently with the suite (daemon-wedge risk) and
    leaving `_rfb_*` stragglers. LESSON: constrain review/verify workflow agents to READ-ONLY (Read/Grep)
    and explicitly forbid running tests/compiles. (Stragglers cleaned; gate unaffected by `_`-exclusion.)
  - Post-fix gates: `bash -n` OK, 0 NUL, byte-identity still ✓, compile-fallback unit GREEN standalone.
  - Out of scope (noted, not changed — minimal-change discipline): `verify-flow.test.sh` shares the
    fixed-name pattern but writes only `_vrt_*.flow.json` (no `.test.sh` straggler), lower risk.
  - RUNNING: full `bash run.sh` re-gate (post-fix). NEXT: on GREEN → logical commits → `--no-ff` merge.
