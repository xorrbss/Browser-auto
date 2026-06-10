# Internal Pilot Open Runbook

Status: active
Date: 2026-06-10
Scope: single-operator internal pilot opening for Browser-auto on Windows + Git Bash.

This runbook is for a supervised internal pilot only. It assumes a trusted Windows host, Git Bash,
loopback webui or an authenticated tunnel, and no unattended live actions. Replay remains
deterministic and AI-free.

Data-handling baseline: follow `SECURITY-DATA-POLICY.md` for threat boundaries, audit retention,
artifact retention, and export rules. Internal pilot artifacts and logs stay local unless reviewed and
redacted.

## 1. Preconditions

- Run from `C:\project\Browser-auto` on Windows.
- Use Git Bash at `C:\Program Files\Git\bin\bash.exe`; do not run pilot shell gates from PowerShell
  directly unless PowerShell is only launching Git Bash.
- Confirm `node`, `jq`, `ffmpeg`, Chrome, and the Playwright runtime under `approve/` are installed.
- Keep webui on `127.0.0.1` or behind an authenticated tunnel/reverse proxy.
- Keep noVNC on localhost or behind external authentication.
- Confirm `fixtures/auth/`, `approve/*.pw-state.json`, `flows/*.values.json`, `data/`, and
  `artifacts/` are gitignored and not exposed by webui.
- Start from a known worktree state and do not mix pilot flow edits with unrelated changes.
- Read `README.md` and `flows/SCHEMA.md` before changing recorder, runner, compiler, or flow format
  behavior.

Git Bash launch pattern:

```powershell
& 'C:\Program Files\Git\bin\bash.exe' -lc 'cd /c/project/Browser-auto && <command>'
```

## 2. Opening Checks

Run these before any target-system login or browser automation:

```bash
git status --short --branch
node --version
jq --version
ffmpeg -version
cd approve && npm ci && npx playwright install chrome && cd ..
```

Run deterministic code and smoke checks:

```bash
while IFS= read -r f; do node --check "$f" >/dev/null || exit 1; done < <(rg --files -g "*.js" -g "*.mjs" -g "*.cjs")
bash tests/build-flow-unit.test.sh
bash tests/compile-engine-unit.test.sh
bash tests/play-flow-smoke.test.sh
bash run.sh
```

If `bash run.sh` includes a flow that depends on stale live auth, remove that flow from the pilot gate
until auth is refreshed on the operator host. Do not treat auth expiration as a product pass/fail.

## 3. Auth State Capture And Handling

Capture auth only with a human present:

```bash
bash setup/auth.sh <app> <login-url> '<success-url>'
```

Expected local outputs:

- Playwright flow auth: `fixtures/auth/playwright/<app>.state.json`
- Approve compatibility auth, when created by approve login paths: `approve/<app>.pw-state.json`
- Flow values: `flows/<flow-name>.values.json`

Rules:

- Auth state is a local credential. Never commit, paste into tickets, upload to chat, or expose through
  the webui static server.
- OTP, passwords, cookies, headers, `.values.json`, DB files, screenshots, videos, and reports stay on
  the operator host.
- Refresh auth when the target host, operator account, tenant, MFA session, or target domain changes.
- Delete state after the pilot if the target system owner asks for credential revocation or session
  cleanup.

## 4. Live-Auth-Dependent Test Policy

Some tests are deterministic in code but depend on live browser state. Treat them as environment-gated:

- A compiled Playwright wrapper may enter the pilot gate only after its `<app>` auth fixture was captured
  on the current operator host.
- If a flow fails because it lands on login, MFA, expired session, or wrong tenant, refresh auth and rerun
  before filing a product defect.
- If a flow contains `needs_review`, `@eN` refs, missing transition waits, or non-unique locators, stop
  and repair the flow before compile or replay.
- Do not add legacy `engine: "agent-browser"` flows to the pilot gate. Migrate to `engine: "playwright"`
  first or list them as explicit debt.

## 5. Read-Only Smoke Path

Use read-only smoke before any effectful action:

```bash
node bin/play-flow.mjs --flow flows/<flow-name>.flow.json --validate-only
bash bin/probe-record.sh verify flows/<flow-name>.flow.json
bash bin/probe-record.sh compile flows/<flow-name>.flow.json
bash tests/<flow-name>.test.sh
bash run.sh <flow-name>
```

Pass criteria:

- The wrapper exits zero and any `.success` marker expected by the test is verified directly.
- The flow has semantic locators only: `testid`, `role`, `label`, `text`, `placeholder`, `alt`, or
  `title`.
- Every navigation or state transition is gated by URL, text, load, or an equivalent settled-page wait.
- Artifacts under `artifacts/<RUN_ID>/` are reviewed and kept local.

## 6. Sync, Enrich, And Dry-Run

For a registered system, use read drivers first:

```bash
bash bin/sync-system.sh --system <app>
bash bin/enrich-system.sh --system <app> --limit 10
bash bin/enrich-system.sh --system <app> --key <record-key>
```

Equivalent direct driver:

```bash
node bin/pw-rpa.mjs sync --system <app>
node bin/pw-rpa.mjs enrich --system <app> --limit 10
node bin/pw-rpa.mjs enrich --system <app> --key <record-key>
```

Dry-run effectful candidates only after sync/enrich produced records and the operator reviewed the
target set in webui:

- Use webui `POST /api/agent/plan/:id/dry-run` through the UI, not a hand-built curl, so plan hash,
  target selection, and job streaming stay attached.
- For approve-like actions, dry-run is the default behavior of `approve/approve-run.mjs`; live requires
  explicit `--live`.
- Inspect dry-run job logs, audit rows, target keys, screenshots/video, and any failure/skipped reasons
  before live consideration.

## 7. Live Action Policy

Live action is forbidden unless all conditions below are true:

- The action is operator-requested in the current session and the operator is watching the browser/job.
- The target list came from synced records, enriched detail where required, and a reviewed checkbox set.
- A dry-run was run for the same plan hash and target keys.
- The recipe action was captured, reviewed, and enabled intentionally.
- The batch has a small positive max count. `approve/approve-run.mjs --live` must include `--max N`.
- The kill switch was tested or at least its path is known: `data/approve-STOP` and `/api/approve/stop`.
- Completion is positively verified by the runner/audit, not inferred from process exit alone.

Live action is always forbidden for:

- Scheduler/unattended paths.
- Unreviewed or auto-selected target sets.
- Missing, expired, or wrong-account auth state.
- Flows with `needs_review`, `@eN`, ambiguous locators, or missing transition gates.
- Publicly exposed webui/noVNC without authentication.
- Any run where the operator cannot explain rollback and cleanup before clicking confirm.

## 8. Rollback And Cleanup

Stop first, then clean:

```bash
mkdir -p data
touch data/approve-STOP
```

In webui, use the job cancel/stop control when available. After the browser stops, inspect:

- `data/approve-audit.jsonl`
- `artifacts/<RUN_ID>/report.json`
- `artifacts/<RUN_ID>/report.junit.xml`
- screenshots and videos under the same artifact run directory

Rollback is target-system-specific. Browser-auto can stop future actions and provide audit evidence; it
cannot universally undo a committed business action. If a live action committed incorrectly, notify the
target system owner, use the target system's native reversal process, and keep the local artifacts until
the incident is closed.

Cleanup commands after review:

```bash
rm -f data/approve-STOP
rm -rf artifacts/<RUN_ID>
rm -f fixtures/auth/playwright/<app>.state.json
rm -f approve/<app>.pw-state.json
rm -f flows/<flow-name>.values.json
```

Only delete auth state after all evidence needed for troubleshooting is captured. Never commit cleanup
deletions of gitignored local files as product changes.

## 9. Closeout

Before opening another target system:

- Record final status: go, no-go, or partial.
- List flow names, recipe names, auth refresh time, run IDs, and artifact locations.
- Classify open issues as P0/P1/P2.
- Confirm no local auth state, values, DB, artifacts, screenshots, or videos were staged.
- Run `git status --short -- dev/active/productization` and commit only productization documentation
  changes if requested.
