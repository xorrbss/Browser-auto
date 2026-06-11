#!/usr/bin/env bash
# Browser-free unit tests for lib/audit-outbox-scheduler.js.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

(
	cd "$DIR"
	AQA_DB_PATH="$TMP/audit-outbox-scheduler.db" NODE_NO_WARNINGS=1 node - <<'NODE'
const schedulerMod = require('./lib/audit-outbox-scheduler.js');
const dbm = require('./lib/db.js');

const assert = (cond, msg) => { if (!cond) { console.error('  audit-outbox-scheduler-unit: ' + msg); process.exit(1); } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hash = (ch) => 'sha256:' + ch.repeat(64);
const target = Object.freeze({
	host: 'audit.example.test',
	origin: 'https://audit.example.test',
	urlHash: hash('1'),
	credentialRefHash: hash('2'),
	credentialRefConfigured: true,
	connectorConfigured: true,
});
const webhookEnv = Object.freeze({
	WEBUI_TENANT_ID: 'tenant_a',
	WEBUI_AUDIT_SINK: 'webhook',
	WEBUI_AUDIT_SINK_URL: 'https://audit.example.test/hook',
	WEBUI_AUDIT_SINK_TOKEN_REF: 'aqa-secret:tenant_a/audit-webhook',
	WEBUI_AUDIT_OUTBOX_INTERVAL_MS: '25',
	WEBUI_AUDIT_OUTBOX_BACKOFF_MS: '40',
	WEBUI_AUDIT_OUTBOX_MAX_BACKOFF_MS: '100',
});

function save(db, rec) {
	return dbm.saveWebuiAuditOutbox(db, {
		at: '2030-01-01T00:00:00.000Z',
		tenantId: 'tenant_a',
		jobId: 'job-a',
		sinkMode: 'webhook',
		status: 'pending',
		payloadBytes: 64,
		target,
		...rec,
	});
}

function open() {
	return dbm.openDb(process.env.AQA_DB_PATH);
}

(async () => {
let cfg = schedulerMod.auditOutboxSchedulerConfig({ env: { WEBUI_AUDIT_SINK: 'local' } });
assert(cfg.disabled && cfg.disabledReason === 'audit-sink-local', 'local audit sink disables scheduler by default');
cfg = schedulerMod.auditOutboxSchedulerConfig({ env: { WEBUI_AUDIT_SINK: 'webhook', WEBUI_AUDIT_OUTBOX_SCHEDULER: 'off' } });
assert(cfg.disabled && cfg.disabledReason === 'disabled-by-config', 'explicit scheduler switch disables webhook scheduler');
cfg = schedulerMod.auditOutboxSchedulerConfig({ env: webhookEnv });
assert(cfg.enabled && cfg.intervalMs === 25 && cfg.backoffMs === 40 && cfg.maxBackoffMs === 100, 'webhook scheduler config reads interval/backoff env');

let disabledCalls = 0;
const disabled = schedulerMod.createAuditOutboxScheduler({
	env: { WEBUI_AUDIT_SINK: 'local' },
	worker: { runOnce: async () => { disabledCalls += 1; throw new Error('disabled scheduler should not run'); } },
});
let disabledState = disabled.start();
assert(disabledState.disabled && !disabledState.started, 'disabled scheduler start is a no-op');
let disabledTick = await disabled.tick();
assert(disabledTick.disabled && disabledTick.skipped && disabledCalls === 0, 'disabled tick does not touch worker');

let db = open();
try {
	save(db, { auditId: 1, sinkId: 'webhook:scheduled-success', payloadHash: hash('a') });
} finally {
	dbm.closeDb(db);
}
const calls = [];
const scheduled = schedulerMod.createAuditOutboxScheduler({
	env: webhookEnv,
	dbPath: process.env.AQA_DB_PATH,
	tenantId: 'tenant_a',
	now: '2030-01-01T00:00:00.000Z',
	connector: {
		deliverAuditOutbox: async (envelope, context) => {
			calls.push({ envelope, context });
			return { ok: true, connectorId: 'mock' };
		},
	},
});
let result = await scheduled.tick();
assert(result.ok && result.delivered === 1 && result.failureStreak === 0, 'manual tick drains due outbox rows through mock connector');
assert(calls.length === 1 && calls[0].context.auditId === 1, 'scheduler passes connector context to worker');
db = open();
try {
	assert(dbm.listWebuiAuditOutbox(db, { auditId: 1 })[0].status === 'delivered', 'scheduled drain persists delivered status');
} finally {
	dbm.closeDb(db);
}
await scheduled.stop();

let resolveSlow;
let slowCalls = 0;
const singleFlight = schedulerMod.createAuditOutboxScheduler({
	env: webhookEnv,
	worker: {
		runOnce: async () => {
			slowCalls += 1;
			await new Promise((resolve) => { resolveSlow = resolve; });
			return { ok: true, checked: 0, delivered: 0, failed: 0, deadLettered: 0 };
		},
	},
});
const first = singleFlight.tick();
await sleep(5);
const second = await singleFlight.tick();
assert(second.skipped && second.reason === 'in-flight' && slowCalls === 1, 'concurrent tick is skipped while one drain is in flight');
resolveSlow();
result = await first;
assert(result.ok && singleFlight.state().skippedInFlight === 1, 'single-flight drain completes and records skipped tick count');
await singleFlight.stop();

db = open();
try {
	save(db, { auditId: 2, sinkId: 'webhook:missing-connector', payloadHash: hash('b') });
} finally {
	dbm.closeDb(db);
}
const missingConnector = schedulerMod.createAuditOutboxScheduler({
	env: webhookEnv,
	dbPath: process.env.AQA_DB_PATH,
	tenantId: 'tenant_a',
	now: '2030-01-01T00:01:00.000Z',
	baseDelayMs: 60000,
	maxAttempts: 3,
});
result = await missingConnector.tick();
assert(!result.ok && result.failed === 1 && result.failureStreak === 1 && result.schedulerBackoffMs === 40, 'missing connector fails closed and starts scheduler backoff');
db = open();
try {
	const row = dbm.listWebuiAuditOutbox(db, { auditId: 2 })[0];
	assert(row.status === 'failed' && row.lastErrorClass === 'connector-missing', 'missing connector is persisted as a classified retry failure');
	assert(row.nextAttemptAt === '2030-01-01T00:02:00.000Z', 'worker-level connector-missing backoff remains deterministic');
} finally {
	dbm.closeDb(db);
}
await missingConnector.stop();

let periodicCalls = 0;
let releasePeriodic;
const periodic = schedulerMod.createAuditOutboxScheduler({
	env: webhookEnv,
	worker: {
		runOnce: async () => {
			periodicCalls += 1;
			if (periodicCalls === 1) {
				await new Promise((resolve) => { releasePeriodic = resolve; });
			}
			return { ok: true, checked: 0, delivered: 0, failed: 0, deadLettered: 0 };
		},
	},
});
periodic.start({ immediate: true });
await sleep(5);
assert(periodic.state().running && periodicCalls === 1, 'periodic scheduler starts an immediate tick');
const stopPromise = periodic.stop({ wait: true });
assert(periodic.state().stopped && !periodic.state().nextTickAt, 'shutdown clears future timer while tick is running');
releasePeriodic();
await stopPromise;
await sleep(40);
assert(periodicCalls === 1 && !periodic.state().running, 'shutdown waits for in-flight tick and prevents the next interval');

let sequence = 0;
const backoff = schedulerMod.createAuditOutboxScheduler({
	env: webhookEnv,
	worker: {
		runOnce: async () => {
			sequence += 1;
			if (sequence < 3) return { ok: true, checked: 1, delivered: 0, failed: 1, deadLettered: 0 };
			return { ok: true, checked: 0, delivered: 0, failed: 0, deadLettered: 0 };
		},
	},
});
result = await backoff.tick();
assert(!result.ok && result.schedulerBackoffMs === 40 && result.failureStreak === 1, 'first failed drain uses base scheduler backoff');
result = await backoff.tick();
assert(!result.ok && result.schedulerBackoffMs === 80 && result.failureStreak === 2, 'second failed drain doubles scheduler backoff');
result = await backoff.tick();
assert(result.ok && result.schedulerBackoffMs === 25 && result.failureStreak === 0, 'successful drain resets scheduler back to interval');
await backoff.stop();

console.log('  audit-outbox-scheduler-unit: all checks passed');
})().catch((e) => {
	console.error('  audit-outbox-scheduler-unit: ' + ((e && e.stack) || e));
	process.exit(1);
});
NODE
)
