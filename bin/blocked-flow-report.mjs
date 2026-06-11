#!/usr/bin/env node
// Static blocked-flow reporter. It reads committed flow JSON only; it never replays flows
// and never reads sidecars such as .values.json or auth state.

import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const LOCAL_PROTOCOLS = new Set(['data:', 'file:']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const RISKY_ACTION_TEXT = /\b(approve|submit|delete|remove|transfer|save|confirm|pay|send|publish|execute|run)\b/i;
const EFFECTFUL_ACTIONS = new Set(['click', 'fill', 'type', 'select', 'check', 'uncheck']);
const AUTH_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_APP_RE = /^[A-Za-z0-9_-]+$/;
const AUTH_SOURCES = Object.freeze([
	Object.freeze({
		source: 'canonical',
		relDir: path.join('fixtures', 'auth', 'playwright'),
		suffix: '.state.json',
	}),
	Object.freeze({
		source: 'legacy',
		relDir: 'approve',
		suffix: '.pw-state.json',
	}),
]);

function stableSort(items) {
	return [...items].sort((a, b) => a.file.localeCompare(b.file, 'en'));
}

function basenameWithoutFlowSuffix(file) {
	const base = path.basename(file);
	return base.endsWith('.flow.json') ? base.slice(0, -'.flow.json'.length) : base;
}

function sanitizeUrl(raw) {
	if (typeof raw !== 'string' || !raw.trim()) return '';
	try {
		const u = new URL(raw);
		u.username = '';
		u.password = '';
		u.search = '';
		u.hash = '';
		return u.toString();
	} catch {
		return raw.replace(/[?#].*$/, '');
	}
}

function sanitizeText(raw, max = 96) {
	let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
	s = sanitizeUrl(s);
	if (s.length > max) s = `${s.slice(0, max - 1)}...`;
	return s;
}

function originFor(raw) {
	try {
		return new URL(String(raw || '')).origin;
	} catch {
		return '';
	}
}

function isLocalUrl(raw) {
	if (typeof raw !== 'string' || !raw.trim()) return false;
	try {
		const u = new URL(raw);
		if (LOCAL_PROTOCOLS.has(u.protocol)) return true;
		return LOCAL_HOSTS.has(u.hostname);
	} catch {
		return false;
	}
}

function flowRefFor(file, name) {
	const base = `${name || basenameWithoutFlowSuffix(file)}.flow.json`;
	const normalized = String(file || '').replace(/\\/g, '/');
	const parts = normalized.split('/');
	const flowsIndex = parts.lastIndexOf('flows');
	if (flowsIndex >= 0 && parts[flowsIndex + 1]) return `flows/${parts[flowsIndex + 1]}`;
	return `flows/${base}`;
}

function flowNameArg(name) {
	return String(name || '').replace(/[^A-Za-z0-9_-]/g, '');
}

function summarizeStep(step = {}) {
	if (!step || typeof step !== 'object') return 'invalid step';
	if (step.kind === 'find') {
		const bits = [`find ${step.by || '?'}`];
		if (step.value) bits.push(`value="${sanitizeText(step.value, 48)}"`);
		if (step.name) bits.push(`name="${sanitizeText(step.name, 48)}"`);
		if (step.action) bits.push(`action=${step.action}`);
		return bits.join(' ');
	}
	if (step.kind === 'wait') return `wait ${step.until || '?'} ${sanitizeText(step.value || '', 48)}`.trim();
	if (step.kind === 'open_record') return `open_record ${sanitizeText(step.recipe || '', 48)}`.trim();
	return sanitizeText(step.kind || 'unknown step', 80);
}

function addBlocker(out, code, message, severity = 'block', evidence = {}) {
	out.push({
		code,
		severity,
		message,
		evidence: Object.fromEntries(
			Object.entries(evidence)
				.filter(([, v]) => v !== undefined && v !== null && v !== '')
				.map(([k, v]) => [k, typeof v === 'string' ? sanitizeUrl(v) : v]),
		),
	});
}

function candidateSummary(candidates = []) {
	if (!Array.isArray(candidates) || !candidates.length) {
		return {
			count: 0,
			items: [],
			text: 'no candidates captured',
		};
	}
	const items = candidates.slice(0, 6).map((candidate) => {
		const by = sanitizeText(candidate?.by || 'unknown', 24);
		const value = sanitizeText(candidate?.value || '', 72);
		const name = sanitizeText(candidate?.name || '', 72);
		const count = Number.isFinite(Number(candidate?.count)) ? Number(candidate.count) : null;
		return {
			by,
			...(value ? { value } : {}),
			...(name ? { name } : {}),
			...(count !== null ? { count } : {}),
			summary: [
				by,
				value ? `"${value}"` : '',
				name ? `name="${name}"` : '',
				count !== null ? `count=${count}` : '',
			].filter(Boolean).join(' '),
		};
	});
	return {
		count: candidates.length,
		items,
		truncated: candidates.length > items.length,
		text: items.map((item) => item.summary).join('; ') || 'candidates captured without semantic summary',
	};
}

function flattenSteps(steps = []) {
	const out = [];
	const visit = (items, prefix = []) => {
		if (!Array.isArray(items)) return;
		items.forEach((step, index) => {
			const current = [...prefix, index];
			out.push({ step: step || {}, index: current.join('.') });
			for (const key of ['steps', 'children']) {
				if (Array.isArray(step?.[key])) visit(step[key], current);
			}
		});
	};
	visit(steps);
	return out;
}

function isEffectfulStep(step) {
	return (step && step.kind === 'find' && EFFECTFUL_ACTIONS.has(step.action)) || (step && step.kind === 'open_record');
}

function validIrreversibleGate(flow, steps) {
	if (flow.reversible === true) return true;
	const i = Number(flow.irreversibleAt);
	if (!Number.isInteger(i) || i < 0 || i >= steps.length) return false;
	const step = steps[i]?.step || {};
	if (step.needs_review) return false;
	return isEffectfulStep(step);
}

function classify(flow, blockers) {
	if (blockers.some((b) => b.severity === 'block')) return 'blocked';
	if (blockers.some((b) => b.severity === 'operator-only')) return 'operator-only';
	const env = String(flow.environment || 'local');
	if (env !== 'local') return 'operator-only';
	return 'runnable-local';
}

function localAuthCandidates(repoRoot, app) {
	return AUTH_SOURCES.map((source) => ({
		source: source.source,
		file: path.join(repoRoot, source.relDir, `${app}${source.suffix}`),
	}));
}

async function authFreshnessForApp(app, options = {}) {
	const nowMs = Number(options.nowMs ?? options.now ?? Date.now());
	const staleAfterMs = Number(options.authStaleAfterMs ?? AUTH_STALE_AFTER_MS);
	const repoRoot = path.resolve(options.repoRoot || process.cwd());
	if (!app) {
		return {
			required: false,
			app: '',
			status: 'not-required',
			ready: true,
			present: false,
			stale: false,
			staleAfterMs,
		};
	}
	if (!AUTH_APP_RE.test(String(app))) {
		return {
			required: true,
			app: String(app),
			status: 'missing',
			ready: false,
			present: false,
			stale: false,
			staleAfterMs,
			blockerReason: 'app name is not valid for local auth-state lookup',
			sourcesChecked: AUTH_SOURCES.map((source) => source.source),
		};
	}
	const summaries = [];
	for (const candidate of localAuthCandidates(repoRoot, app)) {
		try {
			const st = await stat(candidate.file);
			const modifiedAt = Number(st.mtimeMs || 0);
			const ageMs = Number.isFinite(modifiedAt) && modifiedAt > 0 ? Math.max(0, nowMs - modifiedAt) : null;
			const stale = Number.isFinite(ageMs) && ageMs >= staleAfterMs;
			summaries.push({
				source: candidate.source,
				present: true,
				status: stale ? 'stale' : 'ready',
				ready: !stale,
				stale,
				ageMs,
				modifiedAt,
			});
		} catch {
			summaries.push({
				source: candidate.source,
				present: false,
				status: 'missing',
				ready: false,
				stale: false,
				ageMs: null,
				modifiedAt: 0,
			});
		}
	}
	const selected = summaries.find((s) => s.present && s.status === 'ready')
		|| summaries.find((s) => s.present)
		|| summaries[0];
	const status = selected?.status || 'missing';
	const blockerReason = status === 'missing'
		? 'headed setup/auth.sh must refresh operator-owned auth before replay'
		: status === 'stale'
			? 'cached auth is stale; rerun headed setup/auth.sh before replay'
			: '';
	return {
		required: true,
		app: String(app),
		status,
		ready: status === 'ready',
		present: selected?.present === true,
		stale: status === 'stale',
		staleAfterMs,
		ageMs: selected?.ageMs ?? null,
		source: selected?.source || '',
		sourcesChecked: summaries.map((s) => s.source),
		...(blockerReason ? { blockerReason } : {}),
	};
}

function authFreshnessFromOptions(flow, options = {}) {
	if (!flow?.app) return {
		required: false,
		app: '',
		status: 'not-required',
		ready: true,
		present: false,
		stale: false,
		staleAfterMs: Number(options.authStaleAfterMs ?? AUTH_STALE_AFTER_MS),
	};
	const supplied = options.authFreshness || options.authReadiness;
	if (supplied && typeof supplied === 'object') {
		const status = String(supplied.status || supplied.state || (supplied.ready ? 'ready' : 'missing')).replace(/-auth$/, '');
		return {
			required: true,
			app: String(flow.app),
			status,
			ready: status === 'ready',
			present: supplied.present === true,
			stale: supplied.stale === true || status === 'stale',
			staleAfterMs: Number(supplied.staleAfterMs ?? options.authStaleAfterMs ?? AUTH_STALE_AFTER_MS),
			ageMs: Number.isFinite(Number(supplied.ageMs)) ? Number(supplied.ageMs) : null,
			source: supplied.source ? String(supplied.source) : '',
			...(supplied.blockerReason ? { blockerReason: String(supplied.blockerReason) } : {}),
		};
	}
	return {
		required: true,
		app: String(flow.app),
		status: 'not-evaluated',
		ready: false,
		present: false,
		stale: false,
		staleAfterMs: Number(options.authStaleAfterMs ?? AUTH_STALE_AFTER_MS),
		blockerReason: 'auth freshness is evaluated by buildBlockedFlowReport metadata scan',
	};
}

function gateItemsFor(flow, authFreshness) {
	const environment = String(flow?.environment || '');
	const riskClass = String(flow?.riskClass || '');
	const startOrigin = originFor(flow?.startUrl || '');
	const liveAction = environment === 'live-action';
	const nonLocal = environment && environment !== 'local';
	const app = flow?.app ? String(flow.app) : '';
	const gates = [];
	if (app) {
		gates.push({
			id: 'auth-freshness',
			required: true,
			status: authFreshness.status,
			requiredCommand: `bash setup/auth.sh ${app} <login-url> '<success-url>'`,
			blockerReason: authFreshness.blockerReason || (authFreshness.ready ? '' : 'operator-owned auth must be ready before replay'),
		});
	}
	if (nonLocal || (flow?.startUrl && !isLocalUrl(flow.startUrl))) {
		gates.push({
			id: 'target-allowlist',
			required: true,
			status: 'operator-required',
			env: 'AQA_TARGET_ALLOWLIST',
			value: startOrigin || '<origin>',
			blockerReason: 'operator must approve the exact target origin before validate/replay',
		});
		gates.push({
			id: 'resolver-evidence',
			required: true,
			status: 'operator-required',
			env: 'AQA_EGRESS_RESOLVER_EVIDENCE',
			value: '<fresh resolver evidence JSON>',
			blockerReason: 'public/non-local targets require fresh resolver and connection-IP evidence',
		});
	}
	if (liveAction) {
		gates.push({
			id: 'live-allowlist',
			required: true,
			status: 'operator-required',
			env: 'AQA_LIVE_ALLOWLIST',
			value: flow?.name || app || startOrigin || '<flow-or-app-or-origin>',
			blockerReason: 'live-action scope must be explicitly allowlisted',
		});
		gates.push({
			id: 'dry-run-evidence',
			required: true,
			status: 'operator-required',
			env: 'AQA_LIVE_DRY_RUN_PASSED',
			value: flow?.name || '1',
			blockerReason: 'matching dry-run evidence is required before live-action replay',
		});
		gates.push({
			id: 'owner-approval',
			required: true,
			status: 'owner-required',
			env: 'AQA_LIVE_ACTION_APPROVE',
			value: flow?.name || '1',
			blockerReason: 'target owner/operator approval is required before crossing the irreversible gate',
		});
	}
	if (riskClass === 'destructive') {
		gates.push({
			id: 'destructive-owner-review',
			required: true,
			status: 'owner-required',
			blockerReason: 'destructive risk requires owner review even after technical gates pass',
		});
	}
	return gates;
}

function commandsFor(flow, { file = '', compileBlockedReason = '', replayBlockedReason = '' } = {}) {
	const name = flowNameArg(flow?.name || basenameWithoutFlowSuffix(file));
	const flowRef = flowRefFor(file, name);
	const environment = String(flow?.environment || 'local');
	const origin = originFor(flow?.startUrl || '') || '<origin>';
	const resolverEnv = "AQA_EGRESS_RESOLVER_EVIDENCE='<fresh resolver evidence JSON>'";
	const allowlistEnv = `AQA_TARGET_ALLOWLIST=${origin}`;
	const commands = {
		validateOnly: `${allowlistEnv} ${resolverEnv} node bin/play-flow.mjs --flow ${flowRef} --validate-only`,
		compile: `bash bin/probe-record.sh compile ${flowRef}`,
	};
	if (environment === 'staging' || environment === 'live-readonly') {
		commands.replay = `AQA_RUN_MODE=${environment} ${allowlistEnv} ${resolverEnv} bash bin/operator-staging-readonly.sh ${name}`;
		commands.validateReplayEnvelope = `AQA_RUN_MODE=${environment} ${allowlistEnv} ${resolverEnv} bash bin/operator-staging-readonly.sh --validate-only ${name}`;
	} else if (environment === 'live-action') {
		const liveAllow = flow?.name || flow?.app || origin;
		commands.replay = [
			'AQA_RUN_MODE=live-action',
			allowlistEnv,
			resolverEnv,
			`AQA_LIVE_ALLOWLIST=${liveAllow}`,
			`AQA_LIVE_DRY_RUN_PASSED=${flow?.name || '1'}`,
			`AQA_LIVE_ACTION_APPROVE=${flow?.name || '1'}`,
			`node bin/play-flow.mjs --flow ${flowRef}`,
		].join(' ');
	} else {
		commands.replay = `bash tests/${name}.test.sh`;
	}
	return {
		...commands,
		...(compileBlockedReason ? { compileBlockedReason } : {}),
		...(replayBlockedReason ? { replayBlockedReason } : {}),
	};
}

function compileBlockedReason(blockers = []) {
	const structural = blockers.filter((blocker) => blocker.severity === 'block' && !['auth_refresh_required', 'non_local_operator_only'].includes(blocker.code));
	if (!structural.length) return '';
	return structural.map((blocker) => `${blocker.code}: ${blocker.message}`).join('; ');
}

function replayBlockedReason(flow, blockers = [], authFreshness) {
	const hard = blockers.filter((blocker) => blocker.severity === 'block');
	if (hard.length) return hard.map((blocker) => `${blocker.code}: ${blocker.message}`).join('; ');
	if (authFreshness?.required && !authFreshness.ready) return authFreshness.blockerReason || `auth status is ${authFreshness.status}`;
	const operator = blockers.filter((blocker) => blocker.severity === 'operator-only');
	if (operator.length) return operator.map((blocker) => `${blocker.code}: ${blocker.message}`).join('; ');
	if (String(flow?.environment || 'local') !== 'local') return 'operator-only non-local replay requires explicit run mode and target allowlist';
	return '';
}

export function analyzeFlowObject(flow, options = {}) {
	const { file = '' } = options;
	const relFile = file || `${flow?.name || 'unknown'}.flow.json`;
	const name = String(flow?.name || basenameWithoutFlowSuffix(relFile));
	const engine = flow?.engine == null || flow.engine === '' ? 'playwright' : String(flow.engine);
	const environment = String(flow?.environment || '');
	const riskClass = String(flow?.riskClass || '');
	const startUrl = sanitizeUrl(flow?.startUrl || '');
	const steps = flattenSteps(flow?.steps);
	const blockers = [];
	const needsReviewSteps = [];

	if (!flow || typeof flow !== 'object' || Array.isArray(flow)) {
		addBlocker(blockers, 'invalid_flow_object', 'Flow root must be a JSON object.');
		return { file: relFile, name, status: 'blocked', blockers, summary: { blockerCount: blockers.length } };
	}

	if (engine !== 'playwright') {
		addBlocker(blockers, 'invalid_engine', 'Flow engine must be playwright.', 'block', { engine });
	}

	if (!environment) {
		addBlocker(blockers, 'missing_environment', 'Flow environment is required for new work.');
	} else if (!['local', 'staging', 'live-readonly', 'live-action'].includes(environment)) {
		addBlocker(blockers, 'invalid_environment', 'Flow environment is not recognized.', 'block', { environment });
	}

	if (!riskClass) {
		addBlocker(blockers, 'missing_risk_class', 'Flow riskClass is required for new work.');
	} else if (!['read', 'effectful', 'destructive'].includes(riskClass)) {
		addBlocker(blockers, 'invalid_risk_class', 'Flow riskClass is not recognized.', 'block', { riskClass });
	}

	if (!startUrl) {
		addBlocker(blockers, 'missing_start_url', 'Flow startUrl is required.');
	}

	if (!Array.isArray(flow.steps)) {
		addBlocker(blockers, 'missing_steps', 'Flow steps must be an array.');
	}

	for (const { step, index } of steps) {
		if (step.needs_review === true) {
			const candidates = candidateSummary(step.candidates);
			needsReviewSteps.push({
				index,
				action: step.action || '',
				kind: step.kind || '',
				candidateSummary: candidates,
				...(step.frame ? { frame: { by: step.frame.by, value: sanitizeText(step.frame.value || '', 96) } } : {}),
			});
			addBlocker(blockers, 'needs_review', 'Unresolved needs_review step must be repaired before compile/replay.', 'block', {
				step: index,
				stepIndex: index,
				candidateCount: candidates.count,
				candidateSummary: candidates.text,
			});
		}
		const text = `${step.action || ''} ${step.name || ''} ${step.value || ''}`;
		if (environment === 'live-readonly' && RISKY_ACTION_TEXT.test(text)) {
			addBlocker(blockers, 'live_readonly_effectful_signal', 'Live-readonly flow contains an effectful-looking action.', 'block', { step: index });
		}
	}

	const authFreshness = authFreshnessFromOptions(flow, options);
	if (authFreshness.required && ['missing', 'stale', 'invalid'].includes(authFreshness.status)) {
		addBlocker(blockers, 'auth_refresh_required', 'App-bound replay requires ready operator-owned Playwright auth.', 'block', {
			app: authFreshness.app,
			status: authFreshness.status,
			reason: authFreshness.blockerReason || 'auth freshness is not ready',
		});
	}

	if (environment === 'live-action') {
		addBlocker(blockers, 'live_action_operator_only', 'Live-action flows require operator approval and must never run in CI.', 'operator-only', { startUrl });
		if (!['effectful', 'destructive'].includes(riskClass)) {
			addBlocker(blockers, 'live_action_risk_mismatch', 'Live-action flow must declare effectful or destructive risk.');
		}
		if (!validIrreversibleGate(flow, steps)) {
			addBlocker(blockers, 'missing_irreversible_gate', 'Live-action flow must pin a valid irreversibleAt gate or explicitly be reversible.');
		} else if (Number.isInteger(Number(flow.irreversibleAt))) {
			const gateStep = steps[Number(flow.irreversibleAt)]?.step || {};
			addBlocker(blockers, 'irreversible_at_warning', 'irreversibleAt marks the point of no return; replay requires owner approval and dry-run evidence before this step.', 'warn', {
				irreversibleAt: Number(flow.irreversibleAt),
				stepSummary: summarizeStep(gateStep),
			});
		}
	}

	if (riskClass === 'destructive') {
		addBlocker(blockers, 'destructive_operator_only', 'Destructive flows require owner/operator approval.', 'operator-only');
	}

	if (environment && environment !== 'local') {
		addBlocker(blockers, 'non_local_operator_only', 'Non-local flows are operator-only and skipped by default CI.', 'operator-only', { startUrl });
	} else if (startUrl && !isLocalUrl(flow.startUrl)) {
		addBlocker(blockers, 'non_local_url_in_local_flow', 'Local flow startUrl is not local/file/data.', 'block', { startUrl });
	}

	const status = classify({ environment }, blockers);
	const compileReason = compileBlockedReason(blockers);
	const replayReason = replayBlockedReason(flow, blockers, authFreshness);
	return {
		file: relFile,
		name,
		status,
		engine,
		environment: environment || 'missing',
		riskClass: riskClass || 'missing',
		startUrl,
		summary: {
			stepCount: steps.length,
			needsReviewCount: needsReviewSteps.length,
			blockerCount: blockers.length,
			blockingCount: blockers.filter((b) => b.severity === 'block').length,
			operatorOnlyCount: blockers.filter((b) => b.severity === 'operator-only').length,
			warningCount: blockers.filter((b) => b.severity === 'warn').length,
		},
		needsReviewSteps,
		authFreshness,
		compile: {
			blocked: !!compileReason,
			blockedReason: compileReason,
			requiredCommand: `bash bin/probe-record.sh compile ${flowRefFor(relFile, name)}`,
		},
		replay: {
			blocked: status !== 'runnable-local',
			blockedReason: replayReason,
			operatorOnly: status === 'operator-only' || environment !== 'local',
		},
		operatorHandoff: {
			operatorOnly: status !== 'runnable-local' || environment !== 'local' || !!flow?.app,
			noLiveReplayRunByReport: true,
			allowlistChecklist: gateItemsFor(flow, authFreshness).filter((gate) => gate.id === 'target-allowlist' || gate.id === 'resolver-evidence'),
			requiredGates: gateItemsFor(flow, authFreshness),
			commands: commandsFor(flow, { file: relFile, compileBlockedReason: compileReason, replayBlockedReason: replayReason }),
			nextActions: nextActionsFor({ flow, needsReviewSteps, authFreshness, compileReason, replayReason }),
		},
		blockers,
	};
}

function nextActionsFor({ flow, needsReviewSteps, authFreshness, compileReason, replayReason }) {
	const actions = [];
	if (needsReviewSteps.length) {
		actions.push('Resolve each needs_review step to a unique semantic locator before compile or replay.');
	}
	if (authFreshness?.required && !authFreshness.ready) {
		actions.push('Refresh operator-owned auth with headed setup/auth.sh; do not automate OTP/MFA.');
	}
	if (String(flow?.environment || '') === 'live-action') {
		actions.push('Collect matching dry-run evidence and target-owner approval before live-action replay.');
		actions.push('Confirm irreversibleAt with the owner and keep the live batch capped.');
	}
	if (replayBlockedReason && !compileReason) {
		actions.push('Run only from an operator shell with explicit run mode, target allowlist, and fresh resolver evidence.');
	}
	if (!actions.length) actions.push('Run the generated validate-only command before any operator replay.');
	return actions;
}

async function readFlowFile(file, options = {}) {
	try {
		const raw = await readFile(file, 'utf8');
		const flow = JSON.parse(raw);
		const authFreshness = flow?.app ? await authFreshnessForApp(flow.app, options) : null;
		return analyzeFlowObject(flow, { file, authFreshness, authStaleAfterMs: options.authStaleAfterMs });
	} catch (error) {
		return {
			file,
			name: basenameWithoutFlowSuffix(file),
			status: 'blocked',
			blockers: [{
				code: 'invalid_json',
				severity: 'block',
				message: 'Flow JSON could not be parsed.',
				evidence: { error: String(error?.message || error).slice(0, 160) },
			}],
			summary: { stepCount: 0, blockerCount: 1, blockingCount: 1, operatorOnlyCount: 0 },
		};
	}
}

function repoRootFor(flowsDir, repoRoot) {
	if (repoRoot) return path.resolve(repoRoot);
	const resolved = path.resolve(flowsDir);
	return path.basename(resolved).toLowerCase() === 'flows' ? path.dirname(resolved) : process.cwd();
}

export async function buildBlockedFlowReport({ flowsDir = path.resolve('flows'), repoRoot = '', nowMs = Date.now(), authStaleAfterMs = AUTH_STALE_AFTER_MS } = {}) {
	const root = repoRootFor(flowsDir, repoRoot);
	const entries = await readdir(flowsDir, { withFileTypes: true });
	const files = entries
		.filter((entry) => entry.isFile() && entry.name.endsWith('.flow.json'))
		.map((entry) => path.join(flowsDir, entry.name));
	const flows = stableSort(await Promise.all(files.map((file) => readFlowFile(file, { repoRoot: root, nowMs, authStaleAfterMs }))));
	const totals = {
		total: flows.length,
		runnableLocal: flows.filter((f) => f.status === 'runnable-local').length,
		operatorOnly: flows.filter((f) => f.status === 'operator-only').length,
		blocked: flows.filter((f) => f.status === 'blocked').length,
	};
	return {
		generator: 'blocked-flow-report/v1',
		flowsDir,
		metadataOnly: true,
		staticAnalysisOnly: true,
		authStateContentsRead: false,
		liveReplay: false,
		authFreshness: {
			mode: 'file-metadata-only',
			staleAfterMs: authStaleAfterMs,
			statuses: ['missing', 'stale', 'ready'],
			secretPathsExposed: false,
			rawCookieExposed: false,
		},
		decision: totals.blocked > 0 || totals.operatorOnly > 0 ? 'Review Required' : 'OK',
		totals,
		flows,
	};
}

export function renderMarkdownReport(report) {
	const lines = [
		'# Blocked Flow Report',
		'',
		`Decision: ${report.decision}`,
		`Totals: ${report.totals.total} flow(s), ${report.totals.runnableLocal} runnable-local, ${report.totals.operatorOnly} operator-only, ${report.totals.blocked} blocked`,
		'Static analysis only; no replay, auth-state contents, values sidecars, or raw cookies are read.',
		'',
		'| Flow | Status | Blockers |',
		'| --- | --- | --- |',
	];
	for (const flow of report.flows) {
		const blockers = flow.blockers.length
			? flow.blockers.map((b) => b.code).join(', ')
			: 'none';
		lines.push(`| ${flow.name} | ${flow.status} | ${blockers} |`);
	}
	lines.push('');
	lines.push('## Details');
	for (const flow of report.flows) {
		if (!flow.blockers.length && !flow.needsReviewSteps?.length && !flow.operatorHandoff?.requiredGates?.length) continue;
		lines.push('');
		lines.push(`### ${flow.name}`);
		if (flow.authFreshness?.required) {
			lines.push(`- Auth freshness: ${flow.authFreshness.status}`);
		}
		if (flow.compile?.blockedReason) {
			lines.push(`- Compile blocked: ${flow.compile.blockedReason}`);
		}
		if (flow.replay?.blockedReason) {
			lines.push(`- Replay blocked: ${flow.replay.blockedReason}`);
		}
		for (const step of flow.needsReviewSteps || []) {
			lines.push(`- needs_review step ${step.index}: ${step.candidateSummary?.text || 'no candidate summary'}`);
		}
		for (const blocker of flow.blockers.filter((b) => b.code === 'irreversible_at_warning')) {
			lines.push(`- irreversibleAt warning: step ${blocker.evidence?.irreversibleAt}; ${blocker.evidence?.stepSummary || 'review gate before replay'}`);
		}
		for (const gate of flow.operatorHandoff?.requiredGates || []) {
			const env = gate.env ? ` ${gate.env}` : '';
			lines.push(`- Required gate ${gate.id}${env}: ${gate.status}${gate.blockerReason ? `; ${gate.blockerReason}` : ''}`);
		}
	}
	return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
	const out = { flowsDir: path.resolve('flows'), format: 'json', output: '' };
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === '--flows') out.flowsDir = path.resolve(argv[++i] || '');
		else if (arg === '--format') out.format = argv[++i] || 'json';
		else if (arg === '--output') out.output = path.resolve(argv[++i] || '');
		else if (arg === '--help' || arg === '-h') out.help = true;
		else throw new Error(`unknown argument: ${arg}`);
	}
	if (!['json', 'markdown'].includes(out.format)) throw new Error('--format must be json or markdown');
	return out;
}

function usage() {
	return [
		'usage: node bin/blocked-flow-report.mjs [--flows flows] [--format json|markdown] [--output file]',
		'',
		'Static analysis only. Does not replay flows, read auth state, or read .values.json sidecars.',
	].join('\n');
}

async function main(argv = process.argv.slice(2)) {
	const args = parseArgs(argv);
	if (args.help) {
		console.log(usage());
		return;
	}
	const report = await buildBlockedFlowReport({ flowsDir: args.flowsDir });
	const body = args.format === 'markdown' ? renderMarkdownReport(report) : `${JSON.stringify(report, null, 2)}\n`;
	if (args.output) await writeFile(args.output, body, 'utf8');
	else process.stdout.write(body);
	if (report.totals.blocked > 0) process.exitCode = 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
	main().catch((error) => {
		console.error(error?.message || error);
		process.exit(2);
	});
}
