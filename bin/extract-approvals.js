#!/usr/bin/env node
'use strict';
// bin/extract-approvals.js — Hiworks(하이웍스) 전자결재 "대기"(pending) list -> 결재 items JSON.
//
// THE one site-coupled step (authored from a real snapshot of approval/document/lists/W). The
// groupware inbox markup is product-specific, so this lives apart from the generic fetch-approvals.sh.
//
//   stdin : the snapshot DATA object saved by fetch-approvals.sh (jq '.data' = {origin,refs,snapshot}),
//           where .snapshot is the Playwright aria-snapshot YAML tree of the 대기 list page.
//   stdout: JSON array of { doc_id, title, drafter, submitted_at }.
//
// Hiworks 대기 list columns (verified live): [checkbox] · 문서 번호 · [icon] · 제목 · 기안자 · 기안일 · 구분.
// Only 문서번호/제목/기안자/기안일 are IN the list; 금액·기안부서·본문 are DETAIL-only (left to P0+), so
// amount/dept/raw_text are intentionally NOT set here (store-approvals upserts them as null).
//
// We parse the aria TREE and anchor the row->cell mapping to the column HEADERS (not a fixed cell
// index), so adding/reordering a column does not silently mis-map fields — it fails loud instead.

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
	const data = JSON.parse(input.trim() || '{}');
	const tree = typeof data.snapshot === 'string' ? data.snapshot : '';
	if (!tree) {
		console.error('extract-approvals: stdin has no .snapshot tree (expected fetch-approvals .data object)');
		process.exit(1);
	}
	const lines = tree.split('\n').map(parseLine).filter(Boolean);

	// Locate the 대기 list table.
	const tableIdx = lines.findIndex((l) => l.role === 'table' && /대기 문서 리스트/.test(l.name || ''));
	if (tableIdx < 0) {
		console.error('extract-approvals: "대기 문서 리스트" table not found — is the page the pending (대기) list?');
		process.exit(2);
	}
	const tableIndent = lines[tableIdx].indent;

	// Collect the table's rows and each row's DIRECT children (cells / columnheaders).
	const rows = [];
	for (let i = tableIdx + 1; i < lines.length; i++) {
		if (lines[i].indent <= tableIndent) break; // left the table subtree
		if (lines[i].role !== 'row') continue;
		const rowIndent = lines[i].indent;
		const children = [];
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].indent <= rowIndent) break;
			if (lines[j].indent === rowIndent + 2) children.push(lines[j]); // direct children only
		}
		rows.push({ children });
	}

	// Header row = the one whose direct children are columnheaders; it defines column ORDER.
	const header = rows.find((r) => r.children.some((c) => c.role === 'columnheader'));
	if (!header) {
		console.error('extract-approvals: header row (columnheaders) not found');
		process.exit(2);
	}
	const cols = header.children.filter((c) => c.role === 'columnheader').map((c) => norm(c.name));
	const idx = {
		doc_id: cols.indexOf('문서번호'),
		title: cols.indexOf('제목'),
		drafter: cols.indexOf('기안자'),
		submitted_at: cols.indexOf('기안일'),
	};
	for (const k of Object.keys(idx)) {
		if (idx[k] < 0) {
			console.error(`extract-approvals: column "${k}" not found among headers [${cols.join(', ')}] — markup changed; refusing to guess`);
			process.exit(2);
		}
	}

	const items = [];
	for (const r of rows) {
		const cells = r.children.filter((c) => c.role === 'cell');
		if (!cells.length) continue; // header row has columnheaders, not cells
		const doc_id = clean(cells[idx.doc_id] && cells[idx.doc_id].name);
		if (!doc_id) continue; // not a data row (or empty) — skip, never fabricate
		items.push({
			doc_id,
			title: stripAttach(clean(cells[idx.title] && cells[idx.title].name)),
			drafter: clean(cells[idx.drafter] && cells[idx.drafter].name),
			submitted_at: clean(cells[idx.submitted_at] && cells[idx.submitted_at].name),
		});
	}
	process.stdout.write(JSON.stringify(items));
}

// parseLine: "        - cell \"IB-...\" [ref=e55]" -> { indent, role:'cell', name:'IB-...' }.
function parseLine(raw) {
	const m = raw.match(/^(\s*)-\s+(\w+)/);
	if (!m) return null;
	const indent = m[1].length;
	const role = m[2];
	let name = null;
	const q = raw.indexOf('"');
	if (q >= 0) {
		const q2 = raw.lastIndexOf('"'); // ref is [ref=eN] (no quotes), so this is the name's closing quote
		if (q2 > q) name = raw.slice(q + 1, q2);
	}
	return { indent, role, name };
}

const norm = (s) => String(s || '').replace(/\s+/g, ''); // "문서 번호" -> "문서번호"
const clean = (s) => {
	s = String(s == null ? '' : s).trim();
	return s || null;
};
// The title cell appends " 첨부 파일 표시" when the doc has an attachment — strip that UI suffix.
const stripAttach = (t) => (t == null ? null : String(t).replace(/\s*첨부 파일 표시\s*$/, '').trim() || null);
