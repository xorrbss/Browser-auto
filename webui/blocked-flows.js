// webui/blocked-flows.js - WebUI-safe static blocked-flow metadata.
//
// This wraps bin/blocked-flow-report.mjs for read routes. It stays static:
// no replay/spawn, no auth-state contents, no .values.json sidecars, and no
// artifact reads. Auth freshness, when present, is metadata only.

import path from 'node:path';
import {
	analyzeFlowObject,
	buildBlockedFlowReport,
} from '../bin/blocked-flow-report.mjs';

const PROBE_ROOT = path.resolve(import.meta.dirname, '..');
export const WEBUI_FLOWS_DIR = path.join(PROBE_ROOT, 'flows');

function safeRelativePath(value) {
	if (!value) return '';
	const absolute = path.resolve(String(value));
	const rel = path.relative(PROBE_ROOT, absolute);
	if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
	if (!rel) return '.';
	return path.basename(absolute);
}

function sanitizeBlockedFlow(flow) {
	const blockers = Array.isArray(flow?.blockers) ? flow.blockers.map((blocker) => ({
		code: String(blocker?.code || ''),
		severity: String(blocker?.severity || ''),
		message: String(blocker?.message || ''),
		evidence: blocker?.evidence && typeof blocker.evidence === 'object' ? { ...blocker.evidence } : {},
	})) : [];
	const needsReviewSteps = Array.isArray(flow?.needsReviewSteps) ? flow.needsReviewSteps.map((step) => ({
		index: String(step?.index ?? ''),
		action: String(step?.action || ''),
		kind: String(step?.kind || ''),
		candidateSummary: step?.candidateSummary && typeof step.candidateSummary === 'object'
			? {
				count: Number(step.candidateSummary.count) || 0,
				text: String(step.candidateSummary.text || ''),
				items: Array.isArray(step.candidateSummary.items) ? step.candidateSummary.items.map((item) => ({ ...item })) : [],
				truncated: step.candidateSummary.truncated === true,
			}
			: { count: 0, text: '', items: [] },
		...(step?.frame ? { frame: { by: String(step.frame.by || ''), value: String(step.frame.value || '') } } : {}),
	})) : [];
	const authFreshness = flow?.authFreshness && typeof flow.authFreshness === 'object' ? {
		required: flow.authFreshness.required === true,
		app: String(flow.authFreshness.app || ''),
		status: String(flow.authFreshness.status || ''),
		ready: flow.authFreshness.ready === true,
		present: flow.authFreshness.present === true,
		stale: flow.authFreshness.stale === true,
		staleAfterMs: Number(flow.authFreshness.staleAfterMs) || 0,
		ageMs: Number.isFinite(Number(flow.authFreshness.ageMs)) ? Number(flow.authFreshness.ageMs) : null,
		source: String(flow.authFreshness.source || ''),
		...(flow.authFreshness.blockerReason ? { blockerReason: String(flow.authFreshness.blockerReason) } : {}),
	} : null;
	const handoff = flow?.operatorHandoff && typeof flow.operatorHandoff === 'object' ? {
		operatorOnly: flow.operatorHandoff.operatorOnly === true,
		noLiveReplayRunByReport: flow.operatorHandoff.noLiveReplayRunByReport !== false,
		allowlistChecklist: Array.isArray(flow.operatorHandoff.allowlistChecklist)
			? flow.operatorHandoff.allowlistChecklist.map((item) => ({ ...item }))
			: [],
		requiredGates: Array.isArray(flow.operatorHandoff.requiredGates)
			? flow.operatorHandoff.requiredGates.map((item) => ({ ...item }))
			: [],
		commands: flow.operatorHandoff.commands && typeof flow.operatorHandoff.commands === 'object'
			? { ...flow.operatorHandoff.commands }
			: {},
		nextActions: Array.isArray(flow.operatorHandoff.nextActions)
			? flow.operatorHandoff.nextActions.map((item) => String(item || '')).filter(Boolean)
			: [],
	} : null;
	return {
		file: safeRelativePath(flow?.file),
		name: String(flow?.name || ''),
		status: String(flow?.status || 'blocked'),
		engine: flow?.engine ? String(flow.engine) : '',
		environment: flow?.environment ? String(flow.environment) : '',
		riskClass: flow?.riskClass ? String(flow.riskClass) : '',
		startUrl: flow?.startUrl ? String(flow.startUrl) : '',
		summary: {
			stepCount: Number(flow?.summary?.stepCount) || 0,
			needsReviewCount: Number(flow?.summary?.needsReviewCount) || needsReviewSteps.length,
			blockerCount: Number(flow?.summary?.blockerCount) || blockers.length,
			blockingCount: Number(flow?.summary?.blockingCount) || blockers.filter((b) => b.severity === 'block').length,
			operatorOnlyCount: Number(flow?.summary?.operatorOnlyCount) || blockers.filter((b) => b.severity === 'operator-only').length,
			warningCount: Number(flow?.summary?.warningCount) || blockers.filter((b) => b.severity === 'warn').length,
		},
		needsReviewSteps,
		authFreshness,
		compile: flow?.compile && typeof flow.compile === 'object' ? { ...flow.compile } : null,
		replay: flow?.replay && typeof flow.replay === 'object' ? { ...flow.replay } : null,
		operatorHandoff: handoff,
		blockers,
	};
}

function staticMetadata() {
	return {
		metadataOnly: true,
		staticAnalysisOnly: true,
		liveReplay: false,
		spawnsProcess: false,
		reads: {
			flowJson: true,
			valuesSidecars: false,
			authState: false,
			authStateContents: false,
			authStateFileMetadata: true,
			artifacts: false,
		},
	};
}

export function analyzeBlockedFlowForWebui(flow, { name = '', file = '' } = {}) {
	const relFile = file || path.join(WEBUI_FLOWS_DIR, `${name || flow?.name || 'unknown'}.flow.json`);
	return sanitizeBlockedFlow(analyzeFlowObject(flow, { file: relFile }));
}

export function unavailableBlockedFlowReport(error) {
	return {
		generator: 'blocked-flow-report/v1',
		flowsDir: 'flows',
		valid: false,
		error: String(error?.message || error || 'blocked-flow report unavailable').slice(0, 180),
		decision: 'Review Required',
		totals: { total: 0, runnableLocal: 0, operatorOnly: 0, blocked: 0 },
		flows: [],
		...staticMetadata(),
	};
}

export async function getWebuiBlockedFlowReport({ flowsDir = WEBUI_FLOWS_DIR } = {}) {
	const report = await buildBlockedFlowReport({ flowsDir });
	return {
		generator: report.generator,
		flowsDir: safeRelativePath(report.flowsDir),
		valid: true,
		decision: report.decision,
		totals: { ...report.totals },
		flows: (report.flows || []).map(sanitizeBlockedFlow),
		authFreshness: report.authFreshness ? { ...report.authFreshness } : undefined,
		...staticMetadata(),
	};
}

export async function getWebuiBlockedFlowReportSafe(opts = {}) {
	try {
		return await getWebuiBlockedFlowReport(opts);
	} catch (error) {
		return unavailableBlockedFlowReport(error);
	}
}
