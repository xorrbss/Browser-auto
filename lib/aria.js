'use strict';
// lib/aria.js - shared parser for Playwright ARIA snapshot trees. Used by every
// extractor (bin/extract-approvals.js, extract-list.js, extract-detail.js,
// propose-recipe.js) so the line tokenizer + container/row walk + text helpers
// live in a single leaf. Pure; no deps.

// parseLine: '        - cell "IB-..." [ref=e55] [level=1]' -> { indent, role, name, level }.
// indent = leading spaces; role = the node type; name = the FIRST..LAST quoted span (ref/attrs carry
// no quotes, so lastIndexOf('"') is the name's closing quote); level = a [level=N] heading depth.
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

// parse(data): the snapshot .data object (or a raw tree string) -> array of parsed lines.
function parse(data) {
	const tree = data && typeof data.snapshot === 'string' ? data.snapshot : typeof data === 'string' ? data : '';
	return tree.split('\n').map(parseLine).filter(Boolean);
}

const norm = (s) => String(s || '').replace(/\s+/g, ''); // "문서 번호" -> "문서번호"
// clean: TRIM only (no internal-whitespace collapse) — matches the extractors' field semantics so a
// title's internal spacing is preserved verbatim. (A blob that wants collapsing does it itself.)
const clean = (s) => {
	s = String(s == null ? '' : s).trim();
	return s || null;
};

// findByRoleName(lines, role, name): indices of nodes matching role + normalized-exact name. The
// caller decides the cardinality policy (extractors require exactly one; refuse 0 or >1).
function findByRoleName(lines, role, name) {
	const want = norm(name);
	const hits = [];
	lines.forEach((l, i) => {
		if (l.role === role && norm(l.name) === want) hits.push(i);
	});
	return hits;
}

// rowsOf(lines, containerIdx, rowRole): for each row inside the container subtree, its DIRECT
// children (one indent level in) -> [{ children:[lines] }].
function rowsOf(lines, containerIdx, rowRole) {
	const baseIndent = lines[containerIdx].indent;
	const rows = [];
	for (let i = containerIdx + 1; i < lines.length; i++) {
		if (lines[i].indent <= baseIndent) break;
		if (lines[i].role !== rowRole) continue;
		const rowIndent = lines[i].indent;
		const children = [];
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].indent <= rowIndent) break;
			if (lines[j].indent === rowIndent + 2) children.push(lines[j]);
		}
		rows.push({ children });
	}
	return rows;
}

module.exports = { parseLine, parse, norm, clean, findByRoleName, rowsOf };
