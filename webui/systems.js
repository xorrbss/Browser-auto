// webui/systems.js — the generic RPA "system registry" view logic over lib/db.js (systems+records).
// Register any data-collection system, analyze its structure, sync it, and read its records. The
// web layer never reimplements logic — it spawns the bash drivers (analyze/sync) and reads the DB.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { listUrlFor } from './routes-approve.js';

const require = createRequire(import.meta.url);
const { openDb, closeDb, registerSystem, listSystems, getSystem, deleteSystem, queryRecords, countRecords } = require('../lib/db.js');

const DATA_DIR = path.join(import.meta.dirname, '..', 'data');
const PROBE_ROOT = path.join(import.meta.dirname, '..');
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

function hasFile(rel) {
	return fs.existsSync(path.join(PROBE_ROOT, rel));
}

function recipeReady(recipe) {
	return !!(recipe && recipe.collection && recipe.collection.name && recipe.columns && recipe.key && recipe.columns[recipe.key]);
}

function recordStats(db, name) {
	const total = countRecords(db, name);
	const summarized = db.prepare("SELECT COUNT(*) c FROM records WHERE system = ? AND COALESCE(summary,'') <> ''").get(String(name)).c;
	const last = db.prepare('SELECT MAX(fetched_at) fetched_at FROM records WHERE system = ?').get(String(name)).fetched_at || null;
	return { total, summarized, missingSummary: Math.max(0, total - summarized), lastFetchedAt: last };
}

export function systemState(name) {
	if (!validSysName(name)) return null;
	const db = openDb();
	try {
		const sys = getSystem(db, name);
		if (!sys) return null;
		const recipeOk = recipeReady(sys.recipe);
		const proposed = readProposed(name);
		const authState = hasFile(`fixtures/auth/${name}.state.json`);
		const approveLogin = hasFile(`approve/${name}.pw-state.json`);
		const stats = recordStats(db, name);
		const detailReady = !!(sys.recipe && sys.recipe.detail && sys.recipe.detail.idLabel);
		const syncEnabled = !!(authState && sys.target_url && recipeOk);
		const enrichEnabled = !!(authState && detailReady && stats.total > 0);
		return {
			system: { name: sys.name, label: sys.label || sys.name, target_url: sys.target_url, recordCount: stats.total },
			auth: {
				enabled: !!(sys.login_url && sys.success_url),
				state: authState ? 'ready' : 'missing',
				disabledReason: sys.login_url && sys.success_url ? null : 'login_url and success_url are required',
			},
			analyze: {
				enabled: !!sys.target_url,
				state: proposed ? 'proposed' : 'not-run',
				proposed,
				disabledReason: sys.target_url ? null : 'target_url is required',
			},
			sync: {
				enabled: syncEnabled,
				state: syncEnabled ? 'ready' : 'disabled',
				disabledReason: syncEnabled ? null : (!authState ? 'cached auth state missing' : !sys.target_url ? 'target_url is required' : 'valid recipe is required'),
			},
			enrich: {
				enabled: enrichEnabled,
				state: enrichEnabled ? 'ready' : 'disabled',
				disabledReason: enrichEnabled ? null : (!authState ? 'cached auth state missing' : !detailReady ? 'recipe.detail.idLabel is required' : 'sync records before enrich'),
			},
			approve: {
				loginState: approveLogin ? 'ready' : 'missing',
				listUrl: !!listUrlFor(name),
			},
			recordStats: stats,
		};
	} finally { closeDb(db); }
}

export function systemActions(name) {
	const state = systemState(name);
	if (!state) return null;
	const db = openDb();
	try {
		const sys = getSystem(db, name);
		const recipe = sys && sys.recipe ? sys.recipe : {};
		const actions = [];
		actions.push({ system: name, action: 'auth', riskClass: 'read', enabled: state.auth.enabled, state: state.auth.state, disabledReason: state.auth.disabledReason });
		actions.push({ system: name, action: 'analyze', riskClass: 'read', enabled: state.analyze.enabled, state: state.analyze.state, disabledReason: state.analyze.disabledReason });
		actions.push({ system: name, action: 'sync', riskClass: 'read', enabled: state.sync.enabled, state: state.sync.state, disabledReason: state.sync.disabledReason });
		actions.push({ system: name, action: 'enrich', riskClass: 'read', enabled: state.enrich.enabled, state: state.enrich.state, disabledReason: state.enrich.disabledReason });
		const effectful = { ...(recipe.actions || {}) };
		if (recipe.approve && !effectful.approve) effectful.approve = recipe.approve;
		for (const [action, block] of Object.entries(effectful)) {
			const captured = !!block && block.enabled !== false;
			const enabled = !!(captured && state.approve.loginState === 'ready' && state.approve.listUrl);
			actions.push({
				system: name,
				action,
				riskClass: block.class || block.riskClass || 'irreversible',
				enabled,
				state: enabled ? 'enabled' : captured ? 'disabled' : 'needs implementation',
				reviewedOnly: block.reviewedOnly !== false,
				dryRunRequired: true,
				humanConfirmRequired: true,
				permission: block.permission || `actions.${action}.live`,
				disabledReason: enabled ? null : (!captured ? 'action is disabled or not captured' : state.approve.loginState !== 'ready' ? 'Playwright login state missing' : 'pending-list URL missing'),
			});
		}
		if (!effectful.approve) {
			actions.push({ system: name, action: 'approve', riskClass: 'irreversible', enabled: false, state: 'needs implementation', dryRunRequired: true, humanConfirmRequired: true, permission: 'actions.approve.live', disabledReason: 'recipe action is not captured' });
		}
		return actions;
	} finally { closeDb(db); }
}

export function allActionsView() {
	const db = openDb();
	try {
		return listSystems(db).flatMap((s) => systemActions(s.name) || []);
	} finally { closeDb(db); }
}
