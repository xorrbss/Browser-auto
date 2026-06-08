#!/usr/bin/env node
// bin/shadow-eval.js — the SHADOW unattended evaluator (dev/active/phase2-guarded-approve/UNATTENDED-CRITERIA.md,
// phase P-a). Loads a deterministic policy, queries the synced 'fetched' approvals, and AUDITS the
// would-approve / would-skip / requires-live decision per doc to data/policy-shadow.jsonl — so the operator can
// soak + review what the policy WOULD do on real data. It NEVER opens a browser, NEVER clicks, NEVER approves:
// pure read + deterministic evaluate + append-only audit. NO LLM. It also REFUSES any policy whose phase is not
// 'shadow' (the live phases need the full pipeline + Gate-B + sign-off). Read-only ⇒ schedulable via
// bin/scheduled-task.sh (which refuses --live; shadow-eval has none).
//   node bin/shadow-eval.js --policy data/policies/<name>.json [--limit N] [--audit <file>] [--db <file>]
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { openDb, closeDb, listApprovals, DEFAULT_DB_PATH } = require('../lib/db.js');
const { evaluatePolicy, validatePolicy } = require('../lib/policy.js');

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d; };
const policyPath = opt('--policy');
const limit = parseInt(opt('--limit', '0'), 10) || 0;
const auditPath = opt('--audit', path.join(__dirname, '..', 'data', 'policy-shadow.jsonl'));
const dbPath = opt('--db', DEFAULT_DB_PATH);
if (!policyPath) { console.error('usage: node bin/shadow-eval.js --policy <file> [--limit N] [--audit <file>] [--db <file>]'); process.exit(2); }

let policy;
try { policy = JSON.parse(fs.readFileSync(policyPath, 'utf8')); } catch (e) { console.error('policy unreadable: ' + e.message); process.exit(2); }
const pv = validatePolicy(policy);
if (!pv.ok) { console.error('invalid policy: ' + pv.reason); process.exit(2); }
// FAIL-CLOSED: shadow-eval is read-only and ONLY runs a shadow-phase policy. The live phases (sampled /
// unattended) require the full effectful pipeline + Gate-B + operator sign-off — refuse them here.
if (policy.phase !== 'shadow') { console.error(`REFUSED: shadow-eval requires an EXPLICIT phase:"shadow" (got "${policy.phase || 'none'}") — a missing or live (sampled/unattended) phase is refused; live phases need the full pipeline + Gate-B + sign-off (fail-closed)`); process.exit(3); }

const nowYMD = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' }); // KST YYYY-MM-DD
const tick = new Date().toISOString();
fs.mkdirSync(path.dirname(auditPath), { recursive: true });
const fd = fs.openSync(auditPath, 'a');
const write = (o) => fs.writeSync(fd, JSON.stringify(o) + '\n');

const db = openDb(dbPath);
const docs = listApprovals(db, { status: 'fetched', limit: limit || undefined });
closeDb(db);

const counts = { 'would-approve': 0, 'would-skip': 0, 'requires-live': 0 };
const skipReasons = {};
const maxPerTick = policy.caps && Number.isFinite(policy.caps.maxPerTick) ? policy.caps.maxPerTick : Infinity;
let wouldApprove = 0;
for (const doc of docs) {
	const v = evaluatePolicy(doc, policy, nowYMD);
	let stage = v.stage;
	let capped = false;
	// CAP PREVIEW: a live run would stop at maxPerTick — flag the would-approves that exceed it as would-skip:cap.
	if (stage === 'would-approve') { wouldApprove++; if (wouldApprove > maxPerTick) { stage = 'would-skip'; v.reason = 'cap'; capped = true; } }
	counts[stage] = (counts[stage] || 0) + 1;
	if (stage === 'would-skip') skipReasons[v.reason] = (skipReasons[v.reason] || 0) + 1;
	write({ at: tick, policyId: policy.id, shadow: true, doc_id: doc.doc_id, stage, reason: v.reason, ...(capped ? { capped: true } : {}) });
}
write({ at: tick, policyId: policy.id, shadow: true, stage: 'tick-summary', evaluated: docs.length, counts, skipReasons, maxPerTick: maxPerTick === Infinity ? null : maxPerTick });
fs.fsyncSync(fd);
fs.closeSync(fd);

console.error(`[shadow] policy ${policy.id}: evaluated ${docs.length} — would-approve ${counts['would-approve']}, would-skip ${counts['would-skip']}, requires-live ${counts['requires-live']} (NO approval — shadow only)`);
console.log(JSON.stringify({ policyId: policy.id, evaluated: docs.length, counts, skipReasons }));
