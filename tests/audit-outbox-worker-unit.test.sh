#!/usr/bin/env bash
# Browser-free unit tests for lib/audit-outbox-worker.js.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

(
	cd "$DIR"
	AQA_DB_PATH="$TMP/audit-outbox-worker.db" NODE_NO_WARNINGS=1 node - <<'NODE'
const worker = require('./lib/audit-outbox-worker.js');
const dbm = require('./lib/db.js');

const assert = (cond, msg) => { if (!cond) { console.error('  audit-outbox-worker-unit: ' + msg); process.exit(1); } };
const assertThrows = (fn, pattern, label) => {
	try { fn(); }
	catch (e) {
		assert(pattern.test((e && e.message) || String(e)), label);
		return;
	}
	assert(false, label);
};
const assertRejects = async (fn, pattern, label) => {
	try { await fn(); }
	catch (e) {
		assert(pattern.test((e && e.message) || String(e)), label);
		return;
	}
	assert(false, label);
};
const hash = (ch) => 'sha256:' + ch.repeat(64);
const baseTarget = Object.freeze({
	host: 'audit.example.test',
	origin: 'https://audit.example.test',
	urlHash: hash('1'),
	credentialRefHash: hash('2'),
	credentialRefConfigured: true,
	connectorConfigured: true,
});
const noisyTarget = Object.freeze({
	...baseTarget,
	url: 'https://audit.example.test/hook?token=raw-url-secret',
	tokenRef: 'aqa-secret:raw-ref-should-not-leak',
	authorization: 'Bearer should-not-leak',
});

assertThrows(
	() => worker.assertAuditOutboxWorkerConfig({ env: { WEBUI_AUDIT_SINK_TOKEN: 'plain-token' } }),
	/plaintext secret env/,
	'worker refuses plaintext audit token env',
);
assertThrows(
	() => worker.assertAuditOutboxWorkerConfig({
		env: {
			WEBUI_AUDIT_SINK: 'webhook',
			WEBUI_AUDIT_SINK_URL: 'https://audit.example.test/hook',
			WEBUI_AUDIT_SINK_TOKEN_REF: 'Bearer raw-token',
		},
	}),
	/secret reference|plaintext/,
	'worker refuses token-looking audit token ref',
);
assertThrows(
	() => worker.assertAuditOutboxWorkerConfig({
		env: {
			WEBUI_AUDIT_SINK: 'webhook',
			WEBUI_AUDIT_SINK_URL: 'https://audit.example.test/hook',
			WEBUI_AUDIT_SINK_TOKEN_REF: 'raw-token-value',
		},
	}),
	/supported secret reference/,
	'worker refuses non-reference audit token ref',
);
assertThrows(
	() => worker.assertAuditOutboxWorkerConfig({
		env: {
			WEBUI_AUDIT_SINK: 'webhook',
			WEBUI_AUDIT_SINK_URL: 'https://audit.example.test/hook',
			WEBUI_AUDIT_SINK_TOKEN_REF: 'aqa-secret://audit-webhook',
		},
	}),
	/tenant-scoped/,
	'worker refuses webhook token refs without tenant scope',
);
assertThrows(
	() => worker.assertAuditOutboxWorkerConfig({
		env: {
			WEBUI_TENANT_ID: 'tenant_a',
			WEBUI_AUDIT_SINK: 'webhook',
			WEBUI_AUDIT_SINK_URL: 'https://audit.example.test/hook',
			WEBUI_AUDIT_SINK_TOKEN_REF: 'aqa-secret://tenant_b/audit-webhook',
		},
	}),
	/tenant scope/,
	'worker refuses webhook token refs outside the configured tenant',
);
assert(worker.assertAuditOutboxWorkerConfig({
	env: {
		WEBUI_TENANT_ID: 'tenant_a',
		WEBUI_AUDIT_SINK: 'webhook',
		WEBUI_AUDIT_SINK_URL: 'https://audit.example.test/hook',
		WEBUI_AUDIT_SINK_TOKEN_REF: 'aqa-secret://tenant_a/audit-webhook',
	},
}).ok, 'worker accepts webhook config with tenant-scoped secret reference metadata');

(async () => {
const db = dbm.openDb();
try {
	const save = (rec) => dbm.saveWebuiAuditOutbox(db, {
		at: '2030-01-01T00:00:00.000Z',
		tenantId: 'tenant_a',
		jobId: 'job-a',
		sinkMode: 'webhook',
		status: 'pending',
		payloadBytes: 64,
		target: baseTarget,
		...rec,
	});

	save({
		auditId: 1,
		sinkId: 'webhook:due',
		payloadHash: hash('a'),
		target: noisyTarget,
	});
	save({
		auditId: 2,
		sinkId: 'webhook:not-due',
		status: 'failed',
		attempts: 1,
		nextAttemptAt: '2030-01-01T00:10:00.000Z',
		payloadHash: hash('b'),
	});
	save({
		auditId: 3,
		sinkId: 'webhook:delivered',
		status: 'delivered',
		payloadHash: hash('c'),
	});
	save({
		auditId: 4,
		sinkId: 'webhook:dead',
		status: 'dead-letter',
		payloadHash: hash('d'),
	});
	save({
		auditId: 5,
		tenantId: 'tenant_b',
		sinkId: 'webhook:other-tenant',
		payloadHash: hash('e'),
	});

	const connectorCalls = [];
	let summary = await worker.drainAuditOutbox(db, {
		env: {},
		tenantId: 'tenant_a',
		now: '2030-01-01T00:00:00.000Z',
		connector: {
			deliverAuditOutbox: async (envelope, context) => {
				connectorCalls.push({ envelope, context });
				return { ok: true, connectorId: 'mock-local' };
			},
		},
	});
	assert(summary.ok && summary.checked === 1 && summary.delivered === 1, 'worker selects only due pending/failed rows for the requested tenant');
	assert(connectorCalls.length === 1 && connectorCalls[0].context.auditId === 1, 'worker delivers through connector interface only');
	const envelope = connectorCalls[0].envelope;
	assert(envelope.kind === 'webui-audit-outbox' && envelope.payload.hash === hash('a'), 'connector envelope carries audit outbox hash metadata');
	assert(envelope.payload.body === null && envelope.payload.redacted === true, 'connector envelope never carries raw audit payload');
	assert(envelope.sink.target.host === 'audit.example.test' && envelope.sink.target.urlHash === hash('1'), 'connector envelope keeps safe target metadata');
	assert(!('url' in envelope.sink.target) && !('tokenRef' in envelope.sink.target) && !('authorization' in envelope.sink.target), 'connector envelope strips raw target/token fields');
	for (const raw of ['raw-url-secret', 'raw-ref-should-not-leak', 'should-not-leak']) {
		assert(!JSON.stringify(connectorCalls).includes(raw), `connector envelope must not expose ${raw}`);
	}
	assert(dbm.listWebuiAuditOutbox(db, { auditId: 1 })[0].status === 'delivered', 'delivered row is marked delivered');

	summary = await worker.drainAuditOutbox(db, {
		env: {},
		tenantId: 'tenant_a',
		now: '2030-01-01T00:05:00.000Z',
		connector: {
			deliverAuditOutbox: async () => {
				throw new Error('not-due row should not be selected');
			},
		},
	});
	assert(summary.checked === 0 && summary.delivered === 0, 'worker does not drain failed rows before nextAttemptAt');

	save({
		auditId: 10,
		sinkId: 'webhook:retry',
		payloadHash: hash('f'),
	});
	summary = await worker.drainAuditOutbox(db, {
		env: {},
		tenantId: 'tenant_a',
		now: '2030-01-01T00:01:00.000Z',
		baseDelayMs: 180000,
		maxAttempts: 3,
		connector: {
			deliverAuditOutbox: async () => {
				const err = new Error('upstream 503 token=raw-secret');
				err.statusCode = 503;
				throw err;
			},
		},
	});
	const retryRow = dbm.listWebuiAuditOutbox(db, { auditId: 10 })[0];
	assert(summary.ok && summary.failed === 1 && retryRow.status === 'failed', 'transient server failure remains retryable');
	assert(retryRow.attempts === 1 && retryRow.lastErrorClass === 'server', 'transient failure increments attempts and records class');
	assert(retryRow.nextAttemptAt === '2030-01-01T00:04:00.000Z', 'retry backoff is deterministic');
	assert(!String(retryRow.lastError).includes('raw-secret'), 'retry error is redacted before storage');

	save({
		auditId: 11,
		sinkId: 'webhook:auth',
		payloadHash: hash('9'),
	});
	summary = await worker.drainAuditOutbox(db, {
		env: {},
		tenantId: 'tenant_a',
		now: '2030-01-01T00:02:00.000Z',
		connector: {
			deliverAuditOutbox: async () => ({ ok: false, statusCode: 401, error: 'unauthorized token=bad' }),
		},
	});
	const authRow = dbm.listWebuiAuditOutbox(db, { auditId: 11 })[0];
	assert(!summary.ok && summary.deadLettered === 1 && authRow.status === 'dead-letter', 'permanent auth failure goes dead-letter');
	assert(authRow.lastErrorClass === 'auth' && authRow.nextAttemptAt === null && authRow.deadLetterAt === '2030-01-01T00:02:00.000Z', 'dead-letter records permanent failure metadata');
	assert(!String(authRow.lastError).includes('token=bad'), 'permanent failure error is redacted');

	save({
		auditId: 12,
		sinkId: 'webhook:max-attempts',
		status: 'failed',
		attempts: 2,
		nextAttemptAt: '2030-01-01T00:00:00.000Z',
		payloadHash: hash('8'),
	});
	summary = await worker.drainAuditOutbox(db, {
		env: {},
		tenantId: 'tenant_a',
		now: '2030-01-01T00:03:00.000Z',
		maxAttempts: 3,
		connector: {
			deliverAuditOutbox: async () => {
				const err = new Error('still down');
				err.statusCode = 503;
				throw err;
			},
		},
	});
	const maxRow = dbm.listWebuiAuditOutbox(db, { auditId: 12 })[0];
	assert(!summary.ok && maxRow.status === 'dead-letter' && maxRow.attempts === 3, 'retryable failure dead-letters when max attempts is reached');
	assert(maxRow.lastErrorClass === 'server' && maxRow.nextAttemptAt === null, 'max-attempt dead-letter keeps failure classification without scheduling another retry');

	save({
		auditId: 13,
		sinkId: 'webhook:missing-connector',
		payloadHash: hash('7'),
	});
	summary = await worker.drainAuditOutbox(db, {
		env: {},
		tenantId: 'tenant_a',
		now: '2030-01-01T00:03:30.000Z',
		baseDelayMs: 60000,
		maxAttempts: 3,
	});
	const missingConnectorRow = dbm.listWebuiAuditOutbox(db, { auditId: 13 })[0];
	assert(summary.ok && summary.failed === 1 && missingConnectorRow.status === 'failed', 'missing connector fails closed into retry state');
	assert(missingConnectorRow.lastErrorClass === 'connector-missing' && missingConnectorRow.nextAttemptAt === '2030-01-01T00:04:30.000Z', 'missing connector is classified and backoff scheduled');

	save({
		auditId: 14,
		sinkId: 'webhook:config-refusal',
		payloadHash: hash('6'),
	});
	const beforeRefusal = dbm.listWebuiAuditOutbox(db, { auditId: 14 })[0];
	await assertRejects(
		() => worker.drainAuditOutbox(db, {
			env: { WEBUI_AUDIT_OUTBOX_TOKEN: 'plain-worker-token' },
			tenantId: 'tenant_a',
			now: '2030-01-01T00:06:00.000Z',
			connector: { deliverAuditOutbox: async () => ({ ok: true }) },
		}),
		/plaintext secret env/,
		'worker refuses plaintext outbox env before delivery',
	);
	const afterRefusal = dbm.listWebuiAuditOutbox(db, { auditId: 14 })[0];
	assert(afterRefusal.status === beforeRefusal.status && afterRefusal.attempts === beforeRefusal.attempts, 'plaintext env refusal does not mutate outbox rows');

	save({
		auditId: 16,
		sinkId: 'webhook:tenant-refusal',
		payloadHash: hash('4'),
	});
	const beforeTenantRefusal = dbm.listWebuiAuditOutbox(db, { auditId: 16 })[0];
	let tenantRefusalDelivered = false;
	await assertRejects(
		() => worker.drainAuditOutbox(db, {
			env: { WEBUI_AUDIT_OUTBOX_TOKEN_REF: 'aqa-secret://tenant_b/audit-webhook' },
			tenantId: 'tenant_a',
			now: '2030-01-01T00:06:30.000Z',
			connector: { deliverAuditOutbox: async () => { tenantRefusalDelivered = true; return { ok: true }; } },
		}),
		/tenant scope/,
		'worker refuses outbox token refs outside the tenant before delivery',
	);
	const afterTenantRefusal = dbm.listWebuiAuditOutbox(db, { auditId: 16 })[0];
	assert(tenantRefusalDelivered === false, 'tenant-ref refusal does not call the connector');
	assert(afterTenantRefusal.status === beforeTenantRefusal.status && afterTenantRefusal.attempts === beforeTenantRefusal.attempts, 'tenant-ref refusal does not mutate outbox rows');

	const singleWorker = worker.createAuditOutboxDrainWorker({
		env: {},
		tenantId: 'tenant_c',
		connector: { deliverAuditOutbox: async () => ({ ok: true }) },
	});
	save({
		auditId: 15,
		tenantId: 'tenant_c',
		sinkId: 'webhook:run-once',
		payloadHash: hash('5'),
	});
	summary = await singleWorker.runOnce(db, { now: '2030-01-01T00:07:00.000Z' });
	assert(summary.delivered === 1 && dbm.listWebuiAuditOutbox(db, { auditId: 15 })[0].status === 'delivered', 'worker runOnce drains with constructor defaults');
} finally {
	dbm.closeDb(db);
}

console.log('  audit-outbox-worker-unit: all checks passed');
})().catch((e) => {
	console.error('  audit-outbox-worker-unit: ' + ((e && e.stack) || e));
	process.exit(1);
});
NODE
)
