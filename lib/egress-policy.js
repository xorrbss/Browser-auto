// lib/egress-policy.js - deterministic target egress policy for browser-driving code.
// Facade: re-exports the egress-net/allowlist/evidence/validate modules (pure CommonJS leaf).
'use strict';

const {
	PROFILES,
	csvList,
	normalizeProfile,
	hostKind,
	sanitizedUrl,
	sanitizedAuditText,
	deniedUrlAuditDetails,
} = require('./egress-net.js');
const {
	parseAllowlist,
	parseAllowlistRegistry,
} = require('./egress-allowlist.js');
const {
	parseResolvedIpMap,
	parseResolverEvidenceMap,
	validateResolvedIpPolicy,
} = require('./egress-evidence.js');
const {
	validateUrlEgress,
	validateFlowEgressPolicy,
	validateSystemEgressPolicy,
	flowEgressContext,
	systemEgressContext,
	createFlowEgressChecker,
	createSystemEgressChecker,
} = require('./egress-validate.js');

module.exports = {
	PROFILES,
	csvList,
	normalizeProfile,
	parseAllowlist,
	parseAllowlistRegistry,
	parseResolvedIpMap,
	parseResolverEvidenceMap,
	hostKind,
	sanitizedUrl,
	sanitizedAuditText,
	deniedUrlAuditDetails,
	validateResolvedIpPolicy,
	validateUrlEgress,
	validateFlowEgressPolicy,
	validateSystemEgressPolicy,
	flowEgressContext,
	systemEgressContext,
	createFlowEgressChecker,
	createSystemEgressChecker,
};
