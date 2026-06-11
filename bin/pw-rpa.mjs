#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const dbm = require('../lib/db.js');
const { resolveAuthStatePath } = require('../lib/engine.js');
const {
	createSystemEgressChecker,
	validateSystemEgressPolicy,
} = require('../lib/egress-policy.js');
const {
	createRuntimeEgressChecker,
	runtimeEgressDenyEvent,
} = require('../lib/egress-runtime.js');
import { pagerDecision } from '../approve/guards.mjs'; // THE pager fail-closed rule — shared with approve-run.mjs (one copy, no drift)

const PROBE_ROOT = path.resolve(import.meta.dirname, '..');
const DATA_DIR = path.join(PROBE_ROOT, 'data');
const EXTRACT_LIST = path.join(PROBE_ROOT, 'bin', 'extract-list.js');
const EXTRACT_DETAIL = path.join(PROBE_ROOT, 'bin', 'extract-detail.js');
const PROPOSE_RECIPE = path.join(PROBE_ROOT, 'bin', 'propose-recipe.js');
const SUMMARIZE = path.join(PROBE_ROOT, 'bin', 'summarize.js');

const argv = process.argv.slice(2);
const command = argv.shift();
const opt = (n, d = '') => {
	const i = argv.indexOf(n);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};
const IS_DIRECT = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (IS_DIRECT && !['analyze', 'sync', 'enrich'].includes(command)) {
	console.error('usage: node bin/pw-rpa.mjs <analyze|sync|enrich> --system <name> [--limit N] [--key id]');
	process.exit(2);
}

const SYSTEM = opt('--system');
const LIMIT = Number(opt('--limit', '0')) || 0;
const KEY = opt('--key');

function log(prefix, msg) {
	console.error(`[${prefix}] ${msg}`);
}

function readSystem(name) {
	const db = dbm.openDb();
	try {
		const s = dbm.getSystem(db, name);
		if (!s) throw new Error(`no such system: ${name}`);
		if (!s.target_url) throw new Error(`system '${name}' has no target_url`);
		const egress = validateSystemEgressPolicy(s, { phase: 'run', fields: ['target_url'] });
		if (!egress.ok) throw new Error(egress.reason);
		return s;
	} finally {
		dbm.closeDb(db);
	}
}

function writeTempJson(obj) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aqa-pw-rpa-'));
	const file = path.join(dir, 'recipe.json');
	fs.writeFileSync(file, JSON.stringify(obj || {}));
	return { dir, file };
}

function runJson(script, args, input, label) {
	const r = spawnSync(process.execPath, [script, ...args], {
		cwd: PROBE_ROOT,
		input,
		encoding: 'utf8',
		env: process.env,
		windowsHide: true,
	});
	if (r.stderr) process.stderr.write(r.stderr);
	if (r.status !== 0) {
		throw new Error(`${label} failed: ${(r.stderr || r.stdout || '').trim() || `exit ${r.status}`}`);
	}
	try {
		return JSON.parse((r.stdout || '').trim() || 'null');
	} catch (e) {
		throw new Error(`${label} returned invalid JSON: ${e.message}`);
	}
}

function loadShellEnv(file) {
	try {
		for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
			const line = raw.replace(/^\s*export\s+/, '').trim();
			if (!line || line.startsWith('#')) continue;
			const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
			if (!m) continue;
			let v = m[2].trim();
			if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
			if (process.env[m[1]] == null) process.env[m[1]] = v;
		}
	} catch {}
}

async function loadChromium() {
	const pwRequire = createRequire(new URL('../approve/package.json', import.meta.url));
	return pwRequire('playwright').chromium;
}

function egressRequestInfo(request) {
	const paths = [];
	try {
		if (request.redirectedFrom()) paths.push('redirect');
	} catch {}
	try {
		if (request.isNavigationRequest()) {
			const frame = request.frame();
			if (frame && frame.parentFrame()) paths.push('iframe');
		}
	} catch {}
	const pathLabel = paths.length ? paths.join('+') : 'request';
	return {
		label: paths.length ? `request:${pathLabel}` : 'request',
		path: pathLabel,
	};
}

async function newPage(system) {
	const statePath = resolveAuthStatePath(PROBE_ROOT, 'playwright', system.name);
	if (!fs.existsSync(statePath)) {
		throw new Error(`missing Playwright auth state for '${system.name}' (${path.relative(PROBE_ROOT, statePath).replace(/\\/g, '/')}); run setup/auth.sh first`);
	}
	const chromium = await loadChromium();
	const headless = process.env.AQA_PW_HEADLESS !== '0';
	const browser = await chromium.launch({ headless, channel: process.env.AQA_PW_CHANNEL || 'chrome' });
	const ctx = await browser.newContext({ storageState: statePath, serviceWorkers: 'block' });
	const baseChecker = createSystemEgressChecker(system, { phase: 'run' });
	const checker = createRuntimeEgressChecker({ policyOptions: baseChecker.context });
	const loggedBlocks = new Set();
	let blocked = null;
	const check = (request) => {
		const info = egressRequestInfo(request);
		const verdict = checker.checkUrl(request.url(), info.label, { egressPath: info.path });
		if (!verdict.ok) {
			if (!blocked) blocked = verdict;
			if (!loggedBlocks.has(verdict.reason)) {
				loggedBlocks.add(verdict.reason);
				log('egress', verdict.reason);
				log('egress-event', JSON.stringify(runtimeEgressDenyEvent(verdict, { system: system.name })));
			}
		}
		return verdict;
	};
	const assertNoEgressBlocked = () => {
		if (blocked) {
			const reason = blocked.reason;
			blocked = null;
			throw new Error(reason);
		}
	};
	ctx.on('request', (request) => {
		check(request);
	});
	await ctx.route('**/*', async (route) => {
		const verdict = check(route.request());
		if (!verdict.ok) {
			await route.abort('blockedbyclient').catch(() => {});
			return;
		}
		await route.continue();
	});
	const page = await ctx.newPage();
	Object.defineProperty(page, '__aqaAssertNoEgressBlocked', { value: assertNoEgressBlocked });
	return { browser, page, assertNoEgressBlocked };
}

function assertPageEgressClear(page) {
	if (typeof page.__aqaAssertNoEgressBlocked === 'function') page.__aqaAssertNoEgressBlocked();
}

async function gotoWithEgressPolicy(page, url, options = {}) {
	try {
		await page.goto(url, options);
	} catch (e) {
		assertPageEgressClear(page);
		throw e;
	}
	assertPageEgressClear(page);
}

async function gotoTarget(page, url, prefix) {
	log(prefix, `navigating to target...`);
	await gotoWithEgressPolicy(page, url, { waitUntil: 'domcontentloaded' });
	log(prefix, `landed: ${page.url()}`);
}

async function waitText(page, text, seconds = 15) {
	if (!text) return;
	await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: seconds * 1000 }).catch(() => {});
}

// readySeconds(ready, dflt): honor the recipe's documented ready.timeout (seconds), else the default.
export function readySeconds(ready, dflt) {
	const n = Number(ready && ready.timeout);
	return Number.isFinite(n) && n > 0 ? n : dflt;
}

async function snapshotData(page) {
	const snapshot = await page.locator('body').ariaSnapshot({ timeout: 10000 });
	let origin = '';
	try { origin = new URL(page.url()).origin; } catch {}
	return { url: page.url(), origin, refs: [], snapshot };
}

function extractList(data, recipePath) {
	const out = runJson(EXTRACT_LIST, [recipePath], JSON.stringify(data), 'extract-list');
	if (!Array.isArray(out)) throw new Error('extract-list returned non-array');
	return out;
}

function extractDetail(data, recipePath, key) {
	const out = runJson(EXTRACT_DETAIL, [recipePath, key, '--generic'], JSON.stringify(data), 'extract-detail');
	if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error('extract-detail returned non-object');
	return out;
}

function keySig(items) {
	return items.map((x) => x.key).sort().join(',');
}

async function snapshotList(page, recipePath) {
	const data = await snapshotData(page);
	const items = extractList(data, recipePath);
	return { data, items, sig: keySig(items) };
}

// pagerInfo: adapt the live page's <select> option texts to the SHARED fail-closed pager rule
// (approve/guards.mjs::pagerDecision — the same rule the approve leaf's all-pages scan trusts).
// 'none' ⇒ single page; 'uncertain' (windowed/ambiguous/non-1..N pager) ⇒ throw, never under-scan.
async function pagerInfo(page, recipe) {
	const mode = recipe?.pagination?.mode || '';
	if (!mode) return null;
	const selects = page.locator('select');
	const n = await selects.count();
	const optionTexts = [];
	for (let i = 0; i < n; i++) optionTexts.push(await selects.nth(i).locator('option').allTextContents());
	const d = pagerDecision(mode, optionTexts);
	if (d.kind === 'none') return null;
	if (d.kind !== 'pager') throw new Error('pagination combobox is ambiguous/untrustworthy (fail-closed; see guards.pagerDecision)');
	return { locator: selects.nth(d.index), total: d.total };
}

async function selectPage(pager, p) {
	try {
		await pager.locator.selectOption(String(p));
	} catch {
		await pager.locator.selectOption({ label: String(p) });
	}
}

// waitListSettled(getList, { prevSig, tries, wait }): poll the extracted list until it SETTLES.
// waitListChanged (the predecessor) returned on the FIRST signature change, which can be a half-
// rendered intermediate ⇒ undercount (the same bug approve-run.mjs settlePage closed, red-team
// SETTLE-HALFLOAD). Settled means:
//   rows present: the signature CHANGED from prevSig (when given — the page really switched) AND is
//     STABLE across two consecutive reads.
//   empty list: ONLY after EMPTY_STABLE_READS consecutive empty reads (~3s) — a page transition often
//     clears the table before rendering the new rows, so a brief empty is "still loading", but a
//     PERSISTENTLY empty page is real (live: a 대기 page whose docs were all approved is empty; the
//     old rows-required rule false-positived there and failed the whole sync). Page 1 (prevSig null)
//     additionally requires that NO row was ever seen (rows-then-empty on the first page = suspicious
//     ⇒ fail-closed).
// extract failures count as "still rendering" and break the consecutive-equal chain. Budget
// exhaustion returns { error } — callers fail-close via assertPageSettled (never store a partial
// page). getList/wait are injected so the rule is unit-testable browser-free.
const EMPTY_STABLE_READS = 6;
export async function waitListSettled(getList, { prevSig = null, tries = 24, wait = async () => {} } = {}) {
	let lastErr = '';
	let prevRead = null; // previous successful read's sig — the consecutive-equal detector
	let sawRows = false;
	let emptyRun = 0;    // consecutive empty reads
	for (let t = 0; t < tries; t++) {
		let cur = null;
		try { cur = await getList(); } catch (e) { lastErr = e.message; }
		if (cur) {
			const changed = prevSig == null || cur.sig !== prevSig;
			if (cur.sig) {
				sawRows = true;
				emptyRun = 0;
				if (changed && prevRead === cur.sig) return cur; // changed AND stable across two consecutive reads
			} else {
				emptyRun++;
				if (changed && emptyRun >= EMPTY_STABLE_READS && (prevSig != null || !sawRows)) return cur; // persistently empty ⇒ a real empty page
			}
			prevRead = cur.sig;
		} else {
			prevRead = null; // a failed extract breaks the consecutive-equal chain
			emptyRun = 0;
		}
		await wait();
	}
	return { error: lastErr || 'page did not change+stabilize (half-rendered or stuck page)' };
}

export function paginationSettleFailureMessage(scope, pageNumber, totalPages, detail = '') {
	const total = Number(totalPages) > 0 ? `/${Number(totalPages)}` : '';
	const cause = detail ? ` (${detail})` : '';
	return `${scope} page ${pageNumber}${total} did not settle${cause}; refusing to store partial pagination results (fail-closed)`;
}

export function assertPageSettled(result, scope, pageNumber, totalPages) {
	if (result && result.error) throw new Error(paginationSettleFailureMessage(scope, pageNumber, totalPages, result.error));
	return result;
}

function uniqueByKey(items) {
	const m = new Map();
	for (const item of items) if (!m.has(item.key)) m.set(item.key, item);
	return [...m.values()];
}

function upsert(system, items, prefix) {
	const db = dbm.openDb();
	try {
		const n = dbm.upsertRecords(db, system, items);
		log(prefix, `stored ${n} record(s) for '${system}'`);
	} finally {
		dbm.closeDb(db);
	}
}

// Legacy 결재 dual-write: GW_APP (data/approvals.config) names the 결재 system. The approvals table
// is still the read model for the 결재 dashboard / NL 결재 query / shadow-eval / approve title-binding,
// and its dedicated writers (fetch/enrich-approvals.sh) were deleted during the Playwright-only migration -
// so a registry sync/enrich of THAT system keeps approvals fresh too. Other systems write records only.
function approvalsDualWrite(systemName, items, prefix) {
	loadShellEnv(path.join(DATA_DIR, 'approvals.config'));
	if ((process.env.GW_APP || '') !== systemName) return;
	const db = dbm.openDb();
	try {
		const n = dbm.upsertApprovals(db, dbm.approvalsFromRecords(items));
		log(prefix, `결재 dual-write: ${n} row(s) -> approvals (GW_APP=${systemName})`);
	} finally {
		dbm.closeDb(db);
	}
}

function urlMatches(got, want) {
	const esc = String(want).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '*').replace(/\*/g, '.*');
	return new RegExp(`^${esc}([?#].*)?$`).test(got) || got.includes(String(want));
}

async function waitUrl(page, want, seconds = 12) {
	const deadline = Date.now() + seconds * 1000;
	while (Date.now() < deadline) {
		if (urlMatches(page.url(), want)) return true;
		await page.waitForTimeout(500);
	}
	return false;
}

export async function analyze(system, recipePath, deps = {}) {
	const prefix = 'analyze';
	const dataDir = deps.dataDir || DATA_DIR;
	const fsApi = deps.fs || fs;
	const newPageFn = deps.newPage || newPage;
	const gotoTargetFn = deps.gotoTarget || gotoTarget;
	const waitTextFn = deps.waitText || waitText;
	const snapshotDataFn = deps.snapshotData || snapshotData;
	const runJsonFn = deps.runJson || runJson;
	fsApi.mkdirSync(dataDir, { recursive: true });
	const snapPath = path.join(dataDir, `${system.name}.snapshot.json`);
	const proposedPath = path.join(dataDir, `${system.name}.proposed.json`);
	const { browser, page } = await newPageFn(system);
	try {
		log(prefix, `'${system.name}' -> launching Playwright (cached auth)...`);
		await gotoTargetFn(page, system.target_url, prefix);
		await waitTextFn(page, system.recipe?.ready?.text || '', readySeconds(system.recipe?.ready, 15));
		const data = await snapshotDataFn(page);
		fsApi.writeFileSync(snapPath, JSON.stringify(data, null, 2) + '\n');
		log(prefix, `snapshot saved -> ${snapPath}`);
		log(prefix, 'proposing recipe (detect tables + on-prem model)...');
		const proposed = runJsonFn(PROPOSE_RECIPE, [], JSON.stringify(data), 'propose-recipe');
		fsApi.writeFileSync(proposedPath, JSON.stringify(proposed, null, 2) + '\n');
		log(prefix, `proposal saved -> ${proposedPath}`);
		const tables = Array.isArray(proposed.tables) ? proposed.tables.map((t) => `${t.name}(${(t.headers || []).length}h,${t.rowCount}r)`).join(', ') : '';
		log(prefix, `detected: ${tables}`);
		log(prefix, `proposedBy: ${proposed.proposedBy || '?'}`);
		log(prefix, 'done.');
	} finally {
		await browser.close();
	}
}

export async function sync(system, recipePath, deps = {}) {
	const prefix = 'sync-system';
	const newPageFn = deps.newPage || newPage;
	const gotoTargetFn = deps.gotoTarget || gotoTarget;
	const waitTextFn = deps.waitText || waitText;
	const snapshotListFn = deps.snapshotList || snapshotList;
	const pagerInfoFn = deps.pagerInfo || pagerInfo;
	const selectPageFn = deps.selectPage || selectPage;
	const waitListSettledFn = deps.waitListSettled || waitListSettled;
	const upsertFn = deps.upsert || upsert;
	const approvalsDualWriteFn = deps.approvalsDualWrite || approvalsDualWrite;
	const { browser, page } = await newPageFn(system);
	const settleWait = deps.settleWait || (() => page.waitForTimeout(500));
	const settleTries = deps.settleTries || 24;
	try {
		log(prefix, `'${system.name}' -> launching Playwright (cached auth)...`);
		await gotoTargetFn(page, system.target_url, prefix);
		await waitTextFn(page, system.recipe?.ready?.text || '', readySeconds(system.recipe?.ready, 15));
		const getList = () => snapshotListFn(page, recipePath);
		const settleOpts = { tries: settleTries, wait: settleWait };
		const pages = [];
		let cur = assertPageSettled(await waitListSettledFn(getList, settleOpts), 'sync pagination', 1, 0);
		pages.push(cur.items);
		log(prefix, `page 1: ${cur.items.length} rows`);
		let prevSig = cur.sig;
		const pager = await pagerInfoFn(page, system.recipe);
		const total = pager ? Math.min(pager.total, 100) : 1;
		if (pager) log(prefix, `paginating: ${total} page(s)...`);
		for (let p = 2; p <= total; p++) {
			await selectPageFn(pager, p);
			cur = assertPageSettled(await waitListSettledFn(getList, { ...settleOpts, prevSig }), 'sync pagination', p, total);
			pages.push(cur.items);
			prevSig = cur.sig;
			log(prefix, `  page ${p}: ${cur.items.length} rows`);
		}
		const all = uniqueByKey(pages.flat());
		log(prefix, `total unique: ${all.length}`);
		upsertFn(system.name, all, prefix);
		approvalsDualWriteFn(system.name, all, prefix);
		log(prefix, 'done.');
	} finally {
		await browser.close();
	}
}

function recordsToEnrich(systemName) {
	if (KEY) return [KEY];
	const db = dbm.openDb();
	try {
		let rows = dbm.queryRecords(db, systemName, { status: 'fetched' }).filter((x) => !x.summary).map((x) => x.key);
		if (LIMIT > 0) rows = rows.slice(0, LIMIT);
		return rows;
	} finally {
		dbm.closeDb(db);
	}
}

export async function openRecord(page, system, recipePath, key, listReady, deps = {}) {
	const waitTextFn = deps.waitText || waitText;
	const snapshotListFn = deps.snapshotList || snapshotList;
	const pagerInfoFn = deps.pagerInfo || pagerInfo;
	const selectPageFn = deps.selectPage || selectPage;
	const waitListSettledFn = deps.waitListSettled || waitListSettled;
	const settleWait = deps.settleWait || (() => page.waitForTimeout(500));
	const settleTries = deps.settleTries || 24;
	await gotoWithEgressPolicy(page, system.target_url, { waitUntil: 'domcontentloaded' });
	await waitTextFn(page, listReady, readySeconds(system.recipe?.ready, 12));
	const getList = () => snapshotListFn(page, recipePath);
	const settleOpts = { tries: settleTries, wait: settleWait };
	const cur0 = await waitListSettledFn(getList, settleOpts);
	const pager = await pagerInfoFn(page, system.recipe);
	const total = pager ? Math.min(pager.total, 100) : 1;
	// Paginated list: an unsettled page 1 makes the whole scan untrustworthy ⇒ fail-closed. A single
	// un-paginated page tolerates it (the exact-text click below can still find the key).
	if (pager && cur0.error) {
		assertPageSettled(cur0, `enrich pagination while locating ${key}`, 1, total);
	}
	let prevSig = cur0.error ? '' : cur0.sig || '';
	for (let p = 1; p <= total; p++) {
		if (p > 1) {
			await selectPageFn(pager, p);
			const cur = assertPageSettled(await waitListSettledFn(getList, { ...settleOpts, prevSig }), `enrich pagination while locating ${key}`, p, total);
			prevSig = cur.sig;
		}
		const target = page.getByText(key, { exact: false }).first();
		if ((await target.count()) > 0) {
			await target.click();
			return true;
		}
	}
	return false;
}

function wrapRecords(items) {
	return items.map((it) => {
		const { key, summary, ...data } = it;
		return { key, summary: summary ?? null, data };
	});
}

export async function enrich(system, recipePath, deps = {}) {
	const prefix = 'enrich-system';
	loadShellEnv(path.join(DATA_DIR, 'approvals.config'));
	const recordsToEnrichFn = deps.recordsToEnrich || recordsToEnrich;
	const newPageFn = deps.newPage || newPage;
	const openRecordFn = deps.openRecord || ((page, sys, rp, key, listReady) => openRecord(page, sys, rp, key, listReady));
	const waitUrlFn = deps.waitUrl || waitUrl;
	const waitTextFn = deps.waitText || waitText;
	const snapshotDataFn = deps.snapshotData || snapshotData;
	const extractDetailFn = deps.extractDetail || extractDetail;
	const runJsonFn = deps.runJson || runJson;
	const upsertFn = deps.upsert || upsert;
	const approvalsDualWriteFn = deps.approvalsDualWrite || approvalsDualWrite;
	const summaryModel = Object.prototype.hasOwnProperty.call(deps, 'summaryModel') ? deps.summaryModel : process.env.SUMMARY_MODEL;
	const detail = system.recipe?.detail || null;
	if (!detail) throw new Error(`recipe for '${system.name}' has no "detail" block (fields + bodyFromHeadingLevel)`);
	if (!detail.idLabel) throw new Error('recipe.detail.idLabel is REQUIRED on the generic path (per-record identity guard)');
	const docs = recordsToEnrichFn(system.name);
	if (!docs.length) {
		log(prefix, 'nothing to enrich (all fetched records already summarized, or none synced).');
		return;
	}
	log(prefix, `${docs.length} record(s) to enrich for '${system.name}'.`);
	const { browser, page } = await newPageFn(system);
	const out = [];
	try {
		const listReady = system.recipe?.ready?.text || '';
		const readyText = detail.ready?.text || '';
		const urlGlob = detail.urlGlob || '';
		for (let i = 0; i < docs.length; i++) {
			const key = docs[i];
			log(prefix, `(${i + 1}/${docs.length}) ${key}`);
			const clicked = await openRecordFn(page, system, recipePath, key, listReady);
			if (!clicked) {
				log(prefix, `  not found on list page(s) / click failed - skipping`);
				continue;
			}
			if (urlGlob && !(await waitUrlFn(page, urlGlob, 12))) {
				log(prefix, `  click did not open a detail page (no ${urlGlob}) - skipping ${key}`);
				continue;
			}
			await waitTextFn(page, readyText, readySeconds(detail.ready, 12));
			try {
				const data = await snapshotDataFn(page);
				const item = extractDetailFn(data, recipePath, key);
				out.push({ ...item, key });
				log(prefix, `  fields=${Object.keys(item).filter((k) => k !== 'raw_text').join(',')}, body=${String(item.raw_text || '').length} chars`);
			} catch (e) {
				log(prefix, `  skipped (${e.message})`);
			}
		}
		if (!out.length) throw new Error('no records successfully extracted');
		let items = out;
		if (summaryModel) {
			log(prefix, `summarizing ${items.length} record(s) via local model '${summaryModel}'...`);
			items = runJsonFn(SUMMARIZE, [], JSON.stringify(items), 'summarize');
		} else {
			log(prefix, 'SUMMARY_MODEL unset - storing detail fields only (set SUMMARY_MODEL + a local endpoint to summarize).');
		}
		upsertFn(system.name, wrapRecords(items), prefix);
		approvalsDualWriteFn(system.name, wrapRecords(items), prefix);
		log(prefix, 'done.');
	} finally {
		await browser.close();
	}
}

async function main() {
	if (!SYSTEM) {
		console.error(`[${command}] --system <name> required`);
		process.exit(2);
	}
	try {
		const system = readSystem(SYSTEM);
		const tmp = writeTempJson(system.recipe || {});
		try {
			if (command === 'analyze') await analyze(system, tmp.file);
			if (command === 'sync') await sync(system, tmp.file);
			if (command === 'enrich') await enrich(system, tmp.file);
		} finally {
			fs.rmSync(tmp.dir, { recursive: true, force: true });
		}
	} catch (e) {
		console.error(`[pw-rpa] FATAL: ${e && e.message || e}`);
		process.exit(1);
	}
}

if (IS_DIRECT) {
	await main();
}
