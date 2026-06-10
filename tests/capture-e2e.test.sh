#!/usr/bin/env bash
# e2e coverage for bin/capture.js (the in-page recorder) driven by REAL Playwright events; replaces the
# 12 agent-browser capture-*.test.sh integration tests deleted with the daemon (441294d). Pins the
# capture-time guarantees that have no other end-to-end coverage:
#   masking-at-capture (PII never enters the buffer); checkable absolute `check` (incl. label pre-toggle
#   flip + uncheck-stays-click residual); input coalescing + Enter flush order; key allowlist +
#   modifier combos (printables excluded); contenteditable normalized capture; select single/multiple
#   (multiple => insufficient); scroll coalescing + order; dom_settle swap marker; icon-button
#   aria-label role primary; overLong (>80c) barred from primary => insufficient; upload/download
#   actions fail closed; full-doc + pushState navigate marks; per-case seq==buf.length health invariant.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

OUT="$(cd "$DIR" && node --input-type=module - <<'NODE' 2>&1
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dedupeByOrigin } from './bin/pw-record.mjs';

const ROOT = process.cwd();
const SECRET = 'Sup3rSecret!pw';
const OTP = '987654';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqa-capture-e2e-'));

let chromium;
try { chromium = createRequire(path.join(ROOT, 'approve', 'package.json'))('playwright').chromium; }
catch { console.log('SKIP_NO_BROWSER'); process.exit(0); }

const PAGES = {
	'/form': `<!doctype html><meta charset="utf-8">
		<label>User <input id="user"></label>
		<label>Password <input id="pw" type="password"></label>
		<label>OTP <input id="otp" type="tel" name="otp"></label>`,
	'/check': `<!doctype html><meta charset="utf-8">
		<label>Agree <input id="cb1" type="checkbox"></label>
		<label>News <input id="cb2" type="checkbox" checked></label>
		<label>Pick <input id="r1" type="radio" name="g"></label>
		<label id="lbl">Wrapped <input id="cb3" type="checkbox"></label>`,
	'/keys': `<!doctype html><meta charset="utf-8"><label>Name <input id="user"></label>`,
	'/ce': `<!doctype html><meta charset="utf-8">
		<div id="ce" contenteditable style="border:1px solid #999;min-height:2em"></div>
		<button id="out" type="button">Out</button>`,
	'/select': `<!doctype html><meta charset="utf-8">
		<label>Status <select id="sel"><option>pending</option><option>done</option></select></label>
		<label>Tags <select id="msel" multiple><option>alpha</option><option>beta</option><option>gamma</option></select></label>`,
	'/scroll': `<!doctype html><meta charset="utf-8">
		<button id="top" type="button">Top</button>
		<div style="height:3000px"></div>
		<button id="after" type="button" style="position:fixed;top:4px;right:4px">After</button>`,
	'/swap': `<!doctype html><meta charset="utf-8">
		<button id="swap" type="button">Swap</button><div id="box"><p>old</p></div>
		<script>document.getElementById('swap').onclick = () => {
			let h = '';
			for (let i = 0; i < 20; i++) h += '<div><span>row ' + i + '</span></div>';
			document.getElementById('box').innerHTML = h;
		};</script>`,
	'/icon': `<!doctype html><meta charset="utf-8">
		<button id="ib" aria-label="Search" type="button"><svg width="16" height="16"><circle cx="8" cy="8" r="6"/></svg></button>`,
	'/long': `<!doctype html><meta charset="utf-8">
		<button id="lb" type="button">${'x'.repeat(90)}</button>`,
	'/upload': `<!doctype html><meta charset="utf-8">
		<label>Upload file <input id="file" type="file"></label>`,
	'/download': `<!doctype html><meta charset="utf-8">
		<a id="dl" download="report.txt" href="/download-file">Download report</a>`,
	'/download-file': `plain report`,
	'/nav1': `<!doctype html><meta charset="utf-8"><a id="go" href="/nav2">go to page 2</a>`,
	'/nav2': `<!doctype html><meta charset="utf-8"><p>page 2</p>`,
	'/spa': `<!doctype html><meta charset="utf-8">
		<button id="route" type="button">Route</button>
		<script>document.getElementById('route').onclick = () => history.pushState({}, '', '/spa-detail');</script>`,
	'/iframe-same': `<!doctype html><meta charset="utf-8">
		<iframe id="samePay" name="samePayName" title="Same Origin Pay" src="/same-frame"></iframe>`,
	'/same-frame': `<!doctype html><meta charset="utf-8">
		<button data-testid="frame-pay" type="button">Pay in frame</button>`,
};
const srv = http.createServer((req, res) => {
	const html = PAGES[(req.url || '/').split('?')[0]];
	if (!html) { res.statusCode = 404; res.end('nf'); return; }
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.end(html);
});
const srvOther = http.createServer((req, res) => {
	const route = (req.url || '/').split('?')[0];
	const html = route === '/xo-frame'
		? '<!doctype html><meta charset="utf-8"><button data-testid="xo-pay" type="button">Cross frame pay</button>'
		: '<!doctype html><meta charset="utf-8"><p>other origin</p>';
	res.setHeader('content-type', 'text/html; charset=utf-8');
	res.end(html);
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
await new Promise((r) => srvOther.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${srv.address().port}`;
const OTHER_ORIGIN = `http://127.0.0.1:${srvOther.address().port}`;
PAGES['/iframe-xo'] = `<!doctype html><meta charset="utf-8">
	<iframe id="xoPay" name="xoPayName" title="Cross Origin Pay" src="${OTHER_ORIGIN}/xo-frame"></iframe>`;

let browser;
try { browser = await chromium.launch({ headless: true, channel: process.env.AQA_PW_CHANNEL || 'chrome' }); }
catch (e) {
	if (/Executable doesn't exist|Chromium distribution|not found at/.test(String(e && e.message))) { console.log('SKIP_NO_BROWSER'); srv.close(); srvOther.close(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(0); }
	throw e;
}

const ctx = await browser.newContext();
await ctx.addInitScript({ path: path.join(ROOT, 'bin', 'capture.js') });
const page = await ctx.newPage();

let failures = 0;
const ok = (cond, msg) => { if (cond) console.log('  ok ' + msg); else { failures++; console.log('  FAIL ' + msg); } };
const byType = (buf, t) => buf.filter((e) => e && e.action_type === t);
const idxOf = (buf, pred) => buf.findIndex(pred);

async function openCase(route) {
	await page.goto(ORIGIN + route, { waitUntil: 'domcontentloaded' });
	await page.evaluate(() => {
		sessionStorage.setItem('__aqa_buf', '[]');
		sessionStorage.setItem('__aqa_seq', '0');
		sessionStorage.setItem('__aqa_prevurl', location.href);
	});
}
async function drain(label) {
	const d = await page.evaluate(() => ({
		buf: JSON.parse(sessionStorage.getItem('__aqa_buf') || '[]'),
		seq: parseInt(sessionStorage.getItem('__aqa_seq') || '0', 10) || 0,
	}));
	ok(d.seq === d.buf.length, `${label}: seq==buf.length health (${d.seq}/${d.buf.length})`);
	return d.buf;
}
async function drainAllFrames(label) {
	const drained = [];
	const frameFailures = [];
	for (const frame of page.frames()) {
		try {
			const d = await frame.evaluate(() => ({
				url: location.href,
				isTop: window.top === window.self,
				crossOriginFrame: (() => {
					try { return window.top !== window.self && !window.frameElement; }
					catch { return true; }
				})(),
				buf: JSON.parse(sessionStorage.getItem('__aqa_buf') || '[]'),
				seq: parseInt(sessionStorage.getItem('__aqa_seq') || '0', 10) || 0,
			}));
			ok(d.seq === d.buf.length, `${label}: frame health ${d.url} (${d.seq}/${d.buf.length})`);
			drained.push(d);
		} catch (e) {
			frameFailures.push(`${frame.url() || '<blank>'}: ${String(e && e.message || e)}`);
		}
	}
	ok(frameFailures.length === 0, `${label}: all frame buffers drained`);
	return dedupeByOrigin(drained);
}
function buildFlowFromRecords(flowName, startUrl, records) {
	const flowDir = path.join(TMP, flowName);
	fs.mkdirSync(flowDir, { recursive: true });
	const recPath = path.join(flowDir, 'records.json');
	fs.writeFileSync(recPath, JSON.stringify(records, null, 2) + '\n');
	const r = spawnSync(process.execPath, ['bin/build-flow.js', flowName, startUrl, '', recPath, flowDir, 'playwright'], {
		cwd: ROOT,
		encoding: 'utf8',
	});
	ok(r.status === 0, `${flowName}: build-flow exited 0`);
	const flowPath = path.join(flowDir, `${flowName}.flow.json`);
	const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
	return { flow, flowPath, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// 1) masking-at-capture: the secret NEVER enters the buffer; plain input is captured faithfully.
await openCase('/form');
await page.fill('#pw', SECRET);
await page.fill('#otp', OTP);
await page.fill('#user', 'ada');
await page.locator('#user').blur();
{
	const buf = await drain('masking');
	const inputs = byType(buf, 'input');
	ok(inputs.length === 3, `masking: 3 coalesced input records (got ${inputs.length})`);
	ok(inputs.filter((e) => e.masked === true && e.input_value === null).length === 2, 'masking: password + OTP masked to null at capture');
	ok(inputs.some((e) => e.input_value === 'ada'), 'masking: plain field value captured');
	const raw = JSON.stringify(buf);
	ok(!raw.includes(SECRET) && !raw.includes(OTP), 'masking: secret bytes absent from the whole buffer');
}

// 2) checkable: ending-checked click => absolute `check`; uncheck gesture stays a `click` (documented
//    residual); label click flips the PRE-toggle state and dedupes to ONE record.
await openCase('/check');
await page.click('#cb1');
await page.click('#cb2');
await page.click('#r1');
await page.click('#lbl');
{
	const buf = await drain('checkable');
	ok(byType(buf, 'check').length === 3, `checkable: cb1+r1+label-wrapped cb3 recorded as check (got ${byType(buf, 'check').length})`);
	ok(byType(buf, 'click').length === 1, `checkable: unchecking cb2 stays a click (got ${byType(buf, 'click').length})`);
}

// 3) input -> Enter flush order; key allowlist + modifier combo; printable keys are NOT `key` records.
await openCase('/keys');
await page.fill('#user', 'Ada');
await page.locator('#user').press('Enter');
await page.keyboard.press('Escape');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Control+s');
await page.locator('#user').press('x');
await page.locator('#user').blur();
{
	const buf = await drain('keys');
	const iAda = idxOf(buf, (e) => e.action_type === 'input' && e.input_value === 'Ada');
	const iEnter = idxOf(buf, (e) => e.action_type === 'key' && e.input_value === 'Enter');
	ok(iAda >= 0 && iEnter >= 0 && iAda < iEnter, 'keys: pending input committed BEFORE Enter (fill-then-press order)');
	ok(byType(buf, 'key').some((e) => e.input_value === 'Escape'), 'keys: Escape captured');
	ok(byType(buf, 'key').some((e) => e.input_value === 'ArrowDown'), 'keys: ArrowDown captured');
	ok(byType(buf, 'key').some((e) => e.input_value === 'Control+s' && e.modifier === true), 'keys: Ctrl+S combo captured + flagged modifier');
	ok(!byType(buf, 'key').some((e) => e.input_value === 'x'), 'keys: bare printable is text, never a key record');
}

// 4) contenteditable: typed text captured as a normalized input value (not null/false-green).
await openCase('/ce');
await page.click('#ce');
await page.keyboard.type('Hello  World');
await page.click('#out');
{
	const buf = await drain('contenteditable');
	ok(byType(buf, 'input').some((e) => e.input_value === 'Hello World'), 'contenteditable: normalized textContent captured as the fill value');
}

// 5) select: single captures select_text; <select multiple> is UNREPRESENTABLE => insufficient.
await openCase('/select');
await page.selectOption('#sel', 'done');
await page.selectOption('#msel', ['alpha', 'beta']);
{
	const buf = await drain('select');
	const sels = byType(buf, 'select');
	ok(sels.some((e) => e.select_text === 'done'), 'select: single-select text captured');
	ok(sels.some((e) => e.insufficient === true), 'select: multi-select flagged insufficient (needs_review)');
}

// 6) scroll: a wheel gesture coalesces into ONE record and orders BEFORE the following click.
await openCase('/scroll');
await page.mouse.wheel(0, 600);
await page.waitForTimeout(500);
await page.click('#after');
{
	const buf = await drain('scroll');
	const scrolls = byType(buf, 'scroll');
	ok(scrolls.length === 1, `scroll: one coalesced record (got ${scrolls.length})`);
	ok(scrolls[0] && scrolls[0].dir === 'down' && scrolls[0].px >= 80, 'scroll: dominant axis down, px >= threshold');
	const iScroll = idxOf(buf, (e) => e.action_type === 'scroll');
	const iClick = idxOf(buf, (e) => e.action_type === 'click');
	ok(iScroll >= 0 && iClick >= 0 && iScroll < iClick, 'scroll: scroll-then-click order preserved');
}

// 7) dom_settle: a click that swaps a large subtree WITHOUT a URL change records a settle marker.
await openCase('/swap');
await page.click('#swap');
await page.waitForTimeout(700);
{
	const buf = await drain('domswap');
	ok(byType(buf, 'dom_settle').length === 1, 'domswap: dom_settle marker recorded once');
}

// 8) icon button: explicit aria-label button => role primary, sufficient by itself.
await openCase('/icon');
await page.click('#ib');
{
	const buf = await drain('iconbutton');
	const ev = byType(buf, 'click')[0];
	ok(!!ev && !!ev.primary && ev.primary.by === 'role' && ev.primary.value === 'button' && ev.primary.name === 'Search', 'iconbutton: role+aria-label primary');
	ok(!!ev && ev.insufficient !== true, 'iconbutton: lone aria-label-button primary is sufficient');
}

// 9) overLong: >80-char text is barred from auto-primary => needs_review, ladder kept for a human.
await openCase('/long');
await page.click('#lb');
{
	const buf = await drain('longtext');
	const ev = byType(buf, 'click')[0];
	ok(!!ev && ev.primary == null && ev.insufficient === true, 'longtext: no auto-primary, flagged insufficient');
	ok(!!ev && Array.isArray(ev.candidates) && ev.candidates.length > 0, 'longtext: candidate ladder retained for review');
}

// 10) upload/download: schema has no faithful replay action, so capture records review-only
//     events and build-flow emits needs_review with no runnable fallback.
await openCase('/upload');
const uploadPath = path.join(TMP, 'upload.txt');
fs.writeFileSync(uploadPath, 'upload fixture\n');
await page.setInputFiles('#file', uploadPath);
{
	const buf = await drain('upload');
	const ev = byType(buf, 'input')[0];
	ok(!!ev && ev.upload === true && ev.insufficient === true && ev.input_value === null, 'upload: file input marked insufficient with no captured path');
	ok(!JSON.stringify(buf).includes(uploadPath), 'upload: local file path absent from capture buffer');
	const built = buildFlowFromRecords('upload_flow', ORIGIN + '/upload', buf);
	const step = built.flow.steps[0];
	ok(step && step.needs_review === true, 'upload: built step is needs_review');
	ok(step && step.by === undefined && step.value === undefined && step.text === undefined, 'upload: no runnable locator or fake fill token emitted');
}
await openCase('/download');
const downloadPromise = page.waitForEvent('download', { timeout: 3000 }).catch(() => null);
await page.click('#dl');
await downloadPromise;
{
	const buf = await drain('download');
	const ev = byType(buf, 'click')[0];
	ok(!!ev && ev.download === true && ev.insufficient === true, 'download: download link marked insufficient');
	const built = buildFlowFromRecords('download_flow', ORIGIN + '/download', buf);
	const step = built.flow.steps[0];
	ok(step && step.needs_review === true, 'download: built step is needs_review');
	ok(step && step.by === undefined && step.value === undefined, 'download: no runnable click locator emitted');
}

// 11) navigation marks: full-doc nav (prevUrl sentinel across documents) + SPA pushState.
await openCase('/nav1');
await page.click('#go');
await page.waitForURL('**/nav2');
{
	const buf = await drain('navigate');
	const nav = byType(buf, 'navigate').find((e) => e.is_navigation_boundary === true && String(e.from).includes('/nav1'));
	ok(!!nav, 'navigate: full-doc nav recorded with from=prev URL');
}
await openCase('/spa');
await page.click('#route');
await page.waitForTimeout(200);
{
	const buf = await drain('pushstate');
	ok(byType(buf, 'navigate').some((e) => e.is_navigation_boundary === true && String(e.from).includes('/spa')), 'pushstate: SPA route change recorded as a navigation boundary');
}

// 12) same-origin iframe: page.frames() sees the shared sessionStorage buffer twice; recorder drain
//     dedupes it, and build-flow emits a runnable iframe-scoped find step.
await openCase('/iframe-same');
await page.frameLocator('iframe#samePay').getByTestId('frame-pay').click();
await page.waitForTimeout(100);
{
	const drained = await drainAllFrames('iframe-same');
	ok(drained.buf.length === 1, `iframe-same: shared same-origin buffer deduped to one event (got ${drained.buf.length})`);
	const ev = drained.buf[0];
	ok(!!ev && ev.frame_ref && ev.frame_ref.crossOrigin !== true && ev.frame_ref.id === 'samePay', 'iframe-same: event carries parent-visible frame_ref id');
	const built = buildFlowFromRecords('same_iframe_flow', ORIGIN + '/iframe-same', drained.buf);
	const step = built.flow.steps[0];
	ok(built.flow.steps.length === 1, `iframe-same: flow has one find step, not duplicated (got ${built.flow.steps.length})`);
	ok(step && step.kind === 'find' && step.by === 'testid' && step.value === 'frame-pay' && step.action === 'click', 'iframe-same: built semantic click locator');
	ok(step && step.frame && step.frame.by === 'id' && step.frame.value === 'samePay', 'iframe-same: built flow includes frame locator');
	const valid = spawnSync(process.execPath, ['bin/play-flow.mjs', '--flow', built.flowPath, '--validate-only'], { cwd: ROOT, encoding: 'utf8' });
	ok(valid.status === 0, 'iframe-same: frame-scoped flow validates for replay');
}

// 13) cross-origin iframe: events are captured for review, but build-flow must fail closed by
//     emitting needs_review so validate/replay cannot go green unattended.
await openCase('/iframe-xo');
await page.frameLocator('iframe#xoPay').getByTestId('xo-pay').click();
await page.waitForTimeout(100);
{
	const drained = await drainAllFrames('iframe-xo');
	ok(drained.buf.length === 1, `iframe-xo: cross-origin frame event preserved once (got ${drained.buf.length})`);
	const ev = drained.buf[0];
	ok(!!ev && ev.frame_ref && ev.frame_ref.crossOrigin === true, 'iframe-xo: event marked crossOrigin in frame_ref');
	const built = buildFlowFromRecords('xo_iframe_flow', ORIGIN + '/iframe-xo', drained.buf);
	const step = built.flow.steps[0];
	ok(step && step.needs_review === true, 'iframe-xo: built step is needs_review');
	ok(step && step.by === undefined && step.value === undefined, 'iframe-xo: no runnable locator is emitted for cross-origin frame action');
	const invalid = spawnSync(process.execPath, ['bin/play-flow.mjs', '--flow', built.flowPath, '--validate-only'], { cwd: ROOT, encoding: 'utf8' });
	ok(invalid.status !== 0 && /needs_review/.test(`${invalid.stdout || ''}${invalid.stderr || ''}`), 'iframe-xo: validate/replay refuses needs_review flow');
}

await browser.close();
srv.close();
srvOther.close();
fs.rmSync(TMP, { recursive: true, force: true });
if (failures) { console.log(`CAPTURE_E2E_FAILED ${failures}`); process.exit(1); }
console.log('OK_CAPTURE_E2E');
NODE
)"
RC=$?
printf '%s\n' "$OUT" | sed 's/^/  /'
case "$OUT" in
	*SKIP_NO_BROWSER*) echo "  capture-e2e: skipped (Playwright Chrome channel unavailable)"; exit 0 ;;
	*OK_CAPTURE_E2E*) echo "  capture-e2e: all capture.js guarantees pinned"; exit 0 ;;
	*) echo "  capture-e2e: failed (rc=$RC)" >&2; exit 1 ;;
esac
