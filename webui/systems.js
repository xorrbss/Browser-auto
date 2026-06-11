// webui/systems.js — the generic RPA "system registry" view logic over lib/db.js (systems+records).
// Register any data-collection system, analyze its structure, sync it, and read its records. The
// web layer never reimplements logic — it spawns the bash drivers (analyze/sync) and reads the DB.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { listUrlFor } from './routes-approve.js';
import { validateActionBlock } from '../approve/guards.mjs';

const require = createRequire(import.meta.url);
const { openDb, closeDb, registerSystem, listSystems, getSystem, deleteSystem, queryRecords, countRecords } = require('../lib/db.js');
const { authStateExists, playwrightAuthRel, playwrightCompatAuthRel } = require('../lib/engine.js');
const { validateSystemEgressPolicy } = require('../lib/egress-policy.js');

const DATA_DIR = path.join(import.meta.dirname, '..', 'data');
const PROBE_ROOT = path.join(import.meta.dirname, '..');
const NAME_RE = /^[A-Za-z0-9_-]+$/;
export const validSysName = (n) => typeof n === 'string' && NAME_RE.test(n);

function tenantIdFromContext(context) {
	return String(context?.tenantId || context?.tenant?.id || context?.actor?.tenantId || process.env.WEBUI_TENANT_ID || process.env.AQA_TENANT_ID || 'local').trim() || 'local';
}

function tenantOptions(context) {
	return { tenantId: tenantIdFromContext(context) };
}

function isPlainObject(value) {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEgressConfig(input = {}) {
	const source = isPlainObject(input.egress) ? { ...input.egress } : {};
	const setIfPresent = (from, to) => {
		if (input[from] != null && input[from] !== '') source[to] = input[from];
	};
	setIfPresent('egressProfile', 'profile');
	setIfPresent('egressAllowlist', 'allowlist');
	setIfPresent('targetAllowlist', 'allowlist');
	setIfPresent('allowedOrigins', 'allowedOrigins');
	setIfPresent('resolvedHosts', 'resolvedHosts');
	setIfPresent('resolvedIps', 'resolvedIps');
	setIfPresent('resolvedIpMap', 'resolvedIpMap');
	if (input.requireResolvedIps != null) source.requireResolvedIps = !!input.requireResolvedIps;
	const allowed = new Set(['profile', 'allowlist', 'allowedOrigins', 'resolvedHosts', 'resolvedIps', 'resolvedIpMap', 'requireResolvedIps']);
	const out = {};
	for (const [key, value] of Object.entries(source)) {
		if (!allowed.has(key) || value == null || value === '') continue;
		out[key] = value;
	}
	return Object.keys(out).length ? out : null;
}

function mergeSystemEgress(sys) {
	const egress = normalizeEgressConfig(sys);
	if (!egress) return sys;
	const recipe = isPlainObject(sys.recipe) ? { ...sys.recipe } : {};
	recipe.egress = { ...(isPlainObject(recipe.egress) ? recipe.egress : {}), ...egress };
	return { ...sys, recipe };
}

function recipeHasRequiredShape(recipe) {
	return !!(recipe && recipe.collection && recipe.collection.name && recipe.columns && Object.keys(recipe.columns).length && recipe.key && recipe.columns[recipe.key]);
}

function recipeIsEgressOnly(recipe) {
	return isPlainObject(recipe) && Object.keys(recipe).every((key) => key === 'egress');
}

function compactEgressResult(result) {
	if (result.ok) {
		return {
			ok: true,
			profile: result.profile || '',
			checked: Array.isArray(result.checked) ? result.checked : [],
		};
	}
	return {
		ok: false,
		profile: result.profile || '',
		reason: result.reason || 'egress policy refused target',
	};
}

function systemEgressSummary(sys) {
	return {
		target: compactEgressResult(validateSystemEgressPolicy(sys, { phase: 'enqueue', fields: ['target_url'] })),
		auth: compactEgressResult(validateSystemEgressPolicy(sys, { phase: 'enqueue', fields: ['login_url', 'success_url'] })),
	};
}

export function listSystemsView(context = null) {
	const db = openDb();
	try { return listSystems(db, tenantOptions(context)).map((s) => ({ ...s, recordCount: countRecords(db, s.name, tenantOptions(context)), egressPolicy: systemEgressSummary(s) })); }
	finally { closeDb(db); }
}
export function getSystemView(name, context = null) {
	const db = openDb();
	try { const s = getSystem(db, name, tenantOptions(context)); return s ? { ...s, recordCount: countRecords(db, name, tenantOptions(context)), egressPolicy: systemEgressSummary(s) } : null; }
	finally { closeDb(db); }
}
// saveSystem(sys): register/update. Validates name + that recipe (if given) is an object with
// collection.name + key + columns (so a malformed recipe can't be saved and then fail every sync).
export function saveSystem(sys, context = null) {
	if (!validSysName(sys && sys.name)) return { ok: false, error: 'invalid system name (use [A-Za-z0-9_-])' };
	sys = mergeSystemEgress(sys);
	if (sys.engine && sys.engine !== 'playwright') return { ok: false, error: 'system.engine: WebUI is Playwright-only' };
	sys.engine = 'playwright';
	sys.tenantId = tenantIdFromContext(context);
	if (sys.recipe != null) {
		const r = sys.recipe;
		if (!isPlainObject(r) || (!recipeIsEgressOnly(r) && !recipeHasRequiredShape(r))) {
			return { ok: false, error: 'recipe must have collection.name, columns, and a key that is one of columns' };
		}
	}
	const egress = validateSystemEgressPolicy(sys, { phase: 'register' });
	if (!egress.ok) return { ok: false, error: egress.reason };
	const db = openDb();
	try { return { ok: true, system: registerSystem(db, sys) }; }
	finally { closeDb(db); }
}
export function removeSystem(name, context = null) {
	const db = openDb();
	try { deleteSystem(db, name, tenantOptions(context)); return { ok: true }; }
	finally { closeDb(db); }
}
export function recordsView(name, q, context = null) {
	const db = openDb();
	try { return queryRecords(db, name, { keyword: q || undefined, limit: 500, ...tenantOptions(context) }); }
	finally { closeDb(db); }
}
export function systemEgressGate(sys, action) {
	const fields = action === 'auth' ? ['login_url', 'success_url'] : ['target_url'];
	return validateSystemEgressPolicy(sys, { phase: 'enqueue', fields });
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

function recordStats(db, name, context = null) {
	const opts = tenantOptions(context);
	const total = countRecords(db, name, opts);
	const summarized = db.prepare("SELECT COUNT(*) c FROM records WHERE tenant_id = ? AND system = ? AND COALESCE(summary,'') <> ''").get(opts.tenantId, String(name)).c;
	const last = db.prepare('SELECT MAX(fetched_at) fetched_at FROM records WHERE tenant_id = ? AND system = ?').get(opts.tenantId, String(name)).fetched_at || null;
	return { total, summarized, missingSummary: Math.max(0, total - summarized), lastFetchedAt: last };
}

// db0: optional caller-owned handle (allActionsView reuses one across every system). Omitted -> own handle.
export function systemState(name, db0 = null, context = null) {
	if (!validSysName(name)) return null;
	const db = db0 || openDb();
	try {
		const sys = getSystem(db, name, tenantOptions(context));
		if (!sys) return null;
		const engine = 'playwright';
		const recipeOk = recipeReady(sys.recipe);
		const proposed = readProposed(name);
		const pwAuth = authStateExists(PROBE_ROOT, 'playwright', name);
		const selectedAuth = pwAuth;
		const approveLogin = hasFile(playwrightCompatAuthRel(name)) || hasFile(playwrightAuthRel(name));
		const stats = recordStats(db, name, context);
		const detailReady = !!(sys.recipe && sys.recipe.detail && sys.recipe.detail.idLabel);
		const targetEgress = validateSystemEgressPolicy(sys, { phase: 'enqueue', fields: ['target_url'] });
		const loginEgress = validateSystemEgressPolicy(sys, { phase: 'enqueue', fields: ['login_url', 'success_url'] });
		const syncEnabled = !!(selectedAuth && sys.target_url && recipeOk && targetEgress.ok);
		const enrichEnabled = !!(selectedAuth && detailReady && stats.total > 0 && targetEgress.ok);
		const analyzeEnabled = !!(selectedAuth && sys.target_url && targetEgress.ok);
		const authMissing = `${engine} auth state missing`;
		return {
			system: { name: sys.name, label: sys.label || sys.name, engine, target_url: sys.target_url, recordCount: stats.total },
			auth: {
				enabled: !!(sys.login_url && sys.success_url),
				engine,
				state: selectedAuth ? 'ready' : 'missing',
				selected: selectedAuth ? 'ready' : 'missing',
				playwright: pwAuth ? 'ready' : 'missing',
				paths: {
					playwright: playwrightAuthRel(name).replace(/\\/g, '/'),
					playwrightCompat: playwrightCompatAuthRel(name).replace(/\\/g, '/'),
				},
				disabledReason: !(sys.login_url && sys.success_url) ? 'login_url and success_url are required' : loginEgress.ok ? null : loginEgress.reason,
			},
			analyze: {
				enabled: analyzeEnabled,
				state: proposed ? 'proposed' : 'not-run',
				proposed,
				disabledReason: analyzeEnabled ? null : (!selectedAuth ? authMissing : !sys.target_url ? 'target_url is required' : !targetEgress.ok ? targetEgress.reason : 'target_url is required'),
			},
			sync: {
				enabled: syncEnabled,
				state: syncEnabled ? 'ready' : 'disabled',
				engine,
				limited: false,
				disabledReason: syncEnabled ? null : (!selectedAuth ? authMissing : !sys.target_url ? 'target_url is required' : !targetEgress.ok ? targetEgress.reason : 'valid recipe is required'),
			},
			enrich: {
				enabled: enrichEnabled,
				state: enrichEnabled ? 'ready' : 'disabled',
				engine,
				limited: false,
				disabledReason: enrichEnabled ? null : (!selectedAuth ? authMissing : !targetEgress.ok ? targetEgress.reason : !detailReady ? 'recipe.detail.idLabel is required' : 'sync records before enrich'),
			},
			approve: {
				loginState: approveLogin ? 'ready' : 'missing',
				listUrl: !!listUrlFor(name),
			},
			recordStats: stats,
		};
	} finally { if (!db0) closeDb(db); }
}

export function systemActions(name, db0 = null, context = null) {
	const db = db0 || openDb();
	try {
		const state = systemState(name, db, context);
		if (!state) return null;
		const sys = getSystem(db, name, tenantOptions(context));
		const recipe = sys && sys.recipe ? sys.recipe : {};
		const actions = [];
		actions.push({ system: name, action: 'auth', engine: state.auth.engine, riskClass: 'read', enabled: state.auth.enabled, state: state.auth.state, disabledReason: state.auth.disabledReason });
		actions.push({ system: name, action: 'analyze', engine: state.auth.engine, riskClass: 'read', enabled: state.analyze.enabled, state: state.analyze.state, disabledReason: state.analyze.disabledReason });
		actions.push({ system: name, action: 'sync', engine: state.sync.engine, riskClass: 'read', enabled: state.sync.enabled, state: state.sync.state, disabledReason: state.sync.disabledReason });
		actions.push({ system: name, action: 'enrich', engine: state.enrich.engine, riskClass: 'read', enabled: state.enrich.enabled, state: state.enrich.state, disabledReason: state.enrich.disabledReason });
		const effectful = { ...(recipe.actions || {}) };
		if (recipe.approve && !effectful.approve) effectful.approve = recipe.approve;
		for (const [action, block] of Object.entries(effectful)) {
			const schema = validateActionBlock(action, block, { allowDisabled: true });
			const captured = !!block && block.enabled !== false && schema.ok && !schema.disabled;
			const enabled = !!(captured && state.approve.loginState === 'ready' && state.approve.listUrl);
			const catalog = schema.catalog || null;
			actions.push({
				system: name,
				action,
				// These come from recipe.actions/recipe.approve — effectful by construction. The plan GATE
				// (routes-command-plan.js) is the single source of truth and NEVER downgrades a non-READ action
				// to read, so the display must not claim 'read' here either: clamp a (mis)declared read up to
				// irreversible so the capability view can't contradict the gate.
				riskClass: (block.class === 'read' || block.riskClass === 'read') ? 'irreversible' : (block.class || block.riskClass || (catalog && catalog.riskClass) || 'irreversible'),
				enabled,
				state: enabled ? 'enabled' : captured ? 'disabled' : block && block.enabled === false ? 'needs implementation' : 'invalid schema',
				reviewedOnly: block.reviewedOnly !== false,
				dryRunRequired: true,
				humanConfirmRequired: true,
				permission: block.permission || `actions.${action}.live`,
				catalogAction: catalog && catalog.id,
				executor: catalog && catalog.executor,
				resultStatus: schema.resultStatus || (catalog && catalog.resultStatus),
				capRequired: catalog ? !!catalog.requiresCap : true,
				completionRequired: catalog ? !!catalog.requiresCompletion : true,
				disabledReason: enabled ? null : (!schema.ok ? schema.reason : schema.disabled ? schema.reason : !captured ? 'action is disabled or not captured' : state.approve.loginState !== 'ready' ? 'Playwright login state missing' : 'pending-list URL missing'),
			});
		}
		if (!effectful.approve) {
			actions.push({ system: name, action: 'approve', riskClass: 'irreversible', enabled: false, state: 'needs implementation', dryRunRequired: true, humanConfirmRequired: true, permission: 'actions.approve.live', disabledReason: 'recipe action is not captured' });
		}
		return actions;
	} finally { if (!db0) closeDb(db); }
}

export function allActionsView(context = null) {
	const db = openDb();
	try {
		return listSystems(db, tenantOptions(context)).flatMap((s) => systemActions(s.name, db, context) || []);
	} finally { closeDb(db); }
}
