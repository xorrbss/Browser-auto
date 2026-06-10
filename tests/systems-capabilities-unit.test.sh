#!/usr/bin/env bash
# Browser-free unit tests for system state and action capability contracts.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; rm -f "$DIR/fixtures/auth/capunit.state.json" "$DIR/approve/capunit.pw-state.json"; rm -rf "$DIR/fixtures/auth/playwright/capunit.state.json"' EXIT

( cd "$DIR" && AQA_DB_PATH="$TMP/t.db" node --input-type=module - <<'NODE'
import fs from 'node:fs';
import { createRequire } from 'node:module';

process.env.AQA_DB_PATH = process.env.AQA_DB_PATH;
const require = createRequire(import.meta.url);
const dbm = require('./lib/db.js');

fs.mkdirSync('fixtures/auth', { recursive: true });
fs.mkdirSync('fixtures/auth/playwright', { recursive: true });
fs.mkdirSync('approve', { recursive: true });
fs.writeFileSync('fixtures/auth/capunit.state.json', '{}');
fs.writeFileSync('fixtures/auth/playwright/capunit.state.json', '{}');
fs.writeFileSync('approve/capunit.pw-state.json', '{}');

const recipe = {
	collection: { name: 'Rows' },
	key: 'doc_id',
	columns: { doc_id: 'ID', title: 'Title' },
	detail: { idLabel: 'ID', fields: { dept: 'Dept' } },
	actions: {
		approve: { button: { name: 'Approve' }, decision: { name: 'Yes' }, confirm: { name: 'OK' }, success: 'leftInbox' },
		reject: { enabled: false }
	}
};

let db = dbm.openDb();
dbm.registerSystem(db, { name: 'capunit', login_url: 'https://example.test/login', success_url: '**/ok', target_url: 'https://example.test/list', recipe });
dbm.upsertRecords(db, 'capunit', [
	{ key: 'A', data: { title: 'One' }, summary: 'S' },
	{ key: 'B', data: { title: 'Two' } }
]);
dbm.closeDb(db);

const { systemState, systemActions, allActionsView } = await import('./webui/systems.js');
const assert = (cond, msg) => { if (!cond) { console.error('  systems-capabilities-unit: ' + msg); process.exit(1); } };

const st = systemState('capunit');
assert(st.system.engine === 'playwright' && st.auth.engine === 'playwright', 'system engine defaults to playwright');
assert(st.auth.state === 'ready' && st.auth.playwright === 'ready' && st.sync.enabled === true, 'playwright auth and sync enabled from fixture state + recipe');
assert(st.sync.engine === 'playwright' && st.enrich.engine === 'playwright' && st.sync.limited === false && st.enrich.limited === false, 'read drivers use the selected playwright engine');
assert(st.enrich.enabled === true && st.recordStats.total === 2 && st.recordStats.missingSummary === 1, 'enrich and record stats computed');
assert(st.approve.loginState === 'ready' && st.approve.listUrl === true, 'approve readiness includes Playwright state and list URL');

const actions = systemActions('capunit');
const byAction = Object.fromEntries(actions.map((a) => [a.action, a]));
assert(byAction.sync.enabled === true && byAction.sync.riskClass === 'read', 'sync capability exposed');
assert(byAction.enrich.enabled === true, 'enrich capability exposed');
assert(byAction.approve.enabled === true && byAction.approve.dryRunRequired === true && byAction.approve.humanConfirmRequired === true, 'approve capability gated');
assert(byAction.reject.enabled === false && byAction.reject.state === 'needs implementation', 'disabled recipe action stays disabled');
assert(allActionsView().some((a) => a.system === 'capunit' && a.action === 'approve'), 'all actions includes registered system');
assert(systemState('missing') === null && systemActions('missing') === null, 'missing system is null');

console.log('  systems-capabilities-unit: all checks passed');
NODE
)
