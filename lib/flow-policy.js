// lib/flow-policy.js - deterministic run-policy metadata checks for flow replay.
// Pure CommonJS leaf shared by the Playwright runner and browser-free unit tests.
'use strict';

const ENVIRONMENTS = new Set(['local', 'staging', 'live-readonly', 'live-action']);
const RISK_CLASSES = new Set(['read', 'effectful', 'destructive']);
const EFFECTFUL_FIND_ACTIONS = new Set(['click', 'fill', 'type', 'select', 'check', 'uncheck']);
const { validateFlowEgressPolicy, sanitizedUrl } = require('./egress-policy.js');

const OTP_RE = /\b(otp|mfa|2fa|totp|one[-\s]?time|verification\s*code|authenticator|sms\s*code|email\s*code|push\s*approval|recovery\s*code)\b/i;
const DESTRUCTIVE_RE = /\b(submit|approve|approval|transfer|delete|remove|destroy|confirm|pay|purchase|send|archive|revoke|save|commit)\b/i;
const LOGIN_RE = /\b(log\s*in|login|sign\s*in|signin|sso|authenticate)\b/i;
const LOGIN_URL_RE = /\/(login|signin|sign-in|sso|auth)(\/|$|\?|#)/i;
const PERMISSION_RE = /\b(permission\s*denied|access\s*denied|forbidden|not\s*authorized|unauthorized|insufficient\s*permission)\b/i;

function isEffectfulStep(step) {
	return (step && step.kind === 'find' && EFFECTFUL_FIND_ACTIONS.has(step.action)) || (step && step.kind === 'open_record');
}

function fail(reason) {
	return { ok: false, reason };
}

function csvSet(value) {
	return new Set(String(value || '').split(',').map((s) => s.trim()).filter(Boolean));
}

function stepText(step) {
	const values = [];
	const add = (value) => {
		if (value == null) return;
		values.push(String(value));
	};
	if (!step || typeof step !== 'object') return '';
	for (const field of ['by', 'value', 'name', 'text', 'val', 'action']) add(step[field]);
	for (const candidate of Array.isArray(step.candidates) ? step.candidates : []) {
		for (const field of ['by', 'value', 'name']) add(candidate && candidate[field]);
	}
	return values.join(' ');
}

function isOtpStep(step) {
	return step && step.kind === 'find' && ['fill', 'type', 'select'].includes(step.action) && OTP_RE.test(stepText(step));
}

function isDestructiveStep(step) {
	return step && step.kind === 'find' && EFFECTFUL_FIND_ACTIONS.has(step.action) && DESTRUCTIVE_RE.test(stepText(step));
}

function gateKind(flow) {
	if (flow && flow.reversible === true) return 'reversible';
	if (flow && Number.isInteger(flow.irreversibleAt)) return 'irreversible';
	return '';
}

function validateIrreversibleAt(flow) {
	if (!Number.isInteger(flow.irreversibleAt)) return null;
	const steps = Array.isArray(flow.steps) ? flow.steps : [];
	const i = flow.irreversibleAt;
	if (i < 0 || i >= steps.length) return `flow.irreversibleAt ${i} out of range [0,${steps.length})`;
	if (!isEffectfulStep(steps[i])) return `flow.irreversibleAt ${i} must point at an effectful step`;
	return null;
}

function allowlistMatches(flow, allowlist) {
	if (!allowlist || allowlist.size === 0) return false;
	const candidates = new Set();
	if (flow && flow.name) candidates.add(String(flow.name));
	if (flow && flow.app) candidates.add(String(flow.app));
	try { candidates.add(new URL(flow.startUrl).origin); } catch {}
	for (const c of candidates) {
		if (allowlist.has(c)) return true;
	}
	return false;
}

function validateFlowRunPolicy(flow, opts = {}) {
	if (!flow || typeof flow !== 'object' || Array.isArray(flow)) return fail('flow must be an object');

	const environment = flow.environment;
	if (typeof environment !== 'string' || !ENVIRONMENTS.has(environment)) {
		return fail('flow.environment required: local | staging | live-readonly | live-action');
	}

	const riskClass = flow.riskClass;
	if (typeof riskClass !== 'string' || !RISK_CLASSES.has(riskClass)) {
		return fail('flow.riskClass required: read | effectful | destructive');
	}

	const steps = Array.isArray(flow.steps) ? flow.steps : [];
	for (let i = 0; i < steps.length; i++) {
		if (isOtpStep(steps[i])) return fail(`step ${i}: OTP/MFA replay is refused; refresh auth with headed setup/auth.sh`);
	}

	if (environment === 'live-readonly' && riskClass !== 'read') {
		return fail('flow.environment live-readonly only permits riskClass read');
	}
	if (environment === 'live-readonly') {
		for (let i = 0; i < steps.length; i++) {
			if (isDestructiveStep(steps[i])) return fail(`step ${i}: live-readonly flow contains a destructive-looking action`);
		}
	}
	if (environment === 'live-action' && riskClass === 'read') {
		return fail('flow.environment live-action requires riskClass effectful or destructive');
	}

	const badIrreversible = validateIrreversibleAt(flow);
	if (badIrreversible) return fail(badIrreversible);

	const gate = gateKind(flow);
	const requiresGate = environment === 'live-action' || riskClass === 'effectful' || riskClass === 'destructive';
	if (requiresGate && !gate) {
		return fail('live-action/effectful/destructive flows require reversible:true or irreversibleAt');
	}
	if ((environment === 'live-action' || riskClass === 'destructive') && gate !== 'irreversible') {
		return fail('live-action and destructive flows require irreversibleAt; reversible:true is not enough');
	}

	if (opts.phase === 'run') {
		const runMode = String(opts.runMode || 'local');
		if (opts.scheduledNoLive && environment.startsWith('live')) return fail('scheduled runs may not execute live environments');
		if (environment !== 'local' && runMode !== environment) return fail(`run mode "${runMode}" does not allow environment "${environment}"`);
		if (environment === 'live-action') {
			const allowlist = opts.allowlist instanceof Set ? opts.allowlist : csvSet(opts.allowlist);
			if (!allowlistMatches(flow, allowlist)) return fail('live-action flow is not in AQA_LIVE_ALLOWLIST');
			const dryRun = String(opts.liveDryRunPassed || '');
			if (dryRun !== '1' && dryRun !== String(flow.name || '')) {
				return fail('live-action flow requires AQA_LIVE_DRY_RUN_PASSED=1 or the flow name');
			}
			const approve = String(opts.liveActionApprove || '');
			if (approve !== '1' && approve !== String(flow.name || '')) {
				return fail('live-action flow requires AQA_LIVE_ACTION_APPROVE=1 or the flow name');
			}
		}
	}

	const egress = validateFlowEgressPolicy(flow, opts.egress || opts);
	if (!egress.ok) return fail(egress.reason);

	return {
		ok: true,
		environment,
		riskClass,
		gate,
		requiresGate,
		effectfulSteps: steps.filter(isEffectfulStep).length,
		destructiveSteps: steps.filter(isDestructiveStep).length,
		otpSteps: steps.filter(isOtpStep).length,
	};
}

function classifyAuthChallenge(input = {}) {
	const url = String(input.url || '');
	const text = String(input.text || '').slice(0, 20000);
	const haystack = `${url}\n${text}`;
	if (OTP_RE.test(haystack)) {
		return { state: 'otp_required', reason: 'OTP/MFA challenge detected', suggestedAction: 'run headed setup/auth.sh and keep OTP out of deterministic replay' };
	}
	if (PERMISSION_RE.test(haystack)) {
		return { state: 'permission_denied', reason: 'permission denied or insufficient role detected', suggestedAction: 'refresh auth or request the required role before replay' };
	}
	if (LOGIN_URL_RE.test(url) || LOGIN_RE.test(text)) {
		return { state: 'login_redirect', reason: 'login redirect or login page detected', suggestedAction: 'refresh cached auth with setup/auth.sh' };
	}
	return { state: 'ready', reason: '', suggestedAction: '' };
}

function failureSuggestion(message) {
	const s = String(message || '');
	if (/egress policy refused|AQA_TARGET_ALLOWLIST/i.test(s)) return 'add the target origin to AQA_TARGET_ALLOWLIST or use an explicit local/on-prem egress profile for approved fixtures';
	if (/OTP|MFA|login|auth/i.test(s)) return 'refresh auth with headed setup/auth.sh; do not automate OTP in replay';
	if (/permission|forbidden|unauthorized/i.test(s)) return 'check the account role/RBAC grants before replay';
	if (/timeout|waiting|networkidle/i.test(s)) return 'increase step timeoutMs only after adding a deterministic settle signal';
	if (/matched \d+ elements|locator|needs_review/i.test(s)) return 'run verify and resolve locator drift to a unique semantic locator';
	return 'inspect the flow step, current URL, and latest artifact report';
}

module.exports = {
	ENVIRONMENTS,
	RISK_CLASSES,
	isEffectfulStep,
	isOtpStep,
	isDestructiveStep,
	csvSet,
	validateFlowRunPolicy,
	classifyAuthChallenge,
	failureSuggestion,
	sanitizeUrl: sanitizedUrl,
};
