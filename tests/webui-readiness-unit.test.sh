#!/usr/bin/env bash
# Browser-free unit for the read-only P0 readiness summary.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module - <<'NODE'
import { buildP0ReadinessMatrix, buildReleaseChecklist, ciLaneSkeleton, getP0Readiness } from './webui/readiness.js';

const assert = (cond, msg) => { if (!cond) { console.error('  webui-readiness-unit: ' + msg); process.exit(1); } };

const r = await getP0Readiness();
assert(r.valid === true, 'P0 document loads');
assert(r.document === 'dev/active/productization/P0-SERVICE-OPEN.md', 'readiness exposes only relative document path');
assert(r.decision === 'No-Go', 'default decision stays No-Go while checklist is open');
assert(r.state === 'no-go', 'state is no-go, not green');
assert(r.total > 0 && r.open > 0, 'open P0 checklist items are counted');
assert(Array.isArray(r.sections) && r.sections.some((s) => s.id === 'P0-A' && s.open > 0), 'P0 sections parsed');
assert(Array.isArray(r.blockers) && r.blockers.length > 0, 'representative blockers included');
assert(Array.isArray(r.matrix) && r.matrix.length === 8, 'P0 readiness matrix includes P0-A through P0-H');
assert(r.matrix.every((entry) => /^P0-[A-H]$/.test(entry.id)), 'matrix ids are stable P0 section ids');
assert(r.matrix.every((entry) => ['implemented', 'contract-only', 'external-blocked'].includes(entry.status)), 'matrix statuses are machine-readable');
const p0a = r.matrix.find((entry) => entry.id === 'P0-A');
assert(p0a.status === 'contract-only', 'P0-A is contract-only until real IdP integration');
assert(p0a.implemented.some((s) => s.includes('auth gate')), 'matrix lists implemented local controls');
assert(p0a.contractOnly.some((s) => s.includes('claim')), 'matrix lists contract-only local preflights');
assert(p0a.externalBlocked.some((s) => s.includes('IdP')), 'matrix lists external blockers');
assert(p0a.missingEvidence.contractOnly.some((item) => item.requiredCommand.includes('webui-idp-verifier-unit') && item.blockerReason.includes('contract-only')), 'matrix lists contract-only missing evidence with required command and reason');
assert(p0a.missingEvidence.externalBlocked.some((item) => item.requiredEvidence.includes('IdP') && item.blockerReason.includes('externally blocked')), 'matrix lists external-blocked missing evidence with required evidence and reason');
assert(r.matrix.every((entry) => entry.releaseBlocking === true), 'all current P0 sections remain release-blocking');
assert(r.matrix.every((entry) => Array.isArray(entry.releaseBlockingReasons) && entry.releaseBlockingReasons.length > 0), 'matrix gives release-blocking reasons');
assert(r.releaseChecklist.decision === 'No-Go', 'release checklist stays No-Go');
assert(r.releaseChecklist.requiredCommands.includes('bash tests/security-p0-gate.test.sh'), 'release checklist includes security gate');
assert(r.releaseChecklist.requiredCommands.includes('bash run.sh'), 'release checklist includes full deterministic suite');
assert(r.releaseChecklist.operatorOnlyLaneBlockedInCi === true, 'operator-only lane is blocked in CI');
assert(r.releaseChecklist.contractOnly.includes('P0-A'), 'release checklist reports contract-only sections');
assert(r.releaseChecklist.externalBlocked.includes('P0-F'), 'release checklist reports external blockers');
assert(r.releaseChecklist.missingEvidence.some((item) => item.category === 'contract-only' && item.requiredCommand.includes('webui-auth-context-unit')), 'release checklist surfaces contract-only evidence gaps');
assert(r.releaseChecklist.missingEvidence.some((item) => item.category === 'external-blocked' && item.requiredEvidence.includes('operator')), 'release checklist surfaces external-blocked evidence gaps');
assert(r.releaseChecklist.missingEvidenceByCategory.externalBlocked.length > 0, 'release checklist groups external evidence gaps');
assert(Array.isArray(r.ciLanes) && r.ciLanes.some((lane) => lane.id === 'security-p0-gate' && lane.ciAllowed), 'CI lanes include security gate');
assert(r.ciLanes.some((lane) => lane.id === 'operator-only' && lane.ciAllowed === false), 'operator-only lane is explicitly not CI allowed');
assert(r.ciLanes.some((lane) => lane.id === 'dev-integration-readonly' && lane.ciAllowed === false && lane.nonLocalAllowed === true && lane.approvalRequired === false && lane.evidencePackRequired === false), 'development read-only integration lane is manual but does not require owner approval/evidence pack');
assert(r.ciLanes.some((lane) => lane.id === 'staging-readonly' && lane.ciAllowed === false && lane.nonLocalAllowed === true), 'staging-readonly lane is operator-only and non-local');
assert(r.releaseChecklist.developmentIntegrationLanes.includes('dev-integration-readonly'), 'release helper separates development integration lanes');
assert(r.releaseChecklist.developmentIntegrationApprovalRequired === false, 'development integration approval packet is not required');
assert(r.releaseChecklist.ciBlockedLanes.some((lane) => lane.id === 'staging-readonly'), 'release checklist blocks staging-readonly from CI');
assert(r.blockedFlows?.generator === 'blocked-flow-report/v1', 'readiness embeds blocked-flow report metadata');
assert(r.blockedFlows.staticAnalysisOnly === true, 'blocked-flow readiness metadata is static-analysis-only');
assert(r.blockedFlows.liveReplay === false, 'blocked-flow readiness metadata does not replay');
assert(r.blockedFlows.reads.valuesSidecars === false, 'blocked-flow readiness metadata does not read values sidecars');
assert(r.blockedFlows.reads.authStateContents === false, 'blocked-flow readiness metadata does not expose auth state contents');
assert(r.blockedFlows.flows.some((flow) => flow.name === 'hiworks01' && flow.status === 'blocked'), 'hiworks01 is listed as blocked');
assert(r.blockedFlows.flows.some((flow) => flow.name === 'guest_samsungdisplay_com_argos_main_do' && flow.status === 'blocked'), 'Samsung Argos flow is listed as blocked');
assert(r.releaseChecklist.blockedFlows.blocked.includes('hiworks01'), 'release checklist includes blocked flow names');
assert(r.artifactPolicy.rawExport.includes('blocked'), 'raw export is blocked until scan/redaction policy exists');
assert(!JSON.stringify(r).includes('C:\\'), 'absolute Windows paths are not exposed');

const syntheticMatrix = buildP0ReadinessMatrix([{ id: 'P0-A', title: 'Synthetic', total: 1, checked: 1, open: 0, items: [] }]);
assert(syntheticMatrix.length === 8 && syntheticMatrix[0].checklist.total === 1, 'matrix helper merges checklist counts');
assert(syntheticMatrix[0].missingEvidence.contractOnly.length > 0, 'matrix helper carries evidence gaps');
const checklist = buildReleaseChecklist(syntheticMatrix, { sections: [{ id: 'P0-A', open: 0 }] });
assert(checklist.ciBlockedLanes.some((lane) => lane.id === 'operator-only'), 'release helper blocks operator-only lane in CI');
assert(checklist.decision === 'No-Go', 'release helper remains No-Go while evidence gaps remain');
assert(ciLaneSkeleton().every((lane) => typeof lane.id === 'string' && typeof lane.command === 'string'), 'CI lane skeleton is structured');

console.log('  webui-readiness-unit: P0 readiness summary is read-only and no-go by default');
NODE
)
