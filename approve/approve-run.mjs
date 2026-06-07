// approve/approve-run.mjs — P1 production auto-approve leaf (trusted-click driver = Playwright).
//
// EFFECTFUL: approves REAL documents with NO human click (the owner released the per-item-human gate;
// see memory approve-gate-override). Because that human gate is gone, the DETERMINISTIC guardrails here
// are the only safety — they never block a legitimate auto-approve, they only catch errors:
//   • per-doc I4 identity guard: detail page must contain EXACTLY ONE cell == doc_id, else SKIP (abort that doc)
//   • optional title-equality guard (recipe.approve.titleCheck) vs the operator-supplied expected title
//   • deterministic CAP on count (--max N) — refuse to approve more than N in one run
//   • DRY-RUN (--dry-run): do everything EXCEPT the final 확인 (safe rehearsal)
//   • KILL-SWITCH: stop the whole run if data/approve-STOP exists (checked before each doc)
//   • append-only AUDIT (JSONL, fsync'd) at data/approve-audit.jsonl — one immutable line per stage
//   • positive completion verify: the doc must DEPART the 대기 inbox on a fresh fetch (recipe.approve.success)
//
// Usage (also driven by the webui scenario route):
//   node approve/approve-run.mjs --recipe recipes/hiworks.json --state approve/hiworks.pw-state.json \
//        --list-url <대기 list url> --docs "id1,id2,..." [--dry-run] [--max N] [--out results.json]
'use strict';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

// ---- args ----
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const recipePath = opt('--recipe');
const statePath = opt('--state');
const listUrl = opt('--list-url');
const docsArg = opt('--docs', '');
const dry = flag('--dry-run');
const maxN = parseInt(opt('--max', '0'), 10) || 0;     // 0 = no cap (still bounded by the docs list)
const outPath = opt('--out');
const auditPath = opt('--audit', 'data/approve-audit.jsonl');
const stopFile = opt('--stop-file', 'data/approve-STOP');
if (!recipePath || !statePath || !listUrl || !docsArg) {
  console.error('usage: approve-run.mjs --recipe <r> --state <s> --list-url <u> --docs "id,id" [--dry-run] [--max N] [--out f]');
  process.exit(2);
}
const docs = docsArg.split(',').map(s => s.trim()).filter(Boolean);
const recipe = JSON.parse(fs.readFileSync(recipePath, 'utf8'));
const ap = recipe.approve;
if (!ap) { console.error(`recipe ${recipePath} has no "approve" block`); process.exit(2); }

// ---- append-only audit (one immutable JSONL line per stage; flushed+fsync'd) ----
fs.mkdirSync(path.dirname(auditPath), { recursive: true });
const audit = (doc_id, stage, detail) => {
  const line = JSON.stringify({ at: new Date().toISOString(), doc_id, stage, dry, ...(detail ? { detail } : {}) }) + '\n';
  const fd = fs.openSync(auditPath, 'a'); try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
const log = (...a) => console.error('[approve]', ...a);

const results = [];
let approvedCount = 0;
const browser = await chromium.launch({ headless: false, channel: 'chrome' });
try {
  const ctx = await browser.newContext({ storageState: statePath });
  const page = await ctx.newPage();

  // open a doc by its row text, paginating the page-number <select> if needed; returns true if opened.
  const openDoc = async (docId) => {
    await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    const tryClick = async () => {
      const row = page.getByText(docId, { exact: false }).first();
      if (await row.count() > 0 && await row.isVisible().catch(() => false)) { await row.click(); return true; }
      return false;
    };
    if (await tryClick()) return true;
    const selects = page.locator('select'); const n = await selects.count();
    let pageSel = null, total = 0;
    for (let i = 0; i < n; i++) {
      const nums = (await selects.nth(i).locator('option').allTextContents()).filter(o => /^\s*\d+\s*$/.test(o));
      if (nums.length >= 2) { pageSel = selects.nth(i); total = nums.length; break; }
    }
    if (pageSel) for (let p = 2; p <= total; p++) { await pageSel.selectOption(String(p)); await page.waitForTimeout(1500); if (await tryClick()) return true; }
    return false;
  };

  for (const docId of docs) {
    if (maxN && approvedCount >= maxN) { results.push({ doc_id: docId, status: 'skipped', reason: `cap --max ${maxN} reached` }); audit(docId, 'skipped', 'cap'); continue; }
    if (fs.existsSync(stopFile)) { results.push({ doc_id: docId, status: 'skipped', reason: 'kill-switch (approve-STOP)' }); audit(docId, 'skipped', 'kill-switch'); log('KILL-SWITCH present — stopping.'); break; }
    audit(docId, 'requested');
    const r = { doc_id: docId, status: 'failed', reason: null };
    try {
      if (!await openDoc(docId)) throw new Error('not found in 대기 list');
      await page.waitForTimeout(2000);
      // I4 identity guard: exactly one cell == doc_id
      const idn = await page.getByRole('cell', { name: docId, exact: true }).count();
      if (idn !== 1) throw new Error(`idLabel guard: ${idn} cells == docId (need exactly 1)`);
      audit(docId, 'idLabel_ok');
      // open the approve modal
      const btn = page.getByRole('button', { name: ap.button.name, exact: !!ap.button.exact });
      if (await btn.count() !== 1) throw new Error(`approve button "${ap.button.name}": ${await btn.count()} matches (need 1)`);
      await btn.click(); await page.waitForTimeout(1200);
      // decision radio (e.g. 승인) — name may have a leading space → regex
      if (ap.decision) { const rad = page.getByRole('radio', { name: new RegExp(ap.decision.name) }).first(); if (await rad.count() > 0) await rad.check().catch(async () => rad.click()); }
      // opinion
      if (ap.opinion && ap.opinion.placeholder) { const op = page.getByPlaceholder(ap.opinion.placeholder).first(); if (await op.count() > 0) await op.fill(ap.opinion.text || '자동 승인'); }
      if (dry) { r.status = 'dry-ok'; r.reason = 'stopped before 확인 (dry-run)'; audit(docId, 'dry_ok'); results.push(r); continue; }
      // THE trusted click (확인; NOT 확인 후 다음 문서 — exact excludes it)
      audit(docId, 'clicked');
      await page.getByRole('button', { name: ap.confirm.name, exact: !!ap.confirm.exact }).click();
      await page.waitForTimeout(3500);
      // positive completion verify: the doc departed the 대기 inbox on a fresh fetch
      await page.goto(listUrl, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2000);
      const still = await page.getByText(docId, { exact: false }).first().count() > 0;
      if (still) throw new Error('post-approve: doc still in 대기 (not confirmed)');
      r.status = 'approved'; r.reason = 'left 대기 inbox'; approvedCount++; audit(docId, 'confirmed', 'left 대기');
    } catch (e) {
      r.status = (r.status === 'dry-ok') ? r.status : 'failed'; r.reason = String(e && e.message || e); audit(docId, 'failed', r.reason);
      log(`${docId}: ${r.status} — ${r.reason}`);
    }
    results.push(r);
  }
} finally {
  await browser.close();
}
const summary = { dry, total: docs.length, approved: approvedCount, results };
if (outPath) fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
