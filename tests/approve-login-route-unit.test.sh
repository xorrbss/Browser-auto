#!/usr/bin/env bash
# Browser-free unit tests for the webui 결재-로그인 route (spawns approve/auth-pw.mjs from the UI).
# Asserts: registry-aware login coordinate resolution, glob→substring needle, and that the route
# enqueues the Playwright login leaf with the right args (loginUrl, needle, and the CANONICAL
# fixtures/auth/playwright/<app>.state.json out file — lib/engine.js playwrightAuthRel).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

( cd "$DIR" && AQA_DB_PATH="$TMP/t.db" node --input-type=module - <<'NODE'
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const db = require('./lib/db.js');
const { playwrightAuthRel } = require('./lib/engine.js');
const { loginUrlFor, successNeedle, approvePost } = await import('./webui/routes-approve.js');

const assert = (cond, msg) => { if (!cond) { console.error('  approve-login-route-unit: ' + msg); process.exit(1); } };

// glob → substring needle (auth-pw.mjs matches with String.includes, not a glob)
assert(successNeedle('**/dashboard') === '/dashboard', 'needle strips the * wildcards, keeps the literal /dashboard');
assert(successNeedle('https://x/**') === 'https://x/', 'needle strips trailing **');
assert(successNeedle('dashboard.office.hiworks.com') === 'dashboard.office.hiworks.com', 'needle keeps a bare literal');
assert(successNeedle('') === '', 'empty glob → empty needle');

// registry-aware resolution: a generic registered system with login_url/success_url resolves; unknown → null
const h = db.openDb(process.env.AQA_DB_PATH);
db.registerSystem(h, { name: 'logintest', login_url: 'https://login.example.com/app', success_url: '**/home' });
db.closeDb(h);
const coords = loginUrlFor('logintest');
assert(coords && coords.loginUrl === 'https://login.example.com/app' && coords.successUrl === '**/home', 'registry login coords resolve');
assert(loginUrlFor('no-such-system') === null, 'unknown app → null (fail-closed)');

// the route enqueues the Playwright login leaf with the resolved args
let spawned = null, code = null, body = null;
const res = {};
const sendJson = (r, c, b) => { code = c; body = b; };
const enqueue = ({ kind, label, spawnFn }) => { spawnFn(); return { id: 'job-1', kind, label }; };
const nodeLeaf = (script, args) => { spawned = { script, args }; return { on() {}, stdout: { on() {} }, stderr: { on() {} } }; };

const handled = approvePost('/api/approve/login', { app: 'logintest' }, res, { sendJson, enqueue, nodeLeaf });
assert(handled === true, 'route handled /api/approve/login');
assert(code === 202, 'route returns 202, got ' + code);
assert(spawned && spawned.script === 'approve/auth-pw.mjs', 'spawned the auth-pw leaf, got ' + (spawned && spawned.script));
assert(spawned.args[0] === 'https://login.example.com/app', 'arg0 = loginUrl');
assert(spawned.args[1] === '/home', 'arg1 = needle (glob stripped), got ' + spawned.args[1]);
assert(spawned.args[2] === playwrightAuthRel('logintest'), 'arg2 = canonical playwright state file, got ' + spawned.args[2]);

// when the server provides Git Bash, the route delegates storage policy to setup/auth.sh
let bashSpawned = null;
spawned = null; code = null; body = null;
const gitBash = (script, args) => { bashSpawned = { script, args }; return { on() {}, stdout: { on() {} }, stderr: { on() {} } }; };
approvePost('/api/approve/login', { app: 'logintest' }, res, { sendJson, enqueue, nodeLeaf, gitBash });
assert(code === 202, 'gitBash-backed route returns 202, got ' + code);
assert(bashSpawned && bashSpawned.script === 'setup/auth.sh', 'gitBash-backed route spawned setup/auth.sh');
assert(bashSpawned.args[0] === 'logintest', 'setup arg0 = app');
assert(bashSpawned.args[1] === 'https://login.example.com/app', 'setup arg1 = loginUrl');
assert(bashSpawned.args[2] === '**/home', 'setup arg2 keeps the success glob for setup/auth.sh');
assert(spawned === null, 'gitBash-backed route does not bypass setup/auth.sh with nodeLeaf');

// invalid app name and missing coordinates are refused (400), never spawned
spawned = null; code = null;
approvePost('/api/approve/login', { app: 'bad name!' }, res, { sendJson, enqueue, nodeLeaf });
assert(code === 400 && spawned === null, 'invalid app name → 400, no spawn');
spawned = null; code = null;
approvePost('/api/approve/login', { app: 'no-such-system' }, res, { sendJson, enqueue, nodeLeaf });
assert(code === 400 && spawned === null, 'unregistered app (no coords) → 400, no spawn');

console.log('  approve-login-route-unit: all checks passed');
NODE
)
