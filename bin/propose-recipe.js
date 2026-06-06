#!/usr/bin/env node
'use strict';
// bin/propose-recipe.js — structure analysis: snapshot -> a PROPOSED extraction recipe.
//
// Deterministically reads every ARIA table (its accessible name + column headers + data-row count)
// from the snapshot, then asks the ON-PREM model to pick the main list table and map each header to
// a short english field name (doc_id/title/drafter/date/amount/dept/status/…) + choose the key. The
// model only PROPOSES — output is validated against the real detected headers, and on any failure we
// fall back to a deterministic recipe (largest table; field names = slugged headers; key = 1st col).
// The human reviews/edits the proposal before saving (webui). Read-only; no effectful action.
//
//   stdin : snapshot .data object; stdout: { recipe, tables } (recipe = proposal; tables = detected).

const llm = require('../lib/llm.js');
const aria = require('../lib/aria.js');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => { main().catch((e) => { console.error('propose-recipe: ' + e.message); process.exit(1); }); });

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

function deterministicRecipe(tables) {
	const t = [...tables].filter((x) => x.headers.length).sort((a, b) => b.rowCount - a.rowCount || b.headers.length - a.headers.length)[0];
	if (!t) return null;
	const columns = {};
	const used = new Set();
	for (const h of t.headers) { let f = slug(h); while (used.has(f)) f += '_'; used.add(f); columns[f] = h; }
	return { collection: { name: t.name }, key: Object.keys(columns)[0], columns };
}

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
		'{"collection":{"name":"<표 이름>"},"key":"<필드>","columns":{"<필드>":"<헤더 원문>"}}. 헤더 원문은 입력 그대로 사용.';
	const user = '표 목록(JSON):\n' + JSON.stringify(tables, null, 1);
	try {
		const raw = await llm.chat([{ role: 'system', content: sys }, { role: 'user', content: user }], { temperature: 0 });
		const obj = llm.extractJson(raw);
		// Validate: collection.name must be a real table; columns' header values must be real headers of it.
		if (obj && obj.collection && obj.columns && typeof obj.columns === 'object') {
			const t = tables.find((x) => x.name.replace(/\s+/g, '') === String(obj.collection.name || '').replace(/\s+/g, ''));
			if (t) {
				const validHeaders = new Set(t.headers.map((h) => h.replace(/\s+/g, '')));
				const cols = {};
				for (const [f, h] of Object.entries(obj.columns)) {
					if (h != null && validHeaders.has(String(h).replace(/\s+/g, ''))) cols[String(f)] = String(h);
				}
				if (Object.keys(cols).length) {
					const key = cols[obj.key] ? obj.key : Object.keys(cols)[0];
					proposed = { collection: { name: t.name }, key, columns: cols };
				}
			}
		}
	} catch { /* model unavailable -> fall back deterministically */ }

	process.stdout.write(JSON.stringify({ recipe: proposed || fallback, proposedBy: proposed ? 'model' : 'fallback', tables }));
}
