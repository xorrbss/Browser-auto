#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { resolveAuthStatePath } = require('../lib/engine.js');

const PROBE_ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const opt = (n, d = null) => {
	const i = argv.indexOf(n);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

const name = opt('--name');
const startUrl = opt('--url');
const app = opt('--app', '');
const seconds = Number(opt('--seconds', process.env.AQA_CAPTURE_SECONDS || '0')) || 0;
const stopFile = opt('--stop-file', process.env.AQA_CAPTURE_STOPFILE || '');

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStop(violations) {
	if (seconds > 0) {
		const end = Date.now() + seconds * 1000;
		console.error(`[pw-record] recording for ${seconds}s...`);
		while (Date.now() < end) {
			if (violations.length) return; // scope violation: stop waiting, fail loud at the caller
			if (stopFile && fs.existsSync(stopFile)) {
				console.error('[pw-record] stop signal received; finishing capture.');
				return;
			}
			await wait(500);
		}
		return;
	}
	if (process.stdin.isTTY) {
		console.error('\n>>> Recording. Do your journey in the browser window, then press ENTER here to stop...');
		await new Promise((resolve) => {
			const t = setInterval(() => { if (violations.length) { clearInterval(t); resolve(); } }, 500);
			process.stdin.once('data', () => { clearInterval(t); resolve(); });
		});
		return;
	}
	console.error('[pw-record] no --seconds and no TTY; waiting for stop-file.');
	while (!stopFile || !fs.existsSync(stopFile)) {
		if (violations.length) return;
		await wait(500);
	}
}

function tmpFile() {
	return path.join(os.tmpdir(), `aqa-pw-record-${process.pid}-${Date.now()}.json`);
}

function runBuilder(recordsPath) {
	const builder = path.join(PROBE_ROOT, 'bin', 'build-flow.js');
	const flowsDir = path.join(PROBE_ROOT, 'flows');
	const r = spawnSync(process.execPath, [builder, name, startUrl, app || '', recordsPath, flowsDir, 'playwright'], {
		cwd: PROBE_ROOT,
		stdio: 'inherit',
		windowsHide: true,
	});
	if (r.status !== 0) process.exit(r.status || 1);
}

async function drainCaptureBuffers(page) {
	const drained = [];
	const failures = [];
	for (const frame of page.frames()) {
		try {
			const data = await frame.evaluate(() => ({
				url: location.href,
				isTop: window.top === window.self,
				crossOriginFrame: (() => {
					try { return window.top !== window.self && !window.frameElement; }
					catch { return true; }
				})(),
				buf: JSON.parse(sessionStorage.getItem('__aqa_buf') || '[]'),
				seq: parseInt(sessionStorage.getItem('__aqa_seq') || '0', 10) || 0,
			}));
			if (!Array.isArray(data.buf)) throw new Error('capture buffer is not an array');
			drained.push(data);
		} catch (e) {
			failures.push(`${frame.url() || '<blank>'}: ${String(e && e.message || e)}`);
		}
	}
	if (failures.length) {
		throw new Error(`could not drain ${failures.length} frame capture buffer(s): ${failures.join('; ')}`);
	}
	const healthFailures = drained
		.filter((d) => d.seq > d.buf.length)
		.map((d) => `${d.url}: seq=${d.seq}, recovered=${d.buf.length}`);
	if (healthFailures.length) {
		throw new Error(`capture health-check failed: ${healthFailures.join('; ')}`);
	}
	return dedupeByOrigin(drained);
}

// dedupeByOrigin(drained): collapse the per-frame drain to ONE buffer per sessionStorage partition (origin).
// Same-origin iframes SHARE the top frame's sessionStorage (the capture buffer is one object), so page.frames()
// returns the SAME buffer once per same-origin frame; a naive flatMap then counts every event N× (N = same-origin
// frame count) and the per-frame seq==buf.length health check still passes — so duplicated click/submit events
// slip into the built flow and replay wrong state / double-execute. Keeping the first frame per origin dedupes
// the shared partition while preserving cross-origin frames (distinct origin = distinct sessionStorage). Pure.
export function dedupeByOrigin(drained) {
	const byOrigin = new Map();
	for (const d of drained) {
		let origin;
		try { origin = new URL(d.url).origin; } catch { origin = d.url || '<blank>'; }
		if (origin === 'null') origin = d.url || '<blank>'; // opaque origin (sandbox/data:) ⇒ key on the full url so distinct frames aren't merged
		if (!byOrigin.has(origin)) byOrigin.set(origin, d); // first frame of this partition owns the shared buffer
	}
	const reps = [...byOrigin.values()];
	const buf = reps
		.flatMap((d) => d.buf)
		.sort((a, b) => (a.timestamp_ms || 0) - (b.timestamp_ms || 0) || (a.seq || 0) - (b.seq || 0));
	return {
		buf,
		frameCount: reps.length,
		xoFrames: reps.filter((d) => d.crossOriginFrame).length,
		xoEvents: buf.filter((ev) => ev && ev.frame_ref && ev.frame_ref.crossOrigin).length,
	};
}

async function loadChromium() {
	const pwRequire = createRequire(new URL('../approve/package.json', import.meta.url));
	return pwRequire('playwright').chromium;
}

async function main() {
	if (!name || !startUrl) {
		console.error('usage: node bin/pw-record.mjs --name <name> --url <startUrl> [--app app] [--seconds N] [--stop-file path]');
		process.exit(2);
	}
	const capjs = path.join(PROBE_ROOT, 'bin', 'capture.js');
	if (!fs.existsSync(capjs)) {
		console.error(`[pw-record] missing ${capjs}`);
		process.exit(1);
	}

	let startOrigin = '';
	try { startOrigin = new URL(startUrl).origin; } catch {
		console.error('[pw-record] invalid --url');
		process.exit(2);
	}

	const chromium = await loadChromium();
	// Recording is HEADED (a human drives the journey). AQA_PW_RECORD_HEADLESS=1 is a test seam only,
	// so the scope-guard tests can run the recorder without flashing a window.
	const launch = { headless: process.env.AQA_PW_RECORD_HEADLESS === '1', channel: process.env.AQA_PW_CHANNEL || 'chrome' };
	const browser = await chromium.launch(launch);
	let recPath = null;
	try {
		const contextOpts = {};
		if (app) {
			const statePath = resolveAuthStatePath(PROBE_ROOT, 'playwright', app);
			if (!fs.existsSync(statePath)) throw new Error(`no Playwright cached state for '${app}' (${path.relative(PROBE_ROOT, statePath).replace(/\\/g, '/')}). Run setup/auth.sh --engine playwright first.`);
			contextOpts.storageState = statePath;
		}
		const ctx = await browser.newContext(contextOpts);
		await ctx.addInitScript({ path: capjs });
		const page = await ctx.newPage();
		// FAIL-LOUD SCOPE GUARDS: a popup/new tab or a
		// mid-recording top-level cross-origin navigation puts journey events where this recorder cannot drain
		// them (a popup's own sessionStorage / a foreign origin's partition), so a silently-incomplete flow
		// would be written. Out of scope ⇒ record the violation, stop waiting, REFUSE to write the flow.
		const scopeViolations = [];
		ctx.on('page', (p) => {
			if (p !== page) scopeViolations.push(`a new tab/popup opened during recording (${p.url() || 'about:blank'}) — out of scope: single tab`);
		});
		page.on('framenavigated', (frame) => {
			if (frame !== page.mainFrame()) return; // iframe navs are in scope (frame_ref'd by capture.js)
			let origin = '';
			try { origin = new URL(frame.url()).origin; } catch { return; }
			if (origin !== startOrigin) scopeViolations.push(`top-level cross-origin navigation during recording (${startOrigin} -> ${origin}) — out of scope`);
		});
		await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
		await page.evaluate(() => {
			sessionStorage.setItem('__aqa_buf', '[]');
			sessionStorage.setItem('__aqa_seq', '0');
			sessionStorage.setItem('__aqa_prevurl', location.href);
		});
		console.error(`[pw-record] engine=playwright; opened ${startUrl}. Drive the browser journey now.`);
		await waitForStop(scopeViolations);
		if (scopeViolations.length) throw new Error(`${scopeViolations[0]}; recording not written`);

		const nowOrigin = new URL(page.url()).origin;
		if (nowOrigin !== startOrigin) throw new Error(`top-level cross-origin navigation is out of scope (${startOrigin} -> ${nowOrigin}); recording not written`);
		const drained = await drainCaptureBuffers(page);
		if (drained.buf.length === 0) throw new Error('captured 0 events; recording not written');
		if (drained.xoFrames > 0) {
			console.error(`[pw-record] NOTE: ${drained.xoFrames} cross-origin iframe(s) present; ${drained.xoEvents} recorded event(s) there will require review.`);
		}
		recPath = tmpFile();
		fs.writeFileSync(recPath, JSON.stringify(drained.buf, null, 2) + '\n');
		console.error(`[pw-record] captured ${drained.buf.length} raw event(s) from ${drained.frameCount} frame(s) -> build-flow`);
		await ctx.close();
		await browser.close();
		runBuilder(recPath);
	} catch (e) {
		console.error('[pw-record] FATAL: ' + String(e && e.message || e));
		process.exitCode = 1;
	} finally {
		try { await browser.close(); } catch {}
		if (recPath) {
			try { fs.rmSync(recPath, { force: true }); } catch {}
		}
	}
}

// Run the recorder only when invoked directly (node bin/pw-record.mjs …); importing the module for unit
// tests (dedupeByOrigin) must NOT launch a browser.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await main();
}
