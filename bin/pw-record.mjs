#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

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
if (!name || !startUrl) {
	console.error('usage: node bin/pw-record.mjs --name <name> --url <startUrl> [--app app] [--seconds N] [--stop-file path]');
	process.exit(2);
}

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForStop() {
	if (seconds > 0) {
		const end = Date.now() + seconds * 1000;
		console.error(`[pw-record] recording for ${seconds}s...`);
		while (Date.now() < end) {
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
		await new Promise((resolve) => process.stdin.once('data', resolve));
		return;
	}
	console.error('[pw-record] no --seconds and no TTY; waiting for stop-file.');
	while (!stopFile || !fs.existsSync(stopFile)) await wait(500);
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
	const buf = drained
		.flatMap((d) => d.buf)
		.sort((a, b) => (a.timestamp_ms || 0) - (b.timestamp_ms || 0) || (a.seq || 0) - (b.seq || 0));
	return {
		buf,
		frameCount: drained.length,
		xoFrames: drained.filter((d) => d.crossOriginFrame).length,
		xoEvents: buf.filter((ev) => ev && ev.frame_ref && ev.frame_ref.crossOrigin).length,
	};
}

async function loadChromium() {
	const pwRequire = createRequire(new URL('../approve/package.json', import.meta.url));
	return pwRequire('playwright').chromium;
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
const launch = { headless: false, channel: process.env.AQA_PW_CHANNEL || 'chrome' };
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
	await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
	await page.evaluate(() => {
		sessionStorage.setItem('__aqa_buf', '[]');
		sessionStorage.setItem('__aqa_seq', '0');
		sessionStorage.setItem('__aqa_prevurl', location.href);
	});
	console.error(`[pw-record] engine=playwright; opened ${startUrl}. Drive the browser journey now.`);
	await waitForStop();

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
