# webui: local control plane for agent-qa

A thin local web UI over the verified agent-qa CLI. It does not reimplement run, record, auth,
verify, or compile logic; it spawns the existing tools (`run.sh`, `bin/pw-record.mjs`,
`approve/auth-pw.mjs`, `bin/play-flow.mjs`, `bin/probe-record.sh`) and visualizes their artifacts.
Keep it localhost-only unless it is fronted by an authenticated tunnel or reverse proxy.

## Run

```bash
node webui/server.js          # http://127.0.0.1:4310  (WEBUI_PORT overrides)
```

No `npm install` is needed in `webui/`; it uses Node stdlib only (`node:http`, `node:fs`,
`node:child_process`). The `package.json` lives here so `"type":"module"` is scoped to `webui/`.

Node >= 22.5 is recommended because the approvals and systems views read `lib/db.js`, which uses
built-in `node:sqlite`.

## Architecture

```text
[browser, vanilla JS] --HTTP + SSE--> [node:http server] --child_process--> bash / node CLI
```

- Backend: raw `node:http`, plain route dispatch, bound to `127.0.0.1` by default.
- Frontend: no-build vanilla JS/HTML/CSS.
- Live log: SSE from the server to the browser.
- Runs index: fs scan over `artifacts/*/report.json`; report files are the source of truth for runs.
- Job queue: in-process single-slot promise chain so only one browser-driving job runs at a time
  (`run`, `record`, `verify`, `auth`, sync/enrich drivers).

## Playwright Workflows

- Run tests: webui enqueues `bash run.sh`; compiled Playwright tests call `node bin/play-flow.mjs`.
- Auth: webui enqueues headed Playwright auth and saves
  `fixtures/auth/playwright/<app>.state.json`.
- Record: webui enqueues Playwright capture (`node bin/pw-record.mjs ...`) and writes
  `flows/<name>.flow.json` plus gitignored values/candidates sidecars.
- Verify: Playwright flows are verified by `node bin/play-flow.mjs --flow ... --verify`.
- Compile: `bin/probe-record.sh compile` emits `tests/<name>.test.sh`, preserving
  one bash file = one user journey.

## Notes / Limits

- Auth and live recording are human-supervised headed-browser jobs.
- If you raise `HUMAN_TIMEOUT_MS` for OTP, raise `WEBUI_JOB_TIMEOUT_MS` as needed so the queue watchdog
  does not kill the login.
- The webui is a process-spawning control plane. Do not expose it directly to a public network.
- Legacy non-Playwright flows may still appear in old artifacts or migration work; WebUI record,
  auth, verify, and compile paths accept Playwright flows only.

## Key Files

| file | role |
|------|------|
| `server.js` | `node:http` server, routes, static + Range serving |
| `index.js` | read-only fs index over `artifacts/*/report.json` |
| `spawn.js` | cross-platform child-process wrappers |
| `public/index.html`, `public/app.js`, `public/app.css` | vanilla dashboard |

## Selected Endpoints

- `GET /api/runs`: run summaries from `report.json`.
- `GET /api/runs/:id`: per-test status, duration, and artifact availability.
- `GET /artifacts/<path>`: static artifact serving under `artifacts/`.
- `POST /api/auth`: enqueue headed Playwright auth (`{ app, loginUrl, successUrl }`).
- `POST /api/record`: enqueue Playwright capture (`{ name, url, app?, seconds? }`).
- `POST /api/verify`: enqueue Playwright verify-repair (`{ name }`).
- `POST /api/compile`: compile the flow to a deterministic bash wrapper (`{ name }`).
