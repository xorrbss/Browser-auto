// webui/systems.js — the generic RPA "system registry" view logic over lib/db.js (systems+records).
// Register any data-collection system, analyze its structure, sync it, and read its records. The
// web layer never reimplements logic — it spawns the bash drivers (analyze/sync) and reads the DB.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { listUrlFor } from './routes-approve.js';

const require = createRequire(import.meta.url);
const { openDb, closeDb, registerSystem, listSystems, getSystem, deleteSystem, queryRecords, countRecords } = require('../lib/db.js');
const { normalizeEngine, authStateExists, agentBrowserAuthRel, playwrightAuthRel, playwrightCompatAuthRel } = require('../lib/engine.js');

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
	try {
		if (sys.engine != null && sys.engine !== '') sys.engine = normalizeEngine(sys.engine, 'system.engine');
	} catch (e) {
		return { ok: false, error: e.message };
	}
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

// db0: optional caller-owned handle (allActionsView reuses one across every system). Omitted -> own handle.
export function systemState(name, db0 = null) {
	if (!validSysName(name)) return null;
	const db = db0 || openDb();
	try {
		const sys = getSystem(db, name);
		if (!sys) return null;
		const engine = normalizeEngine(sys.engine, 'system.engine');
		const recipeOk = recipeReady(sys.recipe);
		const proposed = readProposed(name);
		const agentAuth = authStateExists(PROBE_ROOT, 'agent-browser', name);
		const pwAuth = authStateExists(PROBE_ROOT, 'playwright', name);
		const selectedAuth = engine === 'playwright' ? pwAuth : agentAuth;
		const approveLogin = hasFile(playwrightCompatAuthRel(name)) || hasFile(playwrightAuthRel(name));
		const stats = recordStats(db, name);
		const detailReady = !!(sys.recipe && sys.recipe.detail && sys.recipe.detail.idLabel);
		const syncEnabled = !!(selectedAuth && sys.target_url && recipeOk);
		const enrichEnabled = !!(selectedAuth && detailReady && stats.total > 0);
		const analyzeEnabled = !!(selectedAuth && sys.target_url);
		const authMissing = `${engine} auth state missing`;
		return {
			system: { name: sys.name, label: sys.label || sys.name, engine, target_url: sys.target_url, recordCount: stats.total },
			auth: {
				enabled: !!(sys.login_url && sys.success_url),
				engine,
				state: selectedAuth ? 'ready' : 'missing',
				selected: selectedAuth ? 'ready' : 'missing',
				agentBrowser: agentAuth ? 'ready' : 'missing',
				playwright: pwAuth ? 'ready' : 'missing',
				paths: {
					agentBrowser: agentBrowserAuthRel(name).replace(/\\/g, '/'),
					playwright: playwrightAuthRel(name).replace(/\\/g, '/'),
					playwrightCompat: playwrightCompatAuthRel(name).replace(/\\/g, '/'),
				},
				disabledReason: sys.login_url && sys.success_url ? null : 'login_url and success_url are required',
			},
			analyze: {
				enabled: analyzeEnabled,
				state: proposed ? 'proposed' : 'not-run',
				proposed,
				disabledReason: analyzeEnabled ? null : (!selectedAuth ? authMissing : 'target_url is required'),
			},
			sync: {
				enabled: syncEnabled,
				state: syncEnabled ? 'ready' : 'disabled',
				engine,
				limited: false,
				disabledReason: syncEnabled ? null : (!selectedAuth ? authMissing : !sys.target_url ? 'target_url is required' : 'valid recipe is required'),
			},
			enrich: {
				enabled: enrichEnabled,
				state: enrichEnabled ? 'ready' : 'disabled',
				engine,
				limited: false,
				disabledReason: enrichEnabled ? null : (!selectedAuth ? authMissing : !detailReady ? 'recipe.detail.idLabel is required' : 'sync records before enrich'),
			},
			approve: {
				loginState: approveLogin ? 'ready' : 'missing',
				listUrl: !!listUrlFor(name),
			},
			recordStats: stats,
		};
	} finally { if (!db0) closeDb(db); }
}

export function systemActions(name, db0 = null) {
	const db = db0 || openDb();
	try {
		const state = systemState(name, db);
		if (!state) return null;
		const sys = getSystem(db, name);
		const recipe = sys && sys.recipe ? sys.recipe : {};
		const actions = [];
		actions.push({ system: name, action: 'auth', engine: state.auth.engine, riskClass: 'read', enabled: state.auth.enabled, state: state.auth.state, disabledReason: state.auth.disabledReason });
		actions.push({ system: name, action: 'analyze', engine: state.auth.engine, riskClass: 'read', enabled: state.analyze.enabled, state: state.analyze.state, disabledReason: state.analyze.disabledReason });
		actions.push({ system: name, action: 'sync', engine: state.sync.engine, riskClass: 'read', enabled: state.sync.enabled, state: state.sync.state, disabledReason: state.sync.disabledReason });
		actions.push({ system: name, action: 'enrich', engine: state.enrich.engine, riskClass: 'read', enabled: state.enrich.enabled, state: state.enrich.state, disabledReason: state.enrich.disabledReason });
		const effectful = { ...(recipe.actions || {}) };
		if (recipe.approve && !effectful.approve) effectful.approve = recipe.approve;
		for (const [action, block] of Object.entries(effectful)) {
			const captured = !!block && block.enabled !== false;
			const enabled = !!(captured && state.approve.loginState === 'ready' && state.approve.listUrl);
			actions.push({
				system: name,
				action,
				// These come from recipe.actions/recipe.approve — effectful by construction. The plan GATE
				// (routes-command-plan.js) is the single source of truth and NEVER downgrades a non-READ action
				// to read, so the display must not claim 'read' here either: clamp a (mis)declared read up to
				// irreversible so the capability view can't contradict the gate.
				riskClass: (block.class === 'read' || block.riskClass === 'read') ? 'irreversible' : (block.class || block.riskClass || 'irreversible'),
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
	} finally { if (!db0) closeDb(db); }
}

export function allActionsView() {
	const db = openDb();
	try {
		return listSystems(db).flatMap((s) => systemActions(s.name, db) || []);
	} finally { closeDb(db); }
}
