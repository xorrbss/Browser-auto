#!/usr/bin/env node
'use strict';
// bin/store-approvals.js — persist scraped 결재 items into the approvals store.
//
// Reads a JSON array of approval items from stdin.
// and upserts them via lib/db.js, then prints the count. Kept as a tiny CJS helper (like the other
// bin/*.js) so the real persistence logic isn't bloated into bash/jq. Pure storage: NO scraping,
// NO network. The DB is the single source of truth for fetched 결재 (webui reads it).
//
// Each item: { doc_id (required), title?, drafter?, dept?, submitted_at?, amount?, raw_text?, summary? }.
// On bad input it exits non-zero so the sync fails LOUD rather than silently storing nothing.

const { openDb, closeDb, upsertApprovals, DEFAULT_DB_PATH } = require('../lib/db.js');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
	let items;
	try {
		items = JSON.parse(input.trim() || '[]');
	} catch (e) {
		console.error('store-approvals: invalid JSON on stdin: ' + e.message);
		process.exit(1);
	}
	if (!Array.isArray(items)) {
		console.error('store-approvals: stdin must be a JSON array of items');
		process.exit(1);
	}
	const db = openDb();
	try {
		const n = upsertApprovals(db, items);
		console.log(`[store-approvals] stored ${n} 결재 item(s) -> ${DEFAULT_DB_PATH}`);
	} catch (e) {
		console.error('store-approvals: ' + e.message);
		process.exit(1);
	} finally {
		closeDb(db);
	}
});
