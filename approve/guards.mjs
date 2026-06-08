// approve/guards.mjs — PURE deterministic guard helpers for the auto-approve leaf (NO Playwright import,
// so they are unit-tested browser-free in tests/approve-guards-unit.test.sh). After the owner removed the
// per-item-human gate (memory approve-gate-override), these deterministic guards are the SOLE safety, so
// each is FAIL-CLOSED by construction: on any ambiguity they return the cautious answer (skip/uncertain),
// never the permissive one. approve-run.mjs imports these; it owns only the Playwright-coupled glue.
'use strict';

// parseKRW(text): largest KRW value in `text`, handling "1,234,567원" / "₩1,234,567" / "5억[3000만]" /
// "300만". Returns -1 if no figure. Takes the MAX in the region so a total alongside line items reads
// the total (over-read ⇒ over-skip ⇒ fail-safe for an amount CEILING).
export function parseKRW(txt) {
	let max = -1; const add = (v) => { if (Number.isFinite(v) && v >= 0 && v > max) max = v; }; let m;
	const reUnit = /([0-9][0-9,.]*)\s*억(?:\s*([0-9][0-9,.]*)\s*만)?/g; while ((m = reUnit.exec(txt))) add(Math.round(parseFloat((m[1] || '0').replace(/,/g, '')) * 1e8 + (m[2] ? parseFloat(m[2].replace(/,/g, '')) * 1e4 : 0)));
	const reMan = /([0-9][0-9,.]*)\s*만\s*원?/g; while ((m = reMan.exec(txt))) add(Math.round(parseFloat(m[1].replace(/,/g, '')) * 1e4));
	const reWon = /(?:₩\s*)?([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*원?/g; while ((m = reWon.exec(txt))) add(parseInt(m[1].replace(/,/g, ''), 10));
	return max;
}

// pagerDecision(mode, optionTextsPerSelect): decide the TOTAL page count from the page-number combobox,
// RELIABLY (red-team PAGESELECT-* / carry-forward). The completion check (countDoc) scans every page and
// concludes a doc "left 대기" when it is absent on ALL scanned pages — so if the page count is UNDER-read,
// a doc on an unscanned page reads ABSENT ⇒ false "approved". This must never happen, so a pager is only
// TRUSTED when both:
//   (a) the recipe explicitly declares pagination.mode === 'combobox' — a native <select> lists ALL its
//       <option>s in the DOM, so it is NOT windowed like a link-pager (option-count == page-count), AND
//   (b) exactly ONE <select> has numeric options forming the CONTIGUOUS sequence 1..N (N≥2). That rejects
//       a rows-per-page select ([10,20,50]) and any 1-based window / sparse set / multiple candidates.
//   mode: recipe.pagination?.mode (falsy ⇒ the recipe declares no pagination ⇒ single page).
//   optionTextsPerSelect: Array<Array<string>> — the option texts of each <select> currently on the page.
// Returns:
//   { kind: 'none' }                  — no pagination / no pager rendered ⇒ treat as a single page (total 1)
//   { kind: 'pager', index, total }   — the index-th <select> is a trustworthy 1..N pager of `total` pages
//   { kind: 'uncertain' }             — declared combobox but the pager is untrustworthy ⇒ caller FAIL-CLOSES
export function pagerDecision(mode, optionTextsPerSelect) {
	if (!mode) return { kind: 'none' };                 // recipe declares no pagination ⇒ single page
	if (mode !== 'combobox') return { kind: 'uncertain' }; // only the <select> combobox pager is reliably scannable
	const selects = Array.isArray(optionTextsPerSelect) ? optionTextsPerSelect : [];
	const numericSelects = []; // indices of selects with ≥2 numeric options (candidate pagers)
	const pagers = [];         // indices whose numeric options are exactly 1..N
	selects.forEach((opts, index) => {
		const nums = (Array.isArray(opts) ? opts : []).map((o) => String(o).trim()).filter((o) => /^\d+$/.test(o)).map(Number);
		if (nums.length < 2) return;
		numericSelects.push(index);
		const uniq = [...new Set(nums)].sort((a, b) => a - b);
		if (uniq.every((v, k) => v === k + 1)) pagers.push({ index, total: uniq.length }); // contiguous 1..N
	});
	if (pagers.length === 1) return { kind: 'pager', ...pagers[0] };
	if (numericSelects.length === 0) return { kind: 'none' }; // combobox declared but none rendered ⇒ single page
	return { kind: 'uncertain' };                             // a numeric select exists but isn't a clean 1..N pager, or >1 candidate ⇒ fail-closed
}

// matchesFormType(liveForm, want): does the live form-type heading match any DECLARED expected form?
// `want` is a string or array of expected form names; match = normalized substring (the heading may carry
// extra adornment). Empty liveForm or no match ⇒ false (caller FAIL-CLOSES). norm() folds whitespace.
export function matchesFormType(liveForm, want) {
	const lf = norm(liveForm);
	if (!lf) return false;
	const names = (Array.isArray(want) ? want : [want]).map(norm).filter(Boolean);
	return names.some((w) => lf.includes(w));
}

export const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// amountVerdict(amt, ceiling): the FAIL-CLOSED amount-ceiling decision (pure; the page-coupled extractAmount
// stays in the leaf). `amt`: null = no amount locator in the recipe, -1 = locator/figure not found, else the
// parsed 원 value. Returns { eligible, reason, audit } — eligible only when a figure ≤ ceiling was read.
export function amountVerdict(amt, ceiling) {
	if (amt === null) return { eligible: false, reason: 'recipe has no amount locator (approve.amount.label) — cannot enforce ceiling (fail-closed)', audit: 'no-amount-locator' };
	if (amt < 0) return { eligible: false, reason: 'amount not parseable at the 금액 label (fail-closed)', audit: 'amount-unparseable' };
	if (amt > ceiling) return { eligible: false, reason: `amount ${amt} > ceiling ${ceiling}`, audit: `amount>${ceiling}` };
	return { eligible: true, reason: '', audit: String(amt) };
}

// completionVerdict(stamped, afterTotal): the POSITIVE completion decision (pure). `stamped` = a NEW today
// 승인 stamp appeared on the doc's own line; `afterTotal` = countDoc across all pages (-1 uncertain, 0 absent,
// >0 still present). Approved ONLY when stamped AND absent; every other combination ⇒ fail-closed with a reason.
export function completionVerdict(stamped, afterTotal) {
	if (afterTotal === -1) return { ok: false, reason: 'post-approve: 대기 list uncertain — cannot confirm' };
	if (!stamped && afterTotal > 0) return { ok: false, reason: 'post-approve: no new 승인 stamp AND still in 대기 (not committed)' };
	if (!stamped) return { ok: false, reason: 'post-approve: doc left 대기 but NO new today 승인 stamp on its line — uncertain (fail-closed)' };
	if (afterTotal > 0) return { ok: false, reason: 'post-approve: today 승인 stamp present but doc still in 대기 — contradictory (fail-closed)' };
	return { ok: true, reason: '' };
}
