#!/usr/bin/env node
'use strict';
// bin/pager-decide.js - shared, fail-closed page-combobox decision for ARIA
// snapshots. It reuses approve/guards.mjs `pagerDecision`, the same pure rule
// the Playwright engine (bin/pw-rpa.mjs / approve/approve-run.mjs) trusts.
//
// The old bash rule was unsafe: it counted EVERY numeric <option> anywhere as a page (a rows-per-page
// select [10,20,50] inflated the count) and drove the FIRST combobox in the snapshot — possibly a filter
// or rows-per-page dropdown. Selecting "2" on a filter changes the row set, the gate sees rows change and
// "settles", and those wrong rows get STORED. This makes the decision fail-closed instead.
//
// Input  : an ARIA snapshot `.data` JSON on stdin.
// Argv   : the recipe's pagination.mode (e.g. "combobox"; anything falsy ⇒ single page).
// Output : one line "<kind> <total> <ref>" —
//            pager     <N> <refId>   a trustworthy 1..N page combobox; drive <refId>, scan N pages
//            none       1            no pagination / no pager rendered ⇒ single page
//            uncertain  1            a select exists but isn't a clean single 1..N pager ⇒ caller scans
//                                    page 1 ONLY and logs (fail-closed) — never a guessed combobox
//
// Grouping note: the flat `.refs` map carries no option→select parent link, so options can't be tied to a
// specific select. We sidestep that safely: only when there is EXACTLY ONE combobox do all numeric options
// provably belong to it (no other select can own them), so they're handed to pagerDecision as that one
// select's options. With ≥2 comboboxes the page selector can't be identified from flat refs ⇒ uncertain.
const path = require('node:path');
const { pathToFileURL } = require('node:url');

function decideFromRefs(mode, refs, pagerDecision) {
	const entries = Object.entries(refs || {});
	const combos = entries.filter(([, v]) => v && v.role === 'combobox');
	const numericOptions = entries
		.filter(([, v]) => v && v.role === 'option' && /^[0-9]+$/.test(String(v.name == null ? '' : v.name).trim()))
		.map(([, v]) => String(v.name).trim());
	if (!mode || mode !== 'combobox' || combos.length === 0) return { kind: 'none', total: 1, ref: '' };
	if (combos.length >= 2) return { kind: 'uncertain', total: 1, ref: '' }; // can't identify the page selector from flat refs
	const d = pagerDecision('combobox', [numericOptions]); // exactly one combobox ⇒ it owns all numeric options
	if (d.kind === 'pager') return { kind: 'pager', total: d.total, ref: combos[0][0] };
	if (d.kind === 'uncertain') return { kind: 'uncertain', total: 1, ref: '' };
	return { kind: 'none', total: 1, ref: '' };
}

async function main() {
	const mode = process.argv[2] || '';
	let raw = '';
	process.stdin.setEncoding('utf8');
	for await (const chunk of process.stdin) raw += chunk;
	let refs = {};
	try { const data = JSON.parse(raw); refs = (data && data.refs) || {}; } catch { refs = {}; }
	const { pagerDecision } = await import(pathToFileURL(path.join(__dirname, '..', 'approve', 'guards.mjs')).href);
	const out = decideFromRefs(mode, refs, pagerDecision);
	process.stdout.write(`${out.kind} ${out.total} ${out.ref}\n`);
}

module.exports = { decideFromRefs };

if (require.main === module) {
	main().catch((e) => { console.error('[pager-decide] ' + (e && e.message || e)); process.stdout.write('uncertain 1 \n'); });
}
