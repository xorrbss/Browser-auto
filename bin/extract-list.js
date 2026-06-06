#!/usr/bin/env node
'use strict';
// bin/extract-list.js — GENERIC recipe-driven aria-table list extractor for the RPA store.
//
// Same engine as bin/extract-approvals.js but field-AGNOSTIC: the recipe names arbitrary fields
// (not the fixed 결재 vocabulary), so ANY system's list (a groupware inbox, an ERP table, a ticket
// queue…) maps to records without code changes. Emits one object per row, ready for lib/db.js
// upsertRecords: { key, data:{ field: value, ... } }.
//
//   argv[2]: recipe (path to a recipe JSON, or inline JSON).
//   stdin  : the snapshot DATA object (jq '.data' = {origin,refs,snapshot}).
//   stdout : JSON array of { key, data }.
//
// recipe shape:
//   { collection:{ name, role?="table", row?="row" },
//     key: "<fieldName>",                 // which column identifies a row (must be in columns)
//     columns: { "<fieldName>": "<header text>", ... },   // arbitrary field names
//     strip:   { "<fieldName>": "<literal trailing suffix>" }? }
//
// Deterministic, no network/LLM. Anchors row→cell to the column HEADERS and FAILS LOUD (never
// guesses) on: missing/ambiguous container, missing/duplicate mapped header, a per-row cell-count
// != header-column count. A row with an empty key value is skipped (never fabricated).

const fs = require('node:fs');

function die(m) { console.error('extract-list: ' + m); process.exit(2); }

function loadRecipe(arg) {
	if (!arg) die('missing recipe arg');
	let raw;
	try { raw = fs.existsSync(arg) ? fs.readFileSync(arg, 'utf8') : arg; } catch (e) { die('cannot read recipe: ' + e.message); }
	let r;
	try { r = JSON.parse(raw); } catch (e) { die('recipe is not valid JSON: ' + e.message); }
	if (!r || !r.collection || !r.collection.name) die('recipe.collection.name is required');
	if (!r.columns || typeof r.columns !== 'object' || !Object.keys(r.columns).length) die('recipe.columns is required');
	if (!r.key || !Object.prototype.hasOwnProperty.call(r.columns, r.key)) die('recipe.key must name one of recipe.columns');
	return r;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
	try { main(); } catch (e) { console.error('extract-list: ' + e.message); process.exit(1); }
});

function main() {
	const recipe = loadRecipe(process.argv[2]);
	const role = recipe.collection.role || 'table';
	const rowRole = recipe.collection.row || 'row';
	const wantName = norm(recipe.collection.name);

	const data = JSON.parse(input.trim() || '{}');
	const tree = typeof data.snapshot === 'string' ? data.snapshot : '';
	if (!tree) die('stdin has no .snapshot tree (expected the .data object)');
	const lines = tree.split('\n').map(parseLine).filter(Boolean);

	const hits = [];
	lines.forEach((l, i) => { if (l.role === role && norm(l.name) === wantName) hits.push(i); });
	if (hits.length === 0) die(`${role} "${recipe.collection.name}" not found`);
	if (hits.length > 1) die(`${hits.length} ${role}s named "${recipe.collection.name}" — ambiguous; tighten collection.name`);
	const tableIdx = hits[0];
	const tableIndent = lines[tableIdx].indent;

	const rows = [];
	for (let i = tableIdx + 1; i < lines.length; i++) {
		if (lines[i].indent <= tableIndent) break;
		if (lines[i].role !== rowRole) continue;
		const rowIndent = lines[i].indent;
		const children = [];
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].indent <= rowIndent) break;
			if (lines[j].indent === rowIndent + 2) children.push(lines[j]);
		}
		rows.push({ children });
	}

	const header = rows.find((r) => r.children.some((c) => c.role === 'columnheader'));
	if (!header) die('no header row (columnheader) found in the container');
	const headers = header.children.filter((c) => c.role === 'columnheader').map((c) => norm(c.name));
	const headerCount = headers.length;

	const idx = {};
	for (const [field, label] of Object.entries(recipe.columns)) {
		const want = norm(label);
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
			die(`a row has ${cells.length} cells but the header has ${headerCount} columns — markup drift; refusing to mis-map (row: ${cells.map((c) => c.name || '∅').join(' | ')})`);
		}
		const rec = {};
		for (const field of fields) rec[field] = applyStrip(clean(cells[idx[field]].name), strip[field]);
		const key = rec[recipe.key];
		if (!key) continue; // no identity → skip, never fabricate
		items.push({ key, data: rec });
	}
	process.stdout.write(JSON.stringify(items));
}

function parseLine(raw) {
	const m = raw.match(/^(\s*)-\s+(\w+)/);
	if (!m) return null;
	let name = null;
	const q = raw.indexOf('"');
	if (q >= 0) { const q2 = raw.lastIndexOf('"'); if (q2 > q) name = raw.slice(q + 1, q2); }
	return { indent: m[1].length, role: m[2], name };
}
const norm = (s) => String(s || '').replace(/\s+/g, '');
const clean = (s) => { s = String(s == null ? '' : s).trim(); return s || null; };
function applyStrip(v, suffix) {
	if (v == null || !suffix) return v;
	const s = String(v);
	return (s.endsWith(suffix) ? s.slice(0, s.length - suffix.length).trim() : s) || null;
}
