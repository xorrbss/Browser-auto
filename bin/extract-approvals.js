#!/usr/bin/env node
'use strict';
// bin/extract-approvals.js — recipe-driven aria-table extractor for the 결재(approval) path.
//
// Emits a FLAT object per row keyed by db columns ({doc_id,title,drafter,submitted_at,...}) for
// bin/store-approvals.js. Shares the aria parse/walk with the other extractors via lib/aria.js; the
// only 결재-specific bits here are the DB-vocabulary check (columns ⊆ doc_id + SCRAPED_COLS) and the
// mandatory doc_id key. (The generic register-any-system path uses bin/extract-list.js → {key,data}.)
//
//   argv[2]: recipe (path or inline JSON).  stdin: snapshot .data.  stdout: JSON array of row objects.
// Fail-loud (never guesses) on: missing/ambiguous table, missing/duplicate mapped header, per-row
// cell-count != header count, or a recipe field outside the db vocabulary. Empty doc_id row → skipped.

const fs = require('node:fs');
const aria = require('../lib/aria.js');
const { SCRAPED_COLS } = require('../lib/db.js');
const VOCAB = ['doc_id', ...SCRAPED_COLS];

function die(m) { console.error('extract-approvals: ' + m); process.exit(2); }

function loadRecipe(arg) {
	if (!arg) die('missing recipe arg (path to recipes/<app>.json or inline JSON)');
	let raw;
	try { raw = fs.existsSync(arg) ? fs.readFileSync(arg, 'utf8') : arg; } catch (e) { die('cannot read recipe: ' + e.message); }
	let r;
	try { r = JSON.parse(raw); } catch (e) { die('recipe is not valid JSON: ' + e.message); }
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
process.stdin.on('end', () => { try { main(); } catch (e) { console.error('extract-approvals: ' + e.message); process.exit(1); } });

function main() {
	const recipe = loadRecipe(process.argv[2]);
	const role = recipe.collection.role || 'table';
	const rowRole = recipe.collection.row || 'row';

	const data = JSON.parse(input.trim() || '{}');
	if (typeof data.snapshot !== 'string') die('stdin has no .snapshot tree (expected the fetch-approvals .data object)');
	const lines = aria.parse(data);

	const hits = aria.findByRoleName(lines, role, recipe.collection.name);
	if (hits.length === 0) die(`${role} "${recipe.collection.name}" not found — is the page the expected list?`);
	if (hits.length > 1) die(`${hits.length} ${role}s named "${recipe.collection.name}" — ambiguous; tighten collection.name`);
	const rows = aria.rowsOf(lines, hits[0], rowRole);

	const header = rows.find((r) => r.children.some((c) => c.role === 'columnheader'));
	if (!header) die('no header row (columnheader) found in the container');
	const headers = header.children.filter((c) => c.role === 'columnheader').map((c) => aria.norm(c.name));
	const headerCount = headers.length;

	const idx = {};
	for (const [field, label] of Object.entries(recipe.columns)) {
		const want = aria.norm(label);
		const found = [];
		headers.forEach((h, i) => { if (h === want) found.push(i); });
		if (found.length === 0) die(`column "${label}" (→${field}) not found among headers [${headers.join(', ')}] — refusing to guess`);
		if (found.length > 1) die(`column "${label}" (→${field}) matches ${found.length} headers — ambiguous`);
		idx[field] = found[0];
	}

	const strip = recipe.strip || {};
	const fields = Object.keys(recipe.columns);
	const items = [];
	for (const r of rows) {
		const cells = r.children.filter((c) => c.role === 'cell');
		if (!cells.length) continue; // header row / non-data row
		if (cells.length !== headerCount) {
			die(`a row has ${cells.length} cells but the header has ${headerCount} columns — markup drift; refusing to mis-map (row cells: ${cells.map((c) => c.name || '∅').join(' | ')})`);
		}
		const doc_id = applyStrip(aria.clean(cells[idx.doc_id].name), strip.doc_id);
		if (!doc_id) continue;
		const item = { doc_id };
		for (const field of fields) {
			if (field === 'doc_id') continue;
			item[field] = applyStrip(aria.clean(cells[idx[field]].name), strip[field]);
		}
		items.push(item);
	}
	process.stdout.write(JSON.stringify(items));
}

// applyStrip: remove a trailing LITERAL suffix (e.g. the " 첨부 파일 표시" attachment tag), then trim.
function applyStrip(v, suffix) {
	if (v == null || !suffix) return v;
	const s = String(v);
	return (s.endsWith(suffix) ? s.slice(0, s.length - suffix.length).trim() : s) || null;
}
