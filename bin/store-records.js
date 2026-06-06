#!/usr/bin/env node
'use strict';
// bin/store-records.js — persist collected rows into the generic RPA store for one system.
// Reads a JSON array of items [{key, data, summary?}] from stdin and upserts into records(system=…).
// Generic sibling of bin/store-approvals.js (which targets the 결재-specific table).
//
//   usage: ... | node bin/store-records.js --system <name>

const { openDb, closeDb, upsertRecords } = require('../lib/db.js');

const i = process.argv.indexOf('--system');
const system = i >= 0 ? process.argv[i + 1] : '';
if (!system) { console.error('store-records: --system <name> required'); process.exit(2); }

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
	let items;
	try { items = JSON.parse(input.trim() || '[]'); } catch (e) { console.error('store-records: invalid JSON on stdin: ' + e.message); process.exit(1); }
	if (!Array.isArray(items)) { console.error('store-records: stdin must be a JSON array'); process.exit(1); }
	const db = openDb();
	try {
		const n = upsertRecords(db, system, items);
		console.log(`[sync-system] stored ${n} record(s) for '${system}'`);
	} catch (e) {
		console.error('store-records: ' + e.message);
		process.exit(1);
	} finally {
		closeDb(db);
	}
});
