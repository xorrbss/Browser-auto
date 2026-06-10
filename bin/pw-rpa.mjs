#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dbm = require('../lib/db.js');
const { resolveAuthStatePath } = require('../lib/engine.js');
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

if (!['analyze', 'sync', 'enrich'].includes(command)) {
	console.error('usage: node bin/pw-rpa.mjs <analyze|sync|enrich> --system <name> [--limit N] [--key id]');
	process.exit(2);
}

const SYSTEM = opt('--system');
const LIMIT = Number(opt('--limit', '0')) || 0;
const KEY = opt('--key');
if (!SYSTEM) {
	console.error(`[${command}] --system <name> required`);
	process.exit(2);
}

function log(prefix, msg) {
	console.error(`[${prefix}] ${msg}`);
}

function readSystem(name) {
	const db = dbm.openDb();
	try {
		const s = dbm.getSystem(db, name);
		if (!s) throw new Error(`no such system: ${name}`);
		if (!s.target_url) throw new Error(`system '${name}' has no target_url`);
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

async function newPage(system) {
	const statePath = resolveAuthStatePath(PROBE_ROOT, 'playwright', system.name);
	if (!fs.existsSync(statePath)) {
		throw new Error(`missing Playwright auth state for '${system.name}' (${path.relative(PROBE_ROOT, statePath).replace(/\\/g, '/')}); run setup/auth.sh first`);
	}
	const chromium = await loadChromium();
	const headless = process.env.AQA_PW_HEADLESS !== '0';
	const browser = await chromium.launch({ headless, channel: process.env.AQA_PW_CHANNEL || 'chrome' });
	const ctx = await browser.newContext({ storageState: statePath });
	const page = await ctx.newPage();
	return { browser, page };
}

async function gotoTarget(page, url, prefix) {
	log(prefix, `navigating to target...`);
	await page.goto(url, { waitUntil: 'domcontentloaded' });
	log(prefix, `landed: ${page.url()}`);
}

async function waitText(page, text, seconds = 15) {
	if (!text) return;
	await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: seconds * 1000 }).catch(() => {});
}

// readySeconds(ready, dflt): honor the recipe's documented ready.timeout (seconds), else the default.
function readySeconds(ready, dflt) {
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

async function waitListChanged(page, recipePath, prevSig) {
	let lastErr = '';
	for (let t = 0; t < 12; t++) {
		try {
			const cur = await snapshotList(page, recipePath);
			if (cur.sig && cur.sig !== prevSig) return cur;
		} catch (e) {
			lastErr = e.message;
		}
		await page.waitForTimeout(500);
	}
	return { error: lastErr || 'no new rows' };
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
// and its dedicated writers (fetch/enrich-approvals.sh) were deleted with the agent-browser engine —
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

async function analyze(system, recipePath) {
	const prefix = 'analyze';
	fs.mkdirSync(DATA_DIR, { recursive: true });
	const snapPath = path.join(DATA_DIR, `${system.name}.snapshot.json`);
	const proposedPath = path.join(DATA_DIR, `${system.name}.proposed.json`);
	const { browser, page } = await newPage(system);
	try {
		log(prefix, `'${system.name}' -> launching Playwright (cached auth)...`);
		await gotoTarget(page, system.target_url, prefix);
		await waitText(page, system.recipe?.ready?.text || '', readySeconds(system.recipe?.ready, 15));
		const data = await snapshotData(page);
		fs.writeFileSync(snapPath, JSON.stringify(data, null, 2) + '\n');
		log(prefix, `snapshot saved -> ${snapPath}`);
		log(prefix, 'proposing recipe (detect tables + on-prem model)...');
		const proposed = runJson(PROPOSE_RECIPE, [], JSON.stringify(data), 'propose-recipe');
		fs.writeFileSync(proposedPath, JSON.stringify(proposed, null, 2) + '\n');
		log(prefix, `proposal saved -> ${proposedPath}`);
		const tables = Array.isArray(proposed.tables) ? proposed.tables.map((t) => `${t.name}(${(t.headers || []).length}h,${t.rowCount}r)`).join(', ') : '';
		log(prefix, `detected: ${tables}`);
		log(prefix, `proposedBy: ${proposed.proposedBy || '?'}`);
		log(prefix, 'done.');
	} finally {
		await browser.close();
	}
}

async function sync(system, recipePath) {
	const prefix = 'sync-system';
	const { browser, page } = await newPage(system);
	try {
		log(prefix, `'${system.name}' -> launching Playwright (cached auth)...`);
		await gotoTarget(page, system.target_url, prefix);
		await waitText(page, system.recipe?.ready?.text || '', readySeconds(system.recipe?.ready, 15));
		const pages = [];
		let cur = await snapshotList(page, recipePath);
		pages.push(cur.items);
		log(prefix, `page 1: ${cur.items.length} rows`);
		let prevSig = cur.sig;
		const pager = await pagerInfo(page, system.recipe);
		const total = pager ? Math.min(pager.total, 100) : 1;
		if (pager) log(prefix, `paginating: ${total} page(s)...`);
		for (let p = 2; p <= total; p++) {
			await selectPage(pager, p);
			cur = await waitListChanged(page, recipePath, prevSig);
			if (cur.error) {
				log(prefix, `page ${p} did not settle (${cur.error}) - stopping (storing pages so far)`);
				break;
			}
			pages.push(cur.items);
			prevSig = cur.sig;
			log(prefix, `  page ${p}: ${cur.items.length} rows`);
		}
		const all = uniqueByKey(pages.flat());
		log(prefix, `total unique: ${all.length}`);
		upsert(system.name, all, prefix);
		approvalsDualWrite(system.name, all, prefix);
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

async function openRecord(page, system, recipePath, key, listReady) {
	await page.goto(system.target_url, { waitUntil: 'domcontentloaded' });
	await waitText(page, listReady, readySeconds(system.recipe?.ready, 12));
	let cur = await snapshotList(page, recipePath).catch(() => ({ sig: '' }));
	const pager = await pagerInfo(page, system.recipe);
	const total = pager ? Math.min(pager.total, 100) : 1;
	let prevSig = cur.sig || '';
	for (let p = 1; p <= total; p++) {
		if (p > 1) {
			await selectPage(pager, p);
			cur = await waitListChanged(page, recipePath, prevSig);
			if (cur.error) return false;
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

async function enrich(system, recipePath) {
	const prefix = 'enrich-system';
	loadShellEnv(path.join(DATA_DIR, 'approvals.config'));
	const detail = system.recipe?.detail || null;
	if (!detail) throw new Error(`recipe for '${system.name}' has no "detail" block (fields + bodyFromHeadingLevel)`);
	if (!detail.idLabel) throw new Error('recipe.detail.idLabel is REQUIRED on the generic path (per-record identity guard)');
	const docs = recordsToEnrich(system.name);
	if (!docs.length) {
		log(prefix, 'nothing to enrich (all fetched records already summarized, or none synced).');
		return;
	}
	log(prefix, `${docs.length} record(s) to enrich for '${system.name}'.`);
	const { browser, page } = await newPage(system);
	const out = [];
	try {
		const listReady = system.recipe?.ready?.text || '';
		const readyText = detail.ready?.text || '';
		const urlGlob = detail.urlGlob || '';
		for (let i = 0; i < docs.length; i++) {
			const key = docs[i];
			log(prefix, `(${i + 1}/${docs.length}) ${key}`);
			const clicked = await openRecord(page, system, recipePath, key, listReady);
			if (!clicked) {
				log(prefix, `  not found on list page(s) / click failed - skipping`);
				continue;
			}
			if (urlGlob && !(await waitUrl(page, urlGlob, 12))) {
				log(prefix, `  click did not open a detail page (no ${urlGlob}) - skipping ${key}`);
				continue;
			}
			await waitText(page, readyText, readySeconds(detail.ready, 12));
			try {
				const data = await snapshotData(page);
				const item = extractDetail(data, recipePath, key);
				out.push({ ...item, key });
				log(prefix, `  fields=${Object.keys(item).filter((k) => k !== 'raw_text').join(',')}, body=${String(item.raw_text || '').length} chars`);
			} catch (e) {
				log(prefix, `  skipped (${e.message})`);
			}
		}
		if (!out.length) throw new Error('no records successfully extracted');
		let items = out;
		if (process.env.SUMMARY_MODEL) {
			log(prefix, `summarizing ${items.length} record(s) via local model '${process.env.SUMMARY_MODEL}'...`);
			items = runJson(SUMMARIZE, [], JSON.stringify(items), 'summarize');
		} else {
			log(prefix, 'SUMMARY_MODEL unset - storing detail fields only (set SUMMARY_MODEL + a local endpoint to summarize).');
		}
		upsert(system.name, wrapRecords(items), prefix);
		approvalsDualWrite(system.name, wrapRecords(items), prefix);
		log(prefix, 'done.');
	} finally {
		await browser.close();
	}
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
