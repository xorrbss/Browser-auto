# Human-headed verification checklist — replay-fallback (#1) + icon-only (#3)

Both merged tracks carry a HUMAN-ONLY flag: their autonomous tests use synthetic / example.com
fixtures, so live behaviour on a real app needs a person to do the *headed capture*. Everything after
the capture (inspect / resolve / compile / replay) is autonomous — paste the flow back and I run it.

`record.cmd` = the only PowerShell entry point. It opens a HEADED browser; with `--seconds N` it
auto-stops after N seconds (no Enter needed), builds `flows/<name>.flow.json` (+ gitignored
`values`/`candidates` sidecars). Run it from this session with the `!` prefix, e.g.
`! .\record.cmd iconverify https://example.com --seconds 60`.

Target rules (capture scope): **single origin, no login** (or use `--app <cached>`), drive a real
journey, prefer clicking **short labelled / icon** controls.

---

## A. icon-only (#3) — the primary, most directly verifiable

GOAL: confirm a real app's icon-only `aria-label` buttons capture as CLEAN `role button --name … --exact`
steps (not `needs_review`) and replay.

1. Pick a public, single-origin page with **icon-only buttons** (no visible text, just an icon, with a
   tooltip/aria-label): e.g. a docs site's copy/search/menu icons, a player's play/mute icons, your
   own app's toolbar. (If it needs login, run `setup/auth.sh` once and add `--app <name>`.)
2. Capture, clicking 3–6 icon-only buttons:
   `! .\record.cmd iconverify <url> --seconds 60`
3. Paste me the result (or just say done) — I will:
   - list each captured step; **expect icon buttons → `by:role value:button name:"…"`, `needs_review:false`**;
   - confirm icon **links** / native checkbox/radio / aria-labelledby / auto-labels stayed `needs_review`
     (correct — the engine won't resolve those as a primary);
   - resolve any leftover `needs_review`, `compile`, and `run.sh iconverify` — **expect GREEN**
     (the `role …--exact` primaries resolve on the real page).

PASS = ≥1 icon-only button captured as a clean role primary AND the compiled test replays green.

---

## B. replay-fallback (#1) — secondary, on a real multi-step flow

GOAL: confirm the fallback ladder is built from real capture candidates, and a fallback actually FIRES
(loud) on a real flow when the primary is made to fail — and an all-fail step still goes RED.

1. Capture a real, **idempotent**, single-origin journey (a few clicks/inputs, ideally ending on a
   stable URL): `! .\record.cmd fbverify <url> --seconds 60`
2. Paste me the result — I will (autonomous):
   - resolve any `needs_review`, set `"replayFallback": true`, `compile`, `run.sh fbverify` → baseline
     GREEN (ladder baked, no fallback fires because the primary still works);
   - count how many steps got a `_find_fb` ladder (`grep -c '^_find_fb '`);
   - **induce a fire**: on one step that has a count==1 fallback, corrupt its PRIMARY locator to a bogus
     value, recompile, `run.sh fbverify` → expect a loud `⚠ FALLBACK` line + still GREEN (the unique
     fallback rescues it on a REAL flow, not just the synthetic test);
   - corrupt the fallback too → expect RED with `no locator resolved` (no false-green).

PASS = real flow compiles with ≥1 fallback ladder; induced-failure run logs `⚠ FALLBACK` and stays
green; all-fail variant goes red.

---

## Results (filled after the captures)

- A (icon-only): _pending capture_
- B (replay-fallback): _pending capture_
