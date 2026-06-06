#!/usr/bin/env node
'use strict';
// bin/propose-recipe.js — structure analysis: snapshot -> a PROPOSED extraction recipe.
//
// Deterministically reads every ARIA table (its accessible name + column headers + data-row count)
// from the snapshot, then asks the ON-PREM model to pick the main list table and map each header to
// a short english field name (doc_id/title/drafter/date/amount/dept/status/…) + choose the key. The
// model only PROPOSES — its (UNTRUSTED) output is validated against the REAL detected headers, then
// the human reviews/edits the proposal in the webui before saving (saveSystem re-validates the final
// recipe). On any failure we fall back to a deterministic recipe (largest table; field names = slugged
// headers; key = 1st col). validateProposal never invents a header; it tolerantly RECOVERS from the two
// model mistakes that otherwise drop a perfectly good proposal: (a) a mismatched/abbreviated
// collection.name when the column headers still pin exactly one detected table, and (b) an inverted
// {"<header>":"<field>"} column object. Read-only; sends ONLY table names+headers (structure, no PII
// rows) to the model.
//
//   stdin : snapshot .data object; stdout: { recipe, tables } (recipe = proposal; tables = detected).

const llm = require('../lib/llm.js');
const aria = require('../lib/aria.js');

// detectTables: every `table` node -> { name, headers:[texts], rowCount } (reuses lib/aria.rowsOf).
function detectTables(lines) {
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].role !== 'table') continue;
		const rows = aria.rowsOf(lines, i, 'row').map((r) => r.children);
		const headerRow = rows.find((r) => r.some((c) => c.role === 'columnheader'));
		const headers = headerRow ? headerRow.filter((c) => c.role === 'columnheader').map((c) => (c.name || '').trim()).filter(Boolean) : [];
		const dataRows = rows.filter((r) => r.some((c) => c.role === 'cell')).length;
		out.push({ name: (lines[i].name || '').trim(), headers, rowCount: dataRows });
	}
	return out;
}

const slug = (h) => (String(h || '').replace(/\s+/g, '_').replace(/[^\w가-힣]/g, '').toLowerCase() || 'field');
// norm: the whitespace-insensitive key used to match a model-supplied name/header to a real one.
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, '');
// sanitizeField: keep a clean model field name (doc_id/title/…) as-is; otherwise slug it. Never empty.
const sanitizeField = (f) => { const s = String(f == null ? '' : f).trim(); return /^[\w가-힣]+$/.test(s) ? s : slug(s); };

function deterministicRecipe(tables) {
	const t = [...tables].filter((x) => x.headers.length).sort((a, b) => b.rowCount - a.rowCount || b.headers.length - a.headers.length)[0];
	if (!t) return null;
	const columns = {};
	const used = new Set();
	for (const h of t.headers) { let f = slug(h); while (used.has(f)) f += '_'; used.add(f); columns[f] = h; }
	return { collection: { name: t.name }, key: Object.keys(columns)[0], columns };
}

// pickTable: choose the model's intended table — exact name match, else (if only one) that table, else
// the table whose headers the model's column endpoints most cover (unique winner with ≥2 hits). A tie or
// <2 hits returns null (give up → deterministic fallback) rather than guessing.
function pickTable(obj, tables) {
	const want = norm(obj && obj.collection && obj.collection.name);
	if (want) { const exact = tables.find((t) => norm(t.name) === want); if (exact) return exact; }
	if (tables.length === 1) return tables[0];
	const endpoints = new Set();
	for (const [k, v] of Object.entries((obj && obj.columns) || {})) { if (k) endpoints.add(norm(k)); if (v != null) endpoints.add(norm(v)); }
	let best = null, bestScore = 0, tie = false;
	for (const t of tables) {
		const hs = new Set(t.headers.map(norm));
		let score = 0; for (const e of endpoints) if (hs.has(e)) score++;
		if (score > bestScore) { best = t; bestScore = score; tie = false; }
		else if (score === bestScore && score > 0) tie = true;
	}
	return (best && bestScore >= 2 && !tie) ? best : null;
}

// validateProposal: the model reply is UNTRUSTED. Pick the table (pickTable), detect column orientation
// ({field:header} vs the common inverted {header:field}), and keep only columns whose header side is a
// REAL header of that table — stored as the table's VERBATIM header (never the model's variant, never an
// invented one). Returns a {collection,key,columns} recipe, or null (caller falls back deterministically).
function validateProposal(obj, tables) {
	if (!obj || !obj.columns || typeof obj.columns !== 'object') return null;
	const entries = Object.entries(obj.columns).filter(([k, v]) => k && v != null);
	if (!entries.length) return null;
	const t = pickTable(obj, tables);
	if (!t) return null;
	const headerByNorm = new Map(t.headers.map((h) => [norm(h), h]));
	// Orientation: entries whose VALUE is a header (normal) vs whose KEY is a header (inverted).
	const nNormal = entries.filter(([, v]) => headerByNorm.has(norm(v))).length;
	const nInvert = entries.filter(([k]) => headerByNorm.has(norm(k))).length;
	const inverted = nInvert > nNormal;
	const columns = {};
	const used = new Set();
	for (const [k, v] of entries) {
		const header = headerByNorm.get(norm(inverted ? k : v));
		if (!header) continue;                       // never invent a header
		let field = sanitizeField(inverted ? v : k);
		while (used.has(field)) field += '_';
		used.add(field);
		columns[field] = header;                     // the table's verbatim header (not the model's)
	}
	if (!Object.keys(columns).length) return null;
	const keyField = sanitizeField(obj.key);
	const key = columns[keyField] ? keyField : Object.keys(columns)[0];
	return { collection: { name: t.name }, key, columns };
}

let input = '';

async function main() {
	const data = JSON.parse(input.trim() || '{}');
	const lines = aria.parse(data);
	const tables = detectTables(lines).filter((t) => t.headers.length);
	if (!tables.length) {
		process.stdout.write(JSON.stringify({ recipe: null, tables: [], error: '표(table)를 찾지 못했습니다. 목록이 ARIA table 구조가 아닐 수 있습니다.' }));
		return;
	}
	const fallback = deterministicRecipe(tables);

	// Ask the on-prem model to choose the list table + map headers -> field names + pick key.
	let proposed = null;
	const sys = '너는 웹 목록 표를 데이터 추출 레시피로 매핑하는 도우미다. 주어진 표들 중 "레코드 목록"인 표 하나를 고르고, ' +
		'각 컬럼 헤더를 짧은 영문 필드명(doc_id, title, drafter, date, amount, dept, status 등 적절히)으로 매핑하고, ' +
		'행을 식별하는 key 필드를 고른다. 반드시 아래 JSON 하나만 출력: ' +
		'{"collection":{"name":"<표 이름>"},"key":"<필드>","columns":{"<필드>":"<헤더 원문>"}}. ' +
		'columns의 키는 영문 필드명, 값은 표의 헤더 원문(입력 그대로, 순서를 바꾸지 말 것)이며, key는 columns의 필드 중 하나여야 한다.';
	const user = '표 목록(JSON):\n' + JSON.stringify(tables, null, 1);
	try {
		const raw = await llm.chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0 });
		proposed = validateProposal(llm.extractJson(raw), tables);
	} catch { /* model unavailable -> fall back deterministically */ }

	process.stdout.write(JSON.stringify({ recipe: proposed || fallback, proposedBy: proposed ? 'model' : 'fallback', tables }));
}

module.exports = { detectTables, deterministicRecipe, pickTable, validateProposal, slug, norm, sanitizeField };

if (require.main === module) {
	process.stdin.setEncoding('utf8');
	process.stdin.on('data', (c) => (input += c));
	process.stdin.on('end', () => { main().catch((e) => { console.error('propose-recipe: ' + e.message); process.exit(1); }); });
}
