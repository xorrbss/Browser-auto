// webui/flows.js — flow read + the documented HUMAN edits on flow.json / values.json.
//
// PURE filesystem: no CLI and no spawn. The agent-qa CLI has NO "resolve" subcommand
// (Playwright verify refuses to drive past a needs_review step, compile refuses to emit one), so
// resolving a needs_review step is the documented human edit — pick one of the listed
// candidates and write it as the step's locator. Doing that here is NOT reimplementing CLI
// logic; it is the same hand-edit a human would make in the JSON. Real input values live in a
// gitignored flows/<name>.values.json sidecar (the flow stores {{input_N}} tokens).

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { latestTestResultsByName } from './index.js';
import { authReadinessForApp } from './auth.js';

const require = createRequire(import.meta.url);
const { flowEngine } = require('../lib/engine.js');
const { validateFlowRunPolicy } = require('../lib/flow-policy.js');
const aria = require('../lib/aria.js');

const PROBE_ROOT = path.resolve(import.meta.dirname, '..');
const FLOWS_DIR = path.join(PROBE_ROOT, 'flows');
const TESTS_DIR = path.join(PROBE_ROOT, 'tests');
const NAME_RE = /^[A-Za-z0-9_-]+$/; // also blocks path traversal in the name
const TOKEN_RE = /\{\{(input_\d+)\}\}/g;

export const validName = (name) => typeof name === 'string' && NAME_RE.test(name);

const flowPath = (name) => path.join(FLOWS_DIR, `${name}.flow.json`);
const valuesPath = (name) => path.join(FLOWS_DIR, `${name}.values.json`);
const testPath = (name) => path.join(TESTS_DIR, `${name}.test.sh`);
const snapshotPath = (name) => path.join(FLOWS_DIR, `${name}.snapshot.txt`);
const recipePath = (name) => path.join(PROBE_ROOT, 'recipes', `${name}.json`);

export const flowExists = (name) => validName(name) && existsSync(flowPath(name));

function compiledFresh(name) {
	try {
		if (!existsSync(testPath(name))) return false;
		return statSync(testPath(name)).mtimeMs >= statSync(flowPath(name)).mtimeMs;
	} catch {
		return false;
	}
}

// Distinct {{input_N}} tokens referenced by fill/type/select steps (text/val fields).
function collectTokens(flow) {
	const tokens = new Set();
	for (const s of flow.steps || []) {
		for (const field of ['text', 'val']) {
			const v = s[field];
			if (typeof v !== 'string') continue;
			TOKEN_RE.lastIndex = 0;
			let m;
			while ((m = TOKEN_RE.exec(v))) tokens.add(m[1]);
		}
	}
	return [...tokens];
}

function safeFlowEngine(flow) {
	try {
		return { engine: flowEngine(flow), engineError: null };
	} catch (e) {
		return {
			engine: String(flow?.engine || 'legacy'),
			engineError: String(e && e.message || e),
		};
	}
}

function missingTokens(tokens, values) {
	return tokens.filter((t) => !(t in values) || values[t] === '');
}

function valueStatus(tokens, values) {
	return Object.fromEntries(tokens.map((token) => {
		const present = token in values && values[token] !== '';
		return [token, { present, state: present ? 'saved' : 'missing' }];
	}));
}

async function authStatus(flow, engine) {
	if (!flow?.app || engine.engineError) return { required: !!flow?.app, ready: true, app: flow?.app || null };
	try {
		const readiness = await authReadinessForApp(flow.app);
		return {
			required: true,
			app: flow.app,
			ready: readiness.ready && readiness.state === 'ready',
			state: readiness.state,
			readiness: readiness.readiness,
			refreshNeeded: readiness.state === 'stale-auth',
			present: readiness.present,
			valid: readiness.valid,
			stale: readiness.stale,
			ageMs: readiness.ageMs,
			staleAfterMs: readiness.staleAfterMs,
			otpMfa: readiness.otpMfa,
			source: readiness.source,
			domains: readiness.domains,
		};
	} catch (e) {
		return { required: true, ready: false, app: flow.app, error: String(e?.message || e) };
	}
}

function flowPolicyStatus(flow) {
	const policy = validateFlowRunPolicy(flow, { phase: 'validate' });
	return policy.ok
		? policy
		: {
			ok: false,
			environment: flow?.environment || '',
			riskClass: flow?.riskClass || '',
			reason: policy.reason,
		};
}

async function buildScenarioStatus({ flow, steps, engine, compiled, missingValues, lastRun }) {
	const needsReview = steps.filter((s) => s.needs_review === true).length;
	const auth = await authStatus(flow, engine);
	const policy = flowPolicyStatus(flow);
	const reasons = [];
	if (engine.engineError) reasons.push(engine.engineError);
	if (!policy.ok) reasons.push(`policy: ${policy.reason}`);
	if (needsReview) reasons.push(`${needsReview} needs_review step(s)`);
	if (missingValues.length) reasons.push(`missing values: ${missingValues.join(', ')}`);
	if (auth.required && auth.refreshNeeded) reasons.push(`auth refresh needed: ${auth.state}`);
	else if (auth.required && !auth.ready) reasons.push(auth.error || `missing Playwright auth for app "${auth.app}"`);
	if (!compiled) reasons.push('compiled test is missing or older than the flow');

	let state = 'ready';
	if (engine.engineError) state = 'engine-error';
	else if (!policy.ok) state = 'policy-blocked';
	else if (needsReview) state = 'needs-review';
	else if (missingValues.length) state = 'missing-values';
	else if (auth.required && auth.refreshNeeded) state = 'stale-auth';
	else if (auth.required && !auth.ready) state = 'missing-auth';
	else if (!compiled) state = 'needs-compile';
	else if (lastRun?.status === 'fail') state = 'last-run-failed';
	else if (lastRun?.status === 'pass') state = 'passed';

	return {
		state,
		runnable: reasons.length === 0,
		reasons,
		unrunnableReason: reasons[0] || '',
		needsReview,
		missingValues,
		compiled,
		auth,
		policy,
		lastRun: lastRun || null,
		lastFailureReason: lastRun?.status === 'fail' ? lastRun.failureReason : '',
	};
}

async function readJsonFile(p) {
	try {
		return JSON.parse(await readFile(p, 'utf8'));
	} catch {
		return null;
	}
}

async function readTextFile(p) {
	try {
		return await readFile(p, 'utf8');
	} catch {
		return null;
	}
}

function applyStrip(value, suffix) {
	const s = String(value == null ? '' : value);
	if (!suffix) return s.trim() || null;
	return (s.endsWith(suffix) ? s.slice(0, s.length - suffix.length).trim() : s.trim()) || null;
}

function extractRecipeRows(snapshotText, recipe) {
	if (!recipe?.collection?.name) throw new Error('recipe.collection.name is required');
	if (!recipe.columns || typeof recipe.columns !== 'object' || !Object.keys(recipe.columns).length) {
		throw new Error('recipe.columns is required');
	}
	if (!recipe.key || !Object.prototype.hasOwnProperty.call(recipe.columns, recipe.key)) {
		throw new Error('recipe.key must name one of recipe.columns');
	}

	const role = recipe.collection.role || 'table';
	const rowRole = recipe.collection.row || 'row';
	const lines = aria.parse({ snapshot: snapshotText });
	const hits = aria.findByRoleName(lines, role, recipe.collection.name);
	if (hits.length === 0) throw new Error(`${role} "${recipe.collection.name}" not found in snapshot`);
	if (hits.length > 1) throw new Error(`${hits.length} ${role}s named "${recipe.collection.name}" in snapshot`);

	const rows = aria.rowsOf(lines, hits[0], rowRole);
	const header = rows.find((r) => r.children.some((c) => c.role === 'columnheader'));
	if (!header) throw new Error('no header row found in snapshot');
	const headers = header.children.filter((c) => c.role === 'columnheader').map((c) => aria.norm(c.name));
	const headerCount = headers.length;
	const idx = {};
	for (const [field, label] of Object.entries(recipe.columns)) {
		const want = aria.norm(label);
		const found = [];
		headers.forEach((h, i) => { if (h === want) found.push(i); });
		if (found.length === 0) throw new Error(`column "${label}" (${field}) not found in snapshot`);
		if (found.length > 1) throw new Error(`column "${label}" (${field}) is ambiguous in snapshot`);
		idx[field] = found[0];
	}

	const strip = recipe.strip || {};
	const fields = Object.keys(recipe.columns);
	const items = [];
	for (const r of rows) {
		const cells = r.children.filter((c) => c.role === 'cell');
		if (!cells.length) continue;
		if (cells.length !== headerCount) {
			throw new Error(`row has ${cells.length} cells but header has ${headerCount}`);
		}
		const data = {};
		for (const field of fields) data[field] = applyStrip(aria.clean(cells[idx[field]].name), strip[field]);
		const key = data[recipe.key];
		if (!key) continue;
		items.push({ key, data });
	}

	const seen = new Set();
	for (const item of items) {
		if (seen.has(item.key)) throw new Error(`recipe key "${recipe.key}" is not unique in snapshot`);
		seen.add(item.key);
	}
	return items;
}

function compactText(value) {
	return aria.norm(String(value == null ? '' : value).trim());
}

function locatorValuesForStep(step) {
	const values = [];
	const add = (v) => {
		if (typeof v !== 'string') return;
		const s = v.trim();
		if (s) values.push(s);
	};
	for (const field of ['value', 'name', 'text', 'val']) add(step?.[field]);
	for (const c of Array.isArray(step?.candidates) ? step.candidates : []) {
		for (const field of ['value', 'name', 'text', 'val']) add(c?.[field]);
	}
	return [...new Set(values)];
}

function rowComparableValues(row) {
	return [row.key, ...Object.values(row.data || {})]
		.filter((v) => v != null && String(v).trim() !== '')
		.map((v) => String(v).trim());
}

function uniqueRowMatch(rows, targets, predicate) {
	const matched = [];
	for (const [rowIndex, row] of rows.entries()) {
		const rowValues = rowComparableValues(row);
		if (targets.some((target) => rowValues.some((value) => predicate(target, value)))) {
			matched.push(rowIndex);
		}
	}
	return [...new Set(matched)];
}

function inferClickedRowIndex(rows, step) {
	const targets = locatorValuesForStep(step);
	if (!targets.length) throw new Error('step has no locator/candidate value to match against snapshot rows');
	if (!rows.length) throw new Error('snapshot recipe found no data rows');

	const exact = uniqueRowMatch(rows, targets, (target, value) => compactText(target) === compactText(value));
	if (exact.length === 1) return exact[0];
	if (exact.length > 1) throw new Error(`locator values match multiple rows exactly: ${exact.join(', ')}`);

	const contains = uniqueRowMatch(rows, targets, (target, value) => {
		const a = compactText(target);
		const b = compactText(value);
		if (a.length < 6 || b.length < 6) return false;
		return a.includes(b) || b.includes(a);
	});
	if (contains.length === 1) return contains[0];
	if (contains.length > 1) throw new Error(`locator values match multiple rows by contains: ${contains.join(', ')}`);
	throw new Error(`locator values did not match any recipe row: ${targets.join(' / ')}`);
}

export async function listFlows() {
	let entries;
	try {
		entries = await readdir(FLOWS_DIR);
	} catch {
		return [];
	}
	const latestResults = await latestTestResultsByName();
	const names = entries.filter((f) => f.endsWith('.flow.json')).map((f) => f.slice(0, -'.flow.json'.length));
	const out = [];
	for (const name of names) {
		if (!validName(name)) continue;
		const flow = await readJsonFile(flowPath(name));
		if (!flow) continue;
		const steps = Array.isArray(flow.steps) ? flow.steps : [];
		const tokens = collectTokens(flow);
		const values = (await readJsonFile(valuesPath(name))) || {};
		const engine = safeFlowEngine(flow);
		const compiled = compiledFresh(name);
		const missingValues = missingTokens(tokens, values);
		const scenarioStatus = await buildScenarioStatus({ flow, steps, engine, compiled, missingValues, lastRun: latestResults[name] || null });
		out.push({
			name,
			engine: engine.engine,
			engineError: engine.engineError,
			environment: flow.environment || '',
			riskClass: flow.riskClass || '',
			policy: scenarioStatus.policy,
			startUrl: flow.startUrl || '',
			app: flow.app || null,
			steps: steps.length,
			needsReview: scenarioStatus.needsReview,
			inputTokens: tokens,
			missingValues,
			valueStatus: valueStatus(tokens, values),
			hasValues: existsSync(valuesPath(name)),
			compiled,
			compilable: !engine.engineError && scenarioStatus.policy.ok && scenarioStatus.needsReview === 0 && missingValues.length === 0,
			runnable: scenarioStatus.runnable,
			runBlockedReason: scenarioStatus.unrunnableReason,
			lastRun: scenarioStatus.lastRun,
			lastFailureReason: scenarioStatus.lastFailureReason,
			scenarioStatus,
		});
	}
	out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return out;
}

export async function getFlow(name) {
	if (!flowExists(name)) return null;
	const flow = await readJsonFile(flowPath(name));
	if (!flow) return null;
	const steps = Array.isArray(flow.steps) ? flow.steps : [];
	const values = (await readJsonFile(valuesPath(name))) || {};
	const tokens = collectTokens(flow);
	const engine = safeFlowEngine(flow);
	const compiled = compiledFresh(name);
	const missingValues = missingTokens(tokens, values);
	const latestResults = await latestTestResultsByName();
	const scenarioStatus = await buildScenarioStatus({ flow, steps, engine, compiled, missingValues, lastRun: latestResults[name] || null });
	return {
		name,
		engine: engine.engine,
		engineError: engine.engineError,
		environment: flow.environment || '',
		riskClass: flow.riskClass || '',
		policy: scenarioStatus.policy,
		startUrl: flow.startUrl || '',
		app: flow.app || null,
		steps,
		asserts: Array.isArray(flow.asserts) ? flow.asserts : [],
		needsReviewSteps: steps
			.map((s, i) => ({ index: i, step: s }))
			.filter((x) => x.step.needs_review === true)
			.map((x) => ({ index: x.index, action: x.step.action || null, candidates: Array.isArray(x.step.candidates) ? x.step.candidates : [] })),
		inputTokens: tokens,
		values: Object.fromEntries(tokens.map((t) => [t, ''])),
		valueStatus: valueStatus(tokens, values),
		missingValues,
		compiled,
		scenarioStatus,
		// compile is safe only when no needs_review remains AND every token has a value.
		compilable: !engine.engineError && scenarioStatus.policy.ok && steps.every((s) => s.needs_review !== true) && tokens.every((t) => t in values && values[t] !== ''),
		runnable: scenarioStatus.runnable,
		runBlockedReason: scenarioStatus.unrunnableReason,
		lastRun: scenarioStatus.lastRun,
		lastFailureReason: scenarioStatus.lastFailureReason,
	};
}

// Serialize flow.json / values.json read-modify-writes so two near-simultaneous POSTs (e.g.
// resolving two steps, or two tabs) can't lost-update — each runs after the prior settles.
let writeChain = Promise.resolve();
function withWriteLock(task) {
	const p = writeChain.then(task, task);
	writeChain = p.then(
		() => {},
		() => {},
	);
	return p;
}

// resolveStep: write the chosen candidate as the step's locator, drop needs_review+candidates.
export function resolveStep(name, stepIndex, candidateIndex) {
	return withWriteLock(() => resolveStepInner(name, stepIndex, candidateIndex));
}
async function resolveStepInner(name, stepIndex, candidateIndex) {
	if (!validName(name)) return { ok: false, error: 'invalid flow name' };
	const flow = await readJsonFile(flowPath(name));
	if (!flow) return { ok: false, error: 'no such flow' };
	const steps = Array.isArray(flow.steps) ? flow.steps : [];
	const step = steps[stepIndex];
	if (!step || step.needs_review !== true) return { ok: false, error: 'step is not needs_review' };
	const cand = (Array.isArray(step.candidates) ? step.candidates : [])[candidateIndex];
	if (!cand) return { ok: false, error: 'invalid candidate index' };
	step.by = cand.by;
	step.value = cand.value;
	if (cand.name != null) step.name = cand.name;
	else delete step.name;
	delete step.needs_review;
	delete step.candidates;
	await writeFile(flowPath(name), JSON.stringify(flow, null, 2) + '\n', 'utf8');
	return { ok: true };
}

// resolveClickedRecordStep: replace a recorded literal document click with a dynamic
// recipe-driven "open the same row position from the current list" step. The row
// position is inferred from the capture snapshot and the clicked locator/candidate value.
export function resolveClickedRecordStep(name, stepIndex, recipe, field = '') {
	return withWriteLock(() => resolveClickedRecordStepInner(name, stepIndex, recipe, field));
}

// Backward-compatible export for older callers; it no longer falls back to first.
export function resolveFirstRecordStep(name, stepIndex, recipe, field = '') {
	return resolveClickedRecordStep(name, stepIndex, recipe, field);
}

async function resolveClickedRecordStepInner(name, stepIndex, recipe, field = '') {
	if (!validName(name)) return { ok: false, error: 'invalid flow name' };
	if (!validName(recipe)) return { ok: false, error: 'invalid recipe name' };
	if (field && !validName(field)) return { ok: false, error: 'invalid field name' };
	if (!existsSync(recipePath(recipe))) return { ok: false, error: `missing recipe recipes/${recipe}.json` };
	if (!existsSync(snapshotPath(name))) return { ok: false, error: `missing snapshot flows/${name}.snapshot.txt; cannot infer clicked row position` };
	const flow = await readJsonFile(flowPath(name));
	if (!flow) return { ok: false, error: 'no such flow' };
	const steps = Array.isArray(flow.steps) ? flow.steps : [];
	const step = steps[stepIndex];
	if (!step) return { ok: false, error: 'invalid step index' };
	if (step.kind !== 'find' || (step.action || 'click') !== 'click') {
		return { ok: false, error: 'only click steps can become open_record' };
	}
	const snapshotText = await readTextFile(snapshotPath(name));
	if (!snapshotText) return { ok: false, error: `empty snapshot flows/${name}.snapshot.txt; cannot infer clicked row position` };
	const recipeJson = await readJsonFile(recipePath(recipe));
	if (!recipeJson) return { ok: false, error: `invalid recipe recipes/${recipe}.json` };
	let rowIndex;
	try {
		rowIndex = inferClickedRowIndex(extractRecipeRows(snapshotText, recipeJson), step);
	} catch (e) {
		return { ok: false, error: `cannot infer clicked row position: ${e.message}` };
	}
	steps[stepIndex] = {
		kind: 'open_record',
		source: 'row_index',
		rowIndex,
		recipe,
		...(field ? { field } : {}),
	};
	await writeFile(flowPath(name), JSON.stringify(flow, null, 2) + '\n', 'utf8');
	return { ok: true, rowIndex };
}

// saveValues: merge {input_N: string} into the gitignored values sidecar.
export function saveValues(name, valuesObj) {
	return withWriteLock(() => saveValuesInner(name, valuesObj));
}
async function saveValuesInner(name, valuesObj) {
	if (!validName(name)) return { ok: false, error: 'invalid flow name' };
	if (!existsSync(flowPath(name))) return { ok: false, error: 'no such flow' };
	if (!valuesObj || typeof valuesObj !== 'object') return { ok: false, error: 'invalid values' };
	const existing = (await readJsonFile(valuesPath(name))) || {};
	for (const [k, v] of Object.entries(valuesObj)) {
		if (/^input_\d+$/.test(k) && typeof v === 'string') existing[k] = v;
	}
	await writeFile(valuesPath(name), JSON.stringify(existing, null, 2) + '\n', 'utf8');
	return { ok: true };
}
