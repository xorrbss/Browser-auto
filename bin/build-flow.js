#!/usr/bin/env node
// bin/build-flow.js — host-side converter: raw captured records -> flows/<name>.flow.json
// (+ gitignored flows/<name>.values.json sidecar). Kept out of probe-record.sh because the
// transform (tokenization, wait-gate insertion, URL-glob normalization, needs_review) is
// real logic that pure bash/jq would bloat past the file-size rule (plan R5 allows this split).
//
// Usage: node bin/build-flow.js <name> <startUrl> <app|""> <records.json> <flowsDir>
//   records.json = JSON array of RecordedAction (see bin/capture.js), in capture order.
// Writes <flowsDir>/<name>.flow.json and, if any non-sensitive values, <name>.values.json.
// Prints a human summary (needs_review / masked / values counts + every committed key) to stderr.
'use strict';
const fs = require('fs');
const path = require('path');

const [, , name, startUrl, app, recordsPath, flowsDir] = process.argv;
if (!name || !startUrl || !recordsPath || !flowsDir) {
  console.error('usage: build-flow.js <name> <startUrl> <app|""> <records.json> <flowsDir>');
  process.exit(2);
}
let records;
try { records = JSON.parse(fs.readFileSync(recordsPath, 'utf8')); }
catch (e) { console.error('[build-flow] cannot read records: ' + e.message); process.exit(1); }
if (!Array.isArray(records)) { console.error('[build-flow] records is not an array'); process.exit(1); }
records.sort((a, b) => (a.seq || 0) - (b.seq || 0));

// --- URL glob normalization: strip query/fragment, ** out volatile path segments ---
function isVolatile(seg) {
  if (/^\d+$/.test(seg)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return true;
  if (/^[0-9a-f]{16,}$/i.test(seg)) return true;
  if (seg.length >= 12 && /\d/.test(seg) && /[a-z]/i.test(seg)) return true;
  return false;
}
function urlGlob(u) {
  let parsed;
  try { parsed = new URL(u); } catch (e) { return null; }
  const segs = parsed.pathname.split('/').filter(Boolean);
  if (!segs.length) return null; // root path -> not a useful glob
  const out = segs.map((s) => (isVolatile(s) ? '**' : s));
  if (out.every((s) => s === '**')) return null; // entirely volatile -> caller marks needs_review
  return '**/' + out.join('/');
}

// --- conversion ---
const steps = [];
const values = {};
let inputN = 0;
const warns = [];
let needsReview = 0, maskedCount = 0;
let lastUrl = startUrl;
// Per find-step candidate ladder (the captured alternates), keyed by flow step index. Written to
// the gitignored <name>.candidates.json sidecar so the optional `verify` step can REPAIR a step
// whose primary locator no longer resolves at replay (down the ladder) before promoting it to
// needs_review. Page structure, not PII; regenerated on each capture.
const candidatesByStep = {};
function ladderOf(rec) {
  // keep count: verify only repairs to a capture-time-UNIQUE candidate (count==1), the same bar
  // capture applied to the primary, so it never "repairs" to a non-unique (wrong-element) locator.
  return (rec.candidates || []).map((c) => { const o = { by: c.by, value: c.value }; if (c.name) o.name = c.name; if (c.count != null) o.count = c.count; return o; });
}

function actionFind(rec, action, extra) {
  const p = rec.primary;
  if (!p || rec.insufficient) {
    needsReview++;
    const step = { kind: 'find', needs_review: true, candidates: (rec.candidates || []).slice(0, Math.max(2, (rec.candidates || []).length)) };
    if (action) step.action = action;
    steps.push(step);
    candidatesByStep[steps.length - 1] = ladderOf(rec);
    warns.push(`needs_review step #${steps.length - 1} (${rec.action_type}): ` +
      (rec.candidates || []).map((c) => `${c.by}:${c.value}${c.count != null ? '(' + c.count + ')' : ''}`).join(', '));
    return;
  }
  const step = { kind: 'find', by: p.by, value: p.value };
  if (p.name) step.name = p.name;
  step.action = action;
  if (extra) Object.assign(step, extra);
  steps.push(step);
  candidatesByStep[steps.length - 1] = ladderOf(rec);
}

function token(realValue) {
  inputN++;
  const key = 'input_' + inputN;
  if (realValue != null) values[key] = realValue;
  return { key, tok: '{{' + key + '}}' };
}

function maybeWait(toUrl) {
  // emit a wait only when the URL actually changed (design rule: no no-op/self waits)
  if (!toUrl || toUrl === lastUrl) return;
  const g = urlGlob(toUrl);
  if (g) { steps.push({ kind: 'wait', until: 'url', value: g }); }
  else { warns.push(`navigation boundary to a volatile/root URL (${toUrl}) — no wait emitted; relying on next find's implicit wait`); }
  lastUrl = toUrl;
}

for (let i = 0; i < records.length; i++) {
  const rec = records[i];
  const t = rec.action_type;
  if (t === 'navigate') {
    // boundary: the settled URL is the next non-navigate record's url, else this marker's url
    let to = null;
    for (let j = i + 1; j < records.length; j++) { if (records[j].action_type !== 'navigate') { to = records[j].url_at_capture; break; } }
    if (!to) to = rec.url_at_capture;
    maybeWait(to);
    continue;
  }
  if (t === 'dom_settle') {
    // C2: a pure DOM-swap (the click changed the DOM but NOT the URL, so `navigate` never fired).
    // Emit an explicit settle wait so replay doesn't race the next locator. Prefer waiting on the
    // NEXT find step's literal text/label (the new view's content); else fall back to networkidle.
    let nextTxt = null;
    for (let j = i + 1; j < records.length; j++) {
      const r = records[j];
      if (r.action_type === 'dom_settle') continue;
      if (r.action_type === 'navigate') break;   // a real nav follows -> let its url-wait gate settle it; don't borrow post-nav text (which would wait on the OLD page)
      if (r.primary && (r.primary.by === 'text' || r.primary.by === 'label')) nextTxt = r.primary.value;
      break;
    }
    if (nextTxt) steps.push({ kind: 'wait', until: 'text', value: nextTxt });
    else steps.push({ kind: 'wait', until: 'load', value: 'networkidle' });
    continue;
  }
  if (t === 'click') { actionFind(rec, 'click'); }
  else if (t === 'key') { steps.push({ kind: 'press', value: rec.input_value || 'Enter' }); }
  else if (t === 'input') {
    if (rec.masked || rec.input_value == null) {
      maskedCount++;
      const { key } = token(null); // token reserved; value supplied by human in gitignored sidecar
      actionFind(rec, 'fill', { text: '{{' + key + '}}' });
      warns.push(`masked field ${key} (sensitive) — set its value in <name>.values.json before replay`);
    } else {
      const { tok } = token(rec.input_value);
      actionFind(rec, 'fill', { text: tok });
    }
  } else if (t === 'select') {
    const real = rec.input_value;
    const { tok } = token(real);
    actionFind(rec, 'select', { val: tok });
    if (rec.select_text != null && rec.select_text !== real) {
      warns.push(`select step (#${steps.length - 1}) option text "${rec.select_text}" != value "${real}"; verify 0.27.0 find select matching`);
    }
  }
}

// trailing url assert from the last settled URL
const asserts = [];
const finalGlob = urlGlob(lastUrl);
if (finalGlob) asserts.push({ kind: 'url', value: finalGlob });

const flow = { name };
if (app) flow.app = app;
flow.startUrl = startUrl;
flow.steps = steps;
flow.asserts = asserts;

const flowPath = path.join(flowsDir, name + '.flow.json');
fs.writeFileSync(flowPath, JSON.stringify(flow, null, 2) + '\n');
let valuesPath = null;
if (Object.keys(values).length) {
  valuesPath = path.join(flowsDir, name + '.values.json');
  fs.writeFileSync(valuesPath, JSON.stringify(values, null, 2) + '\n');
}
const candPath = path.join(flowsDir, name + '.candidates.json');
let candWritten = false;
if (Object.keys(candidatesByStep).length) {
  // `_steps` lets `verify` detect a flow whose steps were structurally edited after capture (the
  // ladder indices would no longer line up). Always (re)write fresh, or remove a stale sidecar.
  fs.writeFileSync(candPath, JSON.stringify({ _steps: steps.length, byStep: candidatesByStep }, null, 2) + '\n');
  candWritten = true;
} else if (fs.existsSync(candPath)) {
  fs.unlinkSync(candPath);
}

// summary
console.error(`[build-flow] wrote ${flowPath}`);
console.error(`[build-flow] steps=${steps.length} needs_review=${needsReview} masked=${maskedCount} values=${Object.keys(values).length}`);
if (valuesPath) console.error(`[build-flow] values sidecar (gitignored) -> ${valuesPath}  keys: ${Object.keys(values).join(', ')}`);
if (candWritten) console.error(`[build-flow] candidates sidecar (gitignored) -> ${candPath}  (repair ladder for \`verify\`)`);
if (warns.length) { console.error('[build-flow] WARNINGS:'); warns.forEach((w) => console.error('  - ' + w)); }
if (needsReview) console.error(`[build-flow] NOTE: ${needsReview} step(s) need_review — resolve them in ${flowPath}; compile will refuse until then.`);
