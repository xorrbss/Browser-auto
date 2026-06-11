// Pure helpers for the read-only operations dashboard. Keep this metadata-only:
// callers should pass summaries, not raw secrets, artifact bytes, or auth state.

const SECRET_WORD_RE = /\b(token|secret|password|cookie|otp|mfa|authorization)=([^&\s]+)/gi;
const WINDOWS_PATH_RE = /[A-Za-z]:\\[^\s'"<>]+/g;

export function redactOpsText(value) {
	if (value == null) return '';
	let text = String(value);
	text = text.replace(SECRET_WORD_RE, '$1=[redacted]');
	text = text.replace(WINDOWS_PATH_RE, '[local-path]');
	try {
		const url = new URL(text);
		url.username = '';
		url.password = '';
		url.search = '';
		url.hash = '';
		text = url.toString();
	} catch {
		text = text.replace(/https?:\/\/[^\s?#]+[^\s]*/gi, (match) => {
			try {
				const url = new URL(match);
				url.username = '';
				url.password = '';
				url.search = '';
				url.hash = '';
				return url.toString();
			} catch {
				return match.replace(/[?#].*$/, '');
			}
		});
	}
	return text.slice(0, 220);
}

function countByStatus(items = []) {
	const out = {};
	for (const item of Array.isArray(items) ? items : []) {
		const status = String(item?.status || item?.state || 'unknown');
		out[status] = (out[status] || 0) + 1;
	}
	return out;
}

function joinCounts(counts) {
	const parts = Object.entries(counts).map(([key, value]) => `${key}:${value}`);
	return parts.length ? parts.join(', ') : '-';
}

export function buildOpsDashboardModel({ readiness = null, queue = null, auditSummary = null, rbac = null } = {}) {
	const matrix = Array.isArray(readiness?.matrix) ? readiness.matrix : [];
	const lanes = Array.isArray(readiness?.ciLanes) ? readiness.ciLanes : [];
	const checklist = readiness?.releaseChecklist || {};
	const blockedFlowReport = readiness?.blockedFlows || {};
	const blockedFlows = Array.isArray(blockedFlowReport.flows) ? blockedFlowReport.flows : [];
	const metrics = queue?.metrics || {};
	const releaseBlockers = [
		...(Array.isArray(checklist.openSections) ? checklist.openSections.map((id) => ({ area: id, reason: 'open checklist items' })) : []),
		...(Array.isArray(checklist.contractOnly) ? checklist.contractOnly.map((id) => ({ area: id, reason: 'contract-only' })) : []),
		...(Array.isArray(checklist.externalBlocked) ? checklist.externalBlocked.map((id) => ({ area: id, reason: 'external-blocked' })) : []),
		...blockedFlows
			.filter((flow) => flow.status === 'blocked' || flow.status === 'operator-only')
			.map((flow) => ({
				area: `flow:${flow.name}`,
				reason: `${flow.status}; ${(flow.blockers || []).map((b) => b.code).filter(Boolean).slice(0, 4).join(', ') || 'no blockers'}`,
			})),
	];
	const uniqueBlockers = [];
	const seen = new Set();
	for (const blocker of releaseBlockers) {
		const key = `${blocker.area}:${blocker.reason}`;
		if (seen.has(key)) continue;
		seen.add(key);
		uniqueBlockers.push({
			area: redactOpsText(blocker.area),
			reason: redactOpsText(blocker.reason),
		});
	}
	const p0Rows = matrix.map((entry) => ({
		section: redactOpsText(entry.id),
		status: redactOpsText(entry.status),
		open: entry.checklist?.open ?? 0,
		local: Array.isArray(entry.implemented) ? entry.implemented.length : 0,
		contract: Array.isArray(entry.contractOnly) ? entry.contractOnly.length : 0,
		blocked: Array.isArray(entry.externalBlocked) ? entry.externalBlocked.length : 0,
	}));
	const laneRows = lanes.map((lane) => ({
		lane: redactOpsText(lane.id),
		ci: lane.ciAllowed ? 'allowed' : 'blocked',
		live: lane.liveActionAllowed || lane.liveAuthAllowed || lane.nonLocalAllowed ? 'operator-only' : 'fixture-only',
		command: redactOpsText(lane.command),
	}));
	return {
		tiles: [
			{ label: 'Release Decision', value: redactOpsText(readiness?.decision || 'No-Go'), detail: redactOpsText(checklist.generator || 'readiness API') },
			{ label: 'P0 Matrix', value: joinCounts(countByStatus(matrix)), detail: `${matrix.length} section(s)` },
			{ label: 'Flow Static Analysis', value: `${blockedFlowReport.totals?.blocked || 0}/${blockedFlowReport.totals?.total || 0} blocked`, detail: `${blockedFlowReport.totals?.operatorOnly || 0} operator-only; ${blockedFlowReport.staticAnalysisOnly ? 'no replay' : 'unknown mode'}` },
			{ label: 'CI Lanes', value: `${lanes.filter((lane) => lane.ciAllowed).length}/${lanes.length || 0} allowed`, detail: checklist.operatorOnlyLaneBlockedInCi ? 'operator-only blocked in CI' : 'review required' },
			{ label: 'Queue', value: `${metrics.running || 0} running / ${metrics.queued || 0} queued`, detail: metrics.lastFailureReason ? redactOpsText(metrics.lastFailureReason) : 'no failure signal' },
			{ label: 'Audit', value: auditSummary?.latestAt ? 'events present' : 'no recent events', detail: redactOpsText(auditSummary?.latestAt || 'metadata only') },
			{ label: 'Actor', value: redactOpsText(rbac?.actorId || 'local-operator'), detail: redactOpsText(rbac?.role || 'unknown role') },
		],
		p0Rows,
		laneRows,
		blockerRows: uniqueBlockers.slice(0, 12),
	};
}
