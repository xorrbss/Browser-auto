#!/usr/bin/env node
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runSteps, validateSteps, buildLocator, irreversibleOptsFor } from '../approve/flow-runner.mjs';

const require = createRequire(import.meta.url);
const {
	resolveAuthStatePath,
} = require('../lib/engine.js');
const {
	validateFlowRunPolicy,
	classifyAuthChallenge,
	failureSuggestion,
	isDestructiveStep,
	sanitizeUrl,
} = require('../lib/flow-policy.js');
const {
	createFlowEgressChecker,
} = require('../lib/egress-policy.js');
const {
	createRuntimeEgressChecker,
	runtimeEgressDenyEvent,
} = require('../lib/egress-runtime.js');
const aria = require('../lib/aria.js');

const PROBE_ROOT = path.resolve(import.meta.dirname, '..');
const ASSERT_KINDS = new Set(['url', 'text', 'value', 'visible', 'count', 'absent']);
const EFFECTFUL_ACTIONS = new Set(['click', 'fill', 'type', 'select', 'check', 'uncheck']);
const SAFE_NAME_RE = /^[A-Za-z0-9_-]+$/;

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

function applyStrip(value, suffix) {
	const s = String(value == null ? '' : value);
	if (!suffix) return s.trim() || null;
	return (s.endsWith(suffix) ? s.slice(0, s.length - suffix.length).trim() : s.trim()) || null;
}

function valuesPathFor(file) {
	return file.replace(/\.flow\.json$/i, '.values.json');
}

function isEffectfulStep(s) {
	return (s && s.kind === 'find' && EFFECTFUL_ACTIONS.has(s.action)) || (s && s.kind === 'open_record');
}

function describeStep(s) {
	if (!s || typeof s !== 'object') return 'invalid step';
	if (s.kind === 'find') {
		const name = s.name ? ` name="${s.name}"` : '';
		const frame = s.frame ? ` frame=${s.frame.by}:${s.frame.value}` : '';
		return `find ${s.by}:${s.value}${name} ${s.action}${frame}`;
	}
	if (s.kind === 'wait') return `wait ${s.until}${s.value != null ? `:${s.value}` : ''}`;
	if (s.kind === 'press') return `press ${s.value}`;
	if (s.kind === 'scroll') {
		const container = s.container ? ` container ${s.container.by}:${s.container.value}${s.container.name ? ` name="${s.container.name}"` : ''}` : '';
		const anchor = s.anchor ? ` anchor ${s.anchor.by}:${s.anchor.value}${s.anchor.name ? ` name="${s.anchor.name}"` : ''}` : '';
		const at = s.at ? ` at ${s.at.x},${s.at.y}` : '';
		return `scroll ${s.dir} ${s.px}${container}${anchor}${at}`;
	}
	if (s.kind === 'open_record') return `open_record ${s.recipe || ''}`;
	return String(s.kind || 'unknown');
}

function errorMessage(e) {
	return String(e && e.message || e);
}

function policyOptions(phase) {
	return {
		phase,
		runMode: process.env.AQA_RUN_MODE || 'local',
		allowlist: process.env.AQA_LIVE_ALLOWLIST || '',
		liveDryRunPassed: process.env.AQA_LIVE_DRY_RUN_PASSED || '',
		liveActionApprove: process.env.AQA_LIVE_ACTION_APPROVE || '',
		scheduledNoLive: process.env.AQA_SCHEDULED_NO_LIVE === '1',
		egress: egressOptions(phase),
	};
}

function assertFlowPolicy(flow, phase) {
	const policyValidation = validateFlowRunPolicy(flow, policyOptions(phase));
	if (!policyValidation.ok) throw new Error('flow policy refused: ' + policyValidation.reason);
	return policyValidation;
}

function egressOptions(phase) {
	return {
		phase,
		runMode: process.env.AQA_RUN_MODE || 'local',
		allowlist: process.env.AQA_TARGET_ALLOWLIST || process.env.AQA_EGRESS_ALLOWLIST || '',
		profile: process.env.AQA_EGRESS_PROFILE || '',
	};
}

function devReadonlySkipsRuntimeEvidence(flow) {
	if (process.env.AQA_DEV_INTEGRATION_READONLY !== '1') return false;
	const environment = String(flow?.environment || '');
	if (!['local', 'staging', 'live-readonly'].includes(environment)) return false;
	if (flow?.riskClass !== 'read') return false;
	if (flow?.irreversibleAt != null) return false;
	const steps = Array.isArray(flow?.steps) ? flow.steps : [];
	return !steps.some(isDestructiveStep);
}

function createRuntimeFlowEgressChecker(flow, phase) {
	const opts = egressOptions(phase);
	if (devReadonlySkipsRuntimeEvidence(flow)) opts.requireRuntimeEvidence = false;
	const base = createFlowEgressChecker(flow, opts);
	return createRuntimeEgressChecker({ policyOptions: base.context });
}

function shouldCheckAuthReadiness(flow) {
	const env = String(flow?.environment || 'local');
	return !!flow?.app || env.startsWith('live');
}

async function assertPageAuthReady(page, flow, label) {
	if (!shouldCheckAuthReadiness(flow)) return;
	const text = await page.locator('body').innerText({ timeout: 2500 }).catch(() => '');
	const diag = classifyAuthChallenge({ url: page.url(), text });
	if (diag.state === 'ready') return;
	throw new Error(`auth readiness ${diag.state} at ${label}: ${diag.reason}; currentUrl=${sanitizeUrl(page.url())}; suggestedAction=${diag.suggestedAction}`);
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
		if (a.kind === 'value' && typeof (a.text != null ? a.text : a.value) !== 'string') throw new Error(`assert ${i}: value/text required`);
		if (a.kind === 'count' && !Number.isInteger(a.n)) throw new Error(`assert ${i}: integer n required`);
	}
}

function makeResolveValue(values, valuesFile) {
	if (!values || typeof values !== 'object' || Array.isArray(values)) throw new Error(`values sidecar must be an object: ${valuesFile}`);
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
		} else if (s && s.kind === 'wait' && s.until === 'text' && s.value != null) {
			resolveValue(s.value);
		}
	}
	for (const a of flow.asserts || []) {
		if (!a) continue;
		if (a.kind === 'text') resolveValue(a.value);
		if (a.kind === 'value') resolveValue(a.text != null ? a.text : a.value);
	}
}

function assertPlayableEngine(flow) {
	const raw = flow && flow.engine;
	const engine = raw == null || raw === '' ? 'playwright' : String(raw).trim();
	if (engine === 'playwright') return engine;
	throw new Error(`flow.engine: invalid engine "${engine}" (expected playwright)`);
}

function replayStep(step, resolveValue) {
	const out = { ...step };
	if (out.kind === 'wait' && out.until === 'text' && out.value != null) out.value = resolveValue(out.value);
	return out;
}

function validateLiveIrreversibleGate(steps, gate, onBeforeIrreversible) {
	if (!gate || gate.reversible !== false) return;
	const i = gate.irreversibleAt;
	if (!Number.isInteger(i) || i < 0 || i >= steps.length) {
		throw new Error(`REFUSED: irreversibleAt ${i} out of range [0,${steps.length}) — an effectful action must pin its point-of-no-return (or pass reversible:true) — fail-closed`);
	}
	if (!isEffectfulStep(steps[i])) {
		throw new Error(`REFUSED: irreversibleAt ${i} is "${steps[i].kind}/${steps[i].action || ''}", not an effectful step — the real commit would run un-gated (fail-closed)`);
	}
	if (typeof onBeforeIrreversible !== 'function') {
		throw new Error('REFUSED: a live irreversible run requires an onBeforeIrreversible callback (audit + cap) — fail-closed');
	}
}

function preflightOpenRecords(flow) {
	for (const s of flow.steps || []) {
		if (s && s.kind === 'open_record') readOpenRecordRecipe(s.recipe);
	}
}

function recipePathFor(name) {
	if (typeof name !== 'string' || !SAFE_NAME_RE.test(name)) throw new Error(`invalid open_record recipe "${name || ''}"`);
	return path.join(PROBE_ROOT, 'recipes', `${name}.json`);
}

function readOpenRecordRecipe(name) {
	const recipePath = recipePathFor(name);
	if (!fs.existsSync(recipePath)) throw new Error(`open_record recipe missing: ${path.relative(PROBE_ROOT, recipePath).replace(/\\/g, '/')}`);
	const recipe = readJson(recipePath);
	if (!recipe?.collection?.name) throw new Error(`open_record recipe ${name}: collection.name required`);
	if (!recipe.columns || typeof recipe.columns !== 'object' || !Object.keys(recipe.columns).length) throw new Error(`open_record recipe ${name}: columns required`);
	if (!recipe.key || !Object.prototype.hasOwnProperty.call(recipe.columns, recipe.key)) throw new Error(`open_record recipe ${name}: key must name one of columns`);
	if (recipe.columnIndexes != null) validateColumnIndexes(recipe, name);
	return recipe;
}

function validateColumnIndexes(recipe, name) {
	if (!recipe.columnIndexes || typeof recipe.columnIndexes !== 'object' || Array.isArray(recipe.columnIndexes)) {
		throw new Error(`open_record recipe ${name}: columnIndexes must be an object`);
	}
	const seen = new Set();
	for (const field of Object.keys(recipe.columns)) {
		const n = recipe.columnIndexes[field];
		if (!Number.isInteger(n) || n < 0) throw new Error(`open_record recipe ${name}: columnIndexes.${field} must be a non-negative integer`);
		if (seen.has(n)) throw new Error(`open_record recipe ${name}: duplicate column index ${n}`);
		seen.add(n);
	}
	return recipe.columnIndexes;
}

async function locatorText(locator) {
	return aria.clean(await locator.innerText());
}

async function extractLiveRecipeRows(page, recipe) {
	const role = recipe.collection.role || 'table';
	const rowRole = recipe.collection.row || 'row';
	const table = page.getByRole(role, { name: recipe.collection.name, exact: true });
	await table.first().waitFor({ timeout: 20000 });
	const tableCount = await table.count();
	if (tableCount !== 1) throw new Error(`open_record: ${role} "${recipe.collection.name}" matched ${tableCount} elements (need exactly 1)`);

	const rows = table.first().getByRole(rowRole);
	const rowCount = await rows.count();
	let headerLabels = null;
	const dataRows = [];
	for (let i = 0; i < rowCount; i++) {
		const row = rows.nth(i);
		const headerCells = row.getByRole('columnheader');
		const headerCount = await headerCells.count();
		if (headerCount > 0) {
			if (!headerLabels) {
				headerLabels = [];
				for (let h = 0; h < headerCount; h++) headerLabels.push(aria.norm(await locatorText(headerCells.nth(h))));
			}
			continue;
		}
		const cells = row.getByRole('cell');
		const cellCount = await cells.count();
		if (cellCount > 0) dataRows.push({ row, cells, cellCount });
	}
	const idx = {};
	let headerlessIndexMode = false;
	if (headerLabels) {
		for (const [field, label] of Object.entries(recipe.columns)) {
			const want = aria.norm(label);
			const found = [];
			headerLabels.forEach((h, i) => { if (h === want) found.push(i); });
			if (found.length === 0) throw new Error(`open_record: column "${label}" (${field}) not found in live table`);
			if (found.length > 1) throw new Error(`open_record: column "${label}" (${field}) is ambiguous in live table`);
			idx[field] = found[0];
		}
	} else if (recipe.columnIndexes) {
		Object.assign(idx, validateColumnIndexes(recipe, recipe.collection.name));
		headerlessIndexMode = true;
	} else {
		throw new Error('open_record: no header row found in live table');
	}

	const strip = recipe.strip || {};
	const fields = Object.keys(recipe.columns);
	const maxIdx = Math.max(...fields.map((field) => idx[field]));
	const items = [];
	for (const row of dataRows) {
		if (headerlessIndexMode) {
			if (row.cellCount <= maxIdx) throw new Error(`open_record: row has ${row.cellCount} cells but recipe needs index ${maxIdx}`);
			let headerLike = true;
			for (const field of fields) {
				const got = aria.norm(await locatorText(row.cells.nth(idx[field])));
				const want = aria.norm(recipe.columns[field]);
				if (got !== want) {
					headerLike = false;
					break;
				}
			}
			if (headerLike) continue;
		} else if (row.cellCount !== headerLabels.length) {
			throw new Error(`open_record: row has ${row.cellCount} cells but header has ${headerLabels.length}`);
		}
		const data = {};
		const cellByField = {};
		for (const field of fields) {
			const cell = row.cells.nth(idx[field]);
			data[field] = applyStrip(await locatorText(cell), strip[field]);
			cellByField[field] = cell;
		}
		const key = data[recipe.key];
		if (!key) continue;
		items.push({ key, data, cellByField });
	}
	const seen = new Set();
	for (const item of items) {
		if (seen.has(item.key)) throw new Error(`open_record: recipe key "${recipe.key}" is not unique in live table`);
		seen.add(item.key);
	}
	return { rows: items, idx };
}

async function clickOpenRecordCell(cell, value) {
	const title = cell.getByTitle(value, { exact: true });
	if ((await title.count()) === 1) return title.first().click();
	const text = cell.getByText(value, { exact: true });
	if ((await text.count()) === 1) return text.first().click();
	const link = cell.getByRole('link');
	if ((await link.count()) === 1) return link.first().click();
	const button = cell.getByRole('button');
	if ((await button.count()) === 1) return button.first().click();
	return cell.click();
}

async function waitForOpenRecordRows(page, recipe, rowIndex) {
	const deadline = Date.now() + 20000;
	let last = null;
	while (Date.now() <= deadline) {
		const live = await extractLiveRecipeRows(page, recipe);
		if (live.rows[rowIndex]) return live;
		last = new Error(`open_record: rowIndex ${rowIndex} is out of range (rows=${live.rows.length})`);
		await page.waitForTimeout(500);
	}
	throw last;
}

function openRecordFieldValue(row, recipe, field) {
	return field === 'key' ? row.key : row.data[field];
}

async function waitForOpenRecordRowByFieldValue(page, recipe, field, value) {
	const deadline = Date.now() + 20000;
	let last = null;
	const want = aria.norm(value);
	while (Date.now() <= deadline) {
		const live = await extractLiveRecipeRows(page, recipe);
		const matches = [];
		for (const [rowIndex, row] of live.rows.entries()) {
			if (aria.norm(openRecordFieldValue(row, recipe, field)) === want) matches.push({ rowIndex, row });
		}
		if (matches.length === 1) return { ...live, rowIndex: matches[0].rowIndex };
		last = new Error(matches.length > 1
			? `open_record: field "${field}" value "${value}" matched ${matches.length} rows (need exactly 1)`
			: `open_record: field "${field}" value "${value}" matched no rows`);
		await page.waitForTimeout(500);
	}
	throw last;
}

async function openRecord(page, step) {
	const recipe = readOpenRecordRecipe(step.recipe);
	const source = step.source || 'first';
	const field = step.field || recipe.key;
	if (field !== 'key' && !Object.prototype.hasOwnProperty.call(recipe.columns, field)) throw new Error(`open_record: field "${field}" is not in recipe columns`);
	const live = source === 'field_value'
		? await waitForOpenRecordRowByFieldValue(page, recipe, field, step.value)
		: await waitForOpenRecordRows(page, recipe, source === 'row_index' ? step.rowIndex : (step.rowIndex ?? 0));
	const { rows, rowIndex } = live;
	const row = rows[rowIndex];
	const clickValue = openRecordFieldValue(row, recipe, field);
	const cell = field === 'key' ? row.cellByField[recipe.key] : row.cellByField[field];
	if (!clickValue || !cell) throw new Error(`open_record: rowIndex ${rowIndex} field "${field}" is empty`);
	const sourceLabel = source === 'field_value' ? `field_value:${field}` : source === 'row_index' ? `row_index:${rowIndex}` : 'first';
	console.error(`[play-flow] open_record:${sourceLabel} recipe=${step.recipe} field=${field} key=${row.key} value=${clickValue}`);
	return clickOpenRecordCell(cell, clickValue);
}

async function loadChromium() {
	const pwRequire = createRequire(new URL('../approve/package.json', import.meta.url));
	return pwRequire('playwright').chromium;
}

function playAuditPath() {
	const override = String(process.env.AQA_PLAY_AUDIT_PATH || '').trim();
	return override || path.join(PROBE_ROOT, 'data', 'play-audit.jsonl');
}

function writePlayAuditEvent(event) {
	const auditFile = playAuditPath();
	fs.mkdirSync(path.dirname(auditFile), { recursive: true });
	const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n';
	const fd = fs.openSync(auditFile, 'a');
	try { fs.writeSync(fd, line); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// appendPlayAudit: when a flow declares an irreversible point-of-no-return (flow.irreversibleAt), record
// the commit to an append-only fsync'd trail BEFORE it runs — the play-side analogue of the approve leaf's
// audit, so a gated replay is never un-audited. This is fail-closed for every irreversible gate.
function appendPlayAudit(flowFile, flow, i, step) {
	const startUrl = sanitizeUrl(flow.startUrl);
	try {
		writePlayAuditEvent({ event: 'irreversible-step', flow: flow.name || path.basename(flowFile), startUrl, irreversibleStep: i, action: step && step.action, by: step && step.by, value: step && step.value });
	} catch (e) {
		const reason = String((e && (e.code || e.message)) || e || 'unknown audit write error');
		throw new Error(`play audit write failed before irreversible step ${i} for flow "${flow.name || path.basename(flowFile)}" startUrl=${startUrl} (fail-closed): ${reason}`);
	}
}

function appendPlayEgressAudit(flowFile, flow, verdict) {
	try {
		const event = runtimeEgressDenyEvent(verdict, { flow: flow.name || path.basename(flowFile) });
		event.startUrl = sanitizeUrl(flow.startUrl);
		writePlayAuditEvent(event);
	} catch (e) {
		const reason = String((e && (e.code || e.message)) || e || 'unknown audit write error');
		console.error(`[play-flow] egress audit write failed: ${reason}`);
	}
}

async function newContext(browser, flow) {
	if (!flow.app) return browser.newContext({ serviceWorkers: 'block' });
	const statePath = resolveAuthStatePath(PROBE_ROOT, 'playwright', flow.app);
	if (!fs.existsSync(statePath)) throw new Error(`missing Playwright auth state for app "${flow.app}"; run setup/auth.sh before deterministic replay`);
	return browser.newContext({ storageState: statePath, serviceWorkers: 'block' });
}

function egressRequestInfo(request) {
	const paths = [];
	try {
		if (request.redirectedFrom()) paths.push('redirect');
	} catch {}
	try {
		if (request.isNavigationRequest()) {
			const frame = request.frame();
			if (frame && frame.parentFrame()) paths.push('iframe');
		}
	} catch {}
	const pathLabel = paths.length ? paths.join('+') : 'request';
	return {
		label: paths.length ? `request:${pathLabel}` : 'request',
		path: pathLabel,
	};
}

async function installEgressGuard(ctx, checker, opts = {}) {
	let blocked = null;
	const auditedBlocks = new Set();
	const recordDeny = (verdict) => {
		const audit = verdict.audit || {};
		const key = `${audit.label || ''}|${audit.url || ''}|${verdict.reason || ''}`;
		if (auditedBlocks.has(key)) return;
		auditedBlocks.add(key);
		if (typeof opts.onDeny === 'function') opts.onDeny(verdict);
	};
	const check = (request) => {
		const info = egressRequestInfo(request);
		const verdict = checker.checkUrl(request.url(), info.label, { egressPath: info.path });
		if (!verdict.ok) {
			if (!blocked) blocked = verdict;
			recordDeny(verdict);
		}
		return verdict;
	};
	ctx.on('request', (request) => {
		check(request);
	});
	await ctx.route('**/*', async (route) => {
		const verdict = check(route.request());
		if (!verdict.ok) {
			await route.abort('blockedbyclient').catch(() => {});
			return;
		}
		await route.continue();
	});
	return {
		assertClear() {
			if (blocked) {
				const reason = blocked.reason;
				blocked = null;
				throw new Error(reason);
			}
		},
	};
}

async function gotoWithEgressGuard(page, url, guard) {
	try {
		await page.goto(url, { waitUntil: 'domcontentloaded' });
	} catch (e) {
		if (guard && typeof guard.assertClear === 'function') {
			try { guard.assertClear(); } catch (egressError) { throw egressError; }
		}
		throw e;
	}
	if (guard && typeof guard.assertClear === 'function') guard.assertClear();
}

async function runAsserts(page, asserts, resolveValue) {
	for (let i = 0; i < asserts.length; i++) {
		const a = asserts[i];
		if (a.kind === 'url') {
			const got = page.url();
			if (!assertUrlMatch(got, a.value)) throw new Error(`assert ${i} url: "${got}" does not match "${a.value}"`);
		} else if (a.kind === 'text') {
			const got = await page.locator('body').innerText();
			const want = resolveValue(a.value);
			if (!got.includes(want)) throw new Error(`assert ${i} text: body does not contain "${want}"`);
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
	// VERIFY GATE (irreversibleAt side-door fix): verify re-drives steps ONE AT A TIME with a per-step
	// reversible:true (a single pre-commit step has no point-of-no-return of its own). That per-step opt-out
	// must never reach a flow-declared point-of-no-return, so verify STOPS before flow.irreversibleAt exactly
	// like a dry-run: locators up to the commit get verified/repaired; the commit step and everything after
	// stay un-executed (fail-closed; they are only verifiable by an audited live run through play mode).
	const gate = irreversibleOptsFor(flow);
	const stopBefore = gate.reversible === false ? gate.irreversibleAt : -1;
	if (gate.reversible === false && (!Number.isInteger(stopBefore) || stopBefore < 0 || stopBefore >= nextSteps.length)) {
		throw new Error(`verify REFUSED: irreversibleAt ${stopBefore} out of range [0,${nextSteps.length}) — fail-closed (same rule as replay)`);
	}
	let stoppedBeforeIrreversible = false;
	let verified = 0;
	let repaired = 0;
	let promoted = 0;
	let failedStep = null; // a NON-find step (wait/press/scroll) that failed at replay — a real divergence, not repairable
	for (let i = 0; i < nextSteps.length; i++) {
		if (i === stopBefore) {
			stoppedBeforeIrreversible = true;
			console.error(`[play-flow] verify: stopped BEFORE irreversible step ${i} — ${nextSteps.length - i} step(s) left unverified (fail-closed)`);
			break;
		}
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
				await runSteps(page, [replayStep(r.step, resolveValue)], { reversible: true, dryRun: false, resolveValue, openRecord });
				verified++;
			} else {
				await runSteps(page, [replayStep(s, resolveValue)], { reversible: true, dryRun: false, resolveValue, openRecord });
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
			} else {
				// A non-find step (wait/press/scroll) failing at replay means the journey DIVERGED — it cannot
				// be repaired or promoted (it has no locator). Record it and fail loud below; a silent break here
					// would let verify report status:'ok' on a broken journey.
				failedStep = { i, kind: s.kind, error: String(e && e.message || e) };
			}
			break;
		}
	}
	if (repaired || promoted) {
		const tmp = `${flowFile}.tmp.${process.pid}`;
		fs.writeFileSync(tmp, JSON.stringify({ ...flow, steps: nextSteps }, null, 2) + '\n');
		fs.renameSync(tmp, flowFile);
	}
	if (failedStep) throw new Error(`verify: step ${failedStep.i} (${failedStep.kind}) failed at replay: ${failedStep.error}`);
	return { verified, repaired, promoted, ...(stoppedBeforeIrreversible ? { stoppedBeforeIrreversible: true } : {}) };
}

async function runFlowStepsWithDiagnostics(page, steps, opts) {
	const gate = opts.gate || { reversible: true };
	const onBeforeIrreversible = opts.onBeforeIrreversible;
	validateLiveIrreversibleGate(steps, gate, onBeforeIrreversible);
	const oneStepOpts = {
		dryRun: false,
		reversible: true,
		resolveValue: opts.resolveValue,
		openRecord: opts.openRecord,
	};
	for (let i = 0; i < steps.length; i++) {
		const step = steps[i];
		try {
			if (gate.reversible === false && i === gate.irreversibleAt) await onBeforeIrreversible(i, step);
			await runSteps(page, [replayStep(step, opts.resolveValue)], oneStepOpts);
			if (typeof opts.afterStep === 'function') await opts.afterStep(i, step);
		} catch (e) {
			let egressMsg = '';
			if (typeof opts.assertNoEgressBlocked === 'function') {
				try { opts.assertNoEgressBlocked(); } catch (eg) { egressMsg = errorMessage(eg); }
			}
			const msg = egressMsg || errorMessage(e);
			throw new Error(`step ${i} (${describeStep(step)}) failed: ${msg}; currentUrl=${sanitizeUrl(page.url())}; suggestedAction=${failureSuggestion(msg)}`);
		}
	}
	return { stoppedBeforeIrreversible: false };
}

let summary = null;
try {
	const absFlow = path.resolve(flowPath);
	const flow = readJson(absFlow);
	assertPlayableEngine(flow);
	const stepsValidation = validateSteps(flow.steps);
	if (!stepsValidation.ok) throw new Error('invalid steps: ' + stepsValidation.reason);
	validateAsserts(flow.asserts || []);
	if (!flow.startUrl) throw new Error('startUrl required');
	const policyValidation = assertFlowPolicy(flow, validateOnly || verify ? 'validate' : 'run');
	const egressPhase = validateOnly ? 'validate' : verify ? 'verify' : 'run';
	const egressChecker = createRuntimeFlowEgressChecker(flow, egressPhase);
	egressChecker.assertUrl(flow.startUrl, 'startUrl');
	const valuesFile = valuesPathFor(absFlow);
	const values = readJson(valuesFile, {});
	const resolveValue = makeResolveValue(values, valuesFile);
	preflightValues(flow, resolveValue);
	preflightOpenRecords(flow);
	if (validateOnly) {
		console.error('[play-flow] validate-only OK');
		process.exit(0);
	}

	const chromium = await loadChromium();
	const browser = await chromium.launch({ headless: !headed, channel: process.env.AQA_PW_CHANNEL || 'chrome' });
	try {
		const ctx = await newContext(browser, flow);
		const egressGuard = await installEgressGuard(ctx, egressChecker, {
			onDeny: (verdict) => appendPlayEgressAudit(absFlow, flow, verdict),
		});
		const page = await ctx.newPage();
		await gotoWithEgressGuard(page, flow.startUrl, egressGuard);
		await assertPageAuthReady(page, flow, 'initial navigation');
		if (verify) {
			const v = await verifyFlow(page, flow, absFlow, resolveValue);
			if (v.promoted) throw new Error(`verify promoted ${v.promoted} step(s) to needs_review`);
			summary = { status: 'ok', mode: 'verify', policy: policyValidation, ...v };
		} else {
			// Gate config from the flow itself (NOT a hardcoded reversible:true): a flow that declares an
			// irreversible point-of-no-return replays through the audited fail-closed gate; every other flow
			// stays reversible exactly as before. See approve/flow-runner.mjs irreversibleOptsFor.
			const gate = irreversibleOptsFor(flow);
			const runOpts = {
				resolveValue,
				openRecord,
				gate,
				assertNoEgressBlocked: () => egressGuard.assertClear(),
				afterStep: async (_i, _step) => {
					egressGuard.assertClear();
					await assertPageAuthReady(page, flow, 'post-step');
				},
			};
			if (gate.reversible === false) runOpts.onBeforeIrreversible = (i, step) => appendPlayAudit(absFlow, flow, i, step);
			await runFlowStepsWithDiagnostics(page, flow.steps, runOpts);
			await runAsserts(page, flow.asserts || [], resolveValue);
			summary = { status: 'ok', mode: 'play', flow: flow.name || path.basename(absFlow), policy: policyValidation };
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
