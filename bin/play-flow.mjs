#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runSteps, validateSteps, buildLocator } from '../approve/flow-runner.mjs';

const require = createRequire(import.meta.url);
const {
	assertFlowEngine,
	resolveAuthStatePath,
} = require('../lib/engine.js');

const PROBE_ROOT = path.resolve(import.meta.dirname, '..');
const ASSERT_KINDS = new Set(['url', 'text', 'value', 'visible', 'count', 'absent']);
const EFFECTFUL = new Set(['click', 'fill', 'type', 'select', 'check', 'uncheck']);

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d = null) => {
	const i = argv.indexOf(n);
	return i >= 0 && i + 1 < argv.length ? argv[i + 1] : d;
};

const flowPath = opt('--flow');
const verify = flag('--verify');
const validateOnly = flag('--validate-only');
const headed = flag('--headed') || process.env.AQA_PW_HEADLESS === '0';
if (!flowPath) {
	console.error('usage: node bin/play-flow.mjs --flow flows/name.flow.json [--verify] [--validate-only] [--headed]');
	process.exit(2);
}

function readJson(file, fallback = null) {
	try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
	catch (e) {
		if (fallback !== null && e.code === 'ENOENT') return fallback;
		throw e;
	}
}

function valuesPathFor(file) {
	return file.replace(/\.flow\.json$/i, '.values.json');
}

function assertUrlMatch(got, want) {
	const esc = String(want).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '*').replace(/\*/g, '.*');
	const re = new RegExp(`^${esc}([?#].*)?$`);
	return re.test(got) || got.includes(String(want));
}

function validateAsserts(asserts) {
	if (!Array.isArray(asserts)) throw new Error('asserts must be an array');
	for (let i = 0; i < asserts.length; i++) {
		const a = asserts[i];
		if (!a || typeof a !== 'object') throw new Error(`assert ${i}: not an object`);
		if (!ASSERT_KINDS.has(a.kind)) throw new Error(`assert ${i}: unknown kind "${a.kind}"`);
		if (['url', 'text'].includes(a.kind) && (typeof a.value !== 'string' || !a.value)) throw new Error(`assert ${i}: value required`);
		if (['value', 'visible', 'count', 'absent'].includes(a.kind) && (typeof a.selector !== 'string' || !a.selector)) throw new Error(`assert ${i}: selector required`);
		if (a.kind === 'count' && !Number.isInteger(a.n)) throw new Error(`assert ${i}: integer n required`);
	}
}

function makeResolveValue(values, valuesFile) {
	return (input) => {
		const s = input == null ? '' : String(input);
		return s.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (m, key) => {
			if (!(key in values) || values[key] === '') throw new Error(`missing value ${key} in ${valuesFile}`);
			return String(values[key]);
		});
	};
}

function preflightValues(flow, resolveValue) {
	for (const s of flow.steps || []) {
		if (s && s.kind === 'find') {
			if (s.text != null) resolveValue(s.text);
			if (s.val != null) resolveValue(s.val);
		}
	}
}

async function loadChromium() {
	const pwRequire = createRequire(new URL('../approve/package.json', import.meta.url));
	return pwRequire('playwright').chromium;
}

async function newContext(browser, flow) {
	if (!flow.app) return browser.newContext();
	const statePath = resolveAuthStatePath(PROBE_ROOT, 'playwright', flow.app);
	if (!fs.existsSync(statePath)) throw new Error(`missing Playwright auth state for app "${flow.app}" (${path.relative(PROBE_ROOT, statePath).replace(/\\/g, '/')})`);
	return browser.newContext({ storageState: statePath });
}

async function runAsserts(page, asserts, resolveValue) {
	for (let i = 0; i < asserts.length; i++) {
		const a = asserts[i];
		if (a.kind === 'url') {
			const got = page.url();
			if (!assertUrlMatch(got, a.value)) throw new Error(`assert ${i} url: "${got}" does not match "${a.value}"`);
		} else if (a.kind === 'text') {
			const got = await page.locator('body').innerText();
			if (!got.includes(resolveValue(a.value))) throw new Error(`assert ${i} text: body does not contain "${a.value}"`);
		} else if (a.kind === 'value') {
			const got = await page.locator(a.selector).inputValue();
			const want = resolveValue(a.text != null ? a.text : a.value);
			if (got !== want) throw new Error(`assert ${i} value: ${a.selector} expected "${want}", got "${got}"`);
		} else if (a.kind === 'visible') {
			const loc = page.locator(a.selector);
			if ((await loc.count()) < 1 || !(await loc.first().isVisible())) throw new Error(`assert ${i} visible: ${a.selector} not visible`);
		} else if (a.kind === 'count') {
			const got = await page.locator(a.selector).count();
			if (got !== a.n) throw new Error(`assert ${i} count: ${a.selector} expected ${a.n}, got ${got}`);
		} else if (a.kind === 'absent') {
			const got = await page.locator(a.selector).count();
			if (got !== 0) throw new Error(`assert ${i} absent: ${a.selector} found ${got}`);
		}
	}
}

function readCandidateLadder(flowFile, flow) {
	const candPath = flowFile.replace(/\.flow\.json$/i, '.candidates.json');
	try {
		const raw = readJson(candPath, {});
		if (raw._steps === (flow.steps || []).length && raw.byStep) return raw.byStep;
	} catch {}
	return {};
}

function candidateStep(base, c) {
	return {
		...base,
		by: c.by,
		value: c.value,
		...(c.name ? { name: c.name } : {}),
		needs_review: false,
	};
}

async function resolveFindForVerify(page, step, ladder) {
	const primary = { by: step.by, value: step.value, ...(step.name ? { name: step.name } : {}) };
	const choices = [primary, ...(ladder || []).filter((c) => c && c.count === 1)];
	for (let i = 0; i < choices.length; i++) {
		const trial = candidateStep(step, choices[i]);
		const c = await buildLocator(page, trial).count();
		if (c === 1) return { step: trial, repaired: i > 0 };
	}
	return { step: null, repaired: false };
}

async function verifyFlow(page, flow, flowFile, resolveValue) {
	const ladderByStep = readCandidateLadder(flowFile, flow);
	const nextSteps = (flow.steps || []).map((s) => ({ ...s }));
	let verified = 0;
	let repaired = 0;
	let promoted = 0;
	for (let i = 0; i < nextSteps.length; i++) {
		const s = nextSteps[i];
		if (s.needs_review) throw new Error(`step ${i}: already needs_review`);
		try {
			if (s.kind === 'find') {
				const r = await resolveFindForVerify(page, s, ladderByStep[String(i)] || []);
				if (!r.step) {
					const cands = (ladderByStep[String(i)] || [{ by: s.by, value: s.value, ...(s.name ? { name: s.name } : {}) }]);
					nextSteps[i] = { kind: 'find', needs_review: true, candidates: cands, action: s.action, ...(s.text ? { text: s.text } : {}), ...(s.val ? { val: s.val } : {}), ...(s.frame ? { frame: s.frame } : {}) };
					promoted++;
					break;
				}
				if (r.repaired) {
					nextSteps[i] = { ...s, by: r.step.by, value: r.step.value, ...(r.step.name ? { name: r.step.name } : {}) };
					delete nextSteps[i].needs_review;
					delete nextSteps[i].candidates;
					repaired++;
				}
				await buildLocator(page, r.step).first().hover();
				await runSteps(page, [r.step], { reversible: true, dryRun: false, resolveValue });
				verified++;
			} else {
				await runSteps(page, [s], { reversible: true, dryRun: false, resolveValue });
			}
		} catch (e) {
			if (s.kind === 'find') {
				nextSteps[i] = {
					kind: 'find',
					needs_review: true,
					candidates: ladderByStep[String(i)] || [{ by: s.by, value: s.value, ...(s.name ? { name: s.name } : {}) }],
					action: s.action,
					...(s.text ? { text: s.text } : {}),
					...(s.val ? { val: s.val } : {}),
					...(s.frame ? { frame: s.frame } : {}),
				};
				promoted++;
			}
			break;
		}
	}
	if (repaired || promoted) {
		const tmp = `${flowFile}.tmp.${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify({ ...flow, steps: nextSteps }, null, 2) + '\n');
		fs.renameSync(tmp, flowFile);
	}
	return { verified, repaired, promoted };
}

let summary = null;
try {
	const absFlow = path.resolve(flowPath);
	const flow = readJson(absFlow);
	assertFlowEngine(flow, 'playwright');
	const stepsValidation = validateSteps(flow.steps);
	if (!stepsValidation.ok) throw new Error('invalid steps: ' + stepsValidation.reason);
	validateAsserts(flow.asserts || []);
	if (!flow.startUrl) throw new Error('startUrl required');
	const valuesFile = valuesPathFor(absFlow);
	const values = readJson(valuesFile, {});
	const resolveValue = makeResolveValue(values, valuesFile);
	preflightValues(flow, resolveValue);
	if (validateOnly) {
		console.error('[play-flow] validate-only OK');
		process.exit(0);
	}

	const chromium = await loadChromium();
	const browser = await chromium.launch({ headless: !headed, channel: process.env.AQA_PW_CHANNEL || 'chrome' });
	try {
		const ctx = await newContext(browser, flow);
		const page = await ctx.newPage();
		await page.goto(flow.startUrl, { waitUntil: 'domcontentloaded' });
		if (verify) {
			const v = await verifyFlow(page, flow, absFlow, resolveValue);
			if (v.promoted) throw new Error(`verify promoted ${v.promoted} step(s) to needs_review`);
			summary = { status: 'ok', mode: 'verify', ...v };
		} else {
			await runSteps(page, flow.steps, { reversible: true, dryRun: false, resolveValue });
			await runAsserts(page, flow.asserts || [], resolveValue);
			summary = { status: 'ok', mode: 'play', flow: flow.name || path.basename(absFlow) };
		}
	} finally {
		await browser.close();
	}
	console.log('AQA_JOB_RESULT=' + JSON.stringify(summary));
} catch (e) {
	summary = { status: 'failed', mode: verify ? 'verify' : 'play', error: String(e && e.message || e) };
	console.log('AQA_JOB_RESULT=' + JSON.stringify(summary));
	console.error('[play-flow] ' + summary.error);
	process.exit(1);
}
