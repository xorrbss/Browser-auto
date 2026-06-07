// approve/approve-run.mjs — production auto-approve leaf (Playwright trusted-click). HARDENED after the
// P4 red-team (REDTEAM-AUTO-APPROVE.md): the owner removed the per-item-human gate, so these deterministic
// guards are the ONLY safety. Every guard FAILS CLOSED (skip/abort the doc) — never approve on doubt.
//
// Per-doc guards before the irreversible 확인 click:
//   • OPEN by an EXACT 문서번호 cell, unique across ALL pages (count===1; abort on 0/≥2) — never substring/first-match (red-team DOCID-2/F6, DESIGN T1).
//   • DETAIL URL must match recipe.detail.urlGlob — else the guard might run against the list (DOCID-3).
//   • idLabel: exactly one cell == doc_id on the detail page (I4).
//   • TITLE binding: the expected title (from the synced DB, supplied per target) MUST appear on the detail — binds CONTENT, not just the id (red-team CRITICAL F1 / R2 / T3). Empty/missing title ⇒ skip.
//   • AMOUNT ceiling (optional --max-amount or per-target maxAmount): extract the largest ...원 figure from the detail body; if none found OR > ceiling ⇒ SKIP (fail-closed) — so a 1만원 and a 1억원 doc are NOT treated identically (red-team CRITICAL F1).
//   • DECISION fail-closed: the 승인 radio must be ASSERTED checked before clicking 확인 (red-team F5).
// Completion verify (replaces the false page-1-only check, red-team DOCID-1/VERIFY-*):
//   • re-fetch the list, ASSERT it actually loaded (collection marker present — not a login redirect),
//     then scan ALL pages; the doc must be ABSENT everywhere ⇒ approved. Not-loaded or still-present ⇒ failed.
// Live is OPT-IN: dry-run is the DEFAULT; live requires --live AND a positive --max cap (red-team F4/F5).
//   node approve/approve-run.mjs --recipe r --state s --list-url u --targets-file t.json [--live --max N] [--max-amount N]
'use strict';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const recipePath = opt('--recipe'), statePath = opt('--state'), listUrl = opt('--list-url');
const targetsFile = opt('--targets-file');
const live = flag('--live');                 // DEFAULT = dry-run (fail-closed); live is explicit
const dry = !live;
const maxN = parseInt(opt('--max', '0'), 10) || 0;
const maxAmount = parseInt(opt('--max-amount', '0'), 10) || 0;
const auditPath = opt('--audit', 'data/approve-audit.jsonl');
const stopFile = opt('--stop-file', 'data/approve-STOP');
if (!recipePath || !statePath || !listUrl || !targetsFile) { console.error('usage: --recipe --state --list-url --targets-file [--live --max N] [--max-amount N]'); process.exit(2); }
if (live && maxN <= 0) { console.error('REFUSED: --live requires a positive --max count cap (fail-closed)'); process.exit(2); }
const recipe = JSON.parse(fs.readFileSync(recipePath, 'utf8'));
const ap = recipe.approve; if (!ap) { console.error(`recipe ${recipePath} has no "approve" block`); process.exit(2); }
const urlGlobRe = (recipe.detail && recipe.detail.urlGlob) ? new RegExp(recipe.detail.urlGlob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')) : /\/view\//;
let targets = JSON.parse(fs.readFileSync(targetsFile, 'utf8'));
try { fs.rmSync(targetsFile, { force: true }); } catch {} // single-use: consume the (possibly-sensitive) targets file
if (!Array.isArray(targets) || !targets.length) { console.error('targets-file must be a non-empty JSON array'); process.exit(2); }

fs.mkdirSync(path.dirname(auditPath), { recursive: true });
const audit = (doc_id, stage, detail) => {
	const line = JSON.stringify({ at: new Date().toISOString(), doc_id, stage, live, ...(detail ? { detail } : {}) }) + '\n';
	const fd = fs.openSync(auditPath, 'a'); try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
const log = (...a) => console.error('[approve]', ...a);
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

const results = [];
let approvedCount = 0;
const browser = await chromium.launch({ headless: false, channel: 'chrome' });
try {
	const ctx = await browser.newContext({ storageState: statePath });
	const page = await ctx.newPage();

	// page-number <select> (numeric options); null if single-page.
	const pageSelect = async () => {
		const selects = page.locator('select'); const n = await selects.count();
		for (let i = 0; i < n; i++) { const nums = (await selects.nth(i).locator('option').allTextContents()).filter(o => /^\s*\d+\s*$/.test(o)); if (nums.length >= 2) return { sel: selects.nth(i), total: nums.length }; }
		return null;
	};
	// is the 대기 list actually loaded? (collection accessible name OR a table present — NOT a login redirect)
	const listLoaded = async () => {
		const byName = recipe.collection && recipe.collection.name ? await page.getByText(recipe.collection.name, { exact: false }).count() : 0;
		return byName > 0 || (await page.getByRole('table').count()) > 0;
	};
	// count exact 문서번호 cells == docId on the CURRENT page
	const cellCount = (docId) => page.getByRole('cell', { name: docId, exact: true }).count();
	// count exact 문서번호 cells across ALL pages — NEVER clicks (so no navigation race). {total, foundPage}
	const countDoc = async (docId) => {
		await page.goto(listUrl, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2000);
		if (!await listLoaded()) return { total: -1, foundPage: 0 };
		let total = 0, foundPage = 0;
		const c1 = await cellCount(docId); if (c1) { total += c1; foundPage = 1; }
		const ps = await pageSelect();
		if (ps) for (let p = 2; p <= ps.total; p++) { await ps.sel.selectOption(String(p)); await page.waitForTimeout(1500); const c = await cellCount(docId); if (c) { total += c; if (!foundPage) foundPage = p; } }
		return { total, foundPage };
	};
	// open the UNIQUE doc: count across all pages (abort 0/≥2 — DESIGN T1), then go to its page and click its cell.
	const openDoc = async (docId) => {
		const { total, foundPage } = await countDoc(docId);
		if (total === -1) return { ok: false, why: '대기 list did not load (session/redirect?)' };
		if (total !== 1) return { ok: false, why: `${total} exact 문서번호 cells across pages (need exactly 1)` };
		await page.goto(listUrl, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1500);
		if (foundPage > 1) { const ps = await pageSelect(); if (ps) { await ps.sel.selectOption(String(foundPage)); await page.waitForTimeout(1500); } }
		if (await cellCount(docId) !== 1) return { ok: false, why: 'doc cell not on its page at click time' };
		await page.getByRole('cell', { name: docId, exact: true }).click();
		return { ok: true };
	};
	// extract the largest "...원" amount from the detail body (deterministic; fail-closed when absent)
	const bodyAmount = async () => {
		const txt = await page.locator('body').innerText().catch(() => '');
		let max = -1; const re = /([0-9][0-9,]{2,})\s*원/g; let m;
		while ((m = re.exec(txt))) { const v = parseInt(m[1].replace(/,/g, ''), 10); if (Number.isFinite(v) && v > max) max = v; }
		return max; // -1 if none
	};

	for (const t of targets) {
		const docId = norm(t.doc_id), title = norm(t.title);
		const ceiling = (parseInt(t.maxAmount, 10) || 0) || maxAmount;
		const r = { doc_id: docId, status: 'failed', reason: null };
		if (maxN && approvedCount >= maxN) { r.status = 'skipped'; r.reason = `--max ${maxN} reached`; audit(docId, 'skipped', 'cap'); results.push(r); continue; }
		if (fs.existsSync(stopFile)) { r.status = 'skipped'; r.reason = 'kill-switch'; audit(docId, 'skipped', 'kill-switch'); results.push(r); log('KILL-SWITCH — stopping.'); break; }
		audit(docId, 'requested');
		try {
			if (!docId) throw new Error('empty doc_id');
			if (!title) throw new Error('no expected title (sync the doc first) — content binding required'); // CRITICAL F1
			// OPEN by the UNIQUE exact 문서번호 cell across all pages (count===1; abort 0/≥2)
			const o = await openDoc(docId);
			if (!o.ok) throw new Error('open: ' + o.why);
			await page.waitForTimeout(2000);
			if (!urlGlobRe.test(page.url())) throw new Error(`click did not open a detail page (url ${page.url()})`); // DOCID-3
			if (await cellCount(docId) !== 1) throw new Error('idLabel: detail does not have exactly one cell == doc_id'); // I4
			if (await page.getByText(title, { exact: false }).count() === 0) throw new Error(`TITLE mismatch: expected title not on detail page`); // CRITICAL F1/T3
			audit(docId, 'identity_ok', `title✓${ceiling ? ` ceiling=${ceiling}` : ''}`);
			if (ceiling) { const amt = await bodyAmount(); if (amt < 0) { r.status = 'skipped'; r.reason = 'amount not found (fail-closed under ceiling)'; audit(docId, 'skipped', 'no-amount'); results.push(r); continue; } if (amt > ceiling) { r.status = 'skipped'; r.reason = `amount ${amt} > ceiling ${ceiling}`; audit(docId, 'skipped', `amount>${ceiling}`); results.push(r); continue; } audit(docId, 'amount_ok', String(amt)); }
			// open modal
			const btn = page.getByRole('button', { name: ap.button.name, exact: !!ap.button.exact });
			if (await btn.count() !== 1) throw new Error(`approve button "${ap.button.name}": ${await btn.count()} (need 1)`);
			await btn.click(); await page.waitForTimeout(1200);
			// decision radio — FAIL CLOSED: must be checked before 확인 (F5)
			if (ap.decision) {
				const rad = page.getByRole('radio', { name: new RegExp(ap.decision.name) }).first();
				if (await rad.count() === 0) throw new Error(`decision radio "${ap.decision.name}" not found`);
				await rad.check().catch(async () => rad.click());
				await page.waitForTimeout(300);
				if (!await rad.isChecked().catch(() => false)) throw new Error('decision radio not checked after select — refusing 확인');
			}
			if (ap.opinion && ap.opinion.placeholder) { const op = page.getByPlaceholder(ap.opinion.placeholder).first(); if (await op.count() > 0) await op.fill(ap.opinion.text || '자동 승인'); }
			if (dry) { r.status = 'dry-ok'; r.reason = 'all guards passed; stopped before 확인 (dry-run)'; audit(docId, 'dry_ok'); results.push(r); continue; }
			audit(docId, 'clicked');
			await page.getByRole('button', { name: ap.confirm.name, exact: !!ap.confirm.exact }).click();
			await page.waitForTimeout(3500);
			// POSITIVE completion verify: list loaded + doc absent across ALL pages
			const after = await countDoc(docId);
			if (after.total === -1) throw new Error('post-approve: 대기 list did not load — cannot confirm (uncertain)');
			if (after.total > 0) throw new Error('post-approve: doc still in 대기 (not committed)');
			r.status = 'approved'; r.reason = 'left 대기 (all pages, list verified loaded)'; approvedCount++; audit(docId, 'confirmed', 'left 대기 all-pages');
		} catch (e) {
			if (r.status !== 'skipped' && r.status !== 'dry-ok') r.status = 'failed';
			r.reason = String(e && e.message || e); audit(docId, r.status === 'skipped' ? 'skipped' : 'failed', r.reason); log(`${docId}: ${r.status} — ${r.reason}`);
		}
		results.push(r);
	}
} finally { await browser.close(); }
const summary = { live, dry, total: targets.length, approved: approvedCount, results };
console.log(JSON.stringify(summary));
