// Durable CommandPlan routes for the NL RPA control plane.
//
// The model may classify text, but live browser work is still deterministic and routed through
// existing drivers. Irreversible approve actions are sealed by server-computed plan hash,
// reviewed target-set hash, dry-run result, and explicit human confirmation.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { classifyIntent, runQuery, runRecordsQuery } from './agent.js';
import { PROBE_ROOT } from './spawn.js';
import { listUrlFor, titlesFor } from './routes-approve.js';
import { resolveAction } from '../approve/guards.mjs';

const require = createRequire(import.meta.url);
const dbm = require('../lib/db.js');

const NAME_RE = /^[A-Za-z0-9_-]+$/;
const ACTOR = 'local-operator';
const READ_ACTIONS = new Set(['query', 'sync', 'enrich', 'summarize']);

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') {
		const out = {};
		for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
		return out;
	}
	return typeof value === 'string' ? value.normalize('NFC') : value;
}

export function hashObject(value) {
	return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`;
}

// Hash ONLY the stable identity of the review: drop reviewedAt AND the per-target volatile fields
// (fetchedAt/status/source). A benign re-sync bumps fetched_at on every row even when the content is
// unchanged (lib/db.js upserts set fetched_at=excluded.fetched_at unconditionally); folding that into
// the hash would make verifyTargetSet reject an already-reviewed set on confirm. titleHash/summaryHash
// already pin what is actually being approved, so content changes are still caught.
function hashTargetSet(targetSet) {
	const { reviewedAt, targets, ...stable } = targetSet;
	const stableTargets = (targets || []).map((t) => ({ key: t.key, titleHash: t.titleHash, summaryHash: t.summaryHash }));
	return hashObject({ ...stable, targets: stableTargets });
}

function newPlanId() {
	const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
	return `cmd_${stamp}_${crypto.randomBytes(4).toString('hex')}`;
}

function recipePath(system) {
	return path.join(PROBE_ROOT, 'recipes', `${system}.json`);
}

function statePath(system) {
	return path.join(PROBE_ROOT, 'approve', `${system}.pw-state.json`);
}

function readRecipe(system) {
	try { return JSON.parse(fs.readFileSync(recipePath(system), 'utf8')); }
	catch { return null; }
}

function actionInfo(system, action) {
	if (READ_ACTIONS.has(action)) return { ok: true, hash: null, actionBlock: null };
	const recipe = readRecipe(system);
	if (!recipe) return { ok: false, reason: 'recipe_missing', detail: `recipes/${system}.json is missing` };
	const r = resolveAction(recipe, action);
	if (!r.ok) return { ok: false, reason: 'action_unavailable', detail: r.reason };
	return { ok: true, recipe, actionBlock: r.action, hash: hashObject({ action, block: r.action }) };
}

function publicPlan(row) {
	if (!row) return null;
	return {
		...(row.plan || {}),
		id: row.id,
		status: row.status,
		hash: row.planHash,
		planHash: row.planHash,
		targetSetHash: row.targetSetHash,
		targetSet: row.targets,
		targets: row.targets && Array.isArray(row.targets.targets) ? row.targets.targets : [],
		targetCount: row.targets && Array.isArray(row.targets.targets) ? row.targets.targets.length : 0,
		dryRun: row.dryRun,
		confirmation: row.confirmation,
		jobId: row.jobId,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

function dbCall(fn) {
	const db = dbm.openDb();
	try { return fn(db); }
	finally { dbm.closeDb(db); }
}

function event(plan, type, status, data = {}, reason = null, jobId = null) {
	dbCall((db) => dbm.appendCommandEvent(db, {
		plan_id: plan.id,
		actor: plan.actor || ACTOR,
		type,
		status,
		reason,
		job_id: jobId,
		plan_hash: plan.planHash || plan.hash,
		target_set_hash: plan.targetSetHash,
		data,
	}));
}

function reject(res, code, plan, reason, message, extra = {}) {
	if (plan) event(plan, 'gate_refused', 'refused', extra, reason);
	res._sendJson(code, { error: message, reason, ...extra });
	return true;
}

function normalizeAction(body, intent) {
	const explicit = body.action ? String(body.action).trim() : '';
	if (explicit) return explicit;
	const a = intent && intent.action;
	if (a === 'review' || a === 'approve') return 'approve';
	if (a === 'summarize') return 'enrich';
	if (a === 'sync' || a === 'query') return a;
	return /approve|approval|review|confirm|결재|승인|검토|확정/i.test(String(body.text || '')) ? 'approve' : 'query';
}

async function createPlan(body) {
	const text = String(body.text || body.sourceText || '').trim();
	const explicitAction = body.action ? String(body.action).trim() : '';
	const intent = explicitAction ? { action: explicitAction, filter: body.filter || {} } : await classifyIntent(text || 'query');
	const action = normalizeAction(body, intent);
	const system = String(body.system || body.app || 'hiworks').trim();
	if (!NAME_RE.test(system)) return { error: 'invalid system name', code: 400 };
	if (!NAME_RE.test(action)) return { error: 'invalid action name', code: 400 };
	const riskClass = READ_ACTIONS.has(action) ? 'read' : 'irreversible';
	const requirements = riskClass === 'irreversible'
		? { targetReview: true, dryRun: true, humanConfirm: true, sessionGate: true, audit: true }
		: { targetReview: false, dryRun: false, humanConfirm: false, sessionGate: false, audit: true };
	const ai = actionInfo(system, action);
	const refusal = ai.ok ? null : { reason: ai.reason, detail: ai.detail };
	const id = newPlanId();
	const filter = body.filter && typeof body.filter === 'object' ? body.filter : (intent.filter || {});
	const targetQuery = {
		source: riskClass === 'irreversible' ? 'approvals-or-records' : action === 'query' ? 'db-query' : 'driver',
		system,
		filter,
		limit: Math.min(parseInt(filter.limit, 10) || 20, 500),
	};
	const planCore = {
		schemaVersion: 1,
		id,
		actor: ACTOR,
		sourceText: text,
		intent: action === 'approve' ? 'prepare_action' : action,
		system,
		action,
		riskClass,
		mode: riskClass === 'irreversible' ? 'reviewed' : 'read',
		filter,
		targetQuery,
		requirements,
		recipeActionHash: ai.hash,
		refusal,
	};
	const planHash = hashObject(planCore);
	const row = dbCall((db) => {
		const created = dbm.createCommandPlan(db, {
			id,
			actor: ACTOR,
			source_text: text,
			status: refusal ? 'refused' : 'planned',
			risk_class: riskClass,
			system,
			action,
			plan_hash: planHash,
			plan: planCore,
		});
		dbm.appendCommandEvent(db, {
			plan_id: id,
			actor: ACTOR,
			type: refusal ? 'plan_refused' : 'plan_created',
			status: created.status,
			reason: refusal && refusal.reason,
			plan_hash: planHash,
			data: { action, system, riskClass, refusal },
		});
		return created;
	});
	return { plan: publicPlan(row), refusal };
}

function loadPlan(id) {
	return dbCall((db) => dbm.getCommandPlan(db, id));
}

function assertPlanHash(res, plan, supplied) {
	if (!supplied) {
		reject(res, 409, plan, 'missing_plan_hash', 'plan hash is required', { expectedHash: plan.planHash });
		return false;
	}
	if (supplied === plan.planHash) return true;
	reject(res, 409, plan, 'hash_mismatch', 'plan hash mismatch', { expectedHash: plan.planHash, actualHash: supplied });
	return false;
}

// Targets are editable / a dry-run may (re)start in exactly the same lifecycle states: pre-confirm,
// not yet confirmed. One predicate is the single source of truth for both gates so they can't drift.
function canEditTargets(plan) {
	return ['planned', 'dry_failed', 'dry_running', 'awaiting_confirmation'].includes(plan.status) && !plan.confirmation;
}
const canRunDryRun = canEditTargets;

function buildTargetSet(plan, targetKeys) {
	const keys = [...new Set((targetKeys || []).map((x) => String(x || '').trim()).filter(Boolean))];
	if (!keys.length) return { ok: false, reason: 'target_review_required', error: 'target review requires at least one target' };
	// titleField follows the plan's ACTUAL action (not a hardcoded 'approve'), so a non-approve effectful
	// action that declares its own titleField can still bind a content title; READ/unknown actions fall
	// back to 'title'. Recipe read (fs) only — does not need the DB handle.
	const ai = plan.system && plan.action ? actionInfo(plan.system, plan.action) : null;
	const titleField = (ai && ai.actionBlock && ai.actionBlock.titleField) || 'title';
	const targets = [];
	const missing = [];
	const db = dbm.openDb();
	try {
		const titles = titlesFor(plan.system, keys, titleField, db); // reuse this handle (no second openDb)
		for (const key of keys) {
			const ap = dbm.getApproval(db, key);
			const rec = dbm.getRecord(db, plan.system, key);
			const title = titles[key];
			if (!title) { missing.push(key); continue; }
			const summary = ap ? ap.summary : rec ? rec.summary : null;
			const fetchedAt = ap ? ap.fetched_at : rec ? rec.fetched_at : null;
			targets.push({
				key,
				title,
				summary: summary || '',
				status: ap ? ap.status : rec ? rec.status : null,
				fetchedAt,
				source: ap ? 'approvals' : rec ? 'records' : 'title-lookup',
				titleHash: hashObject(title),
				summaryHash: hashObject(summary || ''),
			});
		}
	} finally {
		dbm.closeDb(db);
	}
	if (missing.length) return { ok: false, reason: 'target_missing_title', error: 'target title/content binding missing', missing };
	const targetSet = {
		schemaVersion: 1,
		planId: plan.id,
		system: plan.system,
		action: plan.action,
		reviewed: true,
		reviewedAt: new Date().toISOString(),
		keyField: 'doc_id',
		targets: targets.sort((a, b) => a.key.localeCompare(b.key)),
	};
	return { ok: true, targetSet, targetSetHash: hashTargetSet(targetSet) };
}

function saveTargets(plan, targetKeys) {
	if (!canEditTargets(plan)) return { ok: false, reason: plan.confirmation ? 'already_confirmed' : 'invalid_state', error: 'target review is not editable in the current plan state', status: plan.status };
	const built = buildTargetSet(plan, targetKeys);
	if (!built.ok) return built;
	const changed = plan.targetSetHash && plan.targetSetHash !== built.targetSetHash;
	const row = dbCall((db) => {
		const patch = {
			target_set_hash: built.targetSetHash,
			target_json: built.targetSet,
			status: changed ? 'planned' : plan.status,
		};
		if (changed) {
			patch.dry_run_json = null;
			patch.confirmation_json = null;
			patch.job_id = null;
		}
		const updated = dbm.updateCommandPlan(db, plan.id, patch);
		dbm.appendCommandEvent(db, {
			plan_id: plan.id,
			actor: ACTOR,
			type: 'targets_reviewed',
			status: 'ok',
			plan_hash: plan.planHash,
			target_set_hash: built.targetSetHash,
			data: { targetCount: built.targetSet.targets.length, invalidatedDryRun: changed },
		});
		return updated;
	});
	return { ok: true, plan: row, targetSet: built.targetSet, targetSetHash: built.targetSetHash };
}

function verifyTargetSet(plan) {
	if (!plan.targets || !Array.isArray(plan.targets.targets) || !plan.targetSetHash) {
		return { ok: false, reason: 'target_review_required', error: 'target review is required before dry-run' };
	}
	const fresh = buildTargetSet(plan, plan.targets.targets.map((t) => t.key));
	if (!fresh.ok) return fresh;
	if (fresh.targetSetHash !== plan.targetSetHash) {
		return {
			ok: false,
			reason: 'target_review_mismatch',
			error: 'target review mismatch',
			expectedTargetSetHash: plan.targetSetHash,
			actualTargetSetHash: fresh.targetSetHash,
		};
	}
	return { ok: true, targetSet: plan.targets, targetSetHash: plan.targetSetHash };
}

function verifyRecipe(plan) {
	const ai = actionInfo(plan.system, plan.action);
	if (!ai.ok) return { ok: false, reason: ai.reason, error: ai.detail };
	const want = plan.plan && plan.plan.recipeActionHash;
	if (want && ai.hash !== want) return { ok: false, reason: 'hash_mismatch', error: 'recipe action changed', expectedHash: want, actualHash: ai.hash };
	return { ok: true, actionBlock: ai.actionBlock };
}

function stageApproveTargets(plan) {
	const file = path.join(PROBE_ROOT, 'data', `.approve-targets-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`);
	const items = plan.targets.targets.map((t) => ({ doc_id: t.key, title: t.title }));
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(items), { mode: 0o600 });
	return file;
}

function approveArgs(plan, { live }) {
	const listUrl = listUrlFor(plan.system);
	if (!listUrl) return { ok: false, reason: 'list_url_missing', error: 'no pending-list URL configured' };
	if (!fs.existsSync(recipePath(plan.system))) return { ok: false, reason: 'recipe_missing', error: `recipes/${plan.system}.json is missing` };
	if (!fs.existsSync(statePath(plan.system))) return { ok: false, reason: 'login_missing', error: `approve/${plan.system}.pw-state.json is missing` };
	const targetsFile = stageApproveTargets(plan);
	const args = ['--recipe', `recipes/${plan.system}.json`, '--state', `approve/${plan.system}.pw-state.json`, '--list-url', listUrl, '--targets-file', targetsFile, '--reviewed'];
	if (live) args.push('--live', '--max', String(plan.targets.targets.length));
	if (plan.action !== 'approve') args.push('--action', plan.action);
	return { ok: true, args };
}

function dryRunPassed(plan) {
	const dryRun = plan && plan.dryRun;
	const result = dryRun && dryRun.result;
	return !!(
		dryRun &&
		dryRun.status === 'passed' &&
		dryRun.planHash === plan.planHash &&
		dryRun.targetSetHash === plan.targetSetHash &&
		result &&
		Array.isArray(result.results) &&
		result.results.length > 0 &&
		result.results.every((r) => r.status === 'dry-ok')
	);
}

function storeJobCompletion(planId, stage, job, binding = {}) {
	const row = loadPlan(planId);
	if (!row) return;
	if (stage === 'dry-run') {
		const stale = !!(binding.targetSetHash && row.targetSetHash && binding.targetSetHash !== row.targetSetHash);
		const pass = !stale && job.status === 'done' && job.result && Array.isArray(job.result.results) && job.result.results.length > 0 && job.result.results.every((r) => r.status === 'dry-ok');
		const dry = {
			status: stale ? 'stale' : pass ? 'passed' : 'failed',
			jobId: job.id,
			result: job.result,
			exitCode: job.exitCode,
			hash: hashObject(job.result || {}),
			planHash: binding.planHash || row.planHash,
			targetSetHash: binding.targetSetHash || row.targetSetHash,
		};
		dbCall((db) => {
			dbm.updateCommandPlan(db, planId, { status: pass ? 'awaiting_confirmation' : stale ? 'planned' : 'dry_failed', dry_run_json: dry, job_id: job.id });
			dbm.appendCommandEvent(db, {
				plan_id: planId,
				actor: ACTOR,
				type: 'dry_run_completed',
				status: dry.status,
				reason: pass ? null : stale ? 'target_review_mismatch' : 'dry_run_failed',
				job_id: job.id,
				plan_hash: row.planHash,
				target_set_hash: binding.targetSetHash || row.targetSetHash,
				data: { result: job.result, exitCode: job.exitCode },
			});
		});
		return;
	}
	// A LIVE run is 'succeeded' ONLY if it actually approved >=1 target and nothing failed. All-skipped
	// (every guard tripped) or a kill-switch abort (one skipped result, then the leaf breaks) approves
	// NOTHING and must be recorded as failed — otherwise the audit trail reports a no-op/abort as success.
	const results = job.status === 'done' && job.result && Array.isArray(job.result.results) ? job.result.results : null;
	const approvedN = results ? results.filter((r) => r.status === 'approved').length : 0;
	const ok = !!(results && results.length > 0 && approvedN > 0 && results.every((r) => r.status === 'approved' || r.status === 'skipped'));
	dbCall((db) => {
		dbm.updateCommandPlan(db, planId, { status: ok ? 'succeeded' : 'failed', job_id: job.id });
		dbm.appendCommandEvent(db, {
			plan_id: planId,
			actor: ACTOR,
			type: 'live_completed',
			status: ok ? 'succeeded' : 'failed',
			reason: ok ? null : (results && results.length > 0 && approvedN === 0 && results.every((r) => r.status === 'skipped') ? 'live_no_approval' : 'live_failed'),
			job_id: job.id,
			plan_hash: row.planHash,
			target_set_hash: row.targetSetHash,
			data: { result: job.result, exitCode: job.exitCode },
		});
	});
}

function enqueueApprovePlan(plan, deps, { live }) {
	const argResult = approveArgs(plan, { live });
	if (!argResult.ok) return argResult;
	const binding = { planHash: plan.planHash, targetSetHash: plan.targetSetHash };
	const job = deps.enqueue({
		kind: 'approve',
		label: `${live ? 'LIVE' : 'DRY'} plan ${plan.id} ${plan.system} (${plan.targets.targets.length})`,
		meta: { commandId: plan.id, planId: plan.id, system: plan.system, action: plan.action, riskClass: plan.riskClass, dryRun: !live, targetCount: plan.targets.targets.length },
		spawnFn: () => deps.nodeLeaf('approve/approve-run.mjs', argResult.args),
		onFinish: (j) => storeJobCompletion(plan.id, live ? 'live' : 'dry-run', j, binding),
	});
	return { ok: true, job };
}

function runReadPlan(plan, deps) {
	if (plan.action === 'query') {
		const filter = plan.plan.filter || {};
		const result = { approvals: runQuery(filter), systems: runRecordsQuery(filter) };
		const summary = { status: 'succeeded', result, hash: hashObject(result) };
		const row = dbCall((db) => {
			dbm.updateCommandPlan(db, plan.id, { status: 'succeeded', dry_run_json: summary });
			dbm.appendCommandEvent(db, { plan_id: plan.id, actor: ACTOR, type: 'read_completed', status: 'succeeded', plan_hash: plan.planHash, data: summary });
			return dbm.getCommandPlan(db, plan.id);
		});
		return { ok: true, plan: row, result };
	}
	const args = ['--system', plan.system];
	const script = plan.action === 'sync' ? 'bin/sync-system.sh' : 'bin/enrich-system.sh';
	const job = deps.enqueue({
		kind: plan.action === 'sync' ? 'sync' : 'summarize',
		label: `${plan.action} plan ${plan.id} ${plan.system}`,
		meta: { commandId: plan.id, planId: plan.id, system: plan.system, action: plan.action, riskClass: 'read' },
		spawnFn: () => deps.gitBash(script, args),
		onFinish: (j) => {
			const done = j.status === 'done';
			dbCall((db) => {
				dbm.updateCommandPlan(db, plan.id, { status: done ? 'succeeded' : 'failed', job_id: j.id, dry_run_json: { status: done ? 'succeeded' : 'failed', jobId: j.id, exitCode: j.exitCode, result: j.result } });
				dbm.appendCommandEvent(db, { plan_id: plan.id, actor: ACTOR, type: 'read_job_completed', status: done ? 'succeeded' : 'failed', reason: done ? null : 'job_failed', job_id: j.id, plan_hash: plan.planHash, data: { exitCode: j.exitCode, result: j.result } });
			});
		},
	});
	dbCall((db) => {
		dbm.updateCommandPlan(db, plan.id, { status: 'queued', job_id: job.id });
		dbm.appendCommandEvent(db, { plan_id: plan.id, actor: ACTOR, type: 'read_job_queued', status: 'queued', job_id: job.id, plan_hash: plan.planHash });
	});
	return { ok: true, job };
}

function parsePlanPath(p) {
	let m = /^\/api\/agent\/plans?\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(p);
	if (!m) return null;
	try { return { id: decodeURIComponent(m[1]), op: m[2] || 'get', op2: m[3] || '' }; }
	catch { return { bad: true }; }
}

export async function commandPlanPost(p, bodyJson, res, deps) {
	res._sendJson = deps.sendJson.bind(null, res);
	if (p === '/api/agent/plan' || p === '/api/agent/plans') {
		const r = await createPlan(bodyJson);
		if (r.error) { deps.sendJson(res, r.code || 400, { error: r.error }); return true; }
		deps.sendJson(res, 200, r);
		return true;
	}
	const parsed = parsePlanPath(p);
	if (!parsed) return false;
	if (parsed.bad) { deps.sendJson(res, 400, { error: 'bad plan id' }); return true; }
	const plan = loadPlan(parsed.id);
	if (!plan) { deps.sendJson(res, 404, { error: 'no such plan' }); return true; }
	// Trailing path segments must not change which op runs. The server.js effectful-route gate keys on the
	// path SHAPE (…/confirm[/…]); the ONLY op that takes a sub-segment is targets/review. Any other op2 is an
	// unknown shape — refuse here so /confirm/<x> can never fall through to the LIVE approve below (the gate
	// and route now agree on path shape; trailing-segment gate bypass closed).
	if (parsed.op2 && !(parsed.op === 'targets' && parsed.op2 === 'review')) {
		deps.sendJson(res, 404, { error: 'no such plan route' });
		return true;
	}
	if (parsed.op === 'targets' && (parsed.op2 === 'review' || !parsed.op2)) {
		if (!assertPlanHash(res, plan, bodyJson.planHash || bodyJson.hash)) return true;
		const saved = saveTargets(plan, bodyJson.targetKeys || bodyJson.targets || bodyJson.docs);
		if (!saved.ok) return reject(res, 409, plan, saved.reason, saved.error, saved);
		deps.sendJson(res, 200, { ok: true, plan: publicPlan(saved.plan), targetSetHash: saved.targetSetHash, targetCount: saved.targetSet.targets.length });
		return true;
	}
	if (parsed.op === 'dry-run') {
		if (!assertPlanHash(res, plan, bodyJson.planHash || bodyJson.hash)) return true;
		if (!canRunDryRun(plan)) return reject(res, 409, plan, plan.confirmation ? 'already_confirmed' : 'invalid_state', 'dry-run is not allowed in the current plan state', { status: plan.status });
		let working = plan;
		if (Array.isArray(bodyJson.targetKeys) || Array.isArray(bodyJson.docs) || Array.isArray(bodyJson.targets)) {
			const saved = saveTargets(plan, bodyJson.targetKeys || bodyJson.targets || bodyJson.docs);
			if (!saved.ok) return reject(res, 409, plan, saved.reason, saved.error, saved);
			working = saved.plan;
		}
		if (working.riskClass === 'read') {
			const r = runReadPlan(working, deps);
			if (!r.ok) return reject(res, 409, working, r.reason, r.error, r);
			deps.sendJson(res, r.job ? 202 : 200, { plan: publicPlan(r.plan || loadPlan(working.id)), job: r.job, result: r.result });
			return true;
		}
		const vr = verifyRecipe(working);
		if (!vr.ok) return reject(res, 409, working, vr.reason, vr.error, vr);
		const vt = verifyTargetSet(working);
		if (!vt.ok) return reject(res, 409, working, vt.reason, vt.error, vt);
		const enq = enqueueApprovePlan(working, deps, { live: false });
		if (!enq.ok) return reject(res, 409, working, enq.reason, enq.error, enq);
		const row = dbCall((db) => {
			dbm.updateCommandPlan(db, working.id, { status: 'dry_running', job_id: enq.job.id });
			dbm.appendCommandEvent(db, { plan_id: working.id, actor: ACTOR, type: 'dry_run_queued', status: 'queued', job_id: enq.job.id, plan_hash: working.planHash, target_set_hash: working.targetSetHash, data: { targetCount: working.targets.targets.length } });
			return dbm.getCommandPlan(db, working.id);
		});
		deps.sendJson(res, 202, { plan: publicPlan(row), job: enq.job, dryRun: { status: 'running', jobId: enq.job.id } });
		return true;
	}
	if (parsed.op === 'confirm') {
		if (!assertPlanHash(res, plan, bodyJson.planHash || bodyJson.hash)) return true;
		if (plan.confirmation) return reject(res, 409, plan, 'already_confirmed', 'plan has already been confirmed', { confirmation: plan.confirmation });
		if (bodyJson.confirm !== true && bodyJson.humanConfirm !== true) return reject(res, 409, plan, 'missing_human_confirmation', 'human confirmation required');
		if (!bodyJson.targetSetHash) {
			return reject(res, 409, plan, 'missing_target_set_hash', 'target-set hash is required', { expectedTargetSetHash: plan.targetSetHash || null });
		}
		if (!plan.targetSetHash || bodyJson.targetSetHash !== plan.targetSetHash) {
			return reject(res, 409, plan, 'target_review_mismatch', 'target review mismatch', { expectedTargetSetHash: plan.targetSetHash, actualTargetSetHash: bodyJson.targetSetHash || null });
		}
		const vr = verifyRecipe(plan);
		if (!vr.ok) return reject(res, 409, plan, vr.reason, vr.error, vr);
		const vt = verifyTargetSet(plan);
		if (!vt.ok) return reject(res, 409, plan, vt.reason, vt.error, vt);
		if (!dryRunPassed(plan)) {
			const reason = plan.dryRun ? (plan.dryRun.targetSetHash && plan.dryRun.targetSetHash !== plan.targetSetHash ? 'dry_run_stale' : 'dry_run_failed') : 'dry_run_missing';
			return reject(res, 409, plan, reason, 'dry-run missing, stale, or failed', { dryRun: plan.dryRun });
		}
		if (plan.status !== 'awaiting_confirmation') return reject(res, 409, plan, 'invalid_state', 'plan is not awaiting confirmation', { status: plan.status });
		if (!bodyJson.dryRunHash) {
			return reject(res, 409, plan, 'missing_dry_run_hash', 'dry-run hash is required', { expectedDryRunHash: plan.dryRun.hash || null });
		}
		if (plan.dryRun.hash && bodyJson.dryRunHash !== plan.dryRun.hash) {
			return reject(res, 409, plan, 'dry_run_mismatch', 'dry-run hash mismatch', { expectedDryRunHash: plan.dryRun.hash, actualDryRunHash: bodyJson.dryRunHash });
		}
		const enq = enqueueApprovePlan(plan, deps, { live: true });
		if (!enq.ok) return reject(res, 409, plan, enq.reason, enq.error, enq);
		const confirmation = { status: 'confirmed', confirmedAt: new Date().toISOString(), actor: ACTOR, jobId: enq.job.id, dryRunHash: plan.dryRun.hash };
		const row = dbCall((db) => {
			dbm.updateCommandPlan(db, plan.id, { status: 'queued', confirmation_json: confirmation, job_id: enq.job.id });
			dbm.appendCommandEvent(db, { plan_id: plan.id, actor: ACTOR, type: 'confirmed', status: 'queued', job_id: enq.job.id, plan_hash: plan.planHash, target_set_hash: plan.targetSetHash, data: confirmation });
			return dbm.getCommandPlan(db, plan.id);
		});
		deps.sendJson(res, 202, { plan: publicPlan(row), job: enq.job, confirmation });
		return true;
	}
	return false;
}

export function recordCommandGateRefusal(p, reason, data = {}) {
	const parsed = parsePlanPath(p);
	if (!parsed || parsed.bad || parsed.op !== 'confirm') return false;
	const plan = loadPlan(parsed.id);
	if (!plan) return false;
	event(plan, 'gate_refused', 'refused', data, reason);
	return true;
}

export function commandPlanGet(p, url, res, { sendJson }) {
	if (p === '/api/agent/plans') {
		const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 100, 500);
		sendJson(res, 200, { plans: dbCall((db) => dbm.listCommandPlans(db, { limit })).map(publicPlan) });
		return true;
	}
	const parsed = parsePlanPath(p);
	if (!parsed) return false;
	if (parsed.bad) { sendJson(res, 400, { error: 'bad plan id' }); return true; }
	const plan = loadPlan(parsed.id);
	if (!plan) { sendJson(res, 404, { error: 'no such plan' }); return true; }
	if (parsed.op === 'events') {
		sendJson(res, 200, { events: dbCall((db) => dbm.listCommandEvents(db, parsed.id)) });
		return true;
	}
	if (parsed.op === 'result') {
		sendJson(res, 200, { plan: publicPlan(plan), dryRun: plan.dryRun, confirmation: plan.confirmation });
		return true;
	}
	if (parsed.op === 'get') {
		sendJson(res, 200, { plan: publicPlan(plan) });
		return true;
	}
	return false;
}
