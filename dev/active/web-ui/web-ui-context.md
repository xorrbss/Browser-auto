# web-ui — Context

Last Updated: 2026-06-03

## SESSION PROGRESS

- 2026-06-03: **Kickoff (ultracode + dynamic /loop, self-paced).** Read SSOT (README,
  flows/SCHEMA.md, run.sh, lib/report.sh, lib/env.sh, record.cmd, probe-record.sh,
  verify-flow.sh, setup/auth.sh, record-capture-mode-context). Confirmed: Bash tool IS
  Git Bash (MINGW64, /usr/bin/bash); Node v24.14.1; disk C: 96% used (21G free); master
  clean (only untracked .heartbeat + dev/process/). CLI surface mapped (see "CLI surface"
  below). Branch `feat/web-ui-p0` cut from master. Wrote plan/context/tasks docs by hand.
  Launched WF-Arch (adversarial architecture decision). Committed foundation docs (4358560).
- 2026-06-03: **Architecture LOCKED** (WF-Arch synthesis — see DECISIONS). No user gate
  needed. Established a fresh **GREEN baseline: `bash run.sh` 7/7** (artifacts/
  20260603-130328-189078) — also serves as P0 fixture data + the regression baseline.
- 2026-06-03: **P0 dashboard BUILT + empirically verified.** webui/{server.js,index.js,
  public/{index.html,app.js,app.css},package.json,.gitignore,README.md}. Zero npm deps.
  `node --check` clean; isolation confirmed (only webui/ added; no existing tracked file
  touched; no root package.json). Live-verified on :4310 — GET /api/runs (1 run, 7/7),
  GET /api/runs/:id (per-test status + hasVideo true/false correct), video.webm full(200)
  + Range(206, exact bytes), static MIME, bad-id/404/traversal all 404 (no source leak).
  Then launched WF-Review-P0 (5-dim adversarial review).
- 2026-06-03: **WF-Review-P0 (26 agents, ~718k tok): 18 findings / 14 confirmed.** Zero
  architecture-fidelity / thin-layer / XSS findings (build validated). 6 distinct real bugs
  fixed in server.js+index.js: (HIGH) `createReadStream().pipe(res)` had no `'error'`
  handler ⇒ a read error / Windows EBUSY would crash the whole single-process server, and
  leaked the fd on client-abort ⇒ both fixed with `stream.pipeline`; (LOW) malformed `%` in
  run id → 500→404; no `server.on('error')` → EADDRINUSE crash → graceful exit; RUN_ID date
  round-trip (Date rolls 99/99 over); 416 now sends Accept-Ranges; static fall-through
  existsSync TOCTOU 500 → direct serveFile. All re-verified live (happy path + each fix).
  **P0 committed + merged to master (--no-ff).** NEXT: P1 (run trigger + single-slot serial
  queue + spawn run.sh via Git-Bash + SSE live log; re-run full suite at the P1 milestone
  since P1 introduces a code path that interacts with run.sh).

- 2026-06-03: **P1 run-trigger + single-slot serial queue + SSE: BUILT, hardened, merged.**
  webui/spawn.js (gitBash + killTree), webui/jobs.js (serial promise-chain queue, ring-buffer
  log, SSE fan-out, watchdog, cancel), server.js (POST /api/run, GET /api/queue,
  /api/jobs/:id[/stream], SIGINT/SIGTERM shutdown), app.js (run bar + EventSource log + cancel).
  **Serialization PROVEN** (j2.startedAt ≥ j1.endedAt; queue snapshot busy+pending). SSE live +
  reconnect-replay verified. **Full suite via web 7/7 exit 0** (GREEN gate). WF-Review-P1 (32
  agents, 27 findings/16 confirmed; 0 serialization/injection/XSS breaks) → fixed: child
  watchdog (WEBUI_JOB_TIMEOUT_MS, default 20min) + `taskkill /PID <pid> /T /F` tree-kill +
  cancel route + shutdown kill (HIGH: wedged child could brick the queue / orphan the
  run.sh→agent-browser→Chrome tree); EventSource close-before-open + reconnect-clear + onerror.
  Cancel-of-running verified (tree-killed, queue freed). Merged --no-ff to master.
  - **NEW footgun**: cancelling/killing a RUNNING browser job `taskkill /T`s the shared
    agent-browser daemon too → the next run.sh preflight re-warms it but runs noticeably
    SLOWER until orphans clear (saw a full suite go 262s→461s after a cancel; still GREEN, well
    under the 20min watchdog). Inherent to the single shared daemon; not a code defect.

## Execution contract

- Web layer lives ONLY under `webui/`. Backend = Node; it **spawns the existing bash CLI**
  via child_process (Git Bash for `run.sh`/`probe-record.sh`/`verify-flow.sh`/`auth.sh`;
  PowerShell for `record.cmd`). It NEVER reimplements test/record/verify/compile logic.
- **Single-slot browser-job queue** in the server: at most one browser-driving spawn
  (run / capture / verify / auth) active at a time. Read-only indexing endpoints are not
  queued.
- Verification is always by parsing `--json`/fields/JSON output, never by exit code
  (inherited framework footgun).
- localhost bind only. No external exposure. No new heavyweight deps without justification
  (disk-constrained; KISS/YAGNI per global CLAUDE.md).
- Existing `bash run.sh` suite GREEN is the regression gate for every change.

## CLI surface the web layer wraps (do NOT reimplement)

- **Run / suite:** `bash run.sh [name-glob]` — owns daemon + ffmpeg PATH; writes
  `artifacts/<RUN_ID>/report.json` (+ `report.junit.xml`, `results.tsv`, per-test
  subdirs). `RUN_ID = YYYYMMDD-HHMMSS-PID`. Exit 1 if any test failed.
- **report.json shape:** array of `{name, status("pass"|"fail"), durationMs, artifacts}`
  where `artifacts` is an ABSOLUTE path `…/artifacts/<RUN_ID>/<name>`. The per-test dir
  holds `video.webm` + screenshots. (For URLs, derive run-id from the dir name and test
  name from the row — don't trust the absolute path verbatim across machines.)
- **Author/record:** `record.cmd <name> <startUrl> [--app a] [--seconds N]` (PowerShell
  launcher → `bin/probe-record.sh capture` in real headed Chrome) →
  `flows/<name>.flow.json` + gitignored `flows/<name>.values.json` (real values;
  `{{input_N}}` tokens in the flow) + gitignored `flows/<name>.candidates.json`.
- **probe-record.sh modes:** `scaffold <name> <url>` | `capture …` | `verify <flow>` (→
  `bin/verify-flow.sh`, re-drive + repair/promote) | `compile <flow>` (→
  `tests/<name>.test.sh`; **refuses** any `needs_review:true` step, exit 1).
- **flow.json schema:** see flows/SCHEMA.md. `find` steps: by ∈
  {testid,role,label,text,placeholder,alt,title}; `needs_review:true` + `candidates[]`
  (≥2 `{by,value,name?,count}`) when no unique locator; `{{input_N}}` tokens for
  fill/type/select.
- **Auth:** `bash setup/auth.sh <app> <login_url> <success_url>` → headed Chrome, human
  completes OTP, polls `get url` until SUCCESS_URL → saves `fixtures/auth/<app>.state.json`
  (gitignored).

## Footguns (env — strictly observe; prior work burned time here)

- **bash = Git Bash (MINGW64) only.** PowerShell's `bash` = WSL = broken. Repo path under
  Git Bash is `/c/project/agent-qa`. Only `record.cmd` runs under PowerShell.
- **Single shared daemon = serial.** NEVER fan out browser-driving work in parallel
  (wedge). Parallelize only read-only analysis/review/audit workflows.
- **Daemon wedge** (calls hang ~34s; locators suddenly "Element not found"): Stop-Process
  -Force only the `chrome.exe` whose ExecutablePath contains `\.agent-browser\browsers\`
  (Chrome-for-Testing) — NEVER Program Files Chrome — and kill the daemon
  (`agent-browser-win32-x64`); next `run.sh` preflight re-warms. Orphan accumulation =
  flakiness.
- **Disk:** C: ~96% (21G free). At 100% the shell breaks (temp mkdir ENOSPC). Recover:
  Write-truncate a large text file → restore shell → clean
  `/c/Users/dream/AppData/Local/Temp/claude/browser-use-user-data-dir-*` orphans + old
  `artifacts/*`. (machine memory: disk-full-recovery.)
- **cold-spawn agent-browser piped to `$()`/`|tail` HANGS** (daemon holds stdout fd) →
  redirect to a file (`>f 2>&1 </dev/null`) or warm the daemon first.
- **agent-browser CLI quirks:** `find role --name` unreliable (prefer text/label/testid);
  `wait --url <glob>` broken (poll `get url` / use lib `wait_url`); `get count` is
  CSS-selector only.
- **Review/analysis workflow agents must be told: read-only, no file create/modify/exec in
  the repo** (prior work polluted scratch). Run `git status` after each workflow to verify.

## DECISIONS

- **2026-06-03 — Architecture LOCKED by WF-Arch** (7-agent adversarial: 3 proposals →
  skeptic judges → synthesis; `userDecisionNeeded=false`, constraints fully determined it;
  no user gate needed). The judges caught and the synthesis fixed two real bugs in the
  naive proposals (see footguns below). Stack:
  - **Backend:** raw `node:http`, plain switch dispatch on (method+pathname), bound to
    `127.0.0.1` ONLY. No framework (Express/Fastify would add 50–300 packages to save ~80
    lines of stdlib glue — unjustified at 96% disk, violates KISS/YAGNI).
  - **Live log (P1+):** SSE (one-way server→browser). No WebSocket (no stable stdlib WS
    server ⇒ would force a dep or ~150 lines of RFC6455).
  - **Index store:** in-process **mtime-keyed Map cache over an fs-scan** of
    `artifacts/*/report.json`. NOT `node:sqlite` — it is **experimental on Node
    v24.14.1** (emits ExperimentalWarning) and would be a 2nd source of truth. fs stays
    authoritative; cache is rebuildable. Defer sqlite to P3-if-measured-slow.
  - **Frontend:** **no-build vanilla JS/HTML/CSS** (3 files). No framework/bundler — a
    SvelteKit/Vite toolchain (200–400MB node_modules/.svelte-kit) risks ENOSPC at 96%
    disk and would commit generated build output to git.
  - **Serial queue (P1+):** in-process single-slot promise chain (`let tail =
    Promise.resolve()`); jobFn MUST await child `'close'` (not `'exit'`) before resolving;
    don't swallow failures (record status+exitCode); busy-flag + pending FIFO for
    `GET /api/queue`; read-only endpoints bypass the queue.
  - **CLI spawn:** `node:child_process.spawn` with `shell:false` + array args (no
    injection), `cwd=PROBE_ROOT`, in `webui/spawn.js`. Bash:
    `spawn('C:\\Program Files\\Git\\bin\\bash.exe', [scriptRel, ...args], {windowsHide:true})`
    — run `['run.sh',glob]`, verify `['bin/probe-record.sh','verify',flow]`, compile
    `['bin/probe-record.sh','compile',flow]`, auth `['setup/auth.sh',app,login,success]`
    (POSITIONAL). Recorder: `spawn('cmd.exe', ['/c','record.cmd',name,url,...,'--seconds',N],
    {windowsHide:false})`.
  - **npm deps: NONE.** `package.json` lives in `webui/` (NOT repo root) so `"type":
    "module"` is scoped to webui/ and never changes how `bin/*.js` parse.
- **Two judge-proven fixes (carried into P2 design):**
  1. **Recorder stdin-newline stop is BROKEN** — `probe-record.sh capture()` reads its stop
     from `/dev/tty` (read -t 1 ... </dev/tty), not stdin, when a headed window is present;
     a newline written to the child's stdin is ignored. ⇒ `--seconds N` auto-stop is the
     **mandatory, only web-drivable** stop path; add a queue-slot watchdog so a hung headed
     Chrome can't starve the single slot. The web "Stop" = honest "auto-stops after N s" (or
     a taskkill early-kill yielding a degraded/partial capture).
  2. **needs_review "resolve" has NO CLI command** (`verify-flow.sh` refuses to drive past
     needs_review; no resolve/accept subcommand). ⇒ resolving is a **UI-owned `flow.json`
     mutation** in `webui/flows.js` (write the picked candidate's {by,value,name?} as the
     step locator, delete needs_review+candidates; write {{input_N}} → values.json). This is
     the documented human edit, NOT a CLI reimplementation — do not mislabel it.

## Next-session read order

1. `web-ui-plan.md` (phases, acceptance, gates, risks)
2. `web-ui-tasks.md` (checkboxes + current state)
3. this file (contract, footguns, decisions)
4. Code under `webui/` (once it exists)

## Quick resume

`cd /c/project/agent-qa` (Git Bash). On branch `feat/web-ui-p0`. Check
`web-ui-tasks.md` for the active phase. Existing CLI is DONE — never re-do it; keep
`bash run.sh` GREEN as the regression gate.
