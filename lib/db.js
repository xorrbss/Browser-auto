// lib/db.js — the approvals store (P0 of the 결재 automation feature).
//
// CommonJS so it is shared by BOTH consumers without a module-system mismatch:
//   - bin/fetch-approvals.sh's helper JS (CJS, like the other bin/*.js)  -> require('../lib/db.js')
//   - webui (ESM, type:module scoped to webui/)                          -> import { ... } from '../lib/db.js'
// (lib/ sits under the root which has NO package.json, so a .js here is CJS; the webui ESM side
//  reaches it via Node's CJS named-export interop, which works for an object module.exports.)
//
// Backed by node:sqlite (built-in, ZERO external deps) — requires Node >= 22.5. This box runs
// v24; the webui README's historical "Node 18+" note no longer covers this module (documented
// in webui/README.md). The single source of truth for fetched 결재 items; webui READS it,
// bin/fetch-approvals WRITES it. The .db lives under data/ and is gitignored (company PII).

'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const PROBE_ROOT = path.resolve(__dirname, '..');
// Default store: data/approvals.db (gitignored). Override with AQA_DB_PATH (tests use a tmp file).
const DEFAULT_DB_PATH = process.env.AQA_DB_PATH || path.join(PROBE_ROOT, 'data', 'approvals.db');

// The scraped, writable columns — the set re-synced on every fetch. `status` is intentionally
// EXCLUDED: it is owned by the workflow (P0 leaves it 'fetched'; P1 sets 'approved'), so a
// re-sync must never clobber a later decision back to 'fetched'. Keep this list in sync with
// the upsert below and the CREATE TABLE.
const SCRAPED_COLS = ['title', 'drafter', 'dept', 'submitted_at', 'amount', 'raw_text', 'summary'];

// openDb(dbPath?): open (creating parent dir + schema if needed) and return the handle.
// Caller closes via closeDb(). KISS: one table, no migrations framework — CREATE IF NOT EXISTS.
function openDb(dbPath = DEFAULT_DB_PATH) {
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	// The writer (bin/fetch-approvals via node) and the reader (webui) are SEPARATE processes on
	// the SAME .db. WAL lets a reader run concurrently with the writer (no "database is locked" on
	// the dashboard mid-sync); busy_timeout retries a brief lock instead of erroring out.
	db.exec('PRAGMA journal_mode=WAL');
	db.exec('PRAGMA busy_timeout=3000');
	db.exec(`
		CREATE TABLE IF NOT EXISTS approvals (
			doc_id       TEXT PRIMARY KEY,
			title        TEXT,
			drafter      TEXT,
			dept         TEXT,
			submitted_at TEXT,
			amount       TEXT,            -- TEXT, not numeric: groupware amounts carry commas/currency; a lossy parse would corrupt the audit trail
			raw_text     TEXT,
			summary      TEXT,
			status       TEXT NOT NULL DEFAULT 'fetched',
			fetched_at   TEXT NOT NULL
		)
	`);
	return db;
}

function closeDb(db) {
	try { db.close(); } catch { /* already closed / best-effort */ }
}

// upsertApprovals(db, items, fetchedAt?): insert new 결재 docs, refresh the scraped fields of
// existing ones. Returns the count written. `status` is preserved on conflict (see SCRAPED_COLS).
// Each item: { doc_id (required), title?, drafter?, dept?, submitted_at?, amount?, raw_text?, summary? }.
// Runs in ONE transaction so a mid-batch failure leaves the store unchanged (all-or-nothing sync).
function upsertApprovals(db, items, fetchedAt = new Date().toISOString()) {
	if (!Array.isArray(items)) throw new TypeError('upsertApprovals: items must be an array');
	const setClause = SCRAPED_COLS.map((c) => `${c}=excluded.${c}`).join(', ');
	const stmt = db.prepare(`
		INSERT INTO approvals (doc_id, ${SCRAPED_COLS.join(', ')}, fetched_at)
		VALUES (?, ${SCRAPED_COLS.map(() => '?').join(', ')}, ?)
		ON CONFLICT(doc_id) DO UPDATE SET ${setClause}, fetched_at=excluded.fetched_at
	`);
	let n = 0;
	db.exec('BEGIN');
	try {
		for (const it of items) {
			const docId = it && it.doc_id != null ? String(it.doc_id).trim() : '';
			if (!docId) throw new Error('upsertApprovals: every item needs a non-empty doc_id');
			stmt.run(docId, ...SCRAPED_COLS.map((c) => (it[c] == null ? null : String(it[c]))), fetchedAt);
			n++;
		}
		db.exec('COMMIT');
	} catch (e) {
		db.exec('ROLLBACK');
		throw e;
	}
	return n;
}

// listApprovals(db, {status?, limit?}): newest first. Orders by submitted_at then fetched_at so a
// doc with no submitted_at still sorts sanely. Read path for the webui dashboard.
function listApprovals(db, { status, limit } = {}) {
	const where = status ? 'WHERE status = ?' : '';
	const lim = Number.isInteger(limit) && limit > 0 ? `LIMIT ${limit}` : '';
	const sql = `SELECT * FROM approvals ${where} ORDER BY COALESCE(submitted_at, fetched_at) DESC, fetched_at DESC ${lim}`;
	const stmt = db.prepare(sql);
	return status ? stmt.all(status) : stmt.all();
}

// getApproval(db, docId): one row or undefined.
function getApproval(db, docId) {
	return db.prepare('SELECT * FROM approvals WHERE doc_id = ?').get(String(docId));
}

module.exports = { openDb, closeDb, upsertApprovals, listApprovals, getApproval, DEFAULT_DB_PATH, SCRAPED_COLS };
