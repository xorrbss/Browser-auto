# webui — local control plane for agent-qa

A **thin** local web UI over the verified agent-qa bash CLI. It does NOT reimplement any
test/record/verify/compile logic — it spawns the existing CLI (`run.sh`,
`bin/probe-record.sh`, `bin/verify-flow.sh`, `setup/auth.sh`) and `record.cmd`, and
visualizes their artifacts. localhost-only.

## Run

```bash
node webui/server.js          # http://127.0.0.1:4310  (WEBUI_PORT overrides)
```

No `npm install` — there are **zero runtime dependencies** (Node v18+ stdlib only:
`node:http`, `node:fs`, `node:child_process`). The `package.json` lives here (not at the
repo root) so `"type":"module"` is scoped to `webui/` and never changes how the existing
`bin/*.js` are parsed.

## Architecture (decided by WF-Arch, 2026-06-03)

```
[browser, vanilla JS] —HTTP + SSE→ [node:http server] —child_process→ bash CLI / record.cmd
```

- **Backend:** raw `node:http`, plain switch dispatch, bound to `127.0.0.1` only. No
  framework.
- **Live log (P1+):** SSE (one-way server→browser). No WebSocket (no stable stdlib server).
- **Index:** in-process, mtime-keyed cache over an fs-scan of `artifacts/*/report.json`.
  The filesystem is the single source of truth; the cache is rebuildable. No DB
  (`node:sqlite` is experimental on this Node and would be a second source of truth).
- **Frontend:** no-build vanilla JS/HTML/CSS (disk-constrained host; KISS/YAGNI).
- **Serial browser-job queue (P1+):** in-process single-slot promise chain — at most ONE
  browser-driving child (run/record/verify/auth) alive at a time, because the project
  shares ONE agent-browser daemon. `jobFn` resolves only after the child's `close` event.

## Phases

- **P0 — Results dashboard (done):** index `artifacts/*/report.json`; serve videos
  (`video.webm`, HTTP Range) + reports; runs list → run detail with per-test status and
  inline video. Zero browser launches.
- **P1 — Run trigger:** button → `run.sh` through the serial queue → SSE live log → new
  run indexed.
- **P2 — Recorder + Flow editor:** collect a `record.cmd` capture (serialized, `--seconds`
  auto-stop is the only web-drivable stop), resolve `needs_review` (candidate picker) + fill
  `{{input_N}}` values (a UI-owned `flow.json`/`values.json` edit — the documented human
  step, NOT a CLI reimplementation) → `verify` → `compile`.
- **P3 — Policy:** **pass-rate trends** (read-only aggregate of `report.json` across runs —
  `GET /api/trends`, Trends view) and an **auth wrapper** (`POST /api/auth` → `setup/auth.sh`
  as a serial headed-Chrome job for human OTP → `fixtures/auth/<app>.state.json`; `GET /api/auth`
  lists cached app names only). **Scheduling is intentionally NOT built (YAGNI):** an in-app
  scheduler would only run while this localhost server is open — recurring runs belong to the OS
  (Windows Task Scheduler / cron invoking `bash run.sh`), which is how the CI gate is meant to be
  driven.

## Notes / limits

- **Auth timeout coupling:** a headed auth waits up to `HUMAN_TIMEOUT_MS` (default 300000 = 5min,
  read by `setup/auth.sh`) for the human OTP; the queue watchdog tree-kills any job after
  `WEBUI_JOB_TIMEOUT_MS` (default 20min). If you raise `HUMAN_TIMEOUT_MS` above the watchdog,
  raise `WEBUI_JOB_TIMEOUT_MS` too, or the watchdog will kill Chrome mid-login.
- **Human-only steps:** a live recording (drive real Chrome) and a live OTP login cannot be
  automated — they are the one manual action in each of P2 / P3.

## Files (P0)

| file | role |
|------|------|
| `server.js` | node:http server, routes, static + Range serving, 127.0.0.1 bind |
| `index.js`  | read-only fs index over `artifacts/*/report.json` (mtime cache) |
| `public/index.html` · `app.js` · `app.css` | vanilla dashboard |

## Endpoints (P0)

- `GET /api/runs` → `{ runs: [{ runId, startedAt, total, passed, failed, durationMs }] }`
- `GET /api/runs/:id` → run detail with `tests: [{ name, status, durationMs, hasVideo }]`
- `GET /artifacts/<path>` → static file under `artifacts/` (Range-enabled), path-guarded
