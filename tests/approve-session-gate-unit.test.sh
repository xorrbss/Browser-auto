#!/usr/bin/env bash
# Browser-free unit tests for the strict approve/confirm session + same-origin gate.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module - <<'NODE'
import { issueSessionIfNeeded, approveGate } from './webui/session.js';

const assert = (cond, msg) => { if (!cond) { console.error('  approve-session-gate-unit: ' + msg); process.exit(1); } };
const allowed = new Set(['127.0.0.1:4310', 'localhost:4310']);
const sendJson = (res, code, obj) => { res.code = code; res.body = obj; };

let req = { headers: {} };
let res = {};
assert(approveGate(req, res, allowed, sendJson) === true && res.code === 403, 'absent origin/referer is blocked');

req = { headers: { origin: 'http://127.0.0.1:4310' } };
res = {};
assert(approveGate(req, res, allowed, sendJson) === true && res.code === 401, 'same-origin without session is blocked');

const pageReq = { headers: {} };
const pageRes = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
issueSessionIfNeeded(pageReq, pageRes);
const cookie = pageRes.headers['Set-Cookie'].split(';')[0];

req = { headers: { origin: 'http://127.0.0.1:4310', cookie } };
res = {};
assert(approveGate(req, res, allowed, sendJson) === false, 'same-origin with issued session is allowed');

req = { headers: { referer: 'http://localhost:4310/', cookie } };
res = {};
assert(approveGate(req, res, allowed, sendJson) === false, 'same-host referer with session is allowed');

req = { headers: { origin: 'http://evil.test', cookie } };
res = {};
assert(approveGate(req, res, allowed, sendJson) === true && res.code === 403, 'foreign origin is blocked');

console.log('  approve-session-gate-unit: all checks passed');
NODE
)
