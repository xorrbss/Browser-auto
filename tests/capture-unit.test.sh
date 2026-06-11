#!/usr/bin/env bash
# tests/capture-unit.test.sh — browser-free unit for webui/capture.js (UI approve-capture Gate-B, Phase 1a).
# Pins: buildPreviewRecipe builds a NON-committed preview block, STRIPS enabled:false so an uncaptured action
# RESOLVES for a DRY test (verified against the real resolveAction), never mutates the input, fail-closes to null
# when there is no block; listCaptureFlows lists only approve-<app>-* flows; sweepOldPreviews prunes stale temps.
# No browser, no network, no recipe write.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module -e '
import { buildPreviewRecipe, listCaptureFlows, sweepOldPreviews, assembleActionBlock, enableActionInRecipe } from "./webui/capture.js";
import { resolveAction } from "./approve/guards.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const assert = (c, m) => { if (!c) { console.error("  ✗ capture: " + m); process.exit(1); } };

const rec = { app: "x", actions: {
  approve: { button: { name: "결재" }, decision: { name: "승인" }, confirm: { name: "확인" }, success: "leftInbox", titleField: "title" },
  reject: { enabled: false, button: { name: "결재" }, decision: { name: "반려" }, opinion: { placeholder: "사유", text: "반려 사유" }, confirm: { name: "확인" }, success: "leftInbox" }
} };
const pa = buildPreviewRecipe(rec, "approve", null);
assert(pa && pa.actions.approve.button.name === "결재", "existing approve block used");
assert(resolveAction(pa, "approve").ok === true, "preview approve resolves");
const pr = buildPreviewRecipe(rec, "reject", null);
assert(pr && pr.actions.reject.enabled === undefined, "reject enabled:false STRIPPED in preview");
assert(resolveAction(pr, "reject").ok === true, "a disabled action RESOLVES in the dry preview (dry never commits)");
const pb = buildPreviewRecipe(rec, "approve_합의", { button: { name: "결재" }, decision: { name: "합의" }, confirm: { name: "확인" }, success: "leftInbox" });
assert(pb && pb.actions["approve_합의"].decision.name === "합의", "operator-supplied block injected");
assert(resolveAction(pb, "approve_합의").ok === true, "custom block resolves");
assert(buildPreviewRecipe(rec, "nope", null) === null, "no block to test ⇒ null (fail-closed)");
const leg = buildPreviewRecipe({ approve: { button: { name: "결재" }, decision: { name: "승인" }, confirm: { name: "확인" }, success: "leftInbox" } }, "approve", null);
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
// --- assembleActionBlock (Phase 1b): recorded flow + checklist → actions.<form> block, fail-closed ---
const flow = { name: "approve-hiworks-1", steps: [
  { kind: "find", by: "role", value: "row", name: "IB-지출(거래처)-…", action: "click" },
  { kind: "find", by: "role", value: "button", name: "결재", action: "click" },
  { kind: "find", by: "role", value: "radio", name: "승인", action: "check" },
  { kind: "find", by: "placeholder", value: "의견을 입력하세요.", action: "fill", text: "{{input_1}}" },
] };
const facts = { confirmName: "확인", formType: ["지출결의서(거래처)"], amountLabel: "총 금액", success: "leftInbox" };
const ab = assembleActionBlock(flow, facts);
assert(ab.ok === true, "valid flow + facts ⇒ ok");
assert(ab.block.button.name === "결재" && ab.block.button.exact === true, "결재 button extracted");
assert(ab.block.decision.name === "승인", "승인 decision radio extracted");
assert(ab.block.opinion.placeholder === "의견을 입력하세요.", "의견 opinion fill extracted");
assert(ab.block.confirm.name === "확인", "확인 confirm pinned from facts");
assert(ab.block.enabled === false, "assembled block is FAIL-CLOSED (enabled:false)");
assert(ab.block.amount.label === "총 금액" && JSON.stringify(ab.block.formType) === JSON.stringify(["지출결의서(거래처)"]), "amount/formType facts carried");
assert(assembleActionBlock({ steps: [{ kind: "find", by: "role", value: "button", name: "결재", action: "click" }] }, facts).ok === false, "no decision radio ⇒ refused");
assert(assembleActionBlock(flow, {}).ok === false, "no confirmName ⇒ refused (capture stops before 확인)");
// the assembled block RESOLVES for a dry-run (chain into buildPreviewRecipe → resolveAction)
const prev = buildPreviewRecipe({ actions: {} }, "approve_지출", ab.block);
assert(resolveAction(prev, "approve_지출").ok === true, "assembled block resolves for the dry-run test");

// --- enableActionInRecipe (Phase 2): atomic-write content; forces enabled:true + capture meta, fail-closed ---
const committed = { app: "hiworks", actions: { approve: { button: { name: "결재" } } } };
const goodBlock = { enabled: false, button: { role: "button", name: "결재", exact: true }, decision: { role: "radio", name: "승인" }, confirm: { role: "button", name: "확인", exact: true }, success: "leftInbox" };
const en = enableActionInRecipe(committed, "approve_지출", goodBlock, { date: "2026-06-08T00:00:00Z", by: "op", notes: "watched stamp" });
assert(en.ok === true, "valid block enables");
assert(en.recipe.actions["approve_지출"].enabled === true, "FORCES enabled:true");
assert(en.recipe.actions["approve_지출"].capture.confirmed === true && en.recipe.actions["approve_지출"].capture.by === "op", "capture metadata stamped");
assert(en.recipe.actions.approve.button.name === "결재", "existing actions preserved");
assert(committed.actions["approve_지출"] === undefined, "enableActionInRecipe does NOT mutate the input recipe");
assert(enableActionInRecipe(committed, "x", { button: { name: "결재" }, decision: { name: "승인" } }, {}).ok === false, "missing confirm.name ⇒ refused (fail-closed)");
assert(enableActionInRecipe(committed, "x", { button: { name: "결재" }, confirm: { name: "확인" } }, {}).ok === false, "missing decision.name ⇒ refused");
assert(enableActionInRecipe(committed, "", goodBlock, {}).ok === false, "empty action ⇒ refused");

console.log("  ✓ capture: buildPreviewRecipe + listCaptureFlows + sweepOldPreviews + assembleActionBlock + enableActionInRecipe OK");
' )
