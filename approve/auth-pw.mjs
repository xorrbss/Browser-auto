// approve/auth-pw.mjs - one-time HEADED Playwright login -> storageState (gitignored).
//
// Operator logs in once in the window. Callers pass the CANONICAL out path
// fixtures/auth/playwright/<app>.state.json (lib/engine.js playwrightAuthRel); the legacy
// approve/<app>.pw-state.json location is read-only compat handled by resolveAuthStatePath.
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

function stopRequested() {
  return !!(STOPFILE && fs.existsSync(STOPFILE));
}

function isTargetClosedError(e) {
  return /Target page, context or browser has been closed|Target closed|Page closed/i.test(String((e && e.message) || e || ''));
}

// Default = system-installed Google Chrome (channel:'chrome', no Playwright browser download).
// AQA_PW_CHANNEL overrides for environments without branded Chrome (e.g. the Docker image's
// bundled chromium) — same knob every other driver honors.
const browser = await chromium.launch({ headless: false, channel: process.env.AQA_PW_CHANNEL || 'chrome' });
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
  const initialUrl = page.url();
  console.error(`[auth-pw] Log in (incl. OTP) in the window. Waiting until the URL contains "${successNeedle}" (up to ${Math.round(TIMEOUT_MS / 1000)}s).`);

  let waited = 0;
  let matched = false;
  let closedAfterSaveRequest = false;
  while (waited < TIMEOUT_MS) {
    let currentUrl = '';
    try {
      currentUrl = page.url();
    } catch (e) {
      if (stopRequested() && isTargetClosedError(e)) {
        closedAfterSaveRequest = true;
        matched = true;
        break;
      }
      throw e;
    }
    if (currentUrl && currentUrl !== initialUrl && currentUrl.includes(successNeedle)) {
      matched = true;
      break;
    }
    if (stopRequested() && currentUrl) {
      console.error('[auth-pw] confirm-save requested; saving the current session.');
      matched = true;
      break;
    }
    try {
      await page.waitForTimeout(1000);
    } catch (e) {
      if (stopRequested() && isTargetClosedError(e)) {
        console.error('[auth-pw] confirm-save requested after the page closed; attempting to save the current context.');
        closedAfterSaveRequest = true;
        matched = true;
        break;
      }
      throw e;
    }
    waited += 1000;
  }

  if (!matched) {
    console.error('[auth-pw] timed out before reaching the success URL; not saved.');
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  try {
    await ctx.storageState({ path: outFile });
  } catch (e) {
    if (closedAfterSaveRequest || isTargetClosedError(e)) {
      console.error('[auth-pw] save requested, but the browser/context closed before storageState could be written. Leave the login window open until OK is printed.');
      process.exit(1);
    }
    throw e;
  }
  console.error(`[auth-pw] OK. storageState saved -> ${outFile}`);
} finally {
  try { await browser.close(); } catch {}
}
