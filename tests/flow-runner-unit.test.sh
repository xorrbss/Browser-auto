#!/usr/bin/env bash
# tests/flow-runner-unit.test.sh — browser-free unit for approve/flow-runner.mjs (general-action-rpa Step C).
# The flow.json step runner takes `page` as a parameter (no Playwright import), so its dispatch + validation are
# verified here with a MOCK page that records calls. Pins: validateSteps fail-closed (unknown kind / needs_review
# / bad by/action / empty); find→Playwright dispatch; {{input_N}} substitution; an effectful non-unique locator
# (count!==1) throws; and the irreversible gate (dry-run STOPS before it + skips onBeforeIrreversible; live runs
# onBeforeIrreversible then the step). Part of the run.sh gate. No browser, no network.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module -e '
import { validateSteps, runSteps } from "./approve/flow-runner.mjs";
const assert = (c, m) => { if (!c) { console.error("  ✗ flow-runner: " + m); process.exit(1); } };

// --- validateSteps: fail-closed ---
const STEPS = [
  { kind: "find", by: "role", value: "button", name: "결재", action: "click" },
  { kind: "find", by: "role", value: "radio", name: "승인", action: "check" },
  { kind: "find", by: "placeholder", value: "의견", action: "fill", text: "자동 {{input_1}}" },
  { kind: "wait", until: "text", value: "확인" },
  { kind: "find", by: "role", value: "button", name: "확인", action: "click" },
];
assert(validateSteps(STEPS).ok === true, "a valid step sequence validates");
assert(validateSteps([]).ok === false, "empty steps ⇒ refused");
assert(validateSteps([{ kind: "frob" }]).ok === false, "unknown kind ⇒ refused");
assert(validateSteps([{ kind: "find", needs_review: true }]).ok === false, "needs_review ⇒ refused");
assert(validateSteps([{ kind: "find", by: "css", value: "x", action: "click" }]).ok === false, "bad find.by ⇒ refused");
assert(validateSteps([{ kind: "find", by: "role", value: "b", action: "frob" }]).ok === false, "bad find.action ⇒ refused");
assert(validateSteps([{ kind: "wait", until: "nope", value: "x" }]).ok === false, "bad wait.until ⇒ refused");

// --- mock page (records calls) ---
function mockPage(calls, countVal = 1) {
  const node = {
    count: async () => countVal, first: () => node,
    click: async () => calls.push("click"), fill: async (t) => calls.push("fill:" + t),
    pressSequentially: async (t) => calls.push("type:" + t), selectOption: async (v) => calls.push("select:" + v),
    check: async () => calls.push("check"), uncheck: async () => calls.push("uncheck"),
    hover: async () => calls.push("hover"), waitFor: async () => calls.push("waitFor"),
  };
  const loc = () => node;
  return {
    getByRole: (r, o) => { calls.push("role:" + r + ":" + (o ? o.name : "")); return loc(); },
    getByText: (v) => { calls.push("text:" + v); return loc(); },
    getByLabel: (v) => loc(), getByPlaceholder: (v) => { calls.push("ph:" + v); return loc(); },
    getByTestId: (v) => loc(), getByAltText: (v) => loc(), getByTitle: (v) => loc(),
    waitForURL: async (g) => calls.push("waitURL:" + g), waitForLoadState: async (s) => calls.push("waitLoad:" + s),
    keyboard: { press: async (k) => calls.push("press:" + k) }, mouse: { wheel: async (x, y) => calls.push("wheel:" + x + "," + y) },
  };
}

// --- LIVE run: irreversible gate runs onBeforeIrreversible then executes; token substituted ---
{
  const calls = [], irr = [];
  const r = await runSteps(mockPage(calls), STEPS, { irreversibleAt: 4, dryRun: false, onBeforeIrreversible: (i) => irr.push(i), resolveValue: (t) => t.replace("{{input_1}}", "승인") });
  assert(r.stoppedBeforeIrreversible === false, "live: runs to the end");
  assert(JSON.stringify(irr) === "[4]", "live: onBeforeIrreversible fired for the irreversible step (got " + JSON.stringify(irr) + ")");
  assert(calls.includes("fill:자동 승인"), "live: {{input_1}} substituted");
  assert(calls.includes("check"), "live: the 승인 radio check ran");
  assert(calls.filter((c) => c === "click").length === 2, "live: both clicks ran incl. the irreversible 확인 (got " + calls.filter((c) => c === "click").length + ")");
}

// --- DRY-RUN: STOP before the irreversible step; onBeforeIrreversible NOT called; 확인 click NOT executed ---
{
  const calls = [], irr = [];
  const r = await runSteps(mockPage(calls), STEPS, { irreversibleAt: 4, dryRun: true, onBeforeIrreversible: (i) => irr.push(i) });
  assert(r.stoppedBeforeIrreversible === true, "dry-run: stopped before the irreversible step");
  assert(irr.length === 0, "dry-run: onBeforeIrreversible NOT called");
  assert(calls.filter((c) => c === "click").length === 1, "dry-run: only the FIRST (reversible) click ran, NOT 확인 (got " + calls.filter((c) => c === "click").length + ")");
}

// --- FAIL-CLOSED irreversible-gate config (red-team: never run a commit un-gated) ---
{ let t = false; try { await runSteps(mockPage([]), STEPS, { dryRun: false, irreversibleAt: 99, onBeforeIrreversible: () => {} }); } catch { t = true; } assert(t, "out-of-range irreversibleAt ⇒ refused"); }
{ let t = false; try { await runSteps(mockPage([]), STEPS, { dryRun: false, irreversibleAt: 3, onBeforeIrreversible: () => {} }); } catch { t = true; } assert(t, "non-effectful irreversibleAt (a wait step) ⇒ refused"); }
{ let t = false; try { await runSteps(mockPage([]), STEPS, { dryRun: false, irreversibleAt: 4 }); } catch { t = true; } assert(t, "live without onBeforeIrreversible ⇒ refused"); }
{ let t = false; try { await runSteps(mockPage([]), STEPS, { dryRun: false, irreversibleAt: -1, onBeforeIrreversible: () => {} }); } catch { t = true; } assert(t, "effectful steps but no irreversibleAt ⇒ refused (fail-closed)"); }
// a genuinely reversible action opts out: effectful steps, no irreversible gate, reversible:true ⇒ runs (no throw)
{ let ok = true; try { await runSteps(mockPage([]), [{ kind: "find", by: "label", value: "x", action: "fill", text: "y" }], { dryRun: false, reversible: true }); } catch { ok = false; } assert(ok, "reversible:true runs effectful steps without an irreversible gate"); }

// --- FAIL-CLOSED: an effectful find whose locator is NOT unique (count 2) throws (with a valid gate) ---
{
  let threw = false;
  try { await runSteps(mockPage([], 2), [{ kind: "find", by: "role", value: "button", name: "x", action: "click" }], { dryRun: false, irreversibleAt: 0, onBeforeIrreversible: () => {} }); } catch { threw = true; }
  assert(threw, "non-unique effectful locator (count 2) ⇒ throws (fail-closed)");
}
// hover is non-effectful ⇒ no uniqueness gate (count 2 is fine)
{
  let ok = true;
  try { await runSteps(mockPage([], 2), [{ kind: "find", by: "text", value: "x", action: "hover" }], { dryRun: false }); } catch { ok = false; }
  assert(ok, "hover (non-effectful) does NOT require uniqueness");
}

console.log("  ✓ flow-runner: validate + dispatch + irreversible gate + fail-closed uniqueness all pass");
' )
