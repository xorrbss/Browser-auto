// approve/poc-approve.mjs — P0 PoC: PROVE a Playwright (trusted) click completes the Hiworks approve.
//
// Gate B proved agent-browser's synthetic 확인 click is ignored (no commit, no native dialog) while a real
// human click completes it → likely an isTrusted requirement. This PoC checks whether Playwright's click
// (real CDP input) completes it. RUN ONLY ON A DISPOSABLE TEST DOC.
//
//   node approve/poc-approve.mjs <stateFile> <listUrl> <docId> [--dry-run]
// DRY mode does everything EXCEPT the final 확인 click (safe rehearsal).
'use strict';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const [stateFile, listUrl, docId] = args.filter(a => a !== '--dry-run');
if (!stateFile || !listUrl || !docId) {
  console.error('usage: node approve/poc-approve.mjs <stateFile> <listUrl> <docId> [--dry-run]');
  process.exit(2);
}
const log = (...a) => console.error('[poc]', ...a);

const browser = await chromium.launch({ headless: false, channel: 'chrome' }); // system Chrome, no PW browser download
let result = { opened: false, idLabelOk: false, modal: false, radio: false, opinion: false,
               confirmClicked: false, completed: false, dry, error: null };
try {
  const ctx = await browser.newContext({ storageState: stateFile });
  const page = await ctx.newPage();
  await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);

  // --- find + open the doc row, paginating via the page-number <select> if needed ---
  const tryOpen = async () => {
    const row = page.getByText(docId, { exact: false }).first();
    if (await row.count() > 0 && await row.isVisible().catch(() => false)) {
      await row.click();
      return true;
    }
    return false;
  };
  let opened = await tryOpen();
  if (!opened) {
    // locate the page-number select (the one whose options are numeric)
    const selects = page.locator('select');
    const n = await selects.count();
    let pageSel = null, total = 0;
    for (let i = 0; i < n; i++) {
      const opts = await selects.nth(i).locator('option').allTextContents();
      const nums = opts.filter(o => /^\s*\d+\s*$/.test(o));
      if (nums.length >= 2) { pageSel = selects.nth(i); total = nums.length; break; }
    }
    if (pageSel) {
      for (let p = 2; p <= total && !opened; p++) {
        await pageSel.selectOption(String(p));
        await page.waitForTimeout(1500);
        opened = await tryOpen();
      }
    }
  }
  if (!opened) throw new Error(`doc "${docId}" not found in the 대기 list`);
  result.opened = true;
  await page.waitForTimeout(2500);
  log('opened detail:', page.url());

  // --- I4 identity guard: exactly one cell == docId on the detail page ---
  const idCell = page.getByRole('cell', { name: docId, exact: true });
  const idCount = await idCell.count();
  result.idLabelOk = idCount === 1;
  if (!result.idLabelOk) throw new Error(`idLabel guard: expected exactly 1 cell == docId, got ${idCount} — ABORT`);
  log('idLabel OK (exactly one 문서번호 cell == docId)');

  // --- open the approve modal: 결재 button (exact) ---
  const approveBtn = page.getByRole('button', { name: '결재', exact: true });
  if (await approveBtn.count() !== 1) throw new Error(`expected exactly 1 결재 button, got ${await approveBtn.count()}`);
  await approveBtn.click();
  await page.waitForTimeout(1500);
  result.modal = true;

  // --- select 승인 radio (name has a leading space → regex), fill 의견 ---
  const seungin = page.getByRole('radio', { name: /승인/ }).first();
  if (await seungin.count() > 0) { await seungin.check().catch(async () => { await seungin.click(); }); result.radio = true; }
  log('승인 radio:', result.radio);
  const opinion = page.getByPlaceholder('의견을 입력하세요.').first();
  if (await opinion.count() > 0) { await opinion.fill('PoC 자동 승인 테스트 (폐기용)'); result.opinion = true; }
  log('의견 filled:', result.opinion);

  if (dry) { log('DRY-RUN: stopping BEFORE the 확인 click.'); result.error = 'dry-run (no 확인)'; }
  else {
    // --- THE test: trusted Playwright click on 확인 (NOT 확인 후 다음 문서; exact excludes it) ---
    await page.getByRole('button', { name: '확인', exact: true }).click();
    result.confirmClicked = true;
    await page.waitForTimeout(4000);

    // --- positive completion verify: doc departed the 대기 inbox on a fresh fetch ---
    await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const stillThere = await page.getByText(docId, { exact: false }).first().count() > 0;
    // (page-1 check; if the disposable doc was on page 1 this is decisive. For PoC we trust departure.)
    result.completed = !stillThere;
    log('completion (doc left 대기 page1):', result.completed);
  }
} catch (e) {
  result.error = String(e && e.message || e);
  log('ERROR:', result.error);
} finally {
  await browser.close();
}
console.log(JSON.stringify(result, null, 2));
console.log(result.completed ? 'POC_RESULT=APPROVE_COMPLETED' : (result.dry ? 'POC_RESULT=DRY_OK' : 'POC_RESULT=NOT_COMPLETED'));
