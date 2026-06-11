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
const { normalizeEngine, DEFAULT_ENGINE } = require('../lib/engine.js');

const [, , name, startUrl, app, recordsPath, flowsDir, engineArg] = process.argv;
if (!name || !startUrl || !recordsPath || !flowsDir) {
  console.error('usage: build-flow.js <name> <startUrl> <app|""> <records.json> <flowsDir> [engine]');
  process.exit(2);
}
let engine;
try { engine = normalizeEngine(engineArg || DEFAULT_ENGINE, 'flow.engine'); }
catch (e) { console.error('[build-flow] ' + e.message); process.exit(2); }
let records;
try { records = JSON.parse(fs.readFileSync(recordsPath, 'utf8')); }
catch (e) { console.error('[build-flow] cannot read records: ' + e.message); process.exit(1); }
if (!Array.isArray(records)) { console.error('[build-flow] records is not an array'); process.exit(1); }
function eventTime(r) {
  const n = Number(r && r.timestamp_ms);
  return Number.isFinite(n) && n > 0 ? n : null;
}
records.sort((a, b) => {
  const at = eventTime(a), bt = eventTime(b);
  if (at !== null && bt !== null && at !== bt) return at - bt;
  return (a.seq || 0) - (b.seq || 0);
});

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
function sameLocator(a, b) {
  return !!a && !!b && a.by === b.by && a.value === b.value && (a.name || '') === (b.name || '');
}
function overLongLocator(c) {
  return ((c && c.value) || '').length > 80 || ((c && c.name) || '').length > 80;
}
function primaryReviewReason(rec) {
  const p = rec && rec.primary;
  if (!p) return 'no primary locator';
  if (overLongLocator(p)) return 'primary locator text/name exceeds 80 characters';
  const matches = (rec.candidates || []).filter((c) => sameLocator(c, p));
  if (!matches.length) return 'primary locator is missing from the capture candidate ladder';
  if (!matches.some((c) => Number(c.count) === 1)) {
    const counts = matches.map((c) => (c.count == null ? 'missing' : String(c.count))).join('/');
    return `primary locator was not capture-unique (count=${counts || 'missing'})`;
  }
  return '';
}

// frameLoc(frame_ref): the parent-visible iframe LOCATOR for a step recorded inside an iframe (id > name >
// title > src-path > index — semantic, never @ref). A CROSS-ORIGIN frame (parent can't scope into it) or an
// iframe with NO stable identity is UNREPLAYABLE ⇒ {_unreplayable} ⇒ the step is forced needs_review (fail-closed).
function safeFrameString(v) {
  return typeof v === 'string' && v !== '' && !/["\\]/.test(v) ? v : null;
}
function frameLoc(fr) {
  if (!fr) return null;
  if (fr.crossOrigin) return { _unreplayable: 'cross-origin iframe (parent cannot scope into it)' };
  const id = safeFrameString(fr.id);
  const name = safeFrameString(fr.name);
  const title = safeFrameString(fr.title);
  const srcPath = safeFrameString(fr.srcPath);
  if (id) return { by: 'id', value: id };
  if (name) return { by: 'name', value: name };
  if (title) return { by: 'title', value: title };
  if (srcPath) return { by: 'urlGlob', value: srcPath };
  if (typeof fr.index === 'number' && fr.index >= 0) return { by: 'index', value: fr.index };
  return { _unreplayable: 'iframe with no replay-safe identity (no safe id/name/title/src/index)' };
}
function actionFind(rec, action, extra) {
  const p = rec.primary;
  const fl = frameLoc(rec.frame_ref);
  const reviewReason = primaryReviewReason(rec);
  if (!p || rec.insufficient || reviewReason || (fl && fl._unreplayable)) {
    needsReview++;
    const step = { kind: 'find', needs_review: true, candidates: (rec.candidates || []).slice(0, Math.max(2, (rec.candidates || []).length)) };
    if (action) step.action = action;
    if (fl && !fl._unreplayable) step.frame = fl; // a resolvable frame on a (otherwise) needs_review step is still recorded
    steps.push(step);
    candidatesByStep[steps.length - 1] = ladderOf(rec);
    const reasons = [];
    if (rec.insufficient) reasons.push('capture marked insufficient');
    if (reviewReason && reviewReason !== 'no primary locator') reasons.push(reviewReason);
    if (fl && fl._unreplayable) reasons.push(`frame: ${fl._unreplayable}`);
    const why = reasons.length ? ` [${reasons.join('; ')}]` : '';
    warns.push(`needs_review step #${steps.length - 1} (${rec.action_type})${why}: ` +
      (rec.candidates || []).map((c) => `${c.by}:${c.value}${c.count != null ? '(' + c.count + ')' : ''}`).join(', '));
    return;
  }
  const step = { kind: 'find', by: p.by, value: p.value };
  if (p.name) step.name = p.name;
  step.action = action;
  if (fl) step.frame = fl; // iframe-scoped step: replay (flow-runner/Playwright) frameLocators into it
  if (extra) Object.assign(step, extra);
  steps.push(step);
  candidatesByStep[steps.length - 1] = ladderOf(rec);
}

function unsupportedReview(rec) {
  needsReview++;
  const capability = rec.capability || 'unsupported';
  const reason = rec.reason || 'recorded capability is not replayable by the current flow schema';
  const step = {
    kind: capability === 'container-scroll' ? 'scroll' : 'find',
    needs_review: true,
    unsupported: capability,
    reason,
    candidates: (rec.candidates || []).slice(0, Math.max(2, (rec.candidates || []).length))
  };
  if (capability === 'container-scroll') {
    if (rec.dir) step.recordedDir = rec.dir;
    const px = Math.round(Number(rec.px));
    if (Number.isFinite(px) && px > 0) step.recordedPx = px;
  } else if (rec.action) {
    step.action = rec.action;
  }
  steps.push(step);
  candidatesByStep[steps.length - 1] = ladderOf(rec);
  warns.push(`needs_review step #${steps.length - 1} (${capability}): ${reason}`);
}

function token(realValue) {
  inputN++;
  const key = 'input_' + inputN;
  if (realValue != null) values[key] = realValue;
  return { key, tok: '{{' + key + '}}' };
}

function locatorKey(rec) {
  const p = rec && (rec.primary || (rec.candidates || [])[0]);
  if (!p) return '';
  return [p.by || '', p.value || '', p.name || ''].join('\u0001');
}

function isSelectInputDuplicate(rec, next) {
  if (!rec || !next) return false;
  if (rec.action_type !== 'input' || next.action_type !== 'select') return false;
  if (rec.input_value !== next.input_value) return false;
  const a = locatorKey(rec);
  return !!a && a === locatorKey(next);
}

function maybeWait(toUrl) {
  // emit a wait only when the URL actually changed (design rule: no no-op/self waits)
  if (!toUrl || toUrl === lastUrl) return;
  const g = urlGlob(toUrl);
  if (g) { steps.push({ kind: 'wait', until: 'url', value: g }); }
  else {
    steps.push({ kind: 'wait', until: 'load', value: 'networkidle' });
    warns.push(`navigation boundary to a volatile/root URL (${toUrl}) — emitted load wait fallback`);
  }
  lastUrl = toUrl;
}

function defaultEnvironmentFor(url) {
	try {
		const u = new URL(url);
		if (['data:', 'file:', 'about:'].includes(u.protocol)) return 'local';
		if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) return 'local';
	} catch {}
	return 'staging';
}

for (let i = 0; i < records.length; i++) {
  const rec = records[i];
  const t = rec.action_type;
  if (t === 'navigate') {
    if (rec.frame_ref) continue; // a FRAME-load navigate (an iframe loaded/navigated) is NOT a top-level nav gate
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
  if (t === 'unsupported') {
    unsupportedReview(rec);
    continue;
  }
  if (isSelectInputDuplicate(rec, records[i + 1])) {
    warns.push(`dropped duplicate input event before select at record #${i + 1}`);
    continue;
  }
  if (t === 'click') { actionFind(rec, 'click'); }
  else if (t === 'check') { actionFind(rec, 'check'); }   // checkbox/radio absolute set (not a toggle click)
  else if (t === 'key') {
    const keyval = rec.input_value || 'Enter';
    steps.push({ kind: 'press', value: keyval });
    if (rec.modifier) {
      warns.push(`modifier shortcut '${keyval}' captured as a press step (#${steps.length - 1}) — its effect is app-specific; review that replaying it is safe/deterministic before relying on it.`);
    } else if (/Arrow/.test(keyval)) {
      // KEY-1: a run of consecutive arrow presses is index-relative and has no intervening semantic
      // locator, so if the page's initial selection/option order drifts at replay a different item can be
      // chosen yet a generic trailing assert still passes. Surface it (cannot be locator-gated).
      warns.push(`arrow-key press '${keyval}' (step #${steps.length - 1}) is focus/index-relative and NOT gated by a semantic locator — if the page's initial selection or option order drifts at replay, a different item can be chosen. Review drift sensitivity.`);
    }
  }
  else if (t === 'input') {
    if (rec.upload) {
      actionFind(rec, 'fill');
      warns.push(`file upload input at record #${i} is not replayable as a fill; marked needs_review`);
    } else if (rec.masked || rec.input_value == null) {
      maskedCount++;
      const { key } = token(null); // token reserved; value supplied by human in gitignored sidecar
      actionFind(rec, 'fill', { text: '{{' + key + '}}' });
      warns.push(`masked field ${key} (sensitive) — set its value in <name>.values.json before replay`);
    } else {
      const { tok } = token(rec.input_value);
      actionFind(rec, 'fill', { text: tok });
    }
  } else if (t === 'select') {
    // A needs_review select (no primary, or insufficient — e.g. <select multiple>) must NOT tokenize a
    // value: a multi-select only captured option#1, so writing that partial value to the sidecar would
    // be misleading. actionFind emits the needs_review step (action:select) and the human supplies the
    // intended value(s) when resolving it.
    if (!rec.primary || rec.insufficient) {
      actionFind(rec, 'select');
    } else {
      const real = rec.input_value;
      const { tok } = token(real);
      actionFind(rec, 'select', { val: tok });
      if (rec.select_text != null && rec.select_text !== real) {
        warns.push(`select step (#${steps.length - 1}) option text "${rec.select_text}" != value "${real}"; verify Playwright select matching`);
      }
    }
  } else if (t === 'scroll') {
    // #2: explicit page scroll -> a `scroll <dir> <px>` step (no locator). Defensive validation: a
    // malformed record is dropped with a warning rather than emitting a junk step (capture.js only
    // ever emits a valid dir + px >= SCROLL_MIN; this guards hand-written/corrupt records).
    const px = Math.round(Number(rec.px));
    if (['up', 'down', 'left', 'right'].indexOf(rec.dir) >= 0 && Number.isFinite(px) && px > 0) {
      steps.push({ kind: 'scroll', dir: rec.dir, px });
    } else {
      warns.push(`dropped malformed scroll record (dir=${rec.dir}, px=${rec.px})`);
    }
  }
}

// trailing url assert from the last settled URL
const asserts = [];
const finalGlob = urlGlob(lastUrl);
if (finalGlob) asserts.push({ kind: 'url', value: finalGlob });

const flow = { name, engine, environment: defaultEnvironmentFor(startUrl), riskClass: 'read' };
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
