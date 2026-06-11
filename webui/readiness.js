// webui/readiness.js - read-only P0 service-open checklist summary.
//
// This intentionally reports documentation checklist state only. It is not a security attestation
// and never upgrades external-service readiness to green unless the source checklist is explicitly
// complete and independently reviewed.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { securityModeSummary } from './security.js';
import { getWebuiBlockedFlowReportSafe } from './blocked-flows.js';

const PROBE_ROOT = path.resolve(import.meta.dirname, '..');
const P0_DOC_REL = 'dev/active/productization/P0-SERVICE-OPEN.md';
const P0_DOC = path.join(PROBE_ROOT, P0_DOC_REL);
const MATRIX_STATUSES = Object.freeze(['implemented', 'contract-only', 'external-blocked']);
const P0_EVIDENCE_COMMANDS = Object.freeze({
	'P0-A': Object.freeze({
		contractOnly: 'bash tests/webui-auth-context-unit.test.sh && bash tests/webui-idp-verifier-unit.test.sh && bash tests/webui-rbac-unit.test.sh',
		externalBlocked: 'operator-owned IdP/SSO acceptance evidence',
	}),
	'P0-B': Object.freeze({
		contractOnly: 'bash tests/webui-security-unit.test.sh',
		externalBlocked: 'operator-owned HTTPS cookie/session deployment evidence',
	}),
	'P0-C': Object.freeze({
		contractOnly: 'bash tests/webui-secret-store-unit.test.sh && bash tests/webui-secret-broker-unit.test.sh && bash tests/webui-secret-migration-workflow-unit.test.sh',
		externalBlocked: 'owner-approved KMS/broker migration and rotation evidence',
	}),
	'P0-D': Object.freeze({
		contractOnly: 'bash tests/docker-entrypoint-unit.test.sh && bash tests/novnc-boundary-unit.test.sh && bash tests/novnc-cleanup-unit.test.sh',
		externalBlocked: 'operator-owned TLS noVNC proxy/browser-isolation evidence',
	}),
	'P0-E': Object.freeze({
		contractOnly: 'bash tests/egress-policy-unit.test.sh && bash tests/egress-resolver-unit.test.sh && bash tests/egress-runtime-unit.test.sh',
		externalBlocked: 'platform DNS/IP-at-connection enforcement evidence',
	}),
	'P0-F': Object.freeze({
		contractOnly: 'bash tests/jobs-durable-unit.test.sh && bash tests/audit-outbox-worker-unit.test.sh && bash tests/audit-outbox-scheduler-unit.test.sh && bash tests/runner-api-unit.test.sh',
		externalBlocked: 'deployed runner and production audit webhook delivery evidence',
	}),
	'P0-G': Object.freeze({
		contractOnly: 'bash tests/webui-export-gate-unit.test.sh && bash tests/webui-tenant-deletion-unit.test.sh && bash tests/runner-worker-unit.test.sh',
		externalBlocked: 'production export/tenant-deletion/runner-boundary acceptance evidence',
	}),
	'P0-H': Object.freeze({
		contractOnly: 'bash tests/security-p0-gate.test.sh',
		externalBlocked: 'production-open acceptance evidence',
	}),
});
const P0_MATRIX_OVERLAY = Object.freeze({
	'P0-A': Object.freeze({
		status: 'contract-only',
		implemented: Object.freeze(['external auth gate', 'tenant request context', 'RBAC sensitive-read route matrix']),
		contractOnly: Object.freeze(['IdP provider config validation', 'claim/header mapping validation', 'session expiry/logout helpers']),
		externalBlocked: Object.freeze(['real IdP/SSO login', 'token/assertion verification', 'production user management']),
	}),
	'P0-B': Object.freeze({
		status: 'contract-only',
		implemented: Object.freeze(['same-origin mutation checks', 'deny-by-default CORS helpers', 'security headers']),
		contractOnly: Object.freeze(['HTTPS cookie deployment preflight', 'configured CSRF/session metadata checks']),
		externalBlocked: Object.freeze(['production HTTPS origin/session deployment', 'trusted-origin operator configuration']),
	}),
	'P0-C': Object.freeze({
		status: 'contract-only',
		implemented: Object.freeze(['static secret path denial', 'flow values write-only API', 'encrypted-local test backend']),
		contractOnly: Object.freeze(['external broker/KMS connector contract', 'dry-run migration approval manifest', 'rotation/delete capability checks']),
		externalBlocked: Object.freeze(['real KMS/broker connector', 'approved secret migration/rotation/deletion']),
	}),
	'P0-D': Object.freeze({
		status: 'contract-only',
		implemented: Object.freeze(['external/service noVNC fail-closed startup checks', 'route-stub authorization denials']),
		contractOnly: Object.freeze(['tenant/job/session browser root validation', 'profile/download root validation', 'teardown manifest modeling']),
		externalBlocked: Object.freeze(['real TLS proxy/tunnel', 'container/browser isolation', 'physical profile/download cleanup']),
	}),
	'P0-E': Object.freeze({
		status: 'contract-only',
		implemented: Object.freeze(['allowlist checks for local replay and WebUI jobs', 'control-plane target blocking']),
		contractOnly: Object.freeze(['resolver freshness evidence', 'connection-IP mismatch checks', 'sanitized denial details']),
		externalBlocked: Object.freeze(['platform DNS/IP-at-connection enforcement', 'tenant-owned allowlist administration']),
	}),
	'P0-F': Object.freeze({
		status: 'contract-only',
		implemented: Object.freeze(['SQLite job states', 'durable cancel/reconcile', 'local audit hash chain', 'strict durable enqueue/audit fail-closed mode']),
		contractOnly: Object.freeze(['runner identity/deployment preflight', 'audit outbox metadata', 'JSONL sink verification']),
		externalBlocked: Object.freeze(['deployed external runners', 'production audit webhook connector']),
	}),
	'P0-G': Object.freeze({
		status: 'contract-only',
		implemented: Object.freeze(['artifact metadata tenant scoping', 'export policy gates', 'tombstone manifests', 'outbound runner worker test double']),
		contractOnly: Object.freeze(['signed export references', 'tenant deletion preflight', 'legal/incident hold blocking', 'runner worker deployment contract']),
		externalBlocked: Object.freeze(['production export service', 'tenant deletion across real secrets/browser state/log storage']),
	}),
	'P0-H': Object.freeze({
		status: 'contract-only',
		implemented: Object.freeze(['fixture-only security-p0-gate wrapper', 'local negative coverage for current contracts']),
		contractOnly: Object.freeze(['machine-readable readiness matrix', 'release checklist skeleton', 'CI lane separation metadata', 'development integration read-only lane metadata']),
		externalBlocked: Object.freeze(['production-open staging/live acceptance environments', 'unattended/scheduled/external-runner acceptance']),
	}),
});
const CI_LANES = Object.freeze([
	Object.freeze({
		id: 'security-p0-gate',
		label: 'Security P0 Gate',
		command: 'bash tests/security-p0-gate.test.sh',
		ciAllowed: true,
		liveAuthAllowed: false,
		nonLocalAllowed: false,
		liveActionAllowed: false,
	}),
	Object.freeze({
		id: 'browser-fixture',
		label: 'Browser Fixture Lane',
		command: 'bash tests/play-flow-smoke.test.sh',
		ciAllowed: true,
		liveAuthAllowed: false,
		nonLocalAllowed: false,
		liveActionAllowed: false,
	}),
	Object.freeze({
		id: 'slow-fixture',
		label: 'Slow Fixture E2E Lane',
		command: 'bash tests/rpa-fixture-e2e.test.sh && bash tests/rpa-local-fixture-e2e.test.sh',
		ciAllowed: true,
		liveAuthAllowed: false,
		nonLocalAllowed: false,
		liveActionAllowed: false,
	}),
	Object.freeze({
		id: 'dev-integration-readonly',
		label: 'Development Integration Readonly Lane',
		command: 'bash bin/dev-integration-readonly.sh --allowlist https://host <flow>',
		ciAllowed: false,
		ciBlockedReason: 'developer-selected read-only integration may contact non-local systems; run manually with an exact target allowlist',
		liveAuthAllowed: true,
		nonLocalAllowed: true,
		liveActionAllowed: false,
		developmentIntegrationAllowed: true,
		approvalRequired: false,
		evidencePackRequired: false,
	}),
	Object.freeze({
		id: 'operator-only',
		label: 'Operator-Only Live/Non-Local Lane',
		command: 'operator-approved named flow only',
		ciAllowed: false,
		ciBlockedReason: 'production open, unattended/scheduled, external runner, or live-action paths require operator/owner approval',
		liveAuthAllowed: true,
		nonLocalAllowed: true,
		liveActionAllowed: false,
		developmentIntegrationAllowed: false,
		approvalRequired: true,
		evidencePackRequired: true,
	}),
	Object.freeze({
		id: 'staging-readonly',
		label: 'Operator Staging Readonly Lane',
		command: 'AQA_RUN_MODE=staging AQA_TARGET_ALLOWLIST=https://host bash bin/operator-staging-readonly.sh <flow>',
		ciAllowed: false,
		ciBlockedReason: 'production staging readiness remains operator-owned; development read-only uses dev-integration-readonly',
		liveAuthAllowed: true,
		nonLocalAllowed: true,
		liveActionAllowed: false,
		developmentIntegrationAllowed: false,
		approvalRequired: true,
		evidencePackRequired: true,
	}),
]);

function checkboxState(mark) {
	return /^[xX]$/.test(String(mark || '')) ? 'checked' : 'open';
}

function parseSections(raw) {
	const lines = String(raw || '').split(/\r?\n/);
	const sections = [];
	let current = null;
	for (const line of lines) {
		const heading = /^##\s+(P0-[A-H])\s+(.+)$/.exec(line);
		if (heading) {
			current = { id: heading[1], title: heading[2].trim(), items: [] };
			sections.push(current);
			continue;
		}
		if (/^##\s+/.test(line)) {
			current = null;
			continue;
		}
		const item = /^-\s+\[([ xX])\]\s+(.+)$/.exec(line);
		if (current && item) {
			current.items.push({ text: item[2].trim(), state: checkboxState(item[1]) });
		}
	}
	return sections.map((section) => {
		const total = section.items.length;
		const checked = section.items.filter((item) => item.state === 'checked').length;
		const open = total - checked;
		return {
			id: section.id,
			title: section.title,
			total,
			checked,
			open,
			state: open === 0 && total > 0 ? 'document-complete' : 'no-go',
			items: section.items,
		};
	});
}

function openBlockers(sections, limit = 12) {
	const out = [];
	for (const section of sections) {
		for (const item of section.items) {
			if (item.state !== 'open') continue;
			out.push({ section: section.id, text: item.text });
			if (out.length >= limit) return out;
		}
	}
	return out;
}

function overlayFor(id) {
	const overlay = P0_MATRIX_OVERLAY[id] || {};
	const status = MATRIX_STATUSES.includes(overlay.status) ? overlay.status : 'external-blocked';
	const contractOnly = [...(overlay.contractOnly || [])];
	const externalBlocked = [...(overlay.externalBlocked || [])];
	return {
		status,
		implemented: [...(overlay.implemented || [])],
		contractOnly,
		externalBlocked,
		missingEvidence: {
			contractOnly: evidenceItemsFor(id, 'contract-only', contractOnly),
			externalBlocked: evidenceItemsFor(id, 'external-blocked', externalBlocked),
		},
	};
}

function evidenceItemsFor(id, category, items = []) {
	const commands = P0_EVIDENCE_COMMANDS[id] || {};
	const command = category === 'contract-only'
		? commands.contractOnly || 'bash tests/security-p0-gate.test.sh'
		: commands.externalBlocked || 'operator-owned external acceptance evidence';
	return items.map((item) => ({
		section: id,
		category,
		item,
		requiredCommand: command,
		currentEvidence: category === 'contract-only'
			? 'local deterministic contract/preflight coverage only'
			: 'no local fixture can prove this external/operator-owned control',
		requiredEvidence: category === 'contract-only'
			? 'owner-reviewed acceptance evidence that the contract is implemented in the target deployment'
			: command,
		blockerReason: category === 'contract-only'
			? `${id} remains contract-only until deployment acceptance evidence exists for: ${item}`
			: `${id} remains externally blocked until operator-owned evidence exists for: ${item}`,
	}));
}

export function buildP0ReadinessMatrix(sections = []) {
	const sectionById = new Map(sections.map((section) => [section.id, section]));
	return Object.keys(P0_MATRIX_OVERLAY).map((id) => {
		const section = sectionById.get(id) || { id, title: '', total: 0, checked: 0, open: 0, items: [] };
		const overlay = overlayFor(id);
		const missingEvidence = overlay.missingEvidence;
		const releaseBlockingReasons = [
			...(section.open > 0 ? [`${id} has ${section.open} open checklist item(s)`] : []),
			...missingEvidence.contractOnly.map((item) => item.blockerReason),
			...missingEvidence.externalBlocked.map((item) => item.blockerReason),
		];
		return {
			id,
			title: section.title || id,
			status: overlay.status,
			checklist: {
				total: section.total || 0,
				checked: section.checked || 0,
				open: section.open || 0,
			},
			implemented: overlay.implemented,
			contractOnly: overlay.contractOnly,
			externalBlocked: overlay.externalBlocked,
			missingEvidence,
			releaseBlockingReasons,
			releaseBlocking: releaseBlockingReasons.length > 0 || overlay.status !== 'implemented',
		};
	});
}

export function ciLaneSkeleton() {
	return CI_LANES.map((lane) => ({ ...lane }));
}

export function buildReleaseChecklist(matrix = [], { sections = [], blockedFlows = null } = {}) {
	const openSections = sections.filter((section) => section.open > 0).map((section) => section.id);
	const externalBlocked = matrix.filter((entry) => entry.externalBlocked.length > 0).map((entry) => entry.id);
	const contractOnly = matrix.filter((entry) => entry.status === 'contract-only').map((entry) => entry.id);
	const missingEvidence = matrix.flatMap((entry) => [
		...(entry.missingEvidence?.contractOnly || []),
		...(entry.missingEvidence?.externalBlocked || []),
	]);
	const operatorOnlyLane = CI_LANES.find((lane) => lane.id === 'operator-only');
	const developmentIntegrationLanes = CI_LANES.filter((lane) => lane.developmentIntegrationAllowed).map((lane) => lane.id);
	const blockedFlowEntries = Array.isArray(blockedFlows?.flows) ? blockedFlows.flows : [];
	const blockedFlowNames = blockedFlowEntries.filter((flow) => flow.status === 'blocked').map((flow) => flow.name);
	const operatorOnlyFlowNames = blockedFlowEntries.filter((flow) => flow.status === 'operator-only').map((flow) => flow.name);
	return {
		generator: 'webui-readiness-release-checklist/v1',
		decision: openSections.length || missingEvidence.length || externalBlocked.length || contractOnly.length || blockedFlowNames.length ? 'No-Go' : 'Review Required',
		requiredCommands: [
			'node --check <repo js/mjs/cjs>',
			'bash tests/security-p0-gate.test.sh',
			'bash run.sh',
		],
		ciLanes: ciLaneSkeleton(),
		ciBlockedLanes: CI_LANES.filter((lane) => !lane.ciAllowed).map((lane) => ({
			id: lane.id,
			reason: lane.ciBlockedReason || 'operator-only',
		})),
		operatorOnlyLaneBlockedInCi: !!operatorOnlyLane && !operatorOnlyLane.ciAllowed,
		developmentIntegrationLanes,
		developmentIntegrationApprovalRequired: false,
		openSections,
		contractOnly,
		externalBlocked,
		missingEvidence,
		missingEvidenceByCategory: {
			contractOnly: missingEvidence.filter((item) => item.category === 'contract-only'),
			externalBlocked: missingEvidence.filter((item) => item.category === 'external-blocked'),
		},
		blockedFlows: {
			staticAnalysisOnly: true,
			decision: blockedFlows?.decision || 'OK',
			blocked: blockedFlowNames,
			operatorOnly: operatorOnlyFlowNames,
		},
	};
}

export async function getP0Readiness() {
	let raw = '';
	let updatedAt = 0;
	const blockedFlows = await getWebuiBlockedFlowReportSafe();
	try {
		[raw, updatedAt] = await Promise.all([
			readFile(P0_DOC, 'utf8'),
			stat(P0_DOC).then((s) => s.mtimeMs),
		]);
	} catch (e) {
		return {
			decision: 'No-Go',
			state: 'no-go',
			document: P0_DOC_REL,
			valid: false,
			error: 'P0 checklist unavailable',
			updatedAt: 0,
			sections: [],
			blockers: [],
			matrix: buildP0ReadinessMatrix([]),
			releaseChecklist: buildReleaseChecklist(buildP0ReadinessMatrix([]), { sections: [], blockedFlows }),
			ciLanes: ciLaneSkeleton(),
			artifactPolicy: artifactPolicySummary(),
			securityMode: securityModeSummary(),
			blockedFlows,
		};
	}
	const sections = parseSections(raw);
	const total = sections.reduce((sum, section) => sum + section.total, 0);
	const checked = sections.reduce((sum, section) => sum + section.checked, 0);
	const open = total - checked;
	const matrix = buildP0ReadinessMatrix(sections);
	const releaseChecklist = buildReleaseChecklist(matrix, { sections, blockedFlows });
	const releaseBlocked = open > 0 || matrix.some((entry) => entry.releaseBlocking);
	return {
		decision: releaseBlocked || total === 0 ? 'No-Go' : 'Review Required',
		state: releaseBlocked || total === 0 ? 'no-go' : 'review-required',
		document: P0_DOC_REL,
		valid: true,
		updatedAt,
		total,
		checked,
		open,
		sections,
		blockers: openBlockers(sections),
		matrix,
		releaseChecklist,
		ciLanes: ciLaneSkeleton(),
		artifactPolicy: artifactPolicySummary(),
		securityMode: securityModeSummary(),
		blockedFlows,
	};
}

function artifactPolicySummary() {
	const keep = Number(process.env.WEBUI_KEEP_RUNS);
	return {
		mode: 'read-only metadata',
		rawExport: 'blocked until secret scan and redaction policy is implemented',
		prune: Number.isFinite(keep) && keep >= 0 ? `keep newest ${Math.floor(keep)} artifact run(s)` : 'keep newest 50 artifact run(s)',
	};
}
