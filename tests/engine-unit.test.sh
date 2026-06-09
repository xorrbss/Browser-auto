#!/usr/bin/env bash
# Browser-free unit tests for engine resolver + DB defaults.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

(
	cd "$DIR"
	AQA_DB_PATH="$TMP/t.db" NODE_NO_WARNINGS=1 node <<'NODE'
const assert = require('node:assert/strict');
const e = require('./lib/engine.js');
const dbm = require('./lib/db.js');

assert.equal(e.normalizeEngine(undefined), 'playwright', 'missing engine defaults to playwright');
assert.equal(e.normalizeEngine(''), 'playwright', 'empty engine defaults to playwright');
assert.equal(e.DEFAULT_FLOW_ENGINE, 'agent-browser', 'missing flow.engine remains agent-browser for compatibility');
assert.equal(e.normalizeEngine('playwright'), 'playwright', 'playwright accepted');
assert.throws(() => e.normalizeEngine('selenium'), /invalid engine/, 'invalid engine rejected');
assert.equal(e.flowEngine({ name: 'old' }), 'agent-browser', 'old flow without engine is agent-browser');
assert.equal(e.flowEngine({ engine: 'playwright' }), 'playwright', 'flow engine read');
assert.throws(() => e.assertFlowEngine({ engine: 'agent-browser' }, 'playwright'), /not "playwright"/, 'engine mismatch fails closed');

const h = dbm.openDb();
dbm.registerSystem(h, { name: 'legacy', target_url: 'https://example.test/list' });
assert.equal(dbm.getSystem(h, 'legacy').engine, 'playwright', 'registered system default engine');
dbm.registerSystem(h, { name: 'pw', engine: 'playwright', target_url: 'https://example.test/list' });
assert.equal(dbm.getSystem(h, 'pw').engine, 'playwright', 'registered system stores playwright');
assert.throws(() => dbm.registerSystem(h, { name: 'bad', engine: 'selenium' }), /invalid engine/, 'DB rejects invalid engine');
dbm.registerSystem(h, { name: 'pw', label: 'PW2' });
assert.equal(dbm.getSystem(h, 'pw').engine, 'playwright', 'omitted engine preserves existing system engine');
dbm.closeDb(h);

console.log('  engine-unit: all checks passed');
NODE
)
