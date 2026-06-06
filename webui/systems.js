// webui/systems.js — the generic RPA "system registry" view logic over lib/db.js (systems+records).
// Register any data-collection system, analyze its structure, sync it, and read its records. The
// web layer never reimplements logic — it spawns the bash drivers (analyze/sync) and reads the DB.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { openDb, closeDb, registerSystem, listSystems, getSystem, deleteSystem, queryRecords, countRecords } = require('../lib/db.js');

const DATA_DIR = path.join(import.meta.dirname, '..', 'data');
const NAME_RE = /^[A-Za-z0-9_-]+$/;
export const validSysName = (n) => typeof n === 'string' && NAME_RE.test(n);

export function listSystemsView() {
	const db = openDb();
	try { return listSystems(db).map((s) => ({ ...s, recordCount: countRecords(db, s.name) })); }
	finally { closeDb(db); }
}
export function getSystemView(name) {
	const db = openDb();
	try { const s = getSystem(db, name); return s ? { ...s, recordCount: countRecords(db, name) } : null; }
	finally { closeDb(db); }
}
// saveSystem(sys): register/update. Validates name + that recipe (if given) is an object with
// collection.name + key + columns (so a malformed recipe can't be saved and then fail every sync).
export function saveSystem(sys) {
	if (!validSysName(sys && sys.name)) return { ok: false, error: 'invalid system name (use [A-Za-z0-9_-])' };
	if (sys.recipe != null) {
		const r = sys.recipe;
		if (typeof r !== 'object' || !r.collection || !r.collection.name || !r.columns || !Object.keys(r.columns).length || !r.key || !r.columns[r.key]) {
			return { ok: false, error: 'recipe must have collection.name, columns, and a key that is one of columns' };
		}
	}
	const db = openDb();
	try { return { ok: true, system: registerSystem(db, sys) }; }
	finally { closeDb(db); }
}
export function removeSystem(name) {
	const db = openDb();
	try { deleteSystem(db, name); return { ok: true }; }
	finally { closeDb(db); }
}
export function recordsView(name, q) {
	const db = openDb();
	try { return queryRecords(db, name, { keyword: q || undefined, limit: 500 }); }
	finally { closeDb(db); }
}
// readProposed(name): the analyze step's saved proposal (data/<name>.proposed.json) or null.
export function readProposed(name) {
	if (!validSysName(name)) return null;
	try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name + '.proposed.json'), 'utf8')); }
	catch { return null; }
}
