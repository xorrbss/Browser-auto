// webui/flows.js — flow read + the documented HUMAN edits on flow.json / values.json.
//
// PURE filesystem: no CLI, no daemon, no spawn. The agent-qa CLI has NO "resolve" subcommand
// (verify-flow.sh refuses to drive past a needs_review step, compile refuses to emit one), so
// resolving a needs_review step is the documented human edit — pick one of the listed
// candidates and write it as the step's locator. Doing that here is NOT reimplementing CLI
// logic; it is the same hand-edit a human would make in the JSON. Real input values live in a
// gitignored flows/<name>.values.json sidecar (the flow stores {{input_N}} tokens).

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const PROBE_ROOT = path.resolve(import.meta.dirname, '..');
const FLOWS_DIR = path.join(PROBE_ROOT, 'flows');
const TESTS_DIR = path.join(PROBE_ROOT, 'tests');
const NAME_RE = /^[A-Za-z0-9_-]+$/; // also blocks path traversal in the name
const TOKEN_RE = /\{\{(input_\d+)\}\}/g;

export const validName = (name) => typeof name === 'string' && NAME_RE.test(name);

const flowPath = (name) => path.join(FLOWS_DIR, `${name}.flow.json`);
const valuesPath = (name) => path.join(FLOWS_DIR, `${name}.values.json`);
const testPath = (name) => path.join(TESTS_DIR, `${name}.test.sh`);

export const flowExists = (name) => validName(name) && existsSync(flowPath(name));

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

async function readJsonFile(p) {
	try {
		return JSON.parse(await readFile(p, 'utf8'));
	} catch {
		return null;
	}
}

export async function listFlows() {
	let entries;
	try {
		entries = await readdir(FLOWS_DIR);
	} catch {
		return [];
	}
	const names = entries.filter((f) => f.endsWith('.flow.json')).map((f) => f.slice(0, -'.flow.json'.length));
	const out = [];
	for (const name of names) {
		if (!validName(name)) continue;
		const flow = await readJsonFile(flowPath(name));
		if (!flow) continue;
		const steps = Array.isArray(flow.steps) ? flow.steps : [];
		out.push({
			name,
			startUrl: flow.startUrl || '',
			app: flow.app || null,
			steps: steps.length,
			needsReview: steps.filter((s) => s.needs_review === true).length,
			inputTokens: collectTokens(flow),
			hasValues: existsSync(valuesPath(name)),
			compiled: existsSync(testPath(name)),
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
	return {
		name,
		startUrl: flow.startUrl || '',
		app: flow.app || null,
		steps,
		asserts: Array.isArray(flow.asserts) ? flow.asserts : [],
		needsReviewSteps: steps
			.map((s, i) => ({ index: i, step: s }))
			.filter((x) => x.step.needs_review === true)
			.map((x) => ({ index: x.index, action: x.step.action || null, candidates: Array.isArray(x.step.candidates) ? x.step.candidates : [] })),
		inputTokens: tokens,
		values,
		missingValues: tokens.filter((t) => !(t in values) || values[t] === ''),
		compiled: existsSync(testPath(name)),
		// compile is safe only when no needs_review remains AND every token has a value.
		compilable: steps.every((s) => s.needs_review !== true) && tokens.every((t) => t in values && values[t] !== ''),
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
