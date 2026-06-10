// lib/db.js — the approvals store (P0 of the 결재 automation feature).
//
// CommonJS so it is shared by BOTH consumers without a module-system mismatch:
//   - bin/*.js / bin/*.mjs helpers use require('../lib/db.js') where needed
//   - webui (ESM, type:module scoped to webui/) imports it through createRequire
// (lib/ sits under the root which has NO package.json, so a .js here is CJS; the webui ESM side
//  reaches it via Node's CJS named-export interop, which works for an object module.exports.)
//
// Backed by node:sqlite (built-in, ZERO external deps) — requires Node >= 22.5. This box runs
// v24; the webui README's historical "Node 18+" note no longer covers this module (documented
// in webui/README.md). The DB lives under data/ and is gitignored (company PII).

'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const { normalizeEngine, DEFAULT_ENGINE } = require('./engine.js');

const PROBE_ROOT = path.resolve(__dirname, '..');
// Default store: data/approvals.db (gitignored). Override with AQA_DB_PATH (tests use a tmp file).
const DEFAULT_DB_PATH = process.env.AQA_DB_PATH || path.join(PROBE_ROOT, 'data', 'approvals.db');

// The scraped, writable columns — the set re-synced on every fetch. `status` is intentionally
// EXCLUDED: it is owned by the workflow (P0 leaves it 'fetched'; P1 sets 'approved'), so a
// re-sync must never clobber a later decision back to 'fetched'. Keep this list in sync with
// the upsert below and the CREATE TABLE.
const SCRAPED_COLS = ['title', 'drafter', 'dept', 'submitted_at', 'amount', 'raw_text', 'summary'];
const MASKED_VALUE = '[MASKED]';
const REDACTED = {
	email: '[REDACTED_EMAIL]',
	phone: '[REDACTED_PHONE]',
	id: '[REDACTED_ID]',
	card: '[REDACTED_CARD]',
	token: '[REDACTED_TOKEN]',
};
const SENSITIVE_FIELD_RE = /\b(password|passwd|pwd|otp|one[-_\s]?time|token|secret|cookie|authorization|api[-_\s]?key|cvv|cvc|card|cc[-_\s]?number|ssn|resident|national[-_\s]?id|pin|routing|account[-_\s]?(no|num|number)|bank[-_\s]?account)\b/i;
const SENSITIVE_FIELD_COMPACT_RE = /(password|passwd|pwd|otp|onetime|token|secret|cookie|authorization|apikey|cvv|cvc|ssn|resident|nationalid|pin|routing|account(no|num|number)|bankaccount|card(no|num|number)|cc(no|num|number)|creditcard)/i;

function _luhnOk(digits) {
	let sum = 0;
	let dbl = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let n = digits.charCodeAt(i) - 48;
		if (n < 0 || n > 9) return false;
		if (dbl) {
			n *= 2;
			if (n > 9) n -= 9;
		}
		sum += n;
		dbl = !dbl;
	}
	return sum > 0 && sum % 10 === 0;
}

function redactString(v) {
	let s = String(v);
	s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED.token}`);
	s = s.replace(/\b(password|passwd|pwd|otp|token|secret|api[-_\s]?key|authorization|cookie|cvv|cvc|pin)\b\s*[:=]\s*([^\s,;]+)/gi, (_m, label) => `${label}: ${MASKED_VALUE}`);
	s = s.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, REDACTED.email);
	s = s.replace(/\b\d{3}-\d{2}-\d{4}\b/g, REDACTED.id);
	s = s.replace(/\b\d{6}-?[1-4]\d{6}\b/g, REDACTED.id);
	s = s.replace(/\b(?:\d[ -]?){13,19}\b/g, (m) => {
		const digits = m.replace(/\D/g, '');
		return digits.length >= 13 && digits.length <= 19 && _luhnOk(digits) ? REDACTED.card : m;
	});
	s = s.replace(/\b(?:\+?82[-.\s]?)?0?1[016789][-. \s]?\d{3,4}[-. \s]?\d{4}\b/g, REDACTED.phone);
	s = s.replace(/\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g, REDACTED.phone);
	return s;
}

function isSensitiveField(field) {
	const raw = String(field || '');
	if (SENSITIVE_FIELD_RE.test(raw)) return true;
	const compact = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
	return SENSITIVE_FIELD_COMPACT_RE.test(compact) || compact === 'card' || compact === 'cc';
}

function redactDataValue(v, field = '') {
	if (v == null) return null;
	if (typeof v === 'string') return isSensitiveField(field) && v.trim() ? MASKED_VALUE : redactString(v);
	if (typeof v === 'number' || typeof v === 'boolean') return isSensitiveField(field) ? MASKED_VALUE : v;
	if (Array.isArray(v)) return v.map((x) => redactDataValue(x, field));
	if (typeof v === 'object') {
		const out = {};
		for (const [k, val] of Object.entries(v)) {
			if (val != null) out[k] = redactDataValue(val, k);
		}
		return out;
	}
	return isSensitiveField(field) ? MASKED_VALUE : redactString(v);
}

function _requiredIdentity(v, label, field) {
	const out = v != null ? String(v).trim() : '';
	if (!out) throw new Error(`${label}: every item needs a non-empty ${field}`);
	return out;
}

function _assertUniqueBatchId(seen, id, label, field) {
	if (seen.has(id)) throw new Error(`${label}: duplicate ${field} in input batch`);
	seen.add(id);
}

function _normalizedApprovalItems(items) {
	const seen = new Set();
	return items.map((it) => {
		const docId = _requiredIdentity(it && it.doc_id, 'upsertApprovals', 'doc_id');
		_assertUniqueBatchId(seen, docId, 'upsertApprovals', 'doc_id');
		const row = { doc_id: docId };
		for (const c of SCRAPED_COLS) row[c] = it && it[c] == null ? null : String(redactDataValue(it[c], c));
		return row;
	});
}

function _normalizedRecordItems(system, items) {
	const systemName = system != null ? String(system).trim() : '';
	if (!systemName) throw new Error('upsertRecords: system is required');
	const seen = new Set();
	const rows = items.map((it) => {
		const key = _requiredIdentity(it && it.key, 'upsertRecords', 'key');
		_assertUniqueBatchId(seen, key, 'upsertRecords', 'key');
		if (it && it.data != null && (typeof it.data !== 'object' || Array.isArray(it.data))) {
			throw new Error('upsertRecords: item.data must be an object when provided');
		}
		const data = it && it.data == null
			? null
			: Object.fromEntries(Object.entries(it.data).filter(([, v]) => v != null).map(([k, v]) => [k, redactDataValue(v, k)]));
		const summary = it && it.summary == null ? null : String(redactDataValue(it.summary, 'summary'));
		return { key, data, summary };
	});
	return { systemName, rows };
}

// openDb(dbPath?): open (creating parent dir + schema if needed) and return the handle.
// Caller closes via closeDb(). KISS: one table, no migrations framework — CREATE IF NOT EXISTS.
function openDb(dbPath = DEFAULT_DB_PATH) {
	fs.mkdirSync(path.dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
		// Writers and the webui reader are SEPARATE processes on
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
	// --- Generic RPA store (any system, not just 결재) ----------------------------------------
	// `systems` = registered data-collection automations; `records` = the rows each one collects,
	// with FLEXIBLE fields in a JSON `data` blob (so a ticket system, an ERP list, another groupware
	// inbox… all fit without schema changes). The 결재 `approvals` table above stays for the
	// already-shipped Hiworks path; new registrations use this generic store.
	db.exec(`
		CREATE TABLE IF NOT EXISTS systems (
			name        TEXT PRIMARY KEY,   -- automation id (e.g. "hiworks")
			label       TEXT,               -- display name
			engine      TEXT,               -- default engine for new auth/record/play work
			login_url   TEXT,
			success_url TEXT,               -- glob to confirm post-login (setup/auth.sh)
			target_url  TEXT,               -- the list page to collect from
			recipe      TEXT,               -- JSON recipe (collection/columns/key/strip/pagination/ready/detail/summarize)
			created_at  TEXT
		)
	`);
	_migrateSystemsEngine(db);
	db.exec(`
		CREATE TABLE IF NOT EXISTS records (
			system     TEXT NOT NULL,       -- systems.name
			key        TEXT NOT NULL,       -- row identity (the recipe.key field's value)
			data       TEXT,                -- JSON of the collected fields { field: value, ... }
			summary    TEXT,
			status     TEXT NOT NULL DEFAULT 'fetched',
			fetched_at TEXT NOT NULL,
			PRIMARY KEY (system, key)
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS command_plans (
			id                TEXT PRIMARY KEY,
			actor             TEXT,
			source_text       TEXT,
			status            TEXT NOT NULL,
			risk_class        TEXT NOT NULL,
			system            TEXT,
			action            TEXT,
			plan_hash         TEXT NOT NULL,
			target_set_hash   TEXT,
			plan_json         TEXT NOT NULL,
			target_json       TEXT,
			dry_run_json      TEXT,
			confirmation_json TEXT,
			job_id            TEXT,
			created_at        TEXT NOT NULL,
			updated_at        TEXT NOT NULL
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS command_events (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			plan_id         TEXT NOT NULL,
			at              TEXT NOT NULL,
			actor           TEXT,
			type            TEXT NOT NULL,
			status          TEXT,
			reason          TEXT,
			job_id          TEXT,
			plan_hash       TEXT,
			target_set_hash TEXT,
			data_json       TEXT
		)
	`);
	return db;
}

function _migrateSystemsEngine(db) {
	const cols = db.prepare('PRAGMA table_info(systems)').all().map((r) => r.name);
	if (!cols.includes('engine')) db.exec('ALTER TABLE systems ADD COLUMN engine TEXT');
	// One-time data normalization for the Playwright-only migration: a stored legacy engine value
	// would make _parseSystem throw on EVERY listSystems()/getSystem() call (normalizeEngine is
	// fail-closed), bricking the whole systems view because of one pre-migration row. NULL means
	// "no explicit engine" and parses to DEFAULT_ENGINE; the system still cannot run until its
	// Playwright auth exists (fail-closed at the auth layer, not at the listing).
	db.prepare("UPDATE systems SET engine = NULL WHERE engine = 'agent-browser'").run();
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
	const rows = _normalizedApprovalItems(items);
	// COALESCE(excluded.col, col): update a column ONLY when the incoming item provides a non-null
	// value, else keep what's stored. This makes upsert safe for the two-stage model — the LIST sync
	// (doc_id/title/drafter/submitted_at; dept/raw_text/summary null) must NOT wipe a prior DETAIL
	// enrich (dept/raw_text/summary; title null), and vice versa. A changed non-null value still wins.
	const setClause = SCRAPED_COLS.map((c) => `${c}=COALESCE(excluded.${c}, ${c})`).join(', ');
	const stmt = db.prepare(`
		INSERT INTO approvals (doc_id, ${SCRAPED_COLS.join(', ')}, fetched_at)
		VALUES (?, ${SCRAPED_COLS.map(() => '?').join(', ')}, ?)
		ON CONFLICT(doc_id) DO UPDATE SET ${setClause}, fetched_at=excluded.fetched_at
	`);
	let n = 0;
	db.exec('BEGIN');
	try {
		for (const row of rows) {
			stmt.run(row.doc_id, ...SCRAPED_COLS.map((c) => row[c]), fetchedAt);
			n++;
		}
		db.exec('COMMIT');
	} catch (e) {
		db.exec('ROLLBACK');
		throw e;
	}
	return n;
}

// approvalsFromRecords(items): map generic registry records ({key, data, summary?}) to approvals
// upsert rows. The registry sync/enrich of the legacy 결재 system (config GW_APP) dual-writes the
// approvals table through this — its dedicated bash drivers (fetch/enrich-approvals.sh) were deleted
// in the Playwright-only migration, but the 결재 dashboard, NL 결재 query, shadow policy soak, and
// approve title-binding still read approvals. Pure; pairs with upsertApprovals (whose COALESCE keeps
// partial updates non-destructive — a list sync without dept/raw_text never wipes a prior enrich).
function approvalsFromRecords(items) {
	if (!Array.isArray(items)) throw new TypeError('approvalsFromRecords: items must be an array');
	return items.map((it) => {
		const d = (it && it.data) || {};
		const row = { doc_id: it && it.key };
		for (const c of SCRAPED_COLS) row[c] = d[c] != null ? d[c] : null;
		if (row.summary == null && it && it.summary != null) row.summary = it.summary;
		return row;
	});
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

// queryApprovals(db, filter): READ-ONLY filtered read for the NL "query" intent. Whitelisted keys
// only — dept/drafter (substring), dateFrom/dateTo (compared on the YYYY-MM-DD prefix of
// submitted_at, robust to a trailing time), keyword (title/raw_text/summary substring), status.
// NO amount filter: `amount` is stored as TEXT (commas/currency) and is often only inside raw_text,
// so a numeric bound would silently mis-classify a high-value doc — the caller maps amount to a
// keyword + warns instead (fail honest). Unknown keys are ignored. newest first.
function queryApprovals(db, filter = {}) {
	const where = [];
	const params = [];
	if (filter.status) { where.push('status = ?'); params.push(String(filter.status)); }
	if (filter.dept) { where.push('dept LIKE ?'); params.push('%' + filter.dept + '%'); }
	if (filter.drafter) { where.push('drafter LIKE ?'); params.push('%' + filter.drafter + '%'); }
	if (filter.dateFrom) { where.push('substr(submitted_at,1,10) >= ?'); params.push(String(filter.dateFrom)); }
	if (filter.dateTo) { where.push('substr(submitted_at,1,10) <= ?'); params.push(String(filter.dateTo)); }
	if (filter.keyword) {
		where.push('(title LIKE ? OR raw_text LIKE ? OR summary LIKE ?)');
		const k = '%' + filter.keyword + '%';
		params.push(k, k, k);
	}
	const lim = Number.isInteger(filter.limit) && filter.limit > 0 ? `LIMIT ${filter.limit}` : '';
	const sql = `SELECT * FROM approvals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY COALESCE(submitted_at, fetched_at) DESC, fetched_at DESC ${lim}`;
	return db.prepare(sql).all(...params);
}

// ===== Generic RPA store: systems (registered automations) + records (collected rows) =========

// registerSystem(db, sys): create/update a registered system. recipe may be an object (stored as
// JSON) or a JSON string. Only provided fields are updated (COALESCE), so re-registering to tweak
// one field doesn't wipe the rest.
function registerSystem(db, sys, createdAt = new Date().toISOString()) {
	if (!sys || !sys.name) throw new Error('registerSystem: name required');
	const recipe = sys.recipe == null ? null : typeof sys.recipe === 'string' ? sys.recipe : JSON.stringify(sys.recipe);
	const engine = sys.engine == null || sys.engine === '' ? null : normalizeEngine(sys.engine, 'system.engine');
	db.prepare(`
		INSERT INTO systems (name, label, engine, login_url, success_url, target_url, recipe, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(name) DO UPDATE SET
			label=COALESCE(excluded.label, label),
			engine=COALESCE(excluded.engine, engine),
			login_url=COALESCE(excluded.login_url, login_url),
			success_url=COALESCE(excluded.success_url, success_url),
			target_url=COALESCE(excluded.target_url, target_url),
			recipe=COALESCE(excluded.recipe, recipe)
	`).run(String(sys.name), sys.label ?? null, engine, sys.login_url ?? null, sys.success_url ?? null, sys.target_url ?? null, recipe, createdAt);
	return getSystem(db, sys.name);
}

function _parseSystem(row) {
	if (!row) return row;
	let recipe = null;
	try { recipe = row.recipe ? JSON.parse(row.recipe) : null; } catch { recipe = null; }
	return { ...row, engine: normalizeEngine(row.engine || DEFAULT_ENGINE, 'system.engine'), recipe };
}
function listSystems(db) {
	return db.prepare('SELECT * FROM systems ORDER BY created_at DESC, name').all().map(_parseSystem);
}
function getSystem(db, name) {
	return _parseSystem(db.prepare('SELECT * FROM systems WHERE name = ?').get(String(name)));
}
function deleteSystem(db, name) {
	db.exec('BEGIN');
	try {
		db.prepare('DELETE FROM records WHERE system = ?').run(String(name));
		db.prepare('DELETE FROM systems WHERE name = ?').run(String(name));
		db.exec('COMMIT');
	} catch (e) { db.exec('ROLLBACK'); throw e; }
}

// upsertRecords(db, system, items): items = [{ key (required), data (object), summary? }]. The data
// object is MERGED into any existing row's data (json_patch) so a list-sync and a later detail/enrich
// pass accumulate fields instead of clobbering; summary/status are preserved when not provided.
function upsertRecords(db, system, items, fetchedAt = new Date().toISOString()) {
	if (!Array.isArray(items)) throw new TypeError('upsertRecords: items must be an array');
	const { systemName, rows } = _normalizedRecordItems(system, items);
	const stmt = db.prepare(`
		INSERT INTO records (system, key, data, summary, fetched_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(system, key) DO UPDATE SET
			data=CASE WHEN excluded.data IS NULL THEN data ELSE json_patch(COALESCE(data,'{}'), excluded.data) END,
			summary=COALESCE(excluded.summary, summary),
			fetched_at=excluded.fetched_at
	`);
	let n = 0;
	db.exec('BEGIN');
	try {
		for (const it of rows) {
			// Strip null/undefined fields BEFORE json_patch merge: json_patch treats a null value as
			// "delete this key", so passing a null field would CLOBBER a value stored by an earlier
			// pass. Dropping nulls makes the merge truly accumulate-never-clobber (an absent/null field
			// preserves the prior value; a present non-null field updates it).
			const data = it.data == null ? null : JSON.stringify(it.data);
			stmt.run(systemName, it.key, data, it.summary, fetchedAt);
			n++;
		}
		db.exec('COMMIT');
	} catch (e) { db.exec('ROLLBACK'); throw e; }
	return n;
}

// queryRecords(db, system, {keyword?, status?, limit?}): rows for one system, newest first. keyword
// is a substring match across the JSON data blob + summary (flexible-field search). Each row's `data`
// is parsed back to an object.
function queryRecords(db, system, { keyword, status, limit } = {}) {
	const where = ['system = ?'];
	const params = [String(system)];
	if (status) { where.push('status = ?'); params.push(String(status)); }
	if (keyword) { where.push('(data LIKE ? OR summary LIKE ?)'); const k = '%' + keyword + '%'; params.push(k, k); }
	const lim = Number.isInteger(limit) && limit > 0 ? `LIMIT ${limit}` : '';
	const rows = db.prepare(`SELECT * FROM records WHERE ${where.join(' AND ')} ORDER BY fetched_at DESC ${lim}`).all(...params);
	return rows.map((r) => { let data = {}; try { data = r.data ? JSON.parse(r.data) : {}; } catch {} return { ...r, data }; });
}
function countRecords(db, system) {
	return db.prepare('SELECT COUNT(*) c FROM records WHERE system = ?').get(String(system)).c;
}
// getRecord(db, system, key): one record (with parsed `data`) by exact (system,key), or undefined. Used by
// the approve route to bind a registered system's record TITLE to the leaf's content guard (generic path).
function getRecord(db, system, key) {
	const r = db.prepare('SELECT * FROM records WHERE system = ? AND key = ?').get(String(system), String(key));
	if (!r) return undefined;
	let data = {}; try { data = r.data ? JSON.parse(r.data) : {}; } catch {}
	return { ...r, data };
}

function _jsonOrNull(v) {
	if (v == null) return null;
	if (typeof v === 'string') return v;
	return JSON.stringify(v);
}
function _parseJson(v, fallback = null) {
	if (v == null || v === '') return fallback;
	try { return JSON.parse(v); } catch { return fallback; }
}
function _parseCommandPlan(row) {
	if (!row) return null;
	return {
		id: row.id,
		actor: row.actor,
		sourceText: row.source_text,
		status: row.status,
		riskClass: row.risk_class,
		system: row.system,
		action: row.action,
		planHash: row.plan_hash,
		targetSetHash: row.target_set_hash,
		plan: _parseJson(row.plan_json, {}),
		targets: _parseJson(row.target_json, null),
		dryRun: _parseJson(row.dry_run_json, null),
		confirmation: _parseJson(row.confirmation_json, null),
		jobId: row.job_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
function createCommandPlan(db, rec) {
	const now = rec.created_at || new Date().toISOString();
	db.prepare(`
		INSERT INTO command_plans
			(id, actor, source_text, status, risk_class, system, action, plan_hash, target_set_hash,
			 plan_json, target_json, dry_run_json, confirmation_json, job_id, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		String(rec.id),
		rec.actor == null ? null : String(rec.actor),
		rec.source_text == null ? null : String(rec.source_text),
		String(rec.status || 'planned'),
		String(rec.risk_class || 'read'),
		rec.system == null ? null : String(rec.system),
		rec.action == null ? null : String(rec.action),
		String(rec.plan_hash),
		rec.target_set_hash == null ? null : String(rec.target_set_hash),
		_jsonOrNull(rec.plan_json || rec.plan || {}),
		_jsonOrNull(rec.target_json || rec.targets),
		_jsonOrNull(rec.dry_run_json || rec.dry_run),
		_jsonOrNull(rec.confirmation_json || rec.confirmation),
		rec.job_id == null ? null : String(rec.job_id),
		now,
		rec.updated_at || now,
	);
	return getCommandPlan(db, rec.id);
}
function getCommandPlan(db, id) {
	return _parseCommandPlan(db.prepare('SELECT * FROM command_plans WHERE id = ?').get(String(id)));
}
function listCommandPlans(db, { limit } = {}) {
	const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
	return db.prepare('SELECT * FROM command_plans ORDER BY updated_at DESC LIMIT ?').all(n).map(_parseCommandPlan);
}
const COMMAND_PATCH_COLS = new Set(['status', 'target_set_hash', 'target_json', 'dry_run_json', 'confirmation_json', 'job_id', 'plan_json']);
function updateCommandPlan(db, id, fields) {
	const sets = [];
	const vals = [];
	for (const [k, v] of Object.entries(fields || {})) {
		if (!COMMAND_PATCH_COLS.has(k)) continue;
		sets.push(`${k} = ?`);
		vals.push(k.endsWith('_json') ? _jsonOrNull(v) : v == null ? null : String(v));
	}
	sets.push('updated_at = ?');
	vals.push(new Date().toISOString());
	vals.push(String(id));
	db.prepare(`UPDATE command_plans SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
	return getCommandPlan(db, id);
}
function appendCommandEvent(db, ev) {
	const at = ev.at || new Date().toISOString();
	db.prepare(`
		INSERT INTO command_events
			(plan_id, at, actor, type, status, reason, job_id, plan_hash, target_set_hash, data_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		String(ev.plan_id),
		at,
		ev.actor == null ? null : String(ev.actor),
		String(ev.type),
		ev.status == null ? null : String(ev.status),
		ev.reason == null ? null : String(ev.reason),
		ev.job_id == null ? null : String(ev.job_id),
		ev.plan_hash == null ? null : String(ev.plan_hash),
		ev.target_set_hash == null ? null : String(ev.target_set_hash),
		_jsonOrNull(ev.data_json || ev.data),
	);
	return db.prepare('SELECT last_insert_rowid() id').get().id;
}
function listCommandEvents(db, planId) {
	return db.prepare('SELECT * FROM command_events WHERE plan_id = ? ORDER BY id ASC').all(String(planId)).map((r) => ({
		id: r.id,
		planId: r.plan_id,
		at: r.at,
		actor: r.actor,
		type: r.type,
		status: r.status,
		reason: r.reason,
		jobId: r.job_id,
		planHash: r.plan_hash,
		targetSetHash: r.target_set_hash,
		data: _parseJson(r.data_json, {}),
	}));
}

module.exports = {
	openDb, closeDb, DEFAULT_DB_PATH, SCRAPED_COLS,
	// 결재-specific (Hiworks path)
	upsertApprovals, approvalsFromRecords, listApprovals, getApproval, queryApprovals,
	// generic RPA store
	registerSystem, listSystems, getSystem, deleteSystem, upsertRecords, queryRecords, getRecord, countRecords,
	// command plans
	createCommandPlan, getCommandPlan, listCommandPlans, updateCommandPlan, appendCommandEvent, listCommandEvents,
};
