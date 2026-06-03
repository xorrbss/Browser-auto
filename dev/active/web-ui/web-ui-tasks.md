# web-ui — Tasks

Last Updated: 2026-06-03

Legend: [ ] todo · [~] in progress · [x] done · [!] blocked

## Phase 0 — Foundation + architecture decision

- [x] Read SSOT (README, SCHEMA, run.sh, lib, record.cmd, probe-record, verify-flow, auth,
      capture-mode context)
- [x] Confirm env (Git Bash tool, Node v24, disk, clean tree); cut `feat/web-ui-p0`
- [x] Write plan / context / tasks docs by hand
- [~] WF-Arch: adversarial compare candidate stacks → judge → synthesize a decision
- [ ] (gate) Confirm stack with user if WF-Arch surfaces a genuine fork
- [ ] Record final architecture in web-ui-context.md DECISIONS + plan Architecture
- [ ] Commit foundation docs

## Phase 0 — Results dashboard  (browser drive = 0)

- [ ] `webui/` scaffold (server entry, static dir, .gitignore additions, run instructions)
- [ ] Index `artifacts/*/report.json` → runs list (run-id, timestamp, pass/fail, rows)
- [ ] `GET /api/runs`, `GET /api/runs/:id` (parsed from report.json)
- [ ] Static serving of `artifacts/<run-id>/<test>/video.webm` + report files
- [ ] Dashboard page: runs list → run detail (per-test status/duration, video, report)
- [ ] Acceptance: start server, parse `/api/runs` against real artifacts, play a video.
      No browser launches. Verify by field parsing, not exit code.
- [ ] `bash run.sh` suite still GREEN; commit

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
