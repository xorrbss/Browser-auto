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
import { createSecretStore, secretBackendSecureOnly, secretBackendPlaintextBlocked, secretBackendConfigBlockedReason } from './secrets.js';
import { analyzeBlockedFlowForWebui } from './blocked-flows.js';

const require = createRequire(import.meta.url);
const { flowEngine } = require('../lib/engine.js');
const { validateFlowRunPolicy } = require('../lib/flow-policy.js');
const aria = require('../lib/aria.js');

const PROBE_ROOT = path.resolve(import.meta.dirname, '..');
const FLOWS_DIR = path.join(PROBE_ROOT, 'flows');
const TESTS_DIR = path.join(PROBE_ROOT, 'tests');
const NAME_RE = /^[A-Za-z0-9_-]+$/; // also blocks path traversal in the name
const TOKEN_RE = /\{\{(input_\d+)\}\}/g;
const secretStore = createSecretStore();

export const validName = (name) => typeof name === 'string' && NAME_RE.test(name);

const flowPath = (name) => path.join(FLOWS_DIR, `${name}.flow.json`);
const valuesPath = (name) => path.join(FLOWS_DIR, `${name}.values.json`);
const testPath = (name) => path.join(TESTS_DIR, `${name}.test.sh`);
const snapshotPath = (name) => path.join(FLOWS_DIR, `${name}.snapshot.txt`);
const recipePath = (name) => path.join(PROBE_ROOT, 'recipes', `${name}.json`);

export const flowExists = (name) => validName(name) && existsSync(flowPath(name));

function localValuesSecretMetadata(name) {
	return secretStore.describeLocalFile({
		kind: 'flow-values',
		name,
		filePath: valuesPath(name),
	});
}

const useEncryptedBackendOnly = () => secretBackendSecureOnly(secretStore);
const plaintextBlocked = () => secretBackendPlaintextBlocked(secretStore);
const secureBackendConfigBlockedReason = () => secretBackendConfigBlockedReason(secretStore);

async function encryptedValuesSecretMetadata(name) {
	if (!secretStore.secureBackend) return null;
	return secretStore.describeSecret({ kind: 'flow-values', name });
}

async function readFlowValues(name) {
	const localStorage = localValuesSecretMetadata(name);
	const configBlockedReason = secureBackendConfigBlockedReason();
	if (configBlockedReason) {
		return {
			values: {},
			storage: await encryptedValuesSecretMetadata(name) || localStorage,
			localPlaintextStorage: localStorage,
			source: secretStore.backend,
			blockedReason: configBlockedReason,
		};
	}
	if (useEncryptedBackendOnly()) {
		const encryptedStorage = await encryptedValuesSecretMetadata(name);
		if (encryptedStorage?.present && encryptedStorage.usable) {
			try {
				const parsed = await secretStore.describeJsonObjectKeys({ kind: 'flow-values', name });
				if (parsed.blocked || parsed.parseStatus !== 'object') throw new Error('secure flow values metadata is unreadable');
				return {
					values: Object.fromEntries((parsed.jsonObjectKeys || []).map((key) => [key, true])),
					storage: encryptedStorage,
					localPlaintextStorage: localStorage,
					source: secretStore.backend,
					blockedReason: '',
				};
			} catch {
				return {
					values: {},
					storage: { ...encryptedStorage, usable: false, blocked: true, blockReason: 'encrypted flow values are unreadable' },
					localPlaintextStorage: localStorage,
					source: secretStore.backend,
					blockedReason: 'secure flow values metadata is unreadable',
				};
			}
		}
		return {
			values: {},
			storage: encryptedStorage || localStorage,
			localPlaintextStorage: localStorage,
			source: secretStore.backend,
			blockedReason: localStorage.present
				? 'local plaintext flow values are blocked in external mode; secure backend flow values are required'
				: 'secure backend flow values are missing',
		};
	}
	if (plaintextBlocked()) {
		return {
			values: {},
			storage: localStorage,
			localPlaintextStorage: localStorage,
			source: 'local-pilot-file',
			blockedReason: localStorage.blockReason || 'local plaintext flow values are blocked in external mode',
		};
	}
	return {
		values: (await readJsonFile(valuesPath(name))) || {},
		storage: localStorage,
		localPlaintextStorage: localStorage,
		source: 'local-pilot-file',
		blockedReason: '',
	};
}

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

async function buildScenarioStatus({ flow, steps, engine, compiled, missingValues, valuesBlockedReason = '', lastRun, blockedFlow = null }) {
	const needsReview = steps.filter((s) => s.needs_review === true).length;
	const auth = await authStatus(flow, engine);
	const policy = flowPolicyStatus(flow);
	const reasons = [];
	if (engine.engineError) reasons.push(engine.engineError);
	if (!policy.ok) reasons.push(`policy: ${policy.reason}`);
	if (needsReview) reasons.push(`${needsReview} needs_review step(s)`);
	if (valuesBlockedReason) reasons.push(valuesBlockedReason);
	if (missingValues.length) reasons.push(`missing values: ${missingValues.join(', ')}`);
	if (auth.required && auth.refreshNeeded) reasons.push(`auth refresh needed: ${auth.state}`);
	else if (auth.required && !auth.ready) reasons.push(auth.error || `missing Playwright auth for app "${auth.app}"`);
	if (!compiled) reasons.push('compiled test is missing or older than the flow');

	let state = 'ready';
	if (engine.engineError) state = 'engine-error';
	else if (!policy.ok) state = 'policy-blocked';
	else if (needsReview) state = 'needs-review';
	else if (valuesBlockedReason) state = 'blocked-values';
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
		staticAnalysis: blockedFlow,
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
	const idx = {};
	const fields = Object.keys(recipe.columns);
	let headerCount = null;
	let headerlessIndexMode = false;
	if (header) {
		const headers = header.children.filter((c) => c.role === 'columnheader').map((c) => aria.norm(c.name));
		headerCount = headers.length;
		for (const [field, label] of Object.entries(recipe.columns)) {
			const want = aria.norm(label);
			const found = [];
			headers.forEach((h, i) => { if (h === want) found.push(i); });
			if (found.length === 0) throw new Error(`column "${label}" (${field}) not found in snapshot`);
			if (found.length > 1) throw new Error(`column "${label}" (${field}) is ambiguous in snapshot`);
			idx[field] = found[0];
		}
	} else if (recipe.columnIndexes && typeof recipe.columnIndexes === 'object' && !Array.isArray(recipe.columnIndexes)) {
		const seen = new Set();
		for (const field of fields) {
			const n = recipe.columnIndexes[field];
			if (!Number.isInteger(n) || n < 0) throw new Error(`columnIndexes.${field} must be a non-negative integer`);
			if (seen.has(n)) throw new Error(`duplicate column index ${n}`);
			seen.add(n);
			idx[field] = n;
		}
		headerlessIndexMode = true;
	} else {
		throw new Error('no header row found in snapshot');
	}

	const strip = recipe.strip || {};
	const maxIdx = Math.max(...fields.map((field) => idx[field]));
	const items = [];
	for (const r of rows) {
		const cells = r.children.filter((c) => c.role === 'cell');
		if (!cells.length) continue;
		if (headerlessIndexMode) {
			if (cells.length <= maxIdx) throw new Error(`row has ${cells.length} cells but recipe needs index ${maxIdx}`);
			if (fields.every((field) => aria.norm(cells[idx[field]].name) === aria.norm(recipe.columns[field]))) continue;
		} else if (cells.length !== headerCount) {
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

function preferredRecordField(recipe, requestedField = '') {
	if (requestedField) return requestedField;
	for (const field of ['title', 'subject', 'name']) {
		if (Object.prototype.hasOwnProperty.call(recipe.columns || {}, field)) return field;
	}
	return recipe.key;
}

function capturedUniqueRecordValue(step) {
	const candidates = Array.isArray(step?.candidates) ? step.candidates : [];
	const values = [];
	const add = (value) => {
		if (typeof value !== 'string') return;
		const s = value.trim();
		if (s) values.push(s);
	};
	for (const c of candidates) {
		if (Number(c?.count) !== 1) continue;
		if (c.by === 'role' && c.name) add(c.name);
		else if (['text', 'title', 'label', 'alt'].includes(c.by)) add(c.value);
	}
	if (!values.length) {
		if (step?.by === 'role' && step?.name) add(step.name);
		else if (['text', 'title', 'label', 'alt'].includes(step?.by)) add(step.value);
	}
	return [...new Set(values)][0] || '';
}

function fieldValueOpenRecordStep(recipeJson, step, recipe, field = '') {
	const resolvedField = preferredRecordField(recipeJson, field);
	if (!resolvedField || !Object.prototype.hasOwnProperty.call(recipeJson.columns || {}, resolvedField)) {
		throw new Error(`field "${resolvedField || field}" is not in recipe columns`);
	}
	const value = capturedUniqueRecordValue(step);
	if (!value) throw new Error('no capture-unique text/link candidate is available');
	return {
		kind: 'open_record',
		source: 'field_value',
		recipe,
		field: resolvedField,
		value,
	};
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
		const valuesRead = await readFlowValues(name);
		const values = valuesRead.values;
		const engine = safeFlowEngine(flow);
		const compiled = compiledFresh(name);
		const missingValues = missingTokens(tokens, values);
		const blockedFlow = analyzeBlockedFlowForWebui(flow, { name, file: flowPath(name) });
		const scenarioStatus = await buildScenarioStatus({ flow, steps, engine, compiled, missingValues, valuesBlockedReason: valuesRead.blockedReason, lastRun: latestResults[name] || null, blockedFlow });
		out.push({
			name,
			engine: engine.engine,
			engineError: engine.engineError,
			environment: flow.environment || '',
			riskClass: flow.riskClass || '',
			blockedFlow,
			policy: scenarioStatus.policy,
			startUrl: flow.startUrl || '',
			app: flow.app || null,
			steps: steps.length,
			needsReview: scenarioStatus.needsReview,
			inputTokens: tokens,
			missingValues,
			valueStatus: valueStatus(tokens, values),
			valuesStorage: valuesRead.storage,
			localPlaintextValuesStorage: valuesRead.localPlaintextStorage,
			valuesBlockedReason: valuesRead.blockedReason,
			hasValues: !!valuesRead.storage?.present,
			compiled,
			compilable: !engine.engineError && scenarioStatus.policy.ok && scenarioStatus.needsReview === 0 && !valuesRead.blockedReason && missingValues.length === 0,
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
	const valuesRead = await readFlowValues(name);
	const values = valuesRead.values;
	const tokens = collectTokens(flow);
	const engine = safeFlowEngine(flow);
	const compiled = compiledFresh(name);
	const missingValues = missingTokens(tokens, values);
	const latestResults = await latestTestResultsByName();
	const blockedFlow = analyzeBlockedFlowForWebui(flow, { name, file: flowPath(name) });
	const scenarioStatus = await buildScenarioStatus({ flow, steps, engine, compiled, missingValues, valuesBlockedReason: valuesRead.blockedReason, lastRun: latestResults[name] || null, blockedFlow });
	return {
		name,
		engine: engine.engine,
		engineError: engine.engineError,
		environment: flow.environment || '',
		riskClass: flow.riskClass || '',
		blockedFlow,
		policy: scenarioStatus.policy,
		startUrl: flow.startUrl || '',
		app: flow.app || null,
		steps,
		asserts: Array.isArray(flow.asserts) ? flow.asserts : [],
		needsReviewSteps: steps
			.map((s, i) => ({ index: i, step: s }))
			.filter((x) => x.step.needs_review === true)
			.map((x) => ({
				index: x.index,
				kind: x.step.kind || null,
				action: x.step.action || null,
				unsupported: x.step.unsupported || null,
				reason: x.step.reason || '',
				recordedDir: x.step.recordedDir || null,
				recordedPx: Number.isFinite(Number(x.step.recordedPx)) ? Number(x.step.recordedPx) : null,
				candidates: Array.isArray(x.step.candidates) ? x.step.candidates : [],
			})),
		inputTokens: tokens,
		values: Object.fromEntries(tokens.map((t) => [t, ''])),
		valueStatus: valueStatus(tokens, values),
		valuesStorage: valuesRead.storage,
		localPlaintextValuesStorage: valuesRead.localPlaintextStorage,
		valuesBlockedReason: valuesRead.blockedReason,
		missingValues,
		compiled,
		scenarioStatus,
		// compile is safe only when no needs_review remains AND every token has a value.
		compilable: !engine.engineError && scenarioStatus.policy.ok && !valuesRead.blockedReason && steps.every((s) => s.needs_review !== true) && tokens.every((t) => t in values && values[t] !== ''),
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
	if (step.kind === 'scroll' && step.unsupported === 'container-scroll') {
		step.container = { by: cand.by, value: cand.value };
		if (cand.name != null) step.container.name = cand.name;
		step.dir = step.recordedDir || step.dir;
		step.px = step.recordedPx || step.px;
		delete step.by;
		delete step.value;
		delete step.name;
		delete step.unsupported;
		delete step.reason;
		delete step.recordedDir;
		delete step.recordedPx;
	} else {
		step.by = cand.by;
		step.value = cand.value;
		if (cand.name != null) step.name = cand.name;
		else delete step.name;
	}
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
	const flow = await readJsonFile(flowPath(name));
	if (!flow) return { ok: false, error: 'no such flow' };
	const steps = Array.isArray(flow.steps) ? flow.steps : [];
	const step = steps[stepIndex];
	if (!step) return { ok: false, error: 'invalid step index' };
	if (step.kind !== 'find' || (step.action || 'click') !== 'click') {
		return { ok: false, error: 'only click steps can become open_record' };
	}
	const recipeJson = await readJsonFile(recipePath(recipe));
	if (!recipeJson) return { ok: false, error: `invalid recipe recipes/${recipe}.json` };
	let nextStep = null;
	const snapshotText = await readTextFile(snapshotPath(name));
	if (snapshotText) {
		try {
			const rowIndex = inferClickedRowIndex(extractRecipeRows(snapshotText, recipeJson), step);
			nextStep = {
				kind: 'open_record',
				source: 'row_index',
				rowIndex,
				recipe,
				...(field ? { field } : {}),
			};
		} catch (e) {
			try {
				nextStep = fieldValueOpenRecordStep(recipeJson, step, recipe, field);
			} catch {
				return { ok: false, error: `cannot infer clicked row position: ${e.message}` };
			}
		}
	} else {
		try {
			nextStep = fieldValueOpenRecordStep(recipeJson, step, recipe, field);
		} catch (e) {
			return { ok: false, error: `missing snapshot flows/${name}.snapshot.txt; cannot infer clicked row position; ${e.message}` };
		}
	}
	steps[stepIndex] = nextStep;
	await writeFile(flowPath(name), JSON.stringify(flow, null, 2) + '\n', 'utf8');
	return { ok: true, rowIndex: nextStep.rowIndex, source: nextStep.source, field: nextStep.field, value: nextStep.value };
}

// saveValues: merge {input_N: string} into the gitignored values sidecar.
export function saveValues(name, valuesObj) {
	return withWriteLock(() => saveValuesInner(name, valuesObj));
}
async function saveValuesInner(name, valuesObj) {
	if (!validName(name)) return { ok: false, error: 'invalid flow name' };
	if (!existsSync(flowPath(name))) return { ok: false, error: 'no such flow' };
	if (!valuesObj || typeof valuesObj !== 'object') return { ok: false, error: 'invalid values' };
	const configBlockedReason = secureBackendConfigBlockedReason();
	if (configBlockedReason) return { ok: false, error: configBlockedReason };
	if (plaintextBlocked() && !useEncryptedBackendOnly()) {
		return { ok: false, error: secretStore.policy?.plaintextBlockReason || 'local plaintext flow values are blocked in external mode' };
	}
	const incoming = {};
	for (const [k, v] of Object.entries(valuesObj)) {
		if (/^input_\d+$/.test(k) && typeof v === 'string') incoming[k] = v;
	}
	if (useEncryptedBackendOnly()) {
		const secretStorage = await secretStore.putJsonObjectFields({ kind: 'flow-values', name, values: incoming });
		return { ok: true, secretStorage };
	}
	const current = await readFlowValues(name);
	const existing = current.values || {};
	for (const [k, v] of Object.entries(incoming)) existing[k] = v;
	await writeFile(valuesPath(name), JSON.stringify(existing, null, 2) + '\n', 'utf8');
	return { ok: true };
}
