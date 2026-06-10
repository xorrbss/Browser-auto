// webui/approvals.js — read-only view over the approvals store (lib/db.js) for the dashboard.
//
// Mirrors the project rule that the web layer never reimplements logic: the DB schema + CRUD
// live in lib/db.js; this module just opens, reads, closes.
// ESM importing a CJS module — Node's named-export interop resolves lib/db.js's module.exports.
//
// Unlike index.js (runs are fs-authoritative — report.json IS the source of truth), approvals
// have NO filesystem original: the DB is their single source of truth. So a DB here does not
// violate the "fs is authoritative" rule — it is the authority for a different kind of data.

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { openDb, closeDb, listApprovals } = require('../lib/db.js');

// listApprovalsView({status?, limit?}): open the store, read, close. Open/close per request keeps
// no long-lived handle (KISS; the writer is a separate process) — fine for localhost traffic.
// Returns [] if the store does not exist yet (never synced) rather than throwing.
export async function listApprovalsView(opts = {}) {
	let db;
	try {
		db = openDb();
	} catch {
		return []; // store not created yet (no sync has run) — empty dashboard, not an error
	}
	try {
		return listApprovals(db, opts);
	} finally {
		closeDb(db);
	}
}
