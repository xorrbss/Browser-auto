#!/usr/bin/env node
'use strict';
// bin/extract-list.js — GENERIC recipe-driven aria-table list extractor for the RPA store.
//
// Field-AGNOSTIC: the recipe names arbitrary fields, so ANY system's list (a groupware inbox, an ERP
// table, a ticket queue…) maps to records without code changes. Emits one object per row, ready for
// lib/db.js upsertRecords: { key, data:{ field: value, ... } }. Shares the aria parse/walk with the
// other extractors via lib/aria.js.
//
//   argv[2]: recipe (path to a recipe JSON, or inline JSON).
//   stdin  : the snapshot DATA object (jq '.data' = {origin,refs,snapshot}).
//   stdout : JSON array of { key, data }.
//
// Deterministic, no network/LLM. Anchors row→cell to the column HEADERS and FAILS LOUD (never
// guesses) on: missing/ambiguous container, missing/duplicate mapped header, per-row cell-count !=
// header-column count, or a non-unique key. A row with an empty key value is skipped (never fabricated).
//
// HEADERLESS tables: some live tables expose rows/cells but NO columnheader roles in the Playwright
// ariaSnapshot (e.g. the Hiworks 대기 list). For those, recipe.columnIndexes maps every column field to
// a zero-based cell index — the SAME rule bin/play-flow.mjs open_record implements (validated: every
// field mapped, non-negative ints, no duplicates; a row with too few cells fails loud; a row whose
// mapped cells all equal their column labels is skipped as a header-like row). Without columnIndexes
// a headerless table still fails loud.

const fs = require('node:fs');
const aria = require('../lib/aria.js');

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

// validateColumnIndexes: same contract as bin/play-flow.mjs (every column field mapped to a unique
// non-negative integer cell index). Fail-closed — a partial/duplicated map would silently mis-map.
function validateColumnIndexes(recipe) {
	if (!recipe.columnIndexes || typeof recipe.columnIndexes !== 'object' || Array.isArray(recipe.columnIndexes)) {
		die('recipe.columnIndexes must be an object');
	}
	const seen = new Set();
	const idx = {};
	for (const field of Object.keys(recipe.columns)) {
		const n = recipe.columnIndexes[field];
		if (!Number.isInteger(n) || n < 0) die(`columnIndexes.${field} must be a non-negative integer`);
		if (seen.has(n)) die(`columnIndexes: duplicate cell index ${n}`);
		seen.add(n);
		idx[field] = n;
	}
	return idx;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => { try { main(); } catch (e) { console.error('extract-list: ' + e.message); process.exit(1); } });

function main() {
	const recipe = loadRecipe(process.argv[2]);
	const role = recipe.collection.role || 'table';
	const rowRole = recipe.collection.row || 'row';

	const data = JSON.parse(input.trim() || '{}');
	if (typeof data.snapshot !== 'string') die('stdin has no .snapshot tree (expected the .data object)');
	const lines = aria.parse(data);

	const hits = aria.findByRoleName(lines, role, recipe.collection.name);
	if (hits.length === 0) die(`${role} "${recipe.collection.name}" not found`);
	if (hits.length > 1) die(`${hits.length} ${role}s named "${recipe.collection.name}" — ambiguous; tighten collection.name`);
	const rows = aria.rowsOf(lines, hits[0], rowRole);

	const header = rows.find((r) => r.children.some((c) => c.role === 'columnheader'));
	if (!header && !recipe.columnIndexes) die('no header row (columnheader) found in the container (add recipe.columnIndexes for a headerless table)');

	const fields = Object.keys(recipe.columns);
	const idx = {};
	let headerCount = 0;
	if (header) {
		const headers = header.children.filter((c) => c.role === 'columnheader').map((c) => aria.norm(c.name));
		headerCount = headers.length;
		for (const [field, label] of Object.entries(recipe.columns)) {
			const want = aria.norm(label);
			const found = [];
			headers.forEach((h, i) => { if (h === want) found.push(i); });
			if (found.length === 0) die(`column "${label}" (→${field}) not found among headers [${headers.join(', ')}] — refusing to guess`);
			if (found.length > 1) die(`column "${label}" (→${field}) matches ${found.length} headers — ambiguous`);
			idx[field] = found[0];
		}
	} else {
		Object.assign(idx, validateColumnIndexes(recipe));
	}
	const maxIdx = Math.max(...fields.map((f) => idx[f]));

	const strip = recipe.strip || {};
	const items = [];
	for (const r of rows) {
		const cells = r.children.filter((c) => c.role === 'cell');
		if (!cells.length) continue; // header row / non-data row
		if (header) {
			if (cells.length !== headerCount) {
				die(`a row has ${cells.length} cells but the header has ${headerCount} columns — markup drift; refusing to mis-map (row: ${cells.map((c) => c.name || '∅').join(' | ')})`);
			}
		} else {
			if (cells.length <= maxIdx) {
				die(`a row has ${cells.length} cells but columnIndexes needs index ${maxIdx} — markup drift; refusing to mis-map (row: ${cells.map((c) => c.name || '∅').join(' | ')})`);
			}
			// header-like row: in headerless index mode the header (if the page renders one as plain
			// cells) is indistinguishable from data except that every mapped cell equals its column
			// label — skip it, same rule as play-flow.mjs open_record.
			if (fields.every((f) => aria.norm(cells[idx[f]].name) === aria.norm(recipe.columns[f]))) continue;
		}
		const rec = {};
		for (const field of fields) rec[field] = applyStrip(aria.clean(cells[idx[field]].name), strip[field]);
		const key = rec[recipe.key];
		if (!key) continue; // no identity → skip, never fabricate
		items.push({ key, data: rec });
	}
	// A non-unique key would silently collapse distinct rows downstream (jq unique_by / upsert keep
	// only one) — losing records. Fail loud so a bad key choice is caught, never silently dropped.
	const seen = new Set();
	for (const it of items) {
		if (seen.has(it.key)) die(`key column "${recipe.key}" is NOT unique — value "${it.key}" appears more than once; pick a column with unique values as the key`);
		seen.add(it.key);
	}
	process.stdout.write(JSON.stringify(items));
}

// applyStrip: remove a trailing LITERAL suffix (UI noise), then trim.
function applyStrip(v, suffix) {
	if (v == null || !suffix) return v;
	const s = String(v);
	return (s.endsWith(suffix) ? s.slice(0, s.length - suffix.length).trim() : s) || null;
}
