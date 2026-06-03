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

## Phase 1 — Run trigger + serial queue

- [ ] Single-slot browser-job queue (server-owned)
- [ ] `POST /api/runs` → spawn `run.sh [glob]` (Git Bash) through the queue
- [ ] SSE live stdout stream to the page
- [ ] On completion: index new run, surface pass/fail, link into dashboard
- [ ] Acceptance: live log streams; new run indexed; **two concurrent Run requests do NOT
      run two browser jobs at once** (queue depth observable; no wedge)
- [ ] suite GREEN; commit; `--no-ff` merge milestone to master

## Phase 2 — Recorder + Flow editor

- [ ] Trigger/collect a `record.cmd` capture (PowerShell spawn, serialized)
- [ ] Show produced `flow.json`; needs_review candidate-picker UI
- [ ] Fill `{{input_N}}` values → `flows/<name>.values.json`
- [ ] `verify` (bin/verify-flow.sh) then `compile` → tests/<name>.test.sh
- [ ] Acceptance: end-to-end record→edit→verify→compile→run on a safe site
- [ ] suite GREEN; commit; merge milestone

## Phase 3 — Policy (optional)

- [ ] Auth (setup/auth.sh) UI
- [ ] Scheduling / pass-rate trends

## Open questions / blockers

- (none yet) — WF-Arch pending.
