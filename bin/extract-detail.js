#!/usr/bin/env node
'use strict';
// bin/extract-detail.js — extract per-document DETAIL fields from an approval detail-page snapshot.
//
// The detail page is a LABEL→VALUE layout (rowheader → adjacent value cell) plus a form body,
// UNLIKE the list's column model — so this is a separate, recipe-driven extractor. Used by the
// enrichment loop (open each 대기 doc → snapshot → extract-detail → store dept + raw_text).
//
//   argv[2]: recipe path (uses recipe.detail.fields {db_field: "rowheader label"} and
//            recipe.detail.bodyFromHeadingLevel for the raw_text body blob)
//   stdin  : the detail snapshot .data object (jq '.data' = {origin,refs,snapshot})
//   stdout : JSON object of detail db fields (e.g. { dept, raw_text }); fields not found are null.
//
// Deterministic, no network, no LLM. Label→value is anchored to the rowheader TEXT (not a fixed
// position). raw_text is the document body from the form's top heading onward (parent/child text
// de-duplicated, internal whitespace collapsed) — a blob for the local summarizer to consume.

const fs = require('node:fs');
const { SCRAPED_COLS } = require('../lib/db.js');
const VOCAB = ['doc_id', ...SCRAPED_COLS];
const MAX_BODY = 8000; // cap the blob handed to the summarizer

function die(m) { console.error('extract-detail: ' + m); process.exit(2); }

function loadDetailRecipe(arg) {
	if (!arg) die('missing recipe arg');
	let raw;
	try {
		raw = fs.existsSync(arg) ? fs.readFileSync(arg, 'utf8') : arg;
	} catch (e) {
		die('cannot read recipe: ' + e.message);
	}
	let r;
	try {
		r = JSON.parse(raw);
	} catch (e) {
		die('recipe is not valid JSON: ' + e.message);
	}
	const d = r.detail || {};
	for (const f of Object.keys(d.fields || {})) {
		if (!VOCAB.includes(f)) die(`recipe.detail.fields "${f}" is not a known db column [${VOCAB.join(', ')}]`);
	}
	return d;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
	try {
		main();
	} catch (e) {
		console.error('extract-detail: ' + e.message);
		process.exit(1);
	}
});

function main() {
	const detail = loadDetailRecipe(process.argv[2]);
	const expectId = process.argv[3] || null; // the doc_id the enrich loop intended to open
	const data = JSON.parse(input.trim() || '{}');
	const tree = typeof data.snapshot === 'string' ? data.snapshot : '';
	if (!tree) die('stdin has no .snapshot tree (expected the detail .data object)');
	const lines = tree.split('\n').map(parseLine).filter(Boolean);

	// CORRECTNESS GUARD (refuse silent wrong-page storage): the detail page must be the document we
	// meant to open. detail.idLabel is the rowheader carrying the document number; if it is absent
	// the page is not a doc detail (e.g. a click landed back on the list), and if it disagrees with
	// the expected doc_id we opened the wrong one — either way FAIL LOUD so the enrich loop skips it.
	if (detail.idLabel) {
		const pageId = labelValue(lines, detail.idLabel);
		if (!pageId) die(`not a document detail page — "${detail.idLabel}" not found (a click likely stayed on the list)`);
		if (expectId && clean(pageId) !== clean(expectId)) {
			die(`wrong detail page — ${detail.idLabel} is "${pageId}" but expected "${expectId}"; refusing to store`);
		}
	}

	const out = {};

	// label→value fields: find the rowheader by text, take its next SAME-indent sibling cell.
	for (const [field, label] of Object.entries(detail.fields || {})) {
		out[field] = labelValue(lines, label);
	}

	// raw_text body: from the first heading at the configured level (default 1) to the end.
	const lvl = Number.isInteger(detail.bodyFromHeadingLevel) ? detail.bodyFromHeadingLevel : 1;
	out.raw_text = bodyFromHeading(lines, lvl);

	process.stdout.write(JSON.stringify(out));
}

// labelValue: locate `rowheader "<label>"`, return its adjacent value cell's text (or null).
function labelValue(lines, label) {
	const want = norm(label);
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].role !== 'rowheader' || norm(lines[i].name) !== want) continue;
		const ind = lines[i].indent;
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].indent < ind) break; // left the row
			if (lines[j].indent === ind) {
				// first sibling at the rowheader's level — the value cell if it is one
				return lines[j].role === 'cell' ? cellText(lines, j) : null;
			}
		}
		return null;
	}
	return null;
}

// cellText: a cell's own name, else the first descendant text (some cells carry text only in a child).
function cellText(lines, idx) {
	const own = clean(lines[idx].name);
	if (own) return own;
	const ind = lines[idx].indent;
	for (let j = idx + 1; j < lines.length && lines[j].indent > ind; j++) {
		const t = clean(lines[j].name);
		if (t) return t;
	}
	return null;
}

// bodyFromHeading: blob of text from the first heading at `level` to the end, parent/child-deduped.
function bodyFromHeading(lines, level) {
	let start = lines.findIndex((l) => l.role === 'heading' && l.level === level);
	if (start < 0) start = lines.findIndex((l) => l.role === 'heading'); // fall back to first heading
	if (start < 0) start = 0;
	const out = [];
	let prev = '';
	for (let i = start; i < lines.length; i++) {
		const nm = lines[i].name;
		if (nm == null) continue;
		const t = String(nm).replace(/\s+/g, ' ').trim();
		if (!t) continue;
		if (prev && (prev === t || prev.includes(t))) continue; // collapse parent→child / repeated label
		out.push(t);
		prev = t;
	}
	const blob = out.join('\n');
	return (blob.length > MAX_BODY ? blob.slice(0, MAX_BODY) : blob) || null;
}

function parseLine(raw) {
	const m = raw.match(/^(\s*)-\s+(\w+)/);
	if (!m) return null;
	let name = null;
	const q = raw.indexOf('"');
	if (q >= 0) {
		const q2 = raw.lastIndexOf('"');
		if (q2 > q) name = raw.slice(q + 1, q2);
	}
	const lvl = /\blevel=(\d+)/.exec(raw);
	return { indent: m[1].length, role: m[2], name, level: lvl ? Number(lvl[1]) : null };
}

const norm = (s) => String(s || '').replace(/\s+/g, '');
const clean = (s) => {
	s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
	return s || null;
};
