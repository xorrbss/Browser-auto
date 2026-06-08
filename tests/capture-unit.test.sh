#!/usr/bin/env bash
# tests/capture-unit.test.sh — browser-free unit for webui/capture.js (UI approve-capture Gate-B, Phase 1a).
# Pins: buildPreviewRecipe builds a NON-committed preview block, STRIPS enabled:false so an uncaptured action
# RESOLVES for a DRY test (verified against the real resolveAction), never mutates the input, fail-closes to null
# when there is no block; listCaptureFlows lists only approve-<app>-* flows; sweepOldPreviews prunes stale temps.
# No browser, no network, no recipe write.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module -e '
import { buildPreviewRecipe, listCaptureFlows, sweepOldPreviews } from "./webui/capture.js";
import { resolveAction } from "./approve/guards.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const assert = (c, m) => { if (!c) { console.error("  ✗ capture: " + m); process.exit(1); } };

const rec = { app: "x", actions: { approve: { button: { name: "결재" }, titleField: "title" }, reject: { enabled: false, button: { name: "결재" } } } };
const pa = buildPreviewRecipe(rec, "approve", null);
assert(pa && pa.actions.approve.button.name === "결재", "existing approve block used");
assert(resolveAction(pa, "approve").ok === true, "preview approve resolves");
const pr = buildPreviewRecipe(rec, "reject", null);
assert(pr && pr.actions.reject.enabled === undefined, "reject enabled:false STRIPPED in preview");
assert(resolveAction(pr, "reject").ok === true, "a disabled action RESOLVES in the dry preview (dry never commits)");
const pb = buildPreviewRecipe(rec, "approve_합의", { button: { name: "결재" }, decision: { name: "합의" } });
assert(pb && pb.actions["approve_합의"].decision.name === "합의", "operator-supplied block injected");
assert(resolveAction(pb, "approve_합의").ok === true, "custom block resolves");
assert(buildPreviewRecipe(rec, "nope", null) === null, "no block to test ⇒ null (fail-closed)");
const leg = buildPreviewRecipe({ approve: { button: { name: "결재" } } }, "approve", null);
assert(leg && resolveAction(leg, "approve").ok === true, "legacy top-level approve fallback");
assert(rec.actions.reject.enabled === false, "buildPreviewRecipe does NOT mutate the committed recipe");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cap-"));
fs.mkdirSync(path.join(tmp, "flows"), { recursive: true });
fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
fs.writeFileSync(path.join(tmp, "flows", "approve-hiworks-1.flow.json"), "{}");
fs.writeFileSync(path.join(tmp, "flows", "approve-hiworks-2.flow.json"), "{}");
fs.writeFileSync(path.join(tmp, "flows", "login.flow.json"), "{}");
const flows = listCaptureFlows(tmp, "hiworks");
assert(flows.length === 2, "lists exactly the 2 approve-hiworks flows (got " + flows.length + ")");
assert(flows.every((f) => f.name.startsWith("approve-hiworks-")), "only approve-<app>-* flows");
const oldF = path.join(tmp, "data", ".capture-preview-old.json");
const newF = path.join(tmp, "data", ".capture-preview-new.json");
fs.writeFileSync(oldF, "{}"); fs.writeFileSync(newF, "{}");
const past = (Date.now() - 20 * 60 * 1000) / 1000;
fs.utimesSync(oldF, past, past);
sweepOldPreviews(tmp, 600000);
assert(!fs.existsSync(oldF), "stale preview swept");
assert(fs.existsSync(newF), "fresh preview kept");
fs.rmSync(tmp, { recursive: true, force: true });
console.log("  ✓ capture: buildPreviewRecipe + listCaptureFlows + sweepOldPreviews OK");
' )
