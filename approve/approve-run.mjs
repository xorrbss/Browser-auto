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
// Clear any stale kill-switch at the START of this run so a prior batch's STOP doesn't block this one; a
// STOP written DURING this run (via the webui 중지 button) is then seen by the per-doc check below.
try { fs.rmSync(stopFile, { force: true }); } catch {}

fs.mkdirSync(path.dirname(auditPath), { recursive: true });
const audit = (doc_id, stage, detail) => {
	const line = JSON.stringify({ at: new Date().toISOString(), doc_id, stage, live, ...(detail ? { detail } : {}) }) + '\n';
	const fd = fs.openSync(auditPath, 'a'); try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
const log = (...a) => console.error('[approve]', ...a);
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const TODAY = new Date().toISOString().slice(0, 10); // YYYY-MM-DD — a 결재선 decision stamp is dated this on approval

const results = [];
let approvedCount = 0;     // CONFIRMED approvals (for the report)
let clicksIssued = 0;      // irreversible 확인 commits ISSUED — the --max cap binds THIS (red-team CAP-COUNTS):
                           // a committed-but-uncertain doc must still consume budget, else clicks can exceed --max.
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
	// is the 대기 list actually loaded? REQUIRE the collection accessible name when the recipe declares it
	// (a bare "any table" matches a login/error page — red-team LISTLOADED-*). Fall back to a table only
	// when no collection.name is configured.
	const listLoaded = async () => {
		if (recipe.collection && recipe.collection.name) return (await page.getByText(recipe.collection.name, { exact: false }).count()) > 0;
		return (await page.getByRole('table').count()) > 0;
	};
	const waitListLoaded = async () => { for (let t = 0; t < 16; t++) { if (await listLoaded()) return true; await page.waitForTimeout(500); } return false; };
	// row-set signature, to detect a combobox AJAX page change deterministically (vs a fixed sleep — red-team SETTLE-1).
	const rowsSig = async () => { try { return (await page.getByRole('row').allInnerTexts()).join(''); } catch { return ''; } };
	// after selectOption(p): poll until the row set CHANGES from prevSig (the page actually loaded). null ⇒ never settled (UNCERTAIN).
	const waitSettled = async (prevSig) => { for (let t = 0; t < 16; t++) { const s = await rowsSig(); if (s && s !== prevSig) return s; await page.waitForTimeout(500); } return null; };
	// rows may arrive via AJAX AFTER listLoaded() (the table name renders before its rows) — poll for data rows.
	const waitRows = async () => { for (let t = 0; t < 16; t++) { if ((await page.getByRole('row').count()) > 1) return true; await page.waitForTimeout(500); } return false; };
	// settlePage(prevSig): after selectOption, wait for the page to CHANGE *and then STABILIZE* — data rows
	// present AND the row signature unchanged across two consecutive reads. waitSettled alone returns on the
	// FIRST change, which can be a loading/spinner intermediate ⇒ an undercount (red-team APV-1 / SETTLE-
	// HALFLOAD). Returns the stable sig, or null if it never stabilizes (UNCERTAIN ⇒ caller fail-closes).
	const settlePage = async (prevSig) => {
		if (await waitSettled(prevSig) === null) return null;
		if (!await waitRows()) return null;
		let last = await rowsSig();
		for (let t = 0; t < 12; t++) { await page.waitForTimeout(400); const s = await rowsSig(); if (s && s === last) return s; last = s; }
		return null; // never stabilized within budget ⇒ uncertain
	};
	// count exact 문서번호 cells == docId on the CURRENT page
	const cellCount = (docId) => page.getByRole('cell', { name: docId, exact: true }).count();
	// count detail-page cells whose text contains a date string (a 결재선 decision is dated YYYY-MM-DD).
	// Used as the POSITIVE completion marker: a NEW today-dated cell appears after my approve (red-team
	// COMPLETION-ABSENCE-NOT-APPROVAL — replaces absence-only verify).
	const datedCells = async (d) => { try { return (await page.getByRole('cell').allInnerTexts()).filter((t) => t.includes(d)).length; } catch { return 0; } };
	// count exact 문서번호 cells across ALL pages — NEVER clicks. total:-1 means UNCERTAIN (list not loaded OR a
	// page never settled) — callers MUST treat -1 as fail-closed (never approve / never "left inbox").
	const countDoc = async (docId) => {
		await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
		if (!await waitListLoaded() || !await waitRows()) return { total: -1, foundPage: 0 };
		let total = 0, foundPage = 0, prevSig = await rowsSig();
		const c1 = await cellCount(docId); if (c1) { total += c1; foundPage = 1; }
		const ps = await pageSelect();
		if (ps) for (let p = 2; p <= ps.total; p++) {
			await ps.sel.selectOption(String(p));
			const sig = await settlePage(prevSig);
			if (sig === null || !await listLoaded()) return { total: -1, foundPage: 0 }; // page didn't STABLY render ⇒ uncertain
			prevSig = sig;
			const c = await cellCount(docId); if (c) { total += c; if (!foundPage) foundPage = p; }
		}
		return { total, foundPage };
	};
	// open the UNIQUE doc: count across all pages (abort 0/≥2 — DESIGN T1), then go to its page and click its cell.
	const openDoc = async (docId) => {
		const { total, foundPage } = await countDoc(docId);
		if (total === -1) return { ok: false, why: '대기 list did not load / a page did not settle (uncertain)' };
		if (total !== 1) return { ok: false, why: `${total} exact 문서번호 cells across pages (need exactly 1)` };
		await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
		if (!await waitListLoaded() || !await waitRows()) return { ok: false, why: 'list did not load before open' };
		if (foundPage > 1) { const ps = await pageSelect(); if (ps) { const prev = await rowsSig(); await ps.sel.selectOption(String(foundPage)); if (await settlePage(prev) === null) return { ok: false, why: 'page did not settle before open' }; } }
		// poll until the exact 문서번호 cell renders (rows can lag listLoaded)
		let ready = false; for (let t = 0; t < 16 && !ready; t++) { if (await cellCount(docId) === 1) ready = true; else await page.waitForTimeout(500); }
		if (!ready) return { ok: false, why: 'doc cell did not render on its page' };
		await page.getByRole('cell', { name: docId, exact: true }).click();
		return { ok: true };
	};
	// parseKRW(text): largest KRW value in `text`, handling "1,234,567원" / "₩1,234,567" / "5억[3000만]" /
	// "300만". Returns -1 if no figure. Takes the MAX in the region so a total alongside line items reads
	// the total (over-read ⇒ over-skip ⇒ fail-safe).
	const parseKRW = (txt) => {
		let max = -1; const add = (v) => { if (Number.isFinite(v) && v >= 0 && v > max) max = v; }; let m;
		const reUnit = /([0-9][0-9,.]*)\s*억(?:\s*([0-9][0-9,.]*)\s*만)?/g; while ((m = reUnit.exec(txt))) add(Math.round(parseFloat((m[1] || '0').replace(/,/g, '')) * 1e8 + (m[2] ? parseFloat(m[2].replace(/,/g, '')) * 1e4 : 0)));
		const reMan = /([0-9][0-9,.]*)\s*만\s*원?/g; while ((m = reMan.exec(txt))) add(Math.round(parseFloat(m[1].replace(/,/g, '')) * 1e4));
		const reWon = /(?:₩\s*)?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*원?/g; while ((m = reWon.exec(txt))) add(parseInt(m[1].replace(/,/g, ''), 10));
		return max;
	};
	// extractAmount(): LABEL-ANCHORED (recipe.approve.amount.label, e.g. "총 금액") so we read the amount
	// region, not doc-numbers/dates. Returns: null = no amount locator in the recipe (caller fail-closes),
	// -1 = locator/figure not found, else the won value. (red-team AMT-CEILING-EVADE: anchor + fail-closed)
	const extractAmount = async () => {
		if (!(ap.amount && ap.amount.label)) return null;
		const lab = page.getByText(ap.amount.label, { exact: false }).first();
		if (await lab.count() === 0) return -1;
		const region = (await lab.locator('xpath=ancestor-or-self::tr[1]').innerText().catch(() => '')) || (await lab.locator('xpath=..').innerText().catch(() => ''));
		return parseKRW(region);
	};

	// CRASH RECONCILIATION (red-team F-CRASH-CONFIRM-RECONCILE): a doc whose audit's LAST stage is 'clicked'
	// (committed the 확인 but the process died before a terminal stage) is resolved by the reliable
	// departure signal — re-scan 대기; absent ⇒ reconciled-approved, present ⇒ reconciled-failed, uncertain ⇒
	// flagged for manual review. Append-only; never silently. (No-op when there are no stranded 'clicked' rows.)
	const reconcile = async () => {
		let entries = [];
		try { entries = fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return; }
		const lastStage = {}; for (const e of entries) lastStage[e.doc_id] = e.stage;
		const stranded = Object.keys(lastStage).filter((d) => lastStage[d] === 'clicked');
		if (!stranded.length) return;
		log(`RECONCILE: ${stranded.length} doc(s) stranded at 'clicked' — resolving by 대기 departure…`);
		for (const d of stranded) {
			try {
				const c = await countDoc(d);
				if (c.total === -1) { audit(d, 'reconcile-uncertain', '대기 list not loaded'); log(`  RECONCILE ${d}: UNCERTAIN (manual check)`); }
				else if (c.total === 0) { audit(d, 'reconciled-approved', 'left 대기 — 확인 had committed before the crash'); log(`  RECONCILE ${d}: APPROVED (left 대기)`); }
				else { audit(d, 'reconciled-failed', 'still in 대기 — 확인 did not commit'); log(`  RECONCILE ${d}: NOT approved (still in 대기)`); }
			} catch (e) { audit(d, 'reconcile-error', String(e && e.message || e)); log(`  RECONCILE ${d}: error ${e && e.message}`); }
		}
	};
	if (live) await reconcile(); // dry runs never 'clicked', so nothing to reconcile

	for (const t of targets) {
		const docId = norm(t.doc_id), title = norm(t.title);
		const ceiling = (parseInt(t.maxAmount, 10) || 0) || maxAmount;
		const r = { doc_id: docId, status: 'failed', reason: null };
		if (maxN && clicksIssued >= maxN) { r.status = 'skipped'; r.reason = `--max ${maxN} reached (clicks issued)`; audit(docId, 'skipped', 'cap'); results.push(r); continue; }
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
			const detailUrl = page.url(); // recorded for the positive-marker re-open + the 'clicked' audit
			if (await cellCount(docId) !== 1) throw new Error('idLabel: detail does not have exactly one cell == doc_id'); // I4
			if (await page.getByText(title, { exact: false }).count() === 0) throw new Error(`TITLE mismatch: expected title not on detail page`); // CRITICAL F1/T3
			const beforeStamp = await datedCells(TODAY); // today-dated 결재 cells BEFORE my approve (baseline for the +1 transition)
			audit(docId, 'identity_ok', `title✓${ceiling ? ` ceiling=${ceiling}` : ''}`);
			if (ceiling) {
				const amt = await extractAmount();
				if (amt === null) { r.status = 'skipped'; r.reason = 'recipe has no amount locator (approve.amount.label) — cannot enforce ceiling (fail-closed)'; audit(docId, 'skipped', 'no-amount-locator'); results.push(r); continue; }
				if (amt < 0) { r.status = 'skipped'; r.reason = 'amount not parseable at the 금액 label (fail-closed)'; audit(docId, 'skipped', 'amount-unparseable'); results.push(r); continue; }
				if (amt > ceiling) { r.status = 'skipped'; r.reason = `amount ${amt} > ceiling ${ceiling}`; audit(docId, 'skipped', `amount>${ceiling}`); results.push(r); continue; }
				audit(docId, 'amount_ok', String(amt));
			}
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
			audit(docId, 'clicked', detailUrl);
			clicksIssued++; // consume the cap AT the irreversible commit (before the click), not after the verify
			await page.getByRole('button', { name: ap.confirm.name, exact: !!ap.confirm.exact }).click();
			await page.waitForTimeout(3500);
			// POSITIVE completion verify (red-team COMPLETION-ABSENCE-NOT-APPROVAL): require BOTH a NEW today-dated
			// 결재 stamp on the doc (server-fresh re-open; absent-before/present-after) AND departure from the 대기
			// inbox. Either alone is insufficient; any disagreement ⇒ fail-closed (reconciliation re-resolves later).
			await page.goto(detailUrl, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2500);
			const stamped = (await datedCells(TODAY)) > beforeStamp;
			const after = await countDoc(docId);
			if (after.total === -1) throw new Error('post-approve: 대기 list uncertain — cannot confirm');
			if (!stamped && after.total > 0) throw new Error('post-approve: no new 승인 stamp AND still in 대기 (not committed)');
			if (!stamped) throw new Error('post-approve: doc left 대기 but NO new today 승인 stamp on its line — uncertain (fail-closed)');
			if (after.total > 0) throw new Error('post-approve: today 승인 stamp present but doc still in 대기 — contradictory (fail-closed)');
			r.status = 'approved'; r.reason = `승인 stamp ${TODAY} + left 대기`; approvedCount++; audit(docId, 'confirmed', `stamp ${TODAY} + left 대기`);
		} catch (e) {
			if (r.status !== 'skipped' && r.status !== 'dry-ok') r.status = 'failed';
			r.reason = String(e && e.message || e); audit(docId, r.status === 'skipped' ? 'skipped' : 'failed', r.reason); log(`${docId}: ${r.status} — ${r.reason}`);
		}
		results.push(r);
	}
} finally { await browser.close(); }
const summary = { live, dry, total: targets.length, approved: approvedCount, results };
console.log(JSON.stringify(summary));
