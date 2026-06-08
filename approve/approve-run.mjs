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
import { parseKRW, pagerDecision, matchesFormType, norm, amountVerdict, completionVerdict } from './guards.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const recipePath = opt('--recipe'), statePath = opt('--state'), listUrl = opt('--list-url');
const targetsFile = opt('--targets-file');
const live = flag('--live');                 // DEFAULT = dry-run (fail-closed); live is explicit
const dry = !live;
// --reviewed: a HUMAN-REVIEWED batch — the operator read each doc's summary on the webui review screen and
// CHECKED the ones to approve, so the human is the content/amount control (amount-by-label is unreliable:
// 총 금액/총 합 계 are drafter-TYPED, not fixed). This relaxes ONLY the full-auto-only form-homogeneity guard
// (mixed forms are the human's deliberate selection); every form-AGNOSTIC guard stays (unique 문서번호 open,
// urlGlob, exactly-one idLabel, title binding, 승인 radio asserted-checked, positive 완료 verify, audit, cap).
const reviewed = flag('--reviewed');
const maxN = parseInt(opt('--max', '0'), 10) || 0;
const maxAmount = parseInt(opt('--max-amount', '0'), 10) || 0;
const auditPath = opt('--audit', 'data/approve-audit.jsonl');
const stopFile = opt('--stop-file', 'data/approve-STOP');
if (!recipePath || !statePath || !listUrl || !targetsFile) { console.error('usage: --recipe --state --list-url --targets-file [--live --max N] [--max-amount N]'); process.exit(2); }
if (live && maxN <= 0) { console.error('REFUSED: --live requires a positive --max count cap (fail-closed)'); process.exit(2); }
// Defense-in-depth (red-team scheduler WRAPPER-SCRIPT-INJECTION): the host scheduler exports
// AQA_SCHEDULED_NO_LIVE=1, and live is HARD-REFUSED under it regardless of how args were assembled — so no
// wrapper/indirection run through bin/scheduled-task.sh can ever drive a LIVE approve (unattended live is forbidden).
if (live && process.env.AQA_SCHEDULED_NO_LIVE) { console.error('REFUSED: live approve is forbidden under the scheduler (AQA_SCHEDULED_NO_LIVE) — unattended LIVE is fail-closed'); process.exit(3); }
const recipe = JSON.parse(fs.readFileSync(recipePath, 'utf8'));
// CANONICAL form is recipe.actions.approve (general-action-rpa Step A); legacy recipe.approve is the 1:1 fallback.
const ap = (recipe.actions && recipe.actions.approve) || recipe.approve; if (!ap) { console.error(`recipe ${recipePath} has no "actions.approve" (or legacy "approve") block`); process.exit(2); }
const urlGlobRe = (recipe.detail && recipe.detail.urlGlob) ? new RegExp(recipe.detail.urlGlob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*')) : /\/view\//;
let targets = JSON.parse(fs.readFileSync(targetsFile, 'utf8'));
try { fs.rmSync(targetsFile, { force: true }); } catch {} // single-use: consume the (possibly-sensitive) targets file
if (!Array.isArray(targets) || !targets.length) { console.error('targets-file must be a non-empty JSON array'); process.exit(2); }
// KILL-SWITCH halt-ALL (red-team KILLSWITCH-QUEUED / F-STOP-CLEAR-RACE): if STOP is present at startup,
// REFUSE to start — a QUEUED batch must not clobber a just-pressed 일괄 중지. STOP is cleared ONLY by an
// explicit new run (the /api/approve/run route rm's it); a STOP written DURING this run is caught per-doc below.
if (fs.existsSync(stopFile)) { console.error('[approve] kill-switch (data/approve-STOP) present — refusing to start batch (press ▶ 실행 to clear & resume)'); process.exit(0); }

fs.mkdirSync(path.dirname(auditPath), { recursive: true });
const audit = (doc_id, stage, detail) => {
	const line = JSON.stringify({ at: new Date().toISOString(), doc_id, stage, live, reviewed, ...(detail ? { detail } : {}) }) + '\n';
	const fd = fs.openSync(auditPath, 'a'); try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
const log = (...a) => console.error('[approve]', ...a);
// YYYY-MM-DD in KST — the 결재선 stamp renders KST-local dates, so TODAY must be KST not UTC, else the
// positive marker false-negatives during KST 00:00-08:59 and mis-audits a real approval 'failed' (red-team STAMP-TZ-1).
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });

const results = [];
let batchForm = null;      // the form-type heading shared by this batch — a later differing one is refused (red-team C-RECIPE-MISPIN-NO-FORMTYPE)
let approvedCount = 0;     // CONFIRMED approvals (for the report)
let clicksIssued = 0;      // irreversible 확인 commits ISSUED — the --max cap binds THIS (red-team CAP-COUNTS):
                           // a committed-but-uncertain doc must still consume budget, else clicks can exceed --max.
const browser = await chromium.launch({ headless: false, channel: 'chrome' });
try {
	const ctx = await browser.newContext({ storageState: statePath });
	const page = await ctx.newPage();

	// Resolve the page-number combobox RELIABLY (red-team PAGESELECT-* carry-forward): a windowed/ambiguous
	// pager that under-reports the page count would make countDoc under-scan ⇒ a doc on an unscanned page
	// reads ABSENT ⇒ false "left 대기" ⇒ false approved. The decision is pure (approve/guards.mjs,
	// unit-tested): trust ONLY a recipe-declared combobox whose options are a single contiguous 1..N set.
	// Returns: { sel, total } a trusted pager · null = single page · { uncertain:true } ⇒ caller FAIL-CLOSES.
	const pageSelect = async () => {
		const selects = page.locator('select'); const n = await selects.count();
		const optTexts = [];
		for (let i = 0; i < n; i++) optTexts.push(await selects.nth(i).locator('option').allTextContents());
		const d = pagerDecision(recipe.pagination && recipe.pagination.mode, optTexts);
		if (d.kind === 'pager') return { sel: selects.nth(d.index), total: d.total };
		if (d.kind === 'uncertain') return { uncertain: true };
		return null; // 'none' ⇒ single page
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
	// today-dated 결재선 cell TEXTS (each like "<role> <date> <name>") — diffing before/after the click yields
	// the actor whose 승인 stamp was just added (red-team/M4 actor binding; fail-soft metadata, never a gate).
	const datedCellTexts = async (d) => { try { return (await page.getByRole('cell').allInnerTexts()).map(norm).filter((t) => t.includes(d)); } catch { return []; } };
	// form-type heading (Gate B: the detail h1 is the FORM TYPE, e.g. "지출결의서(거래처)" — stable per form,
	// NOT the per-doc subject which is the h2). Used to keep a batch HOMOGENEOUS + optionally pin recipe.approve.formType.
	const formTypeOf = async () => { try { return norm((await page.getByRole('heading', { level: 1 }).allInnerTexts()).join(' • ')); } catch { return ''; } };
	// count exact 문서번호 cells across ALL pages — NEVER clicks. total:-1 means UNCERTAIN (list not loaded OR a
	// page never settled) — callers MUST treat -1 as fail-closed (never approve / never "left inbox").
	const countDoc = async (docId) => {
		await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
		if (!await waitListLoaded() || !await waitRows()) return { total: -1, foundPage: 0 };
		let total = 0, foundPage = 0, prevSig = await rowsSig();
		const c1 = await cellCount(docId); if (c1) { total += c1; foundPage = 1; }
		const ps = await pageSelect();
		if (ps && ps.uncertain) return { total: -1, foundPage: 0 }; // untrustworthy pager ⇒ fail-closed (can't prove all pages scanned)
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
		if (foundPage > 1) { const ps = await pageSelect(); if (!ps || ps.uncertain || !ps.sel) return { ok: false, why: 'pager uncertain before open (fail-closed)' }; const prev = await rowsSig(); await ps.sel.selectOption(String(foundPage)); if (await settlePage(prev) === null) return { ok: false, why: 'page did not settle before open' }; }
		// poll until the exact 문서번호 cell renders (rows can lag listLoaded)
		let ready = false; for (let t = 0; t < 16 && !ready; t++) { if (await cellCount(docId) === 1) ready = true; else await page.waitForTimeout(500); }
		if (!ready) return { ok: false, why: 'doc cell did not render on its page' };
		await page.getByRole('cell', { name: docId, exact: true }).click();
		return { ok: true };
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
		let raw = ''; try { raw = fs.readFileSync(auditPath, 'utf8'); } catch { return; }
		for (const l of raw.split('\n')) { if (!l.trim()) continue; try { entries.push(JSON.parse(l)); } catch {} } // per-line: a torn final line (from the very crash) must not disable all recovery
		// Only LIVE rows define the latest stage — a later dry-run's 'dry_ok'/'failed' must NOT mask a live
		// 'clicked' (red-team RECONCILE-DRY-RUN-MASKS-STRANDED). Remember the 'clicked' detailUrl + KST day.
		const lastStage = {}, clicked = {};
		for (const e of entries) { if (!e.live) continue; lastStage[e.doc_id] = e.stage; if (e.stage === 'clicked') clicked[e.doc_id] = { url: e.detail, day: e.at ? new Date(e.at).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }) : '' }; }
		const stranded = Object.keys(lastStage).filter((d) => lastStage[d] === 'clicked');
		if (!stranded.length) return;
		log(`RECONCILE: ${stranded.length} doc(s) stranded at 'clicked' — resolving by 대기 departure + 승인 stamp…`);
		for (const d of stranded) {
			try {
				const c = await countDoc(d);
				if (c.total === -1) { audit(d, 'reconcile-uncertain', '대기 list not loaded'); log(`  RECONCILE ${d}: UNCERTAIN (manual check)`); continue; }
				if (c.total > 0) { audit(d, 'reconciled-failed', 'still in 대기 — 확인 did not commit'); log(`  RECONCILE ${d}: NOT approved (still in 대기)`); continue; }
				// departed 대기 — cross-check the recorded detail for a click-day 승인 stamp to distinguish an
				// approval from a non-approval departure (회수/반려/parallel approver). Stamp-absent ⇒ uncertain, not approved.
				const info = clicked[d]; let stamped = null;
				if (info && info.url) { try { await page.goto(info.url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2000); stamped = (await datedCells(info.day)) > 0; } catch { stamped = null; } }
				if (stamped === false) { audit(d, 'reconcile-uncertain', `left 대기 but no ${info.day} 승인 stamp — possibly 회수/반려 (manual check)`); log(`  RECONCILE ${d}: UNCERTAIN (departed, no stamp)`); }
				else { audit(d, 'reconciled-approved', `left 대기${stamped ? ` + ${info.day} 승인 stamp` : ''} — 확인 committed before the crash`); log(`  RECONCILE ${d}: APPROVED (left 대기${stamped ? ' + stamp' : ''})`); }
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
			// FORM-TYPE guard (red-team C-RECIPE-MISPIN-NO-FORMTYPE): a recipe's deterministic guards (esp. the
			// amount label) are validated for ONE form family; misapplying it across forms (a 지출 recipe on a 품의)
			// is unsafe — most acute under allowNoValueCeiling. THREE FAIL-CLOSED checks: (1) optional explicit pin
			// recipe.approve.formType must match the live form; (2) the form-type heading MUST be READABLE — an
			// unreadable h1 is DOUBT and is refused (else it would bypass the homogeneity check below — red-team
			// FORMTYPE-UNREADABLE-BYPASS); (3) ALWAYS keep a batch HOMOGENEOUS (the first form sets the baseline;
			// a later differing one is refused — never mix forms in one auto-approve batch).
			const liveForm = await formTypeOf();
			if (ap.formType && !matchesFormType(liveForm, ap.formType)) { r.status = 'skipped'; r.reason = `form type mismatch (live "${liveForm || '?'}" not in expected ${JSON.stringify(ap.formType)})`; audit(docId, 'skipped', 'form-type-mismatch'); results.push(r); continue; }
			// Homogeneity + readable-h1 are FULL-AUTO-only safety (they replace human content review for a recipe
			// valid for ONE form). In --reviewed mode the operator read each summary and checked each item, so a
			// mixed-form selection is DELIBERATE and the human is the form/content control — skip these two checks.
			if (!reviewed) {
				if (!liveForm) { r.status = 'skipped'; r.reason = 'form-type heading (h1) unreadable on the detail — cannot verify the form (fail-closed)'; audit(docId, 'skipped', 'form-unreadable'); results.push(r); continue; }
				if (batchForm === null) batchForm = liveForm; else if (batchForm !== liveForm) { r.status = 'skipped'; r.reason = `mixed-form batch: "${liveForm}" ≠ batch form "${batchForm}" — run one form type per batch`; audit(docId, 'skipped', 'mixed-form'); results.push(r); continue; }
			}
			const beforeStamp = await datedCells(TODAY); // today-dated 결재 cells BEFORE my approve (baseline for the +1 transition)
			const beforeStampTexts = await datedCellTexts(TODAY); // baseline texts for the actor diff after approval
			audit(docId, 'identity_ok', `title✓${ceiling ? ` ceiling=${ceiling}` : ''}`);
			if (ceiling) {
				const v = amountVerdict(await extractAmount(), ceiling);
				if (!v.eligible) { r.status = 'skipped'; r.reason = v.reason; audit(docId, 'skipped', v.audit); results.push(r); continue; }
				audit(docId, 'amount_ok', v.audit);
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
			await page.goto(detailUrl, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1500);
			// POLL for MY new today-dated 결재 stamp to render (vs a single fixed-sleep read — red-team F-MARKER-WEAK-PROXY)
			let stamped = false;
			for (let t = 0; t < 12 && !stamped; t++) { if ((await datedCells(TODAY)) > beforeStamp) stamped = true; else await page.waitForTimeout(500); }
			// ACTOR (M4 / DESIGN §13-Q2): the today-dated 결재선 cell that appeared since beforeStamp IS the
			// approver line just stamped by the live login (e.g. "대표이사 2026-06-08 김택균"). Capture it HERE,
			// while still on the detail page (countDoc navigates away next). Fail-soft metadata — never a gate.
			const afterStampTexts = await datedCellTexts(TODAY);
			const newStamps = afterStampTexts.filter((tx) => !beforeStampTexts.includes(tx));
			const actor = newStamps.length === 1 ? newStamps[0] : (newStamps.length ? newStamps.join(' | ') : null);
			const after = await countDoc(docId);
			const cv = completionVerdict(stamped, after.total);
			if (!cv.ok) throw new Error(cv.reason);
			r.status = 'approved'; r.actor = actor; r.reason = `승인 stamp ${TODAY}${actor ? ` (${actor})` : ''} + left 대기`; approvedCount++; audit(docId, 'confirmed', `stamp ${TODAY}${actor ? ` | actor: ${actor}` : ''} + left 대기`);
		} catch (e) {
			if (r.status !== 'skipped' && r.status !== 'dry-ok') r.status = 'failed';
			r.reason = String(e && e.message || e); audit(docId, r.status === 'skipped' ? 'skipped' : 'failed', r.reason); log(`${docId}: ${r.status} — ${r.reason}`);
		}
		results.push(r);
	}
} finally { await browser.close(); }
const summary = { live, dry, total: targets.length, approved: approvedCount, results };
console.log(JSON.stringify(summary));
