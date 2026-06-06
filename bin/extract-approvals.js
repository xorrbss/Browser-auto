#!/usr/bin/env node
'use strict';
// bin/extract-approvals.js — generic, RECIPE-DRIVEN aria-snapshot LIST extractor.
//
// Was Hiworks-specific; the four site constants (table name, column→field map, the mandatory
// doc_id key, and the title suffix strip) now live in recipes/<app>.json, so the SAME parser
// handles any ARIA-table list screen with NO code change — only the recipe (data) differs.
//
//   argv[2]: recipe — a path to recipes/<app>.json, OR an inline JSON string (used by the unit test).
//   stdin  : the snapshot DATA object saved by fetch-approvals.sh (jq '.data' = {origin,refs,snapshot}),
//            where .snapshot is the Playwright aria-snapshot YAML tree of the list page.
//   stdout : JSON array of items keyed by the recipe's db fields (doc_id always present).
//
// Deterministic, no network, no LLM. Anchors row→cell mapping to the column HEADERS and FAILS LOUD
// (never guesses) on: missing/ambiguous container, missing/duplicate mapped header, a row whose cell
// count != the header column count (the silent positional-mis-map vector), or a recipe field outside
// the DB vocabulary. A row with an empty doc_id cell is skipped — never fabricated.
//
// Ceiling (honest): handles the ARIA TABLE family (role table/grid with columnheader/row/cell and a
// single named container). A pure CSS div-grid with no ARIA table semantics, or a page with multiple
// same-named containers, is out of scope — it fails loud rather than guessing.

const fs = require('node:fs');
const { SCRAPED_COLS } = require('../lib/db.js');
// The legal field vocabulary is the DB's own column set (single source of truth) + the doc_id PK.
const VOCAB = ['doc_id', ...SCRAPED_COLS];

function die(msg) {
	console.error('extract-approvals: ' + msg);
	process.exit(2);
}

function loadRecipe(arg) {
	if (!arg) die('missing recipe arg (path to recipes/<app>.json or inline JSON)');
	let raw;
	try {
		raw = fs.existsSync(arg) ? fs.readFileSync(arg, 'utf8') : arg; // path, else inline JSON
	} catch (e) {
		die('cannot read recipe: ' + e.message);
	}
	let r;
	try {
		r = JSON.parse(raw);
	} catch (e) {
		die('recipe is not valid JSON: ' + e.message);
	}
	if (!r || !r.collection || !r.collection.name) die('recipe.collection.name is required');
	const cols = r.columns;
	if (!cols || typeof cols !== 'object' || !Object.keys(cols).length) die('recipe.columns is required');
	for (const f of Object.keys(cols)) {
		if (!VOCAB.includes(f)) die(`recipe.columns field "${f}" is not a known db column [${VOCAB.join(', ')}]`);
	}
	if (!cols.doc_id) die('recipe.columns must map doc_id (the approvals primary key)');
	return r;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
	try {
		main();
	} catch (e) {
		console.error('extract-approvals: ' + e.message);
		process.exit(1);
	}
});

function main() {
	const recipe = loadRecipe(process.argv[2]);
	const role = recipe.collection.role || 'table';
	const rowRole = recipe.collection.row || 'row';
	const wantName = norm(recipe.collection.name);

	const data = JSON.parse(input.trim() || '{}');
	const tree = typeof data.snapshot === 'string' ? data.snapshot : '';
	if (!tree) die('stdin has no .snapshot tree (expected the fetch-approvals .data object)');
	const lines = tree.split('\n').map(parseLine).filter(Boolean);

	// 1. Locate the container: EXACTLY one role+name match (0 or >1 → fail loud).
	const hits = [];
	lines.forEach((l, i) => {
		if (l.role === role && norm(l.name) === wantName) hits.push(i);
	});
	if (hits.length === 0) die(`${role} "${recipe.collection.name}" not found — is the page the expected list?`);
	if (hits.length > 1) die(`${hits.length} ${role}s named "${recipe.collection.name}" — ambiguous; tighten collection.name`);
	const tableIdx = hits[0];
	const tableIndent = lines[tableIdx].indent;

	// 2. Collect rows + each row's DIRECT children within the container subtree.
	const rows = [];
	for (let i = tableIdx + 1; i < lines.length; i++) {
		if (lines[i].indent <= tableIndent) break; // left the container
		if (lines[i].role !== rowRole) continue;
		const rowIndent = lines[i].indent;
		const children = [];
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].indent <= rowIndent) break;
			if (lines[j].indent === rowIndent + 2) children.push(lines[j]); // direct children only
		}
		rows.push({ children });
	}

	// 3. Header row → ordered column labels (INCLUDING empty filler cols, to stay position-aligned
	//    with the data cells). The header count is the integrity anchor for every data row.
	const header = rows.find((r) => r.children.some((c) => c.role === 'columnheader'));
	if (!header) die('no header row (columnheader) found in the container');
	const headers = header.children.filter((c) => c.role === 'columnheader').map((c) => norm(c.name));
	const headerCount = headers.length;

	// 4. Resolve each mapped field to a UNIQUE column index (0 or duplicate → fail loud).
	const idx = {};
	for (const [field, label] of Object.entries(recipe.columns)) {
		const want = norm(label);
		const found = [];
		headers.forEach((h, i) => {
			if (h === want) found.push(i);
		});
		if (found.length === 0) die(`column "${label}" (→${field}) not found among headers [${headers.join(', ')}] — refusing to guess`);
		if (found.length > 1) die(`column "${label}" (→${field}) matches ${found.length} headers — ambiguous`);
		idx[field] = found[0];
	}

	// 5. Emit data rows. Per-row cell count MUST equal the header column count (the silent
	//    positional-mis-map guard). doc_id-empty rows are skipped, never fabricated.
	const strip = recipe.strip || {};
	const fields = Object.keys(recipe.columns);
	const items = [];
	for (const r of rows) {
		const cells = r.children.filter((c) => c.role === 'cell');
		if (!cells.length) continue; // the header row (columnheaders) and any non-data row
		if (cells.length !== headerCount) {
			die(`a row has ${cells.length} cells but the header has ${headerCount} columns — markup drift; refusing to mis-map (row cells: ${cells.map((c) => c.name || '∅').join(' | ')})`);
		}
		const doc_id = applyStrip(clean(cells[idx.doc_id].name), strip.doc_id);
		if (!doc_id) continue;
		const item = { doc_id };
		for (const field of fields) {
			if (field === 'doc_id') continue;
			item[field] = applyStrip(clean(cells[idx[field]].name), strip[field]);
		}
		items.push(item);
	}
	process.stdout.write(JSON.stringify(items));
}

// parseLine: "        - cell \"IB-...\" [ref=e55]" → { indent, role:'cell', name:'IB-...' }.
function parseLine(raw) {
	const m = raw.match(/^(\s*)-\s+(\w+)/);
	if (!m) return null;
	let name = null;
	const q = raw.indexOf('"');
	if (q >= 0) {
		const q2 = raw.lastIndexOf('"'); // [ref=eN] has no quotes, so this is the name's closing quote
		if (q2 > q) name = raw.slice(q + 1, q2);
	}
	return { indent: m[1].length, role: m[2], name };
}

const norm = (s) => String(s || '').replace(/\s+/g, ''); // "문서 번호" → "문서번호"
const clean = (s) => {
	s = String(s == null ? '' : s).trim();
	return s || null;
};
// applyStrip: remove a trailing LITERAL suffix (e.g. the " 첨부 파일 표시" attachment tag), then trim.
function applyStrip(v, suffix) {
	if (v == null || !suffix) return v;
	const s = String(v);
	return (s.endsWith(suffix) ? s.slice(0, s.length - suffix.length).trim() : s) || null;
}
