# DESIGN — agent-browser robustness layer (close the Playwright-only gaps)

**Context:** This is a GENERAL enterprise RPA platform (register ANY web system → automate ANY business
task: read/fetch/summarize/query + effectful submit/create/update/delete/upload/send/approve…). 결재 is just
one example action. (memory `product-scope-general-rpa`.)

**Why this exists:** 2026-06-09 we EMPIRICALLY PROVED agent-browser 0.27.0 does trusted (`isTrusted=true`)
clicks (CDP-backed) — verified on about:blank AND a Hiworks-modal mimic (native 승인 radio + isTrusted-gated
확인 → completed:true with `click`+`keyboard type`). So the "Playwright is required for the trusted click"
premise is WRONG (memory `agent-browser-trusted-click`); the real Hiworks miss was an ARIA-locator issue
(`find role --name 승인` can't reach a native `<input>`; a CSS/id selector works). ⇒ Playwright is likely
REMOVABLE → single agent-browser stack → single auth/engine (kills the dual-auth pain: today sync failed
because 🔐결재로그인 only refreshed the Playwright state, not the agent-browser `fixtures/auth/*.state.json`).

For a GENERAL platform the make-or-break is breadth + robustness + reliability across many unknown enterprise
UIs — exactly agent-browser's weak spots. This design closes those so option A (single agent-browser stack)
is viable. Principle: **extend the existing `lib/*` structure** (assert.sh `.success`-checks, `wait_url`
polling, `bin/daemon-recover.sh`) — minimal new files (`lib/act.sh`, `lib/daemon.sh`). Tests AND the RPA
runtime drivers share the same helpers (every business action, not just approve).

---

## The 6 fixes

### 1. `exit 0` even on action failure → checked action `ABX`  — `lib/env.sh`
agent-browser returns exit 0 even when an action fails; only the `--json` `.success` field is truthful
(already how `assert.sh`/`BATCH` work). Generalize to EVERY single action:
```sh
# ABX <cmd...>: run an action via --json; fail LOUD on success!=true. The only sanctioned way to perform
# an effectful step (bare AB in a driver is a false-green waiting to happen).
ABX() { local out; out="$(AB_JSON "$@")"; \
  [ "$(jq -r .success <<<"$out")" = true ] || { echo "  ✗ ab action: $* -> $(jq -r '.error//"unknown"' <<<"$out")" >&2; return 1; }; \
  printf '%s' "$out"; }
```
Drivers use `ABX click …` / `ABX <action>` instead of bare `AB`.

### 2. No auto-wait → `wait_actionable` + `*_ready` act helpers  — `lib/act.sh` (NEW)
Mirror Playwright actionability (attached + visible + stable) by polling the RELIABLE getters
(snapshot/find/get) — never the broken `wait --url`.
```sh
wait_actionable <loc> [timeout_ms]   # poll until the locator = exactly ONE visible node, stable across 2 reads; else fail-loud
click_ready  <loc> [to]              # wait_actionable -> ABX click  (+ optional post-transition gate)
type_ready   <loc> <text> [to]       # wait_actionable -> focus -> keyboard type (real keystrokes) -> verify value
select_ready <loc> <val>  [to]       # wait_actionable -> set -> verify
```
One call = wait + act + verify.

### 3. `wait --url` broken (os 10060 hang on globs) → polling waiter family  — `lib/assert.sh`
`wait_url` (polls `get url`) already exists. Add the rest, all built on reliable getters:
```sh
wait_url <glob>   wait_text <txt>   wait_visible <loc>   wait_gone <loc>   wait_stable <loc>
```
`wait_gone` = modal closed / row removed; `wait_stable` = SPA settle. The broken `wait --url` stays banned.

### 4. `find role --name` is substring → strict resolve  — `lib/act.sh`
```sh
resolve_one <loc>   # role+name: ALWAYS append --exact; assert count==1 (abort on 0 or >=2). Playwright strict locator.
```
Recipe schema/lint: role+name locators must carry `exact:true`. Capture-time count==1 then agrees with the engine.

### 5. `uncheck` broken (success=false, leaves checked) → verified `set_check`  — `lib/act.sh`
We proved `click` toggles native inputs (radioChecked:true). So:
```sh
set_check <loc> <true|false>   # read current checked (get/eval); if != target, click; verify reached target (retry once). Replaces broken uncheck.
```

### 6. daemon wedge (os 10060) → `ensure_daemon` + reap  — `lib/daemon.sh` (NEW) + wire into webui  ★ROOT CAUSE of today's sync failure
webui `spawn.js` does NOT ensure a healthy daemon before browser jobs (run.sh owns it for tests; the webui
does not) — that + orphan pileup (saw 60 chrome) is why sync hung with os 10060.
```sh
ensure_daemon         # 1) cheap bounded health probe (throwaway-session `get url`, ~8s timeout)
                      # 2) on error/hang (10060 wedge) -> bin/daemon-recover.sh (stop+clean stale+prime) -> re-probe
                      # 3) still unhealthy after 1 recovery -> fail-loud
reap_browser_orphans  # bounded cleanup of orphaned agent-browser engine + its OWN chromium
                      # (~/.agent-browser/browsers ONLY — NEVER the user's Program Files Chrome)
```
Wiring:
- **webui `spawn.js`**: run `ensure_daemon` before EVERY browser job (sync/enrich/analyze/approve/generic) —
  e.g. a small `bin/with-daemon.sh` wrapper, or gitBash an ensure step first. The webui now owns daemon health
  like run.sh. **This is the immediate live fix** (today's blocked sync).
- `run.sh`: route its existing prime through `ensure_daemon` for consistency.
- `reap_browser_orphans` after a job / on wedge → prevents the chrome pileup.

---

## Mapping

| Weakness | Fix | Where |
|---|---|---|
| exit 0 on failure | `ABX` checked wrapper | `lib/env.sh` |
| no auto-wait | `wait_actionable` + `*_ready` | `lib/act.sh` (new) |
| `wait --url` broken | `wait_gone/visible/text/stable` | `lib/assert.sh` |
| `find role` substring | `resolve_one` (--exact + count==1) | `lib/act.sh` (new) |
| `uncheck` broken | `set_check` (read→click→verify) | `lib/act.sh` (new) |
| **daemon wedge** | `ensure_daemon` + `reap` + **webui wiring** | `lib/daemon.sh` (new) + `webui/spawn.js` |

## Recommended build order
1. **`lib/daemon.sh` + webui `spawn.js` wiring** — the live blocker (recovers sync immediately). Verify by
   running 동기화 from the webui end-to-end.
2. `ABX` (`lib/env.sh`) + `resolve_one` + `set_check` (`lib/act.sh`).
3. auto-wait `*_ready` + the `wait_*` family (`lib/assert.sh`/`lib/act.sh`).
4. Migrate the existing drivers (sync-system/enrich/fetch-approvals + future generic action runner) onto the
   helpers; add browser-free unit tests; `bash run.sh` green.

## Out of scope / sequencing notes
- Each new helper gets a browser-free unit test where possible; the gate is `bash run.sh`.
- This hardening makes single-stack agent-browser viable, which in turn enables removing Playwright (separate
  task — needs ONE real-Hiworks disposable-doc confirmation of the agent-browser approve first; see
  `agent-browser-trusted-click` memory).
- Keep the safety-gate architecture (model never authors steps/never clicks; deterministic driver; dry-run →
  reviewed targets → confirm → audit) — it is tool-independent and generalizes to ALL effectful actions.
