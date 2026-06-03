# web-ui — Context

Last Updated: 2026-06-03

## SESSION PROGRESS

- 2026-06-03: **Kickoff (ultracode + dynamic /loop, self-paced).** Read SSOT (README,
  flows/SCHEMA.md, run.sh, lib/report.sh, lib/env.sh, record.cmd, probe-record.sh,
  verify-flow.sh, setup/auth.sh, record-capture-mode-context). Confirmed: Bash tool IS
  Git Bash (MINGW64, /usr/bin/bash); Node v24.14.1; disk C: 96% used (21G free); master
  clean (only untracked .heartbeat + dev/process/). CLI surface mapped (see "CLI surface"
  below). Branch `feat/web-ui-p0` cut from master. Wrote plan/context/tasks docs by hand.
  Launched WF-Arch (adversarial architecture decision). Awaiting its synthesis before P0.

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

- (pending WF-Arch) backend framework (raw http vs minimal lib), index store (fs-scan vs
  node:sqlite), frontend approach (no-build vanilla/HTMX vs SPA build). Prior: KISS +
  disk-96% ⇒ favour zero/low-dep, no-build. Will confirm with user before building P0 if
  WF-Arch surfaces a genuine fork.

## Next-session read order

1. `web-ui-plan.md` (phases, acceptance, gates, risks)
2. `web-ui-tasks.md` (checkboxes + current state)
3. this file (contract, footguns, decisions)
4. Code under `webui/` (once it exists)

## Quick resume

`cd /c/project/agent-qa` (Git Bash). On branch `feat/web-ui-p0`. Check
`web-ui-tasks.md` for the active phase. Existing CLI is DONE — never re-do it; keep
`bash run.sh` GREEN as the regression gate.
