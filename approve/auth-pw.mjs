// approve/auth-pw.mjs - one-time HEADED Playwright login -> storageState (gitignored).
//
// The approve leaf uses Playwright (trusted clicks), NOT agent-browser. agent-browser's
// fixtures/auth/<app>.state.json is CDP-shaped, so it is not a clean Playwright storageState.
// Operator logs in once in the window.
//
//   node approve/auth-pw.mjs <loginUrl> <successNeedle> <outFile> [stopFile]
'use strict';

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const [loginUrl, successNeedle, outFile, stopFileArg] = process.argv.slice(2);
if (!loginUrl || !successNeedle || !outFile) {
  console.error('usage: node approve/auth-pw.mjs <loginUrl> <successNeedle> <outFile> [stopFile]');
  process.exit(2);
}

const TIMEOUT_MS = Number(process.env.HUMAN_TIMEOUT_MS) || 900000;
const STOPFILE = stopFileArg || process.env.AQA_AUTH_STOPFILE || '';

// Use the system-installed Google Chrome (channel:'chrome') so no Playwright browser download is needed.
const browser = await chromium.launch({ headless: false, channel: 'chrome' });
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  console.error(`[auth-pw] Log in (incl. OTP) in the window. Waiting until the URL contains "${successNeedle}" (up to ${Math.round(TIMEOUT_MS / 1000)}s).`);

  let waited = 0;
  let matched = false;
  while (waited < TIMEOUT_MS) {
    if (page.url().includes(successNeedle)) {
      matched = true;
      break;
    }
    if (STOPFILE && fs.existsSync(STOPFILE) && page.url()) {
      console.error('[auth-pw] confirm-save requested; saving the current session.');
      matched = true;
      break;
    }
    await page.waitForTimeout(1000);
    waited += 1000;
  }

  if (!matched) {
    console.error('[auth-pw] timed out before reaching the success URL; not saved.');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  await ctx.storageState({ path: outFile });
  console.error(`[auth-pw] OK. storageState saved -> ${outFile}`);
} finally {
  await browser.close();
}
