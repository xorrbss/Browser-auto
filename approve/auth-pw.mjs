// approve/auth-pw.mjs — one-time HEADED Playwright login → storageState (gitignored).
//
// The approve leaf uses Playwright (trusted clicks), NOT agent-browser. agent-browser's
// fixtures/auth/<app>.state.json is CDP-shaped (no sameSite; red-team AUTH-DUP-2STACK-1), so it is NOT a
// clean Playwright storageState — the approve leaf captures its OWN. Operator logs in once in the window.
//
//   node approve/auth-pw.mjs <loginUrl> <successNeedle> <outFile>
// e.g. node approve/auth-pw.mjs "https://login.office.hiworks.com/ibizsoftware.net" "dashboard.office.hiworks.com" approve/hiworks.pw-state.json
'use strict';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [loginUrl, successNeedle, outFile] = process.argv.slice(2);
if (!loginUrl || !successNeedle || !outFile) {
  console.error('usage: node approve/auth-pw.mjs <loginUrl> <successNeedle> <outFile>');
  process.exit(2);
}
const TIMEOUT_MS = Number(process.env.HUMAN_TIMEOUT_MS) || 900000;

// Use the system-installed Google Chrome (channel:'chrome') so no Playwright browser download is needed.
const browser = await chromium.launch({ headless: false, channel: 'chrome' });
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  console.error(`[auth-pw] Log in (incl. OTP) in the window. Waiting until the URL contains "${successNeedle}" (up to ${Math.round(TIMEOUT_MS/1000)}s)…`);
  const start = Number(process.env.AQA_NOW_MS) || 0; // monotonic-ish via loop counter; wall clock not needed
  let waited = 0;
  while (waited < TIMEOUT_MS) {
    if (page.url().includes(successNeedle)) break;
    await page.waitForTimeout(1000);
    waited += 1000;
  }
  if (!page.url().includes(successNeedle)) {
    console.error('[auth-pw] timed out before reaching the success URL — not saved.');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await ctx.storageState({ path: outFile });
  console.error(`[auth-pw] OK. storageState saved → ${outFile}`);
} finally {
  await browser.close();
}
