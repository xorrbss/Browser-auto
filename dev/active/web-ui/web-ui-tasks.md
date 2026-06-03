# web-ui — Tasks

Last Updated: 2026-06-03

Legend: [ ] todo · [~] in progress · [x] done · [!] blocked

## Phase 0 — Foundation + architecture decision

- [x] Read SSOT (README, SCHEMA, run.sh, lib, record.cmd, probe-record, verify-flow, auth,
      capture-mode context)
- [x] Confirm env (Git Bash tool, Node v24, disk, clean tree); cut `feat/web-ui-p0`
- [x] Write plan / context / tasks docs by hand
- [x] WF-Arch: adversarial compare candidate stacks → judge → synthesize a decision
- [x] (gate) No user fork — `userDecisionNeeded=false`; constraints determined the stack
- [x] Record final architecture in web-ui-context.md DECISIONS + plan Architecture
- [x] Commit foundation docs (4358560)

## Phase 0 — Results dashboard  (browser drive = 0)

- [x] `webui/` scaffold (server.js, index.js, public/, package.json, .gitignore, README)
- [x] Index `artifacts/*/report.json` → runs list (run-id, timestamp, pass/fail, rows)
- [x] `GET /api/runs`, `GET /api/runs/:id` (parsed from report.json, mtime cache)
- [x] Static serving of `artifacts/<run-id>/<test>/video.webm` (Range) + report files
- [x] Dashboard page: runs list → run detail (per-test status/duration, video, report)
- [x] Acceptance: server up; `/api/runs`+`/api/runs/:id` parsed against real artifacts;
      video full(200)+Range(206); traversal guarded. Verified by field parsing, not exit code.
- [x] WF-Review-P0 (5-dim adversarial review; 18 findings/14 confirmed) → 6 distinct fixes
      applied (stream pipeline crash+fd-leak, %-decode 404, EADDRINUSE handler, RUN_ID date
      round-trip, 416 Accept-Ranges, static TOCTOU) → all re-verified empirically
- [x] GREEN baseline 7/7; **P0 committed + merged to master (--no-ff)**

P0 = DEMOABLE: `node webui/server.js` → http://127.0.0.1:4310 → runs list → run detail
(per-test pass/fail + inline video with seeking). Zero browser launches, zero npm deps.

## Phase 1 — Run trigger + serial queue  ✅ DONE (merged to master)

- [x] Single-slot serial promise-chain queue (webui/jobs.js); jobFn awaits child 'close'
- [x] webui/spawn.js gitBash() → `bash.exe run.sh [glob]` shell:false cwd=PROBE_ROOT
- [x] `POST /api/run` (enqueue) + `GET /api/queue` + `GET /api/jobs/:id` + SSE `/stream`
- [x] SSE live stdout stream (ring buffer + replay-on-connect + end frame); UI run bar + log
- [x] On completion: parse RUN_ID from stream, index new run, surface pass/fail, deep-link
- [x] Acceptance PROVEN: live log streams; new run indexed; **two enqueued jobs → snapshot
      {busy, running:j1, pending:[j2]}; j2.startedAt ≥ j1.endedAt (no concurrent browser job)**
- [x] WF-Review-P1 (27 findings/16 confirmed) → fixes: child watchdog timeout + taskkill /T
      tree-kill + POST /api/jobs/:id/cancel + SIGINT/SIGTERM shutdown kill (HIGH: queue could
      be bricked by a wedged child / orphan tree on shutdown); EventSource close-before-open;
      reconnect-clear (no dup); es.onerror. All re-verified (cancel running → tree-killed,
      queue freed; reconnect replay clean).
- [x] **suite GREEN via the web path itself: full suite 7/7 exit 0; merged --no-ff to master**

P1 = DEMOABLE: Run bar → ▶ Run suite (optional glob) → live SSE log → pass/fail → new run
auto-opens in the dashboard. Serial queue proven; cancel + watchdog + graceful shutdown.

## Phase 2 — Recorder + Flow editor  (built + verified; review in progress)

- [x] spawn.recordCmd (cmd.exe /c record.cmd … --seconds N mandatory); POST /api/record
      → record job through the SAME serial queue (browser job)
- [x] webui/flows.js (pure FS): listFlows/getFlow; resolveStep = write picked candidate as
      step locator + delete needs_review/candidates (documented human edit); saveValues sidecar
- [x] GET /api/flows, /api/flows/:name; POST /api/flows/:name/{resolve,values}
- [x] POST /api/verify (browser job → queue); POST /api/compile (deterministic, un-queued, sync)
- [x] Flow editor UI (flows.js + util.js split; app.js = entry): steps view, candidate-picker
      radios, {{input_N}} values form, gated Compile (needs_review==0 && all values filled)
- [x] Acceptance (autonomous parts PROVEN): list/get/resolve/values; compile refusal(unresolved)
      + success(resolved)→tests/<name>.test.sh; verify nav-roundtrip browser job exit 0;
      frontend modules render; view switch; **candidate radio click → resolve mutated flow.json**
- [x] WF-Review-P2 (30 agents, 25 findings/24 confirmed) → fixes all re-verified:
      **CRITICAL cmd.exe arg-injection via startUrl → RCE** (recordCmd used `cmd.exe /c
      record.cmd`; cmd.exe re-parses args) → **fixed: recordCmd now spawns Git-Bash directly on
      `bin/probe-record.sh capture` (no cmd.exe) + `new URL()` validation + Origin/CSRF guard**;
      LOW: overwrite-guard (409 unless overwrite), recorder onEnd gated on success, persistent
      flow-log/compile-out (no detached node), flow-job cancel buttons, `%`-escape→404 on
      resolve/values, press-step rendering, serialized flow.json writes (no lost update).
- [x] suite GREEN (gate 7/7 exit 0); fixes are webui-only (isolated). Frontend re-smoke after
      restructure: runs render, flows render, candidate-picker click→resolve, concurrency mutex.
- [ ] commit; --no-ff merge milestone
- [!] **NEEDS HUMAN**: full headed `record.cmd` capture (human drives real Chrome → flow). The
      spawn shape (now Git-Bash `probe-record.sh capture --seconds N`) + record-job wiring + the
      editor (candidate-picker→resolve, values, verify, gated compile) are all verified; only a
      live human-driven headed recording remains (seed-#5 pattern).

## Phase 3 — Policy (optional)

- [ ] Auth (setup/auth.sh) UI
- [ ] Scheduling / pass-rate trends

## Open questions / blockers

- (none yet) — WF-Arch pending.
