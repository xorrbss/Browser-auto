# Human-headed verification checklist - verify-time locator repair + icon-only

Both tracks carry a HUMAN-ONLY flag: autonomous tests use synthetic or localhost fixtures, so live
behaviour on a real app needs a person to do the headed capture. Everything after capture (inspect,
verify-time repair, resolve, compile, replay) can be handled autonomously from the resulting flow and
sidecars.

`record.cmd` is the PowerShell entry point. It opens a headed browser; with `--seconds N` it
auto-stops after N seconds, builds `flows/<name>.flow.json`, and writes gitignored values/candidates
sidecars. Run it from this session with the `!` prefix, for example:

```powershell
! .\record.cmd iconverify https://example.com --seconds 60
```

Target rules for capture: single origin, no login unless using `--app <cached>`, idempotent journey,
and preferably short labelled or icon controls.

## A. icon-only

GOAL: confirm a real app's icon-only `aria-label` buttons capture as clean `role button` steps with a
stable accessible name, not `needs_review`, and replay after compile.

1. Pick a public, single-origin page with icon-only buttons: for example copy/search/menu icons, player
   controls, or your own app toolbar. If it needs login, run `setup/auth.sh` once and add
   `--app <name>`.
2. Capture, clicking three icon-only buttons:

```powershell
! .\record.cmd iconverify <url> --seconds 60
```

3. Paste me the result, or just say done. I will:
   - list each captured step and expect icon buttons to be `by:role`, `value:button`, with `name`;
   - confirm unsupported icon links, native checkbox/radio, or ambiguous auto-labels stayed
     `needs_review`;
   - resolve any leftover `needs_review`, compile, and run `bash run.sh iconverify`.

PASS = icon-only buttons capture as clean role primaries and the compiled test replays green.

## B. verify-time locator repair

GOAL: confirm locator repair happens only during `probe-record.sh verify`. Replay has no locator
fallback: compiled tests run the committed locators exactly and fail closed.

1. Capture a real, idempotent, single-origin journey:

```powershell
! .\record.cmd fbverify <url> --seconds 60
```

2. Paste me the result. I will:
   - inspect committed `find` locators and the gitignored candidates sidecar;
   - resolve any existing `needs_review`;
   - run `node bin/play-flow.mjs --flow flows/fbverify.flow.json --validate-only`;
   - intentionally corrupt one repairable primary locator in the flow, then run
     `bash bin/probe-record.sh verify flows/fbverify.flow.json`;
   - expect verify to either swap in a capture-time-unique candidate or promote the step to
     `needs_review`;
   - compile and replay only after the flow has no `needs_review` steps;
   - confirm a replay with a still-bogus committed locator goes red instead of silently trying another
     locator.

PASS = verify repairs a broken locator or marks it `needs_review`, and replay never uses fallback
locators at pass/fail time.

## Results

- A (icon-only): _pending capture_
- B (verify-time locator repair): _pending capture_
