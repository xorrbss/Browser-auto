# web-ui — Plan

Last Updated: 2026-06-03

## Goal (single definition of "done")

A **trustworthy local web UI** over the already-verified agent-qa bash CLI. It is a
**thin orchestration/visualization layer** that wraps the existing CLI via
`child_process` — it does **not** reimplement any test/record/verify/compile logic.

Done = (a) P0–P2 acceptance empirically demonstrated (server up → real endpoint/page
behaviour → parsed result, never trusting exit codes), (b) existing `bash run.sh` suite
stays GREEN (regression gate — the web layer must not touch CLI behaviour/contracts),
(c) docs match behaviour, (d) the serial browser-job queue and the recording control
plane actually work.

## Non-negotiable constraints (acknowledge before designing)

1. **Recording happens in real headed Chrome launched by `record.cmd` (PowerShell), not
   inside the web app.** Cross-origin iframe embedding cannot instrument an arbitrary
   site. → The web app is a *control plane* that **starts / collects / edits / verifies**
   recordings; it is **not** an in-browser recorder.
2. **One shared agent-browser daemon ⇒ all browser work is serial.** Concurrent
   record/run wedges the daemon. → The server MUST own a **single-slot job queue** (one
   browser job at a time). This is a correctness requirement, not an optimization.
3. **No reimplementation of test logic** (global CLAUDE.md invariants: KISS / YAGNI /
   prefer existing structure). Only a thin layer that spawns the CLI.
4. **localhost-only** to start (spawns processes + drives a real browser → never expose
   externally). All web artifacts isolated under a new `webui/` folder.

## Architecture — LOCKED (WF-Arch, 2026-06-03)

`[browser, vanilla JS] —HTTP + SSE→ [raw node:http server] —child_process→ bash CLI / record.cmd`

- **Backend:** raw `node:http`, switch dispatch, `127.0.0.1` only. **Zero npm deps.**
- **Live log (P1+):** SSE. **Index:** in-process mtime-keyed Map cache over fs-scan of
  `artifacts/*/report.json` (no sqlite — experimental on v24). **Frontend:** no-build
  vanilla JS/HTML/CSS. **Serial queue (P1+):** single-slot promise chain, jobFn awaits
  child `'close'`. **Spawn:** Git-Bash `bash.exe` for the CLI, `cmd.exe`+`record.cmd` for
  the recorder; `shell:false`+array args.
- `package.json` is inside `webui/` (not repo root) — `"type":"module"` scoped to webui/.
- Full rationale + the two judge-proven fixes (broken stdin recorder-stop → `--seconds`;
  no-CLI needs_review "resolve" → UI-owned flow.json edit): see web-ui-context.md DECISIONS.

## Phases (value/risk order — each independently demoable; start at P0)

### P0 — Results dashboard  (browser drive = 0, risk = 0) ← START HERE
Index existing `artifacts/*/report.json` + serve videos/reports.
- **Acceptance:** server starts; `GET /api/runs` returns the real runs parsed from
  `artifacts/*/report.json` (run-id, timestamp, pass/fail counts, per-test rows); a run
  detail page lists each test with status/duration and plays its `video.webm` + links
  its report. Verified by parsing JSON/asserting fields, never by exit code. Zero browser
  launches.

### P1 — Run trigger
Web button → `run.sh` (through the serial queue) → SSE live log → pass/fail surfaced; new
run appears in the dashboard.
- **Acceptance:** clicking Run spawns `run.sh [glob]`; stdout streams live to the page via
  SSE; on completion the new `artifacts/<run-id>/report.json` is indexed and shown.
  **Serial queue proven:** a second Run queued while one is active does NOT start a second
  browser job concurrently (demonstrated, e.g. queue depth observable + no daemon wedge).

### P2 — Recorder + Flow editor
`record.cmd` collection → resolve `needs_review` (candidate picker UI) + fill values →
`verify` (`bin/verify-flow.sh`) → `compile`.
- **Acceptance:** UI triggers/collects a `record.cmd` capture (serialized); shows the
  produced `flow.json`; lets a human resolve each `needs_review` step by picking a listed
  candidate and fill `{{input_N}}` values into `flows/<name>.values.json`; runs `verify`
  then `compile` to produce `tests/<name>.test.sh`; the compiled test then runs via P1.
  End-to-end record→edit→verify→compile→run demonstrated on a safe site.

### P3 — Policy (optional polish)
- **Pass-rate trends (done):** `getTrends()` aggregates `artifacts/*/report.json` across runs →
  per-run pass-rate + per-test pass/fail history; `GET /api/trends` + a Trends view (table of
  test × run dots). Read-only, no queue.
- **Auth UI (done):** `POST /api/auth` enqueues `setup/auth.sh <app> <login> <success>` as a
  serial **browser** job (headed Chrome, human OTP) → caches `fixtures/auth/<app>.state.json`;
  `GET /api/auth` lists cached app **names** (never secret content); Auth view form + state list.
  Full e2e (the OTP itself) needs a human.
- **Scheduling — DEFERRED (YAGNI), rationale:** scheduling a localhost dev UI would need a
  persistent in-process scheduler that only runs while the server is open — the wrong place for
  it. Recurring runs belong to the OS/CI (Windows Task Scheduler / cron invoking `bash run.sh`),
  which is how the CI gate is meant to be driven. Adding a stateful scheduler (or a dep) to a
  thin localhost control plane violates KISS/YAGNI for no demonstrated need. Documented here +
  in webui/README.md rather than built.

## Verification gates (every change)

- Code changes: `bash -n` / `node --check` / lint clean.
- **`bash run.sh` suite stays GREEN** (web layer didn't break the CLI). This is the
  regression gate.
- Web features demonstrated empirically: start server → hit endpoint / drive page →
  inspect result. **Never trust exit codes** — parse JSON/fields.
- Serial browser-job queue actually prevents concurrent browser jobs (demonstrated).
- Report "demoable" status to the user at the end of each phase.

## Risks

- **Daemon wedge** from concurrent/rapid browser jobs → mitigated by the single-slot
  queue + the documented Chrome-for-Testing/daemon kill + preflight re-warm recovery.
- **Disk at 96%** (21G free) → keep the stack zero/low-dependency; clean `artifacts/*` and
  Temp orphans as needed (see web-ui-context.md footguns).
- **record.cmd is PowerShell + headed Chrome** → the server must invoke it correctly from
  Windows (not Git Bash), and capture is interactive/human-driven (control-plane, not
  automated).
- **Scope creep into reimplementing the CLI** → forbidden; every browser/test action is a
  spawn of the existing CLI.

## Branch / commit discipline

Feature branches off master; logical-unit commits; `--no-ff` merge to master at each
milestone. No remote (no push). Never commit `.heartbeat` / `dev/process/` / `.claude/`.
`.sh` files stay LF. Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context)
<noreply@anthropic.com>`.
