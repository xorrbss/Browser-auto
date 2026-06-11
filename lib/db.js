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
const crypto = require('node:crypto');
const { normalizeEngine, DEFAULT_ENGINE } = require('./engine.js');
const { auditSinkDeliveryMetadata, writeAuditSinkEvent, classifyAuditSinkDeliveryFailure } = require('./audit-sink.js');

const PROBE_ROOT = path.resolve(__dirname, '..');
// Default store: data/approvals.db (gitignored). Override with AQA_DB_PATH (tests use a tmp file).
const DEFAULT_DB_PATH = process.env.AQA_DB_PATH || path.join(PROBE_ROOT, 'data', 'approvals.db');
const LOCAL_TENANT_ID = 'local';
const LOCAL_ACTOR_ID = 'local';

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

function _cleanIdentity(value, fallback, label) {
	let out = value != null ? String(value).trim() : '';
	if (!out) out = fallback;
	if (!out || out.includes('\0') || out.length > 120) throw new Error(`${label}: invalid`);
	return out;
}

function _defaultTenantId() {
	return _cleanIdentity(process.env.WEBUI_TENANT_ID || process.env.AQA_TENANT_ID, LOCAL_TENANT_ID, 'tenantId');
}

function _defaultActorId() {
	return _cleanIdentity(process.env.WEBUI_ACTOR_ID || process.env.AQA_WEBUI_ACTOR || process.env.AQA_ACTOR_ID, LOCAL_ACTOR_ID, 'actorId');
}

function _tenantIdFrom(source = null) {
	if (source && typeof source === 'object') {
		return _cleanIdentity(source.tenantId || source.tenant_id || source.tenant?.id || source.actor?.tenantId, _defaultTenantId(), 'tenantId');
	}
	return _defaultTenantId();
}

function _actorIdFrom(source = null) {
	if (source && typeof source === 'object') {
		return _cleanIdentity(source.actorId || source.actor_id || source.actor?.id, _defaultActorId(), 'actorId');
	}
	return _defaultActorId();
}

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

function _normalizedRecordItems(system, items, options = {}) {
	const systemName = system != null ? String(system).trim() : '';
	if (!systemName) throw new Error('upsertRecords: system is required');
	const tenantId = _tenantIdFrom(options);
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
	return { tenantId, systemName, rows };
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
			tenant_id   TEXT NOT NULL DEFAULT 'local',
			name        TEXT NOT NULL,      -- automation id (e.g. "hiworks")
			label       TEXT,               -- display name
			engine      TEXT,               -- default engine for new auth/record/play work
			login_url   TEXT,
			success_url TEXT,               -- glob to confirm post-login (setup/auth.sh)
			target_url  TEXT,               -- the list page to collect from
			recipe      TEXT,               -- JSON recipe (collection/columns/key/strip/pagination/ready/detail/summarize)
			created_at  TEXT,
			PRIMARY KEY (tenant_id, name)
		)
	`);
	_migrateSystemsSchema(db);
	db.exec(`
		CREATE TABLE IF NOT EXISTS records (
			tenant_id  TEXT NOT NULL DEFAULT 'local',
			system     TEXT NOT NULL,       -- systems.name
			key        TEXT NOT NULL,       -- row identity (the recipe.key field's value)
			data       TEXT,                -- JSON of the collected fields { field: value, ... }
			summary    TEXT,
			status     TEXT NOT NULL DEFAULT 'fetched',
			fetched_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, system, key)
		)
	`);
	_migrateRecordsSchema(db);
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
	db.exec(`
		CREATE TABLE IF NOT EXISTS webui_jobs (
			id                  TEXT PRIMARY KEY,
			schema_version      INTEGER NOT NULL DEFAULT 1,
			tenant_id           TEXT NOT NULL,
			actor_id            TEXT NOT NULL,
			actor_role          TEXT,
			session_id          TEXT,
			kind                TEXT NOT NULL,
			label               TEXT,
			meta_json           TEXT,
			route               TEXT,
			status              TEXT NOT NULL,
			exit_code           INTEGER,
			cancelled           INTEGER NOT NULL DEFAULT 0,
			cancel_requested_at INTEGER,
			timed_out           INTEGER NOT NULL DEFAULT 0,
			enqueued_at         INTEGER NOT NULL,
			claimed_at          INTEGER,
			started_at          INTEGER,
			ended_at            INTEGER,
			pid                 INTEGER,
			worker_id           TEXT,
			worker_tenant_id    TEXT,
			worker_deployment_id TEXT,
			last_heartbeat_at   INTEGER,
			claim_expires_at    INTEGER,
			attempts            INTEGER NOT NULL DEFAULT 0,
			max_attempts        INTEGER NOT NULL DEFAULT 1,
			run_id              TEXT,
			exit_signal         TEXT,
			error               TEXT,
			failure_reason      TEXT,
			result_json         TEXT,
			log_json            TEXT,
			command_json        TEXT,
			resumable           INTEGER NOT NULL DEFAULT 0,
			non_resumable_reason TEXT,
			retention           TEXT NOT NULL DEFAULT 'ephemeral-debug',
			delete_after        INTEGER,
			updated_at          INTEGER NOT NULL
		)
	`);
	_migrateWebuiJobsSchema(db);
	db.exec('CREATE INDEX IF NOT EXISTS idx_webui_jobs_status ON webui_jobs(status)');
	db.exec('CREATE INDEX IF NOT EXISTS idx_webui_jobs_tenant_updated ON webui_jobs(tenant_id, updated_at)');
	db.exec('CREATE INDEX IF NOT EXISTS idx_webui_jobs_claim ON webui_jobs(status, tenant_id, enqueued_at, id)');
	db.exec('CREATE INDEX IF NOT EXISTS idx_webui_jobs_worker ON webui_jobs(worker_id, status, id)');
	db.exec('CREATE INDEX IF NOT EXISTS idx_webui_jobs_worker_binding ON webui_jobs(worker_id, worker_tenant_id, worker_deployment_id, status, id)');
	db.exec('CREATE INDEX IF NOT EXISTS idx_webui_jobs_claim_expires ON webui_jobs(status, claim_expires_at)');
	db.exec(`
		CREATE TABLE IF NOT EXISTS webui_job_audit (
			id          INTEGER PRIMARY KEY AUTOINCREMENT,
			at          TEXT NOT NULL,
			tenant_id   TEXT NOT NULL,
			actor_id    TEXT NOT NULL,
			actor_role  TEXT,
			session_id  TEXT,
			job_id      TEXT NOT NULL,
			kind        TEXT NOT NULL,
			event       TEXT NOT NULL,
			status      TEXT NOT NULL,
			route       TEXT,
			command_json TEXT,
			system      TEXT,
			redaction   TEXT NOT NULL DEFAULT 'applied',
			result_json TEXT,
			data_json   TEXT,
			prev_hash   TEXT,
			hash        TEXT NOT NULL
		)
	`);
	_migrateWebuiJobAuditSchema(db);
	db.exec('CREATE INDEX IF NOT EXISTS idx_webui_job_audit_job ON webui_job_audit(job_id, id)');
	db.exec('CREATE INDEX IF NOT EXISTS idx_webui_job_audit_tenant_job ON webui_job_audit(tenant_id, job_id, id)');
	db.exec(`
		CREATE TABLE IF NOT EXISTS webui_audit_outbox (
			id                INTEGER PRIMARY KEY AUTOINCREMENT,
			audit_id          INTEGER NOT NULL,
			at                TEXT NOT NULL,
			tenant_id         TEXT NOT NULL,
			job_id            TEXT,
			sink_mode         TEXT NOT NULL,
			sink_id           TEXT NOT NULL,
			status            TEXT NOT NULL,
			payload_hash      TEXT NOT NULL,
			payload_bytes     INTEGER NOT NULL,
			target_json       TEXT NOT NULL,
			attempts          INTEGER NOT NULL DEFAULT 0,
			next_attempt_at   TEXT,
			last_attempt_at   TEXT,
			last_error        TEXT,
			last_error_class  TEXT,
			dead_letter_at    TEXT,
			created_at        TEXT NOT NULL,
			updated_at        TEXT NOT NULL,
			UNIQUE(audit_id, sink_id)
		)
	`);
	_migrateWebuiAuditOutboxSchema(db);
	db.exec('CREATE INDEX IF NOT EXISTS idx_webui_audit_outbox_status ON webui_audit_outbox(status, id)');
	db.exec('CREATE INDEX IF NOT EXISTS idx_webui_audit_outbox_tenant_status ON webui_audit_outbox(tenant_id, status, id)');
	db.exec(`
		CREATE TABLE IF NOT EXISTS webui_artifacts (
			id              INTEGER PRIMARY KEY AUTOINCREMENT,
			tenant_id       TEXT NOT NULL,
			actor_id        TEXT,
			job_id          TEXT,
			run_id          TEXT NOT NULL,
			path            TEXT NOT NULL,
			kind            TEXT,
			sha256          TEXT NOT NULL,
			bytes           INTEGER,
			redaction       TEXT NOT NULL DEFAULT 'unknown',
			retention       TEXT NOT NULL DEFAULT 'ephemeral-debug',
			scan_status     TEXT NOT NULL DEFAULT 'unknown',
			redaction_status TEXT NOT NULL DEFAULT 'unknown',
			policy_approval TEXT NOT NULL DEFAULT 'missing',
			policy_approved_by TEXT,
			policy_approved_at TEXT,
			policy_reason   TEXT,
			created_at      TEXT NOT NULL,
			delete_after     TEXT,
			deleted_at      TEXT,
			deleted_by      TEXT,
			delete_reason   TEXT,
			meta_json       TEXT,
			UNIQUE(tenant_id, run_id, path)
		)
	`);
	_migrateWebuiArtifactsSchema(db);
	db.exec('CREATE INDEX IF NOT EXISTS idx_webui_artifacts_tenant_job ON webui_artifacts(tenant_id, job_id, id)');
	db.exec('CREATE INDEX IF NOT EXISTS idx_webui_artifacts_tenant_run ON webui_artifacts(tenant_id, run_id, id)');
	db.exec('CREATE INDEX IF NOT EXISTS idx_webui_artifacts_tenant_deleted ON webui_artifacts(tenant_id, deleted_at, id)');
	return db;
}

function _tableColumns(db, table) {
	return db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}

function _primaryKeyColumns(db, table) {
	return db.prepare(`PRAGMA table_info(${table})`).all()
		.filter((r) => r.pk > 0)
		.sort((a, b) => a.pk - b.pk)
		.map((r) => r.name);
}

function _addColumnIfMissing(db, table, cols, ddl) {
	const m = /^([A-Za-z0-9_]+)\s+/.exec(ddl.trim());
	if (m && !cols.includes(m[1])) {
		db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
		cols.push(m[1]);
	}
}

function _rebuildSystemsTableForTenantPk(db) {
	db.exec(`
		DROP TABLE IF EXISTS systems__tenant_migration;
		CREATE TABLE systems__tenant_migration (
			tenant_id   TEXT NOT NULL DEFAULT 'local',
			name        TEXT NOT NULL,
			label       TEXT,
			engine      TEXT,
			login_url   TEXT,
			success_url TEXT,
			target_url  TEXT,
			recipe      TEXT,
			created_at  TEXT,
			PRIMARY KEY (tenant_id, name)
		);
		INSERT OR REPLACE INTO systems__tenant_migration
			(tenant_id, name, label, engine, login_url, success_url, target_url, recipe, created_at)
		SELECT
			COALESCE(NULLIF(tenant_id, ''), 'local'), name, label, engine, login_url, success_url, target_url, recipe, created_at
		FROM systems
		WHERE name IS NOT NULL AND name != '';
		DROP TABLE systems;
		ALTER TABLE systems__tenant_migration RENAME TO systems;
	`);
}

function _rebuildRecordsTableForTenantPk(db) {
	db.exec(`
		DROP TABLE IF EXISTS records__tenant_migration;
		CREATE TABLE records__tenant_migration (
			tenant_id  TEXT NOT NULL DEFAULT 'local',
			system     TEXT NOT NULL,
			key        TEXT NOT NULL,
			data       TEXT,
			summary    TEXT,
			status     TEXT NOT NULL DEFAULT 'fetched',
			fetched_at TEXT NOT NULL,
			PRIMARY KEY (tenant_id, system, key)
		);
		INSERT OR REPLACE INTO records__tenant_migration
			(tenant_id, system, key, data, summary, status, fetched_at)
		SELECT
			COALESCE(NULLIF(tenant_id, ''), 'local'), system, key, data, summary,
			COALESCE(NULLIF(status, ''), 'fetched'), fetched_at
		FROM records
		WHERE system IS NOT NULL AND system != '' AND key IS NOT NULL AND key != '';
		DROP TABLE records;
		ALTER TABLE records__tenant_migration RENAME TO records;
	`);
}

function _migrateSystemsSchema(db) {
	const cols = db.prepare('PRAGMA table_info(systems)').all().map((r) => r.name);
	_addColumnIfMissing(db, 'systems', cols, "tenant_id TEXT NOT NULL DEFAULT 'local'");
	if (!cols.includes('engine')) db.exec('ALTER TABLE systems ADD COLUMN engine TEXT');
	if (_primaryKeyColumns(db, 'systems').join(',') !== 'tenant_id,name') {
		_rebuildSystemsTableForTenantPk(db);
	}
	// One-time data normalization for the Playwright-only migration: an old explicit engine value
	// would make _parseSystem throw on every listSystems()/getSystem() call. NULL means "no explicit
	// engine" and parses to DEFAULT_ENGINE; the system still cannot run until its Playwright auth
	// exists, so the auth layer remains fail-closed.
	db.prepare("UPDATE systems SET engine = NULL WHERE engine IS NOT NULL AND TRIM(engine) != '' AND engine != 'playwright'").run();
	db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_systems_tenant_name ON systems(tenant_id, name)');
	db.exec('CREATE INDEX IF NOT EXISTS idx_systems_tenant_created ON systems(tenant_id, created_at)');
}

function _migrateRecordsSchema(db) {
	const cols = _tableColumns(db, 'records');
	_addColumnIfMissing(db, 'records', cols, "tenant_id TEXT NOT NULL DEFAULT 'local'");
	if (_primaryKeyColumns(db, 'records').join(',') !== 'tenant_id,system,key') {
		_rebuildRecordsTableForTenantPk(db);
	}
	db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_records_tenant_system_key ON records(tenant_id, system, key)');
	db.exec('CREATE INDEX IF NOT EXISTS idx_records_tenant_system_fetched ON records(tenant_id, system, fetched_at)');
}

function _migrateWebuiJobsSchema(db) {
	const cols = _tableColumns(db, 'webui_jobs');
	_addColumnIfMissing(db, 'webui_jobs', cols, 'actor_role TEXT');
	_addColumnIfMissing(db, 'webui_jobs', cols, 'session_id TEXT');
	_addColumnIfMissing(db, 'webui_jobs', cols, 'route TEXT');
	_addColumnIfMissing(db, 'webui_jobs', cols, 'worker_id TEXT');
	_addColumnIfMissing(db, 'webui_jobs', cols, 'worker_tenant_id TEXT');
	_addColumnIfMissing(db, 'webui_jobs', cols, 'worker_deployment_id TEXT');
	_addColumnIfMissing(db, 'webui_jobs', cols, 'last_heartbeat_at INTEGER');
	_addColumnIfMissing(db, 'webui_jobs', cols, 'claim_expires_at INTEGER');
	_addColumnIfMissing(db, 'webui_jobs', cols, 'attempts INTEGER NOT NULL DEFAULT 0');
	_addColumnIfMissing(db, 'webui_jobs', cols, 'max_attempts INTEGER NOT NULL DEFAULT 1');
	_addColumnIfMissing(db, 'webui_jobs', cols, 'command_json TEXT');
	_addColumnIfMissing(db, 'webui_jobs', cols, 'resumable INTEGER NOT NULL DEFAULT 0');
	_addColumnIfMissing(db, 'webui_jobs', cols, 'non_resumable_reason TEXT');
	_addColumnIfMissing(db, 'webui_jobs', cols, "retention TEXT NOT NULL DEFAULT 'ephemeral-debug'");
	_addColumnIfMissing(db, 'webui_jobs', cols, 'delete_after INTEGER');
}

function _migrateWebuiJobAuditSchema(db) {
	const cols = _tableColumns(db, 'webui_job_audit');
	_addColumnIfMissing(db, 'webui_job_audit', cols, 'actor_role TEXT');
	_addColumnIfMissing(db, 'webui_job_audit', cols, 'session_id TEXT');
	_addColumnIfMissing(db, 'webui_job_audit', cols, 'route TEXT');
	_addColumnIfMissing(db, 'webui_job_audit', cols, 'command_json TEXT');
	_addColumnIfMissing(db, 'webui_job_audit', cols, 'system TEXT');
	_addColumnIfMissing(db, 'webui_job_audit', cols, "redaction TEXT NOT NULL DEFAULT 'applied'");
}

function _migrateWebuiAuditOutboxSchema(db) {
	const cols = _tableColumns(db, 'webui_audit_outbox');
	_addColumnIfMissing(db, 'webui_audit_outbox', cols, 'job_id TEXT');
	_addColumnIfMissing(db, 'webui_audit_outbox', cols, 'next_attempt_at TEXT');
	_addColumnIfMissing(db, 'webui_audit_outbox', cols, 'last_attempt_at TEXT');
	_addColumnIfMissing(db, 'webui_audit_outbox', cols, 'last_error TEXT');
	_addColumnIfMissing(db, 'webui_audit_outbox', cols, 'last_error_class TEXT');
	_addColumnIfMissing(db, 'webui_audit_outbox', cols, 'dead_letter_at TEXT');
}

function _migrateWebuiArtifactsSchema(db) {
	const cols = _tableColumns(db, 'webui_artifacts');
	_addColumnIfMissing(db, 'webui_artifacts', cols, "scan_status TEXT NOT NULL DEFAULT 'unknown'");
	_addColumnIfMissing(db, 'webui_artifacts', cols, "redaction_status TEXT NOT NULL DEFAULT 'unknown'");
	_addColumnIfMissing(db, 'webui_artifacts', cols, "policy_approval TEXT NOT NULL DEFAULT 'missing'");
	_addColumnIfMissing(db, 'webui_artifacts', cols, 'policy_approved_by TEXT');
	_addColumnIfMissing(db, 'webui_artifacts', cols, 'policy_approved_at TEXT');
	_addColumnIfMissing(db, 'webui_artifacts', cols, 'policy_reason TEXT');
	_addColumnIfMissing(db, 'webui_artifacts', cols, 'deleted_at TEXT');
	_addColumnIfMissing(db, 'webui_artifacts', cols, 'deleted_by TEXT');
	_addColumnIfMissing(db, 'webui_artifacts', cols, 'delete_reason TEXT');
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
	const tenantId = _tenantIdFrom(sys);
	const recipe = sys.recipe == null ? null : typeof sys.recipe === 'string' ? sys.recipe : JSON.stringify(sys.recipe);
	const engine = sys.engine == null || sys.engine === '' ? null : normalizeEngine(sys.engine, 'system.engine');
	db.prepare(`
		INSERT INTO systems (tenant_id, name, label, engine, login_url, success_url, target_url, recipe, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(tenant_id, name) DO UPDATE SET
			label=COALESCE(excluded.label, label),
			engine=COALESCE(excluded.engine, engine),
			login_url=COALESCE(excluded.login_url, login_url),
			success_url=COALESCE(excluded.success_url, success_url),
			target_url=COALESCE(excluded.target_url, target_url),
			recipe=COALESCE(excluded.recipe, recipe)
	`).run(tenantId, String(sys.name), sys.label ?? null, engine, sys.login_url ?? null, sys.success_url ?? null, sys.target_url ?? null, recipe, createdAt);
	return getSystem(db, sys.name, { tenantId });
}

function _parseSystem(row) {
	if (!row) return row;
	let recipe = null;
	try { recipe = row.recipe ? JSON.parse(row.recipe) : null; } catch { recipe = null; }
	return { ...row, tenantId: row.tenant_id || LOCAL_TENANT_ID, engine: normalizeEngine(row.engine || DEFAULT_ENGINE, 'system.engine'), recipe };
}
function listSystems(db, options = {}) {
	const tenantId = _tenantIdFrom(options);
	return db.prepare('SELECT * FROM systems WHERE tenant_id = ? ORDER BY created_at DESC, name').all(tenantId).map(_parseSystem);
}
function getSystem(db, name, options = {}) {
	const tenantId = _tenantIdFrom(options);
	return _parseSystem(db.prepare('SELECT * FROM systems WHERE tenant_id = ? AND name = ?').get(tenantId, String(name)));
}
function deleteSystem(db, name, options = {}) {
	const tenantId = _tenantIdFrom(options);
	db.exec('BEGIN');
	try {
		db.prepare('DELETE FROM records WHERE tenant_id = ? AND system = ?').run(tenantId, String(name));
		db.prepare('DELETE FROM systems WHERE tenant_id = ? AND name = ?').run(tenantId, String(name));
		db.exec('COMMIT');
	} catch (e) { db.exec('ROLLBACK'); throw e; }
}

// upsertRecords(db, system, items): items = [{ key (required), data (object), summary? }]. The data
// object is MERGED into any existing row's data (json_patch) so a list-sync and a later detail/enrich
// pass accumulate fields instead of clobbering; summary/status are preserved when not provided.
function upsertRecords(db, system, items, fetchedAt = new Date().toISOString(), options = {}) {
	if (!Array.isArray(items)) throw new TypeError('upsertRecords: items must be an array');
	const { tenantId, systemName, rows } = _normalizedRecordItems(system, items, options);
	const stmt = db.prepare(`
		INSERT INTO records (tenant_id, system, key, data, summary, fetched_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(tenant_id, system, key) DO UPDATE SET
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
			stmt.run(tenantId, systemName, it.key, data, it.summary, fetchedAt);
			n++;
		}
		db.exec('COMMIT');
	} catch (e) { db.exec('ROLLBACK'); throw e; }
	return n;
}

// queryRecords(db, system, {keyword?, status?, limit?}): rows for one system, newest first. keyword
// is a substring match across the JSON data blob + summary (flexible-field search). Each row's `data`
// is parsed back to an object.
function queryRecords(db, system, { keyword, status, limit, tenantId: tenantOpt } = {}) {
	const tenantId = _tenantIdFrom({ tenantId: tenantOpt });
	const where = ['tenant_id = ?', 'system = ?'];
	const params = [tenantId, String(system)];
	if (status) { where.push('status = ?'); params.push(String(status)); }
	if (keyword) { where.push('(data LIKE ? OR summary LIKE ?)'); const k = '%' + keyword + '%'; params.push(k, k); }
	const lim = Number.isInteger(limit) && limit > 0 ? `LIMIT ${limit}` : '';
	const rows = db.prepare(`SELECT * FROM records WHERE ${where.join(' AND ')} ORDER BY fetched_at DESC ${lim}`).all(...params);
	return rows.map((r) => {
		let data = {};
		try { data = r.data ? JSON.parse(r.data) : {}; } catch {}
		return { ...r, tenantId: r.tenant_id || LOCAL_TENANT_ID, data };
	});
}
function countRecords(db, system, options = {}) {
	const tenantId = _tenantIdFrom(options);
	return db.prepare('SELECT COUNT(*) c FROM records WHERE tenant_id = ? AND system = ?').get(tenantId, String(system)).c;
}
// getRecord(db, system, key): one record (with parsed `data`) by exact (system,key), or undefined. Used by
// the approve route to bind a registered system's record TITLE to the leaf's content guard (generic path).
function getRecord(db, system, key, options = {}) {
	const tenantId = _tenantIdFrom(options);
	const r = db.prepare('SELECT * FROM records WHERE tenant_id = ? AND system = ? AND key = ?').get(tenantId, String(system), String(key));
	if (!r) return undefined;
	let data = {}; try { data = r.data ? JSON.parse(r.data) : {}; } catch {}
	return { ...r, tenantId: r.tenant_id || LOCAL_TENANT_ID, data };
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
const AUDIT_REDACTED = '[redacted]';
function _alreadyRedacted(value) {
	return /^\[(?:redacted|masked|REDACTED_[A-Z_]+|MASKED)\]$/i.test(String(value || '').trim());
}
function _redactAuditString(value) {
	let s = String(value);
	s = s.replace(/\bBearer\s+(?!\[redacted\])["']?[A-Za-z0-9._~+/=-]+["']?/gi, `Bearer ${AUDIT_REDACTED}`);
	s = s.replace(/\b(password|passwd|pwd|otp|token|secret|api[-_\s]?key|authorization|cookie|cvv|cvc|pin)\b\s*[:=]\s*(?!\[redacted\]|\[MASKED\]|\[REDACTED_[A-Z_]+\])([^\s,;]+)/gi, (_m, label) => `${label}=${AUDIT_REDACTED}`);
	s = s.replace(/(https?:\/\/[^\s?#]+)\?[^)\]\s"'<>]+/ig, `$1?${AUDIT_REDACTED}`);
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
function _redactAuditValue(value, field = '') {
	if (value == null) return null;
	if (typeof value === 'string') {
		if (isSensitiveField(field) && value.trim() && !_alreadyRedacted(value)) return AUDIT_REDACTED;
		return _redactAuditString(value);
	}
	if (typeof value === 'number' || typeof value === 'boolean') return isSensitiveField(field) ? AUDIT_REDACTED : value;
	if (Array.isArray(value)) return value.map((item) => _redactAuditValue(item, field));
	if (typeof value === 'object') {
		const out = {};
		for (const [key, raw] of Object.entries(value)) {
			if (raw != null) out[key] = _redactAuditValue(raw, key);
		}
		return out;
	}
	return _redactAuditString(value);
}
function _auditJson(value, fallback) {
	if (value == null) return fallback == null ? null : JSON.stringify(fallback);
	if (typeof value === 'string') {
		const parsed = _parseJson(value, undefined);
		return parsed === undefined ? JSON.stringify(_redactAuditValue(value)) : JSON.stringify(_redactAuditValue(parsed));
	}
	return JSON.stringify(_redactAuditValue(value));
}
function _firstDefined(...values) {
	for (const value of values) if (value !== undefined) return value;
	return undefined;
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

// ===== WebUI durable queue + audit ============================================================

const WEBUI_JOB_STATUS = new Set(['queued', 'claimed', 'running', 'canceling', 'canceled', 'succeeded', 'failed', 'interrupted', 'expired']);

function _jobStatus(value) {
	const status = String(value || '').trim();
	if (!WEBUI_JOB_STATUS.has(status)) throw new Error(`webui job: invalid status ${status || '(empty)'}`);
	return status;
}

function _toMs(value) {
	if (value == null || value === '') return null;
	const n = Number(value);
	return Number.isFinite(n) ? Math.trunc(n) : null;
}

function _toNonNegativeInt(value, fallback = 0) {
	if (value == null || value === '') return fallback;
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0) throw new Error('webui job: invalid attempt count');
	return Math.trunc(n);
}

function _toPositiveInt(value, fallback = 1, label = 'value') {
	if (value == null || value === '') return fallback;
	const n = Number(value);
	if (!Number.isFinite(n) || n < 1) throw new Error(`webui job: invalid ${label}`);
	return Math.trunc(n);
}

function _runnerIdFrom(value) {
	return _cleanIdentity(value, '', 'runnerId');
}

function _optionalIdentity(value, label) {
	const out = value != null ? String(value).trim() : '';
	if (!out) return null;
	if (out.includes('\0') || out.length > 120) throw new Error(`${label}: invalid`);
	return out;
}

function _runnerBindingFrom(opts = {}) {
	const runnerId = _runnerIdFrom(opts.runnerId);
	const requestedTenant = _optionalIdentity(opts.tenantId, 'tenantId');
	const runnerTenant = _optionalIdentity(opts.runnerTenantId || opts.runner_tenant_id, 'runnerTenantId');
	const runnerDeployment = _optionalIdentity(opts.runnerDeploymentId || opts.runner_deployment_id || opts.deploymentId || opts.deployment_id, 'runnerDeploymentId');
	if (requestedTenant && runnerTenant && requestedTenant !== runnerTenant) return null;
	return {
		runnerId,
		tenantId: requestedTenant || runnerTenant || null,
		runnerTenantId: runnerTenant || requestedTenant || null,
		runnerDeploymentId: runnerDeployment,
	};
}

function _toIntBool(value) {
	return value ? 1 : 0;
}

function _toNullableInt(value) {
	const n = _toMs(value);
	return n == null ? null : n;
}

function _toNullableString(value) {
	return value == null ? null : String(value);
}

function _jobJson(value, fallback) {
	if (value == null) return fallback == null ? null : JSON.stringify(fallback);
	return typeof value === 'string' ? value : JSON.stringify(value);
}

function _parseWebuiJob(row) {
	if (!row) return null;
	return {
		id: row.id,
		tenantId: row.tenant_id,
		actorId: row.actor_id,
		actorRole: row.actor_role,
		sessionId: row.session_id,
		kind: row.kind,
		label: row.label,
		meta: _parseJson(row.meta_json, {}),
		route: row.route,
		status: row.status,
		exitCode: row.exit_code,
		cancelled: !!row.cancelled,
		cancelRequestedAt: row.cancel_requested_at,
		timedOut: !!row.timed_out,
		enqueuedAt: row.enqueued_at,
		claimedAt: row.claimed_at,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		pid: row.pid,
		workerId: row.worker_id,
		workerTenantId: row.worker_tenant_id,
		workerDeploymentId: row.worker_deployment_id,
		lastHeartbeatAt: row.last_heartbeat_at,
		claimExpiresAt: row.claim_expires_at,
		attempts: row.attempts || 0,
		maxAttempts: row.max_attempts || 1,
		runId: row.run_id,
		exitSignal: row.exit_signal,
		error: row.error,
		failureReason: row.failure_reason,
		result: _parseJson(row.result_json, null),
		log: _parseJson(row.log_json, []),
		command: _parseJson(row.command_json, null),
		resumable: !!row.resumable,
		nonResumableReason: row.non_resumable_reason,
		retention: row.retention || 'ephemeral-debug',
		deleteAfter: row.delete_after,
		updatedAt: row.updated_at,
	};
}

function saveWebuiJob(db, rec, updatedAt = Date.now()) {
	if (!rec || !rec.id) throw new Error('saveWebuiJob: id required');
	const row = {
		id: String(rec.id),
		tenant_id: String(rec.tenantId || rec.tenant_id || 'local'),
		actor_id: String(rec.actorId || rec.actor_id || 'local'),
		actor_role: _toNullableString(rec.actorRole || rec.actor_role || rec.role),
		session_id: _toNullableString(rec.sessionId || rec.session_id),
		kind: String(rec.kind || 'job'),
		label: _toNullableString(rec.label),
		meta_json: _jobJson(rec.metaJson || rec.meta_json || rec.meta || {}, {}),
		route: _toNullableString(rec.route),
		status: _jobStatus(rec.status),
		exit_code: rec.exitCode == null ? null : Number(rec.exitCode),
		cancelled: _toIntBool(rec.cancelled),
		cancel_requested_at: _toNullableInt(rec.cancelRequestedAt || rec.cancel_requested_at),
		timed_out: _toIntBool(rec.timedOut || rec.timed_out),
		enqueued_at: _toMs(rec.enqueuedAt || rec.enqueued_at) || updatedAt,
		claimed_at: _toNullableInt(rec.claimedAt || rec.claimed_at),
		started_at: _toNullableInt(rec.startedAt || rec.started_at),
		ended_at: _toNullableInt(rec.endedAt || rec.ended_at),
		pid: rec.pid == null ? null : Number(rec.pid),
		worker_id: _toNullableString(rec.workerId || rec.worker_id),
		worker_tenant_id: _toNullableString(rec.workerTenantId || rec.worker_tenant_id),
		worker_deployment_id: _toNullableString(rec.workerDeploymentId || rec.worker_deployment_id || rec.deploymentId || rec.deployment_id),
		last_heartbeat_at: _toNullableInt(rec.lastHeartbeatAt || rec.last_heartbeat_at),
		claim_expires_at: _toNullableInt(rec.claimExpiresAt || rec.claim_expires_at),
		attempts: _toNonNegativeInt(_firstDefined(rec.attempts, rec.attempt_count), 0),
		max_attempts: _toPositiveInt(_firstDefined(rec.maxAttempts, rec.max_attempts, rec.retryMaxAttempts, rec.retry_max_attempts), 1, 'maxAttempts'),
		run_id: _toNullableString(rec.runId || rec.run_id),
		exit_signal: _toNullableString(rec.exitSignal || rec.exit_signal),
		error: _toNullableString(rec.error),
		failure_reason: _toNullableString(rec.failureReason || rec.failure_reason),
		result_json: _jobJson(rec.resultJson || rec.result_json || rec.result, null),
		log_json: _jobJson(rec.logJson || rec.log_json || rec.log || [], []),
		command_json: _jobJson(rec.commandJson || rec.command_json || rec.command, null),
		resumable: _toIntBool(rec.resumable),
		non_resumable_reason: _toNullableString(rec.nonResumableReason || rec.non_resumable_reason),
		retention: String(rec.retention || rec.retentionPolicy || rec.retention_policy || 'ephemeral-debug'),
		delete_after: _toNullableInt(rec.deleteAfter || rec.delete_after),
		updated_at: updatedAt,
	};
	db.prepare(`
		INSERT INTO webui_jobs (
			id, schema_version, tenant_id, actor_id, actor_role, session_id, kind, label, meta_json,
			route, status, exit_code, cancelled, cancel_requested_at, timed_out, enqueued_at,
			claimed_at, started_at, ended_at, pid, worker_id, worker_tenant_id, worker_deployment_id, last_heartbeat_at, claim_expires_at,
			attempts, max_attempts, run_id, exit_signal, error, failure_reason, result_json,
			log_json, command_json, resumable, non_resumable_reason,
			retention, delete_after, updated_at
		)
		VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			tenant_id=excluded.tenant_id,
			actor_id=excluded.actor_id,
			actor_role=excluded.actor_role,
			session_id=excluded.session_id,
			kind=excluded.kind,
			label=excluded.label,
			meta_json=excluded.meta_json,
			route=excluded.route,
			status=excluded.status,
			exit_code=excluded.exit_code,
			cancelled=excluded.cancelled,
			cancel_requested_at=excluded.cancel_requested_at,
			timed_out=excluded.timed_out,
			enqueued_at=excluded.enqueued_at,
			claimed_at=excluded.claimed_at,
			started_at=excluded.started_at,
			ended_at=excluded.ended_at,
			pid=excluded.pid,
			worker_id=excluded.worker_id,
			worker_tenant_id=excluded.worker_tenant_id,
			worker_deployment_id=excluded.worker_deployment_id,
			last_heartbeat_at=excluded.last_heartbeat_at,
			claim_expires_at=excluded.claim_expires_at,
			attempts=excluded.attempts,
			max_attempts=excluded.max_attempts,
			run_id=excluded.run_id,
			exit_signal=excluded.exit_signal,
			error=excluded.error,
			failure_reason=excluded.failure_reason,
			result_json=excluded.result_json,
			log_json=excluded.log_json,
			command_json=excluded.command_json,
			resumable=excluded.resumable,
			non_resumable_reason=excluded.non_resumable_reason,
			retention=excluded.retention,
			delete_after=excluded.delete_after,
			updated_at=excluded.updated_at
	`).run(
		row.id, row.tenant_id, row.actor_id, row.actor_role, row.session_id, row.kind, row.label,
		row.meta_json, row.route, row.status, row.exit_code, row.cancelled, row.cancel_requested_at,
		row.timed_out, row.enqueued_at, row.claimed_at, row.started_at, row.ended_at, row.pid,
		row.worker_id, row.worker_tenant_id, row.worker_deployment_id, row.last_heartbeat_at, row.claim_expires_at, row.attempts, row.max_attempts,
		row.run_id, row.exit_signal, row.error, row.failure_reason, row.result_json, row.log_json,
		row.command_json, row.resumable, row.non_resumable_reason, row.retention, row.delete_after,
		row.updated_at,
	);
	return getWebuiJob(db, row.id);
}

function getWebuiJob(db, id, options = {}) {
	if (options && options.tenantId) {
		return _parseWebuiJob(db.prepare('SELECT * FROM webui_jobs WHERE id = ? AND tenant_id = ?').get(String(id), _tenantIdFrom(options)));
	}
	return _parseWebuiJob(db.prepare('SELECT * FROM webui_jobs WHERE id = ?').get(String(id)));
}

function listWebuiJobs(db, { limit = 100, tenantId } = {}) {
	const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 500) : 100;
	if (tenantId) {
		return db.prepare(`
			SELECT * FROM (
				SELECT * FROM webui_jobs WHERE tenant_id = ? ORDER BY enqueued_at DESC, id DESC LIMIT ?
			) ORDER BY enqueued_at ASC, id ASC
		`).all(String(tenantId), n).map(_parseWebuiJob);
	}
	return db.prepare(`
		SELECT * FROM (
			SELECT * FROM webui_jobs ORDER BY enqueued_at DESC, id DESC LIMIT ?
		) ORDER BY enqueued_at ASC, id ASC
	`).all(n).map(_parseWebuiJob);
}

function claimWebuiJob(db, id, { runnerId, tenantId, now = Date.now(), leaseMs = 60000, requireResumable = true } = {}) {
	const binding = _runnerBindingFrom(arguments[2] || {});
	if (!binding) return null;
	const lease = _toPositiveInt(leaseMs, 60000, 'leaseMs');
	const where = ['id = ?', "status = 'queued'", 'attempts < max_attempts'];
	const params = [String(id)];
	if (binding.tenantId) { where.push('tenant_id = ?'); params.push(binding.tenantId); }
	if (requireResumable !== false) where.push('resumable = 1', 'command_json IS NOT NULL');
	const update = db.prepare(`
		UPDATE webui_jobs
		SET status = 'claimed',
			claimed_at = ?,
			worker_id = ?,
			worker_tenant_id = ?,
			worker_deployment_id = ?,
			last_heartbeat_at = ?,
			claim_expires_at = ?,
			attempts = attempts + 1,
			updated_at = ?
		WHERE ${where.join(' AND ')}
	`);
	const result = update.run(now, binding.runnerId, binding.runnerTenantId, binding.runnerDeploymentId, now, now + lease, now, ...params);
	if (!result.changes) return null;
	return getWebuiJob(db, id, binding.tenantId ? { tenantId: binding.tenantId } : {});
}

function claimNextWebuiJob(db, { runnerId, tenantId, now = Date.now(), leaseMs = 60000, requireResumable = true, kinds } = {}) {
	const binding = _runnerBindingFrom(arguments[1] || {});
	if (!binding) return null;
	const where = ["status = 'queued'", 'attempts < max_attempts'];
	const params = [];
	if (binding.tenantId) { where.push('tenant_id = ?'); params.push(binding.tenantId); }
	if (requireResumable !== false) where.push('resumable = 1', 'command_json IS NOT NULL');
	if (Array.isArray(kinds) && kinds.length) {
		const safeKinds = kinds.map((k) => String(k).trim()).filter(Boolean);
		if (safeKinds.length) {
			where.push(`kind IN (${safeKinds.map(() => '?').join(', ')})`);
			params.push(...safeKinds);
		}
	}
	const row = db.prepare(`
		SELECT id FROM webui_jobs
		WHERE ${where.join(' AND ')}
		ORDER BY enqueued_at ASC, id ASC
		LIMIT 1
	`).get(...params);
	return row ? claimWebuiJob(db, row.id, { runnerId, tenantId: binding.tenantId, runnerTenantId: binding.runnerTenantId, runnerDeploymentId: binding.runnerDeploymentId, now, leaseMs, requireResumable }) : null;
}

function heartbeatWebuiJob(db, id, { runnerId, now = Date.now(), leaseMs = 60000, status = 'running', pid, runId } = {}) {
	const binding = _runnerBindingFrom(arguments[2] || {});
	if (!binding) return null;
	const nextStatus = _jobStatus(status);
	if (!['claimed', 'running', 'canceling'].includes(nextStatus)) {
		throw new Error(`webui job heartbeat: invalid active status ${nextStatus}`);
	}
	const lease = _toPositiveInt(leaseMs, 60000, 'leaseMs');
	const identityWhere = ['id = ?', 'worker_id = ?'];
	const identityParams = [String(id), binding.runnerId];
	if (binding.runnerTenantId) { identityWhere.push('worker_tenant_id = ?'); identityParams.push(binding.runnerTenantId); }
	if (binding.runnerDeploymentId) { identityWhere.push('worker_deployment_id = ?'); identityParams.push(binding.runnerDeploymentId); }
	const row = db.prepare(`SELECT * FROM webui_jobs WHERE ${identityWhere.join(' AND ')}`).get(...identityParams);
	if (!row || !['claimed', 'running', 'canceling'].includes(row.status)) return null;
	db.prepare(`
		UPDATE webui_jobs
		SET status = CASE WHEN status = 'canceling' THEN 'canceling' ELSE ? END,
			started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
			pid = COALESCE(?, pid),
			run_id = COALESCE(?, run_id),
			last_heartbeat_at = ?,
			claim_expires_at = ?,
			updated_at = ?
		WHERE ${identityWhere.join(' AND ')} AND status IN ('claimed', 'running', 'canceling')
	`).run(
		nextStatus, nextStatus, now,
		pid == null ? null : Number(pid),
		runId == null ? null : String(runId),
		now, now + lease, now, ...identityParams,
	);
	const out = getWebuiJob(db, id);
	return out ? { ...out, cancelRequested: !!out.cancelled || out.status === 'canceling' } : null;
}

function completeWebuiJob(db, id, { runnerId, status, now = Date.now(), exitCode, result, log, runId, exitSignal, error, failureReason, timedOut = false } = {}) {
	const binding = _runnerBindingFrom(arguments[2] || {});
	if (!binding) return null;
	const terminalStatus = _jobStatus(status);
	if (!['canceled', 'succeeded', 'failed', 'interrupted', 'expired'].includes(terminalStatus)) {
		throw new Error(`webui job complete: invalid terminal status ${terminalStatus}`);
	}
	const identityWhere = ['id = ?', 'worker_id = ?'];
	const identityParams = [String(id), binding.runnerId];
	if (binding.runnerTenantId) { identityWhere.push('worker_tenant_id = ?'); identityParams.push(binding.runnerTenantId); }
	if (binding.runnerDeploymentId) { identityWhere.push('worker_deployment_id = ?'); identityParams.push(binding.runnerDeploymentId); }
	const res = db.prepare(`
		UPDATE webui_jobs
		SET status = ?,
			exit_code = ?,
			cancelled = CASE WHEN ? = 'canceled' THEN 1 ELSE cancelled END,
			timed_out = CASE WHEN ? = 'expired' THEN 1 ELSE ? END,
			ended_at = COALESCE(ended_at, ?),
			pid = NULL,
			run_id = COALESCE(?, run_id),
			exit_signal = ?,
			error = ?,
			failure_reason = ?,
			result_json = COALESCE(?, result_json),
			log_json = COALESCE(?, log_json),
			last_heartbeat_at = ?,
			claim_expires_at = NULL,
			updated_at = ?
		WHERE ${identityWhere.join(' AND ')} AND status IN ('claimed', 'running', 'canceling')
	`).run(
		terminalStatus,
		exitCode == null ? null : Number(exitCode),
		terminalStatus,
		terminalStatus,
		_toIntBool(timedOut),
		now,
		runId == null ? null : String(runId),
		_toNullableString(exitSignal),
		_toNullableString(error),
		_toNullableString(failureReason),
		result == null ? null : _jobJson(result, null),
		log == null ? null : _jobJson(log, []),
		now,
		now,
		...identityParams,
	);
	return res.changes ? getWebuiJob(db, id) : null;
}

function requestWebuiJobCancel(db, id, { tenantId, now = Date.now(), reason = 'cancel requested' } = {}) {
	const options = tenantId ? { tenantId } : {};
	const before = getWebuiJob(db, id, options);
	if (!before) return { ok: false, found: false, changed: false, job: null };
	if (['canceled', 'succeeded', 'failed', 'interrupted', 'expired'].includes(before.status)) {
		return { ok: true, found: true, changed: false, terminal: true, job: before };
	}
	const alreadyRequested = !!before.cancelled || before.status === 'canceling';
	const nextStatus = before.status === 'queued' ? 'canceled' : 'canceling';
	db.prepare(`
		UPDATE webui_jobs
		SET status = ?,
			cancelled = 1,
			cancel_requested_at = COALESCE(cancel_requested_at, ?),
			ended_at = CASE WHEN ? = 'canceled' THEN COALESCE(ended_at, ?) ELSE ended_at END,
			failure_reason = CASE WHEN ? = 'canceled' THEN COALESCE(failure_reason, ?) ELSE failure_reason END,
			updated_at = ?
		WHERE id = ? ${tenantId ? 'AND tenant_id = ?' : ''} AND status IN ('queued', 'claimed', 'running', 'canceling')
	`).run(
		nextStatus,
		now,
		nextStatus,
		now,
		nextStatus,
		reason,
		now,
		String(id),
		...(tenantId ? [_tenantIdFrom({ tenantId })] : []),
	);
	return {
		ok: true,
		found: true,
		changed: !alreadyRequested,
		terminal: nextStatus === 'canceled',
		job: getWebuiJob(db, id, options),
	};
}

function reconcileWebuiJobs(db, {
	now = Date.now(),
	reason = 'server restart reconciliation',
	staleMs = null,
	retryStale = false,
	tenantId,
} = {}) {
	const where = ["status IN ('claimed', 'running', 'canceling')"];
	const params = [];
	if (tenantId) { where.push('tenant_id = ?'); params.push(_tenantIdFrom({ tenantId })); }
	if (staleMs != null) {
		const cutoff = now - _toPositiveInt(staleMs, 1, 'staleMs');
		where.push('(claim_expires_at IS NULL OR claim_expires_at <= ? OR last_heartbeat_at IS NULL OR last_heartbeat_at <= ?)');
		params.push(now, cutoff);
	}
	const rows = db.prepare(`
		SELECT * FROM webui_jobs
		WHERE ${where.join(' AND ')}
		ORDER BY enqueued_at ASC, id ASC
	`).all(...params).map(_parseWebuiJob);
	if (!rows.length) return [];
	const interruptStmt = db.prepare(`
		UPDATE webui_jobs
		SET status = 'interrupted',
			ended_at = COALESCE(ended_at, ?),
			updated_at = ?,
			pid = NULL,
			claim_expires_at = NULL,
			failure_reason = COALESCE(failure_reason, ?),
			error = COALESCE(error, ?)
		WHERE id = ? AND status IN ('claimed', 'running', 'canceling')
	`);
	const retryStmt = db.prepare(`
		UPDATE webui_jobs
		SET status = 'queued',
			claimed_at = NULL,
			started_at = NULL,
			pid = NULL,
			worker_id = NULL,
			worker_tenant_id = NULL,
			worker_deployment_id = NULL,
			last_heartbeat_at = NULL,
			claim_expires_at = NULL,
			updated_at = ?,
			failure_reason = COALESCE(failure_reason, ?)
		WHERE id = ? AND status IN ('claimed', 'running') AND cancelled = 0
	`);
	const out = [];
	db.exec('BEGIN');
	try {
		for (const row of rows) {
			const canRetry = retryStale && row.status !== 'canceling' && !row.cancelled && row.resumable && row.command && row.attempts < row.maxAttempts;
			if (canRetry) {
				retryStmt.run(now, reason, row.id);
				out.push({
					...row,
					status: 'queued',
					claimedAt: null,
					startedAt: null,
					pid: null,
					workerId: null,
					workerTenantId: null,
					workerDeploymentId: null,
					lastHeartbeatAt: null,
					claimExpiresAt: null,
					failureReason: row.failureReason || reason,
					updatedAt: now,
					reconcileAction: 'retry-queued',
				});
			} else {
				interruptStmt.run(now, now, reason, reason, row.id);
				out.push({
					...row,
					status: 'interrupted',
					endedAt: row.endedAt || now,
					pid: null,
					claimExpiresAt: null,
					failureReason: row.failureReason || reason,
					error: row.error || reason,
					updatedAt: now,
					reconcileAction: 'interrupted',
				});
			}
		}
		db.exec('COMMIT');
	} catch (e) {
		db.exec('ROLLBACK');
		throw e;
	}
	return out;
}

function _auditHash(fields) {
	return crypto.createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

const AUDIT_OUTBOX_STATUS = new Set(['pending', 'delivered', 'failed', 'dead-letter']);

function _auditOutboxStatus(value) {
	const status = String(value || '').trim();
	if (!AUDIT_OUTBOX_STATUS.has(status)) throw new Error(`webui audit outbox: invalid status ${status || '(empty)'}`);
	return status;
}

function _parseWebuiAuditOutbox(row) {
	if (!row) return null;
	return {
		id: row.id,
		auditId: row.audit_id,
		at: row.at,
		tenantId: row.tenant_id,
		jobId: row.job_id,
		sinkMode: row.sink_mode,
		sinkId: row.sink_id,
		status: row.status,
		payloadHash: row.payload_hash,
		payloadBytes: row.payload_bytes,
		target: _parseJson(row.target_json, {}),
		attempts: row.attempts || 0,
		nextAttemptAt: row.next_attempt_at,
		lastAttemptAt: row.last_attempt_at,
		lastError: row.last_error,
		lastErrorClass: row.last_error_class,
		deadLetterAt: row.dead_letter_at,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function saveWebuiAuditOutbox(db, rec) {
	if (!rec || !rec.auditId || !rec.sinkId || !rec.payloadHash) throw new Error('saveWebuiAuditOutbox: auditId, sinkId, and payloadHash required');
	const now = rec.updatedAt || rec.updated_at || rec.createdAt || rec.created_at || new Date().toISOString();
	const row = {
		audit_id: Number(rec.auditId || rec.audit_id),
		at: String(rec.at || now),
		tenant_id: String(rec.tenantId || rec.tenant_id || 'local'),
		job_id: _toNullableString(rec.jobId || rec.job_id),
		sink_mode: String(rec.sinkMode || rec.sink_mode || 'webhook'),
		sink_id: String(rec.sinkId || rec.sink_id),
		status: _auditOutboxStatus(rec.status || 'pending'),
		payload_hash: String(rec.payloadHash || rec.payload_hash),
		payload_bytes: Number(rec.payloadBytes || rec.payload_bytes || 0),
		target_json: _auditJson(rec.targetJson || rec.target_json || rec.target || {}, {}),
		attempts: _toNonNegativeInt(rec.attempts, 0),
		next_attempt_at: _toNullableString(rec.nextAttemptAt || rec.next_attempt_at),
		last_attempt_at: _toNullableString(rec.lastAttemptAt || rec.last_attempt_at),
		last_error: _toNullableString(_redactAuditValue(rec.lastError || rec.last_error)),
		last_error_class: _toNullableString(rec.lastErrorClass || rec.last_error_class),
		dead_letter_at: _toNullableString(rec.deadLetterAt || rec.dead_letter_at),
		created_at: String(rec.createdAt || rec.created_at || now),
		updated_at: now,
	};
	db.prepare(`
		INSERT INTO webui_audit_outbox
			(audit_id, at, tenant_id, job_id, sink_mode, sink_id, status, payload_hash, payload_bytes,
			 target_json, attempts, next_attempt_at, last_attempt_at, last_error, last_error_class, dead_letter_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(audit_id, sink_id) DO UPDATE SET
			status=excluded.status,
			payload_hash=excluded.payload_hash,
			payload_bytes=excluded.payload_bytes,
			target_json=excluded.target_json,
			attempts=excluded.attempts,
			next_attempt_at=excluded.next_attempt_at,
			last_attempt_at=excluded.last_attempt_at,
			last_error=excluded.last_error,
			last_error_class=excluded.last_error_class,
			dead_letter_at=excluded.dead_letter_at,
			updated_at=excluded.updated_at
	`).run(
		row.audit_id, row.at, row.tenant_id, row.job_id, row.sink_mode, row.sink_id, row.status,
		row.payload_hash, row.payload_bytes, row.target_json, row.attempts, row.next_attempt_at,
		row.last_attempt_at, row.last_error, row.last_error_class, row.dead_letter_at, row.created_at, row.updated_at,
	);
	return _parseWebuiAuditOutbox(db.prepare('SELECT * FROM webui_audit_outbox WHERE audit_id = ? AND sink_id = ?').get(row.audit_id, row.sink_id));
}

function markWebuiAuditOutboxDelivery(db, auditId, sinkId, { status, at = new Date().toISOString(), error = null, errorClass = null, nextAttemptAt = null, deadLetterAt = null } = {}) {
	const nextStatus = _auditOutboxStatus(status);
	const res = db.prepare(`
		UPDATE webui_audit_outbox
		SET status = ?,
			attempts = attempts + 1,
			last_attempt_at = ?,
			last_error = ?,
			last_error_class = ?,
			next_attempt_at = ?,
			dead_letter_at = ?,
			updated_at = ?
		WHERE audit_id = ? AND sink_id = ?
	`).run(
		nextStatus,
		at,
		error == null ? null : String(_redactAuditValue(error)),
		errorClass == null ? null : String(errorClass),
		nextAttemptAt == null ? null : String(nextAttemptAt),
		deadLetterAt == null ? null : String(deadLetterAt),
		at,
		Number(auditId),
		String(sinkId),
	);
	return res.changes ? _parseWebuiAuditOutbox(db.prepare('SELECT * FROM webui_audit_outbox WHERE audit_id = ? AND sink_id = ?').get(Number(auditId), String(sinkId))) : null;
}

function listWebuiAuditOutbox(db, { tenantId, jobId, auditId, status, limit = 100 } = {}) {
	const where = [];
	const params = [];
	if (tenantId) { where.push('tenant_id = ?'); params.push(_tenantIdFrom({ tenantId })); }
	if (jobId) { where.push('job_id = ?'); params.push(String(jobId)); }
	if (auditId != null) { where.push('audit_id = ?'); params.push(Number(auditId)); }
	if (Array.isArray(status) && status.length) {
		const safe = status.map(_auditOutboxStatus);
		where.push(`status IN (${safe.map(() => '?').join(', ')})`);
		params.push(...safe);
	} else if (status) { where.push('status = ?'); params.push(_auditOutboxStatus(status)); }
	const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 100;
	params.push(n);
	const sql = `SELECT * FROM webui_audit_outbox ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ASC LIMIT ?`;
	return db.prepare(sql).all(...params).map(_parseWebuiAuditOutbox);
}

function listDueWebuiAuditOutbox(db, { tenantId, now = new Date().toISOString(), limit = 100 } = {}) {
	const where = ["status IN ('pending', 'failed')", '(next_attempt_at IS NULL OR next_attempt_at <= ?)'];
	const params = [String(now)];
	if (tenantId) { where.push('tenant_id = ?'); params.push(_tenantIdFrom({ tenantId })); }
	const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 100;
	params.push(n);
	const sql = `SELECT * FROM webui_audit_outbox WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ?`;
	return db.prepare(sql).all(...params).map(_parseWebuiAuditOutbox);
}

function appendWebuiJobAudit(db, ev) {
	if (!ev || !ev.jobId) throw new Error('appendWebuiJobAudit: jobId required');
	const at = ev.at || new Date().toISOString();
	const prev = db.prepare('SELECT hash FROM webui_job_audit ORDER BY id DESC LIMIT 1').get();
	const command = _firstDefined(ev.command, ev.commandJson, ev.command_json);
	const rec = {
		at,
		tenant_id: String(ev.tenantId || ev.tenant_id || 'local'),
		actor_id: String(ev.actorId || ev.actor_id || 'local'),
		actor_role: _toNullableString(ev.actorRole || ev.actor_role || ev.role),
		session_id: _toNullableString(ev.sessionId || ev.session_id),
		job_id: String(ev.jobId || ev.job_id),
		kind: String(ev.kind || 'job'),
		event: String(ev.event || 'event'),
		status: _jobStatus(ev.status),
		route: _toNullableString(_redactAuditValue(ev.route)),
		command_json: command == null ? null : _auditJson(command, null),
		system: _toNullableString(_redactAuditValue(ev.system || ev.targetSystem || ev.target_system, 'system')),
		redaction: String(ev.redaction || ev.redactionStatus || ev.redaction_status || 'applied'),
		result_json: _auditJson(_firstDefined(ev.result, ev.resultJson, ev.result_json), null),
		data_json: _auditJson(_firstDefined(ev.data, ev.dataJson, ev.data_json), {}),
		prev_hash: prev ? prev.hash : '',
	};
	const hash = _auditHash(rec);
	db.prepare(`
		INSERT INTO webui_job_audit
			(at, tenant_id, actor_id, actor_role, session_id, job_id, kind, event, status, route,
			 command_json, system, redaction, result_json, data_json, prev_hash, hash)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`).run(
		rec.at, rec.tenant_id, rec.actor_id, rec.actor_role, rec.session_id, rec.job_id,
		rec.kind, rec.event, rec.status, rec.route, rec.command_json, rec.system, rec.redaction,
		rec.result_json, rec.data_json, rec.prev_hash, hash,
	);
	const id = db.prepare('SELECT last_insert_rowid() id').get().id;
	const event = { id, ...rec, hash };
	let outbox = null;
	try {
		const delivery = auditSinkDeliveryMetadata(event);
		if (delivery.enabled && delivery.mode === 'webhook') {
			outbox = saveWebuiAuditOutbox(db, {
				auditId: id,
				at: rec.at,
				tenantId: rec.tenant_id,
				jobId: rec.job_id,
				sinkMode: delivery.mode,
				sinkId: delivery.sinkId,
				status: 'pending',
				payloadHash: delivery.payloadHash,
				payloadBytes: delivery.payloadBytes,
				target: delivery.target,
			});
		}
	} catch {
		/* writeAuditSinkEvent below reports invalid sink configuration to the caller. */
	}
	try {
		writeAuditSinkEvent(event);
		if (outbox) markWebuiAuditOutboxDelivery(db, id, outbox.sinkId, { status: 'delivered' });
	} catch (e) {
		if (outbox) {
			const failure = classifyAuditSinkDeliveryFailure(e);
			const status = e && e.code === 'AUDIT_SINK_CONNECTOR_REQUIRED' ? 'pending' : 'failed';
			markWebuiAuditOutboxDelivery(db, id, outbox.sinkId, {
				status,
				error: (e && e.message) || e,
				errorClass: failure.class,
			});
		}
		throw e;
	}
	return id;
}

function _parseWebuiJobAudit(row) {
	if (!row) return null;
	return {
		id: row.id,
		at: row.at,
		tenantId: row.tenant_id,
		actorId: row.actor_id,
		actorRole: row.actor_role,
		sessionId: row.session_id,
		jobId: row.job_id,
		kind: row.kind,
		event: row.event,
		status: row.status,
		route: row.route,
		command: _parseJson(row.command_json, null),
		system: row.system,
		redaction: row.redaction || 'applied',
		result: _parseJson(row.result_json, null),
		data: _parseJson(row.data_json, {}),
		prevHash: row.prev_hash,
		hash: row.hash,
	};
}

function listWebuiJobAudit(db, { jobId, limit = 100, tenantId: tenantOpt } = {}) {
	const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 100;
	let rows;
	if (tenantOpt) {
		const tenantId = _tenantIdFrom({ tenantId: tenantOpt });
		rows = jobId
			? db.prepare('SELECT * FROM webui_job_audit WHERE tenant_id = ? AND job_id = ? ORDER BY id DESC LIMIT ?').all(tenantId, String(jobId), n)
			: db.prepare('SELECT * FROM webui_job_audit WHERE tenant_id = ? ORDER BY id DESC LIMIT ?').all(tenantId, n);
	} else {
		rows = jobId
			? db.prepare('SELECT * FROM webui_job_audit WHERE job_id = ? ORDER BY id DESC LIMIT ?').all(String(jobId), n)
			: db.prepare('SELECT * FROM webui_job_audit ORDER BY id DESC LIMIT ?').all(n);
	}
	return rows.reverse().map(_parseWebuiJobAudit);
}

function _auditCanonicalFromRow(row) {
	return {
		at: row.at,
		tenant_id: row.tenant_id,
		actor_id: row.actor_id,
		actor_role: row.actor_role,
		session_id: row.session_id,
		job_id: row.job_id,
		kind: row.kind,
		event: row.event,
		status: row.status,
		route: row.route,
		command_json: row.command_json,
		system: row.system,
		redaction: row.redaction || 'applied',
		result_json: row.result_json,
		data_json: row.data_json,
		prev_hash: row.prev_hash,
	};
}

function _legacyAuditCanonicalFromRow(row) {
	return {
		at: row.at,
		tenant_id: row.tenant_id,
		actor_id: row.actor_id,
		job_id: row.job_id,
		kind: row.kind,
		event: row.event,
		status: row.status,
		result_json: row.result_json,
		data_json: row.data_json,
		prev_hash: row.prev_hash,
	};
}

function verifyWebuiJobAuditChain(db) {
	const rows = db.prepare('SELECT * FROM webui_job_audit ORDER BY id ASC').all();
	let prevHash = '';
	let checked = 0;
	for (const row of rows) {
		const actualPrev = row.prev_hash || '';
		if (actualPrev !== prevHash) {
			return {
				ok: false,
				checked,
				brokenAt: row.id,
				reason: 'prev_hash mismatch',
				expectedPrevHash: prevHash,
				actualPrevHash: actualPrev,
			};
		}
		const expectedHash = _auditHash(_auditCanonicalFromRow(row));
		const legacyExpectedHash = _auditHash(_legacyAuditCanonicalFromRow(row));
		if (row.hash !== expectedHash && row.hash !== legacyExpectedHash) {
			return {
				ok: false,
				checked,
				brokenAt: row.id,
				reason: 'hash mismatch',
				expectedHash,
				legacyExpectedHash,
				actualHash: row.hash,
			};
		}
		prevHash = row.hash;
		checked++;
	}
	return {
		ok: true,
		checked,
		firstId: rows.length ? rows[0].id : null,
		lastId: rows.length ? rows[rows.length - 1].id : null,
		headHash: prevHash,
		brokenAt: null,
		reason: '',
	};
}

function _safeArtifactPath(value) {
	const p = String(value || '').replace(/\\/g, '/').trim();
	if (!p || p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:\//.test(p)) throw new Error('webui artifact: invalid path');
	let decoded = p;
	try {
		decoded = decodeURIComponent(p).replace(/\\/g, '/');
	} catch {
		throw new Error('webui artifact: invalid path');
	}
	if (decoded.startsWith('/') || /^[A-Za-z]:\//.test(decoded) || decoded.split('/').includes('..')) throw new Error('webui artifact: invalid path');
	const normalized = path.posix.normalize(decoded);
	if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..') throw new Error('webui artifact: invalid path');
	return normalized;
}

function _artifactHash(value) {
	const h = String(value || '').trim().toLowerCase();
	if (!/^sha256:[0-9a-f]{64}$/.test(h)) throw new Error('webui artifact: sha256 hash required');
	return h;
}

function _parseWebuiArtifact(row) {
	if (!row) return null;
	return {
		id: row.id,
		tenantId: row.tenant_id,
		actorId: row.actor_id,
		jobId: row.job_id,
		runId: row.run_id,
		path: row.path,
		kind: row.kind,
		sha256: row.sha256,
		bytes: row.bytes,
		redaction: row.redaction,
		retention: row.retention,
		scanStatus: row.scan_status,
		redactionStatus: row.redaction_status,
		policyApproval: row.policy_approval,
		policyApprovedBy: row.policy_approved_by,
		policyApprovedAt: row.policy_approved_at,
		policyReason: row.policy_reason,
		createdAt: row.created_at,
		deleteAfter: row.delete_after,
		deletedAt: row.deleted_at,
		deletedBy: row.deleted_by,
		deleteReason: row.delete_reason,
		deleted: !!row.deleted_at,
		meta: _parseJson(row.meta_json, {}),
	};
}

function saveWebuiArtifact(db, rec) {
	if (!rec || !rec.runId || !rec.path || !rec.sha256) throw new Error('saveWebuiArtifact: runId, path, and sha256 required');
	const now = rec.createdAt || rec.created_at || new Date().toISOString();
	const policy = rec.policyApproval && typeof rec.policyApproval === 'object' ? rec.policyApproval : {};
	const row = {
		tenant_id: _tenantIdFrom(rec),
		actor_id: rec.actorId || rec.actor_id ? _actorIdFrom(rec) : null,
		job_id: _toNullableString(rec.jobId || rec.job_id),
		run_id: String(rec.runId || rec.run_id),
		path: _safeArtifactPath(rec.path),
		kind: _toNullableString(rec.kind),
		sha256: _artifactHash(rec.sha256),
		bytes: rec.bytes == null ? null : Number(rec.bytes),
		redaction: String(rec.redaction || 'unknown'),
		retention: String(rec.retention || 'ephemeral-debug'),
		scan_status: String(rec.scanStatus || rec.scan_status || 'unknown'),
		redaction_status: String(rec.redactionStatus || rec.redaction_status || rec.redaction || 'unknown'),
		policy_approval: String(policy.status || policy.decision || rec.policyApprovalStatus || rec.policy_approval || (typeof rec.policyApproval === 'string' ? rec.policyApproval : '') || 'missing'),
		policy_approved_by: _toNullableString(policy.approvedBy || rec.policyApprovedBy || rec.policy_approved_by),
		policy_approved_at: _toNullableString(policy.approvedAt || rec.policyApprovedAt || rec.policy_approved_at),
		policy_reason: _toNullableString(policy.reason || rec.policyReason || rec.policy_reason),
		created_at: now,
		delete_after: _toNullableString(rec.deleteAfter || rec.delete_after),
		deleted_at: _toNullableString(rec.deletedAt || rec.deleted_at),
		deleted_by: _toNullableString(rec.deletedBy || rec.deleted_by),
		delete_reason: _toNullableString(rec.deleteReason || rec.delete_reason),
		meta_json: _jobJson(rec.metaJson || rec.meta_json || rec.meta || {}, {}),
	};
	db.prepare(`
		INSERT INTO webui_artifacts
			(tenant_id, actor_id, job_id, run_id, path, kind, sha256, bytes, redaction, retention,
			 scan_status, redaction_status, policy_approval, policy_approved_by, policy_approved_at,
			 policy_reason, created_at, delete_after, deleted_at, deleted_by, delete_reason, meta_json)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(tenant_id, run_id, path) DO UPDATE SET
			actor_id=excluded.actor_id,
			job_id=excluded.job_id,
			kind=excluded.kind,
			sha256=excluded.sha256,
			bytes=excluded.bytes,
			redaction=excluded.redaction,
			retention=excluded.retention,
			scan_status=excluded.scan_status,
			redaction_status=excluded.redaction_status,
			policy_approval=excluded.policy_approval,
			policy_approved_by=excluded.policy_approved_by,
			policy_approved_at=excluded.policy_approved_at,
			policy_reason=excluded.policy_reason,
			created_at=excluded.created_at,
			delete_after=excluded.delete_after,
			deleted_at=COALESCE(webui_artifacts.deleted_at, excluded.deleted_at),
			deleted_by=COALESCE(webui_artifacts.deleted_by, excluded.deleted_by),
			delete_reason=COALESCE(webui_artifacts.delete_reason, excluded.delete_reason),
			meta_json=excluded.meta_json
	`).run(
		row.tenant_id, row.actor_id, row.job_id, row.run_id, row.path, row.kind, row.sha256,
		row.bytes, row.redaction, row.retention, row.scan_status, row.redaction_status,
		row.policy_approval, row.policy_approved_by, row.policy_approved_at, row.policy_reason,
		row.created_at, row.delete_after, row.deleted_at, row.deleted_by, row.delete_reason,
		row.meta_json,
	);
	return _parseWebuiArtifact(db.prepare('SELECT * FROM webui_artifacts WHERE tenant_id = ? AND run_id = ? AND path = ?').get(row.tenant_id, row.run_id, row.path));
}

function getWebuiArtifact(db, { tenantId, id, runId, path: artifactPath, includeDeleted = true } = {}) {
	const tenant = _tenantIdFrom({ tenantId });
	if (id != null) {
		const row = db.prepare(`SELECT * FROM webui_artifacts WHERE tenant_id = ? AND id = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`).get(tenant, Number(id));
		return _parseWebuiArtifact(row);
	}
	if (!runId || !artifactPath) throw new Error('getWebuiArtifact: id or runId/path required');
	const safePath = _safeArtifactPath(artifactPath);
	const row = db.prepare(`SELECT * FROM webui_artifacts WHERE tenant_id = ? AND run_id = ? AND path = ? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`).get(tenant, String(runId), safePath);
	return _parseWebuiArtifact(row);
}

function listWebuiArtifacts(db, { tenantId, jobId, runId, limit = 500, includeDeleted = true } = {}) {
	const where = [];
	const params = [];
	if (tenantId) { where.push('tenant_id = ?'); params.push(_tenantIdFrom({ tenantId })); }
	if (jobId) { where.push('job_id = ?'); params.push(String(jobId)); }
	if (runId) { where.push('run_id = ?'); params.push(String(runId)); }
	if (!includeDeleted) where.push('deleted_at IS NULL');
	const n = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 1000) : 500;
	params.push(n);
	const sql = `SELECT * FROM webui_artifacts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ASC LIMIT ?`;
	return db.prepare(sql).all(...params).map(_parseWebuiArtifact);
}

function tombstoneWebuiArtifact(db, { tenantId, id, runId, path: artifactPath, actorId, reason = 'deleted', now = new Date().toISOString() } = {}) {
	const tenant = _tenantIdFrom({ tenantId });
	let row;
	if (id != null) {
		row = db.prepare('SELECT * FROM webui_artifacts WHERE id = ?').get(Number(id));
	} else if (runId && artifactPath) {
		row = db.prepare('SELECT * FROM webui_artifacts WHERE tenant_id = ? AND run_id = ? AND path = ?').get(tenant, String(runId), _safeArtifactPath(artifactPath));
	} else {
		throw new Error('tombstoneWebuiArtifact: id or runId/path required');
	}
	if (!row || row.tenant_id !== tenant) {
		return { ok: false, deleted: false, denied: true, reason: 'not-found-or-tenant-mismatch' };
	}
	if (row.deleted_at) {
		return { ok: true, deleted: false, alreadyDeleted: true, artifact: _parseWebuiArtifact(row) };
	}
	db.prepare(`
		UPDATE webui_artifacts
		SET deleted_at = ?, deleted_by = ?, delete_reason = ?, bytes = NULL
		WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
	`).run(now, _toNullableString(actorId || _actorIdFrom({ actorId })), String(reason || 'deleted'), row.id, tenant);
	return {
		ok: true,
		deleted: true,
		artifact: _parseWebuiArtifact(db.prepare('SELECT * FROM webui_artifacts WHERE id = ? AND tenant_id = ?').get(row.id, tenant)),
	};
}

function tombstoneTenantWebuiArtifacts(db, { tenantId, actorId, reason = 'tenant deletion', now = new Date().toISOString() } = {}) {
	const tenant = _tenantIdFrom({ tenantId });
	const rows = db.prepare('SELECT id FROM webui_artifacts WHERE tenant_id = ? AND deleted_at IS NULL').all(tenant);
	const stmt = db.prepare(`
		UPDATE webui_artifacts
		SET deleted_at = ?, deleted_by = ?, delete_reason = ?, bytes = NULL
		WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
	`);
	db.exec('BEGIN');
	try {
		for (const row of rows) stmt.run(now, _toNullableString(actorId || _actorIdFrom({ actorId })), String(reason || 'tenant deletion'), row.id, tenant);
		db.exec('COMMIT');
	} catch (e) {
		db.exec('ROLLBACK');
		throw e;
	}
	return { ok: true, tenantId: tenant, tombstoned: rows.length, deleted: rows.length };
}

module.exports = {
	openDb, closeDb, DEFAULT_DB_PATH, SCRAPED_COLS,
	// 결재-specific (Hiworks path)
	upsertApprovals, approvalsFromRecords, listApprovals, getApproval, queryApprovals,
	// generic RPA store
	registerSystem, listSystems, getSystem, deleteSystem, upsertRecords, queryRecords, getRecord, countRecords,
	// command plans
	createCommandPlan, getCommandPlan, listCommandPlans, updateCommandPlan, appendCommandEvent, listCommandEvents,
	// WebUI durable queue and audit
	saveWebuiJob, getWebuiJob, listWebuiJobs, claimWebuiJob, claimNextWebuiJob, heartbeatWebuiJob,
	completeWebuiJob, requestWebuiJobCancel, reconcileWebuiJobs,
	appendWebuiJobAudit, listWebuiJobAudit, verifyWebuiJobAuditChain,
	saveWebuiAuditOutbox, markWebuiAuditOutboxDelivery, listWebuiAuditOutbox, listDueWebuiAuditOutbox,
	saveWebuiArtifact, getWebuiArtifact, listWebuiArtifacts, tombstoneWebuiArtifact, tombstoneTenantWebuiArtifacts,
};
