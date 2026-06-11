// lib/egress-subject.js - egress profile resolution and subject/env option collectors.
// Pure CommonJS leaf: no Playwright import, no DNS/network lookup, no secret reads.
'use strict';

const {
	TRUE_RE,
	DEFAULT_RESOLVER_EVIDENCE_MAX_AGE_MS,
	DEFAULT_RESOLVER_EVIDENCE_CLOCK_SKEW_MS,
	csvList,
	isExternalMode,
	normalizeProfile,
	millisOption,
} = require('./egress-net.js');
const {
	entryLooksLikeUrlOrHost,
	parseAllowlist,
	tenantIdFromValue,
} = require('./egress-allowlist.js');

function envProfile(env = process.env) {
	const raw = env.AQA_EGRESS_PROFILE || env.WEBUI_EGRESS_PROFILE || '';
	return raw ? normalizeProfile(raw, '') : '';
}

function defaultFlowProfile(flow, opts = {}) {
	return String(flow?.environment || '') === 'local' ? 'local' : 'public';
}

function defaultSystemProfile(opts = {}) {
	const env = opts.env || process.env;
	if (isExternalMode(env)) return 'public';
	return String(env.AQA_RUN_MODE || 'local') === 'local' ? 'local' : 'public';
}

function profileFromSubject(subject, opts = {}, fallback = 'public') {
	const explicit = opts.profile || subject?.egress?.profile || subject?.egressProfile || subject?.recipe?.egress?.profile || '';
	return normalizeProfile(explicit || envProfile(opts.env || process.env) || fallback, fallback);
}

function collectAllowlist(subject, opts = {}) {
	const env = opts.env || process.env;
	const raw = [
		opts.allowlist,
		env.AQA_TARGET_ALLOWLIST,
		env.AQA_EGRESS_ALLOWLIST,
		env.WEBUI_TARGET_ALLOWLIST,
		subject?.egress?.allowlist,
		subject?.egress?.allowedOrigins,
		subject?.egressAllowlist,
		subject?.targetAllowlist,
		subject?.recipe?.egress?.allowlist,
		subject?.recipe?.egress?.allowedOrigins,
	];
	if (opts.includeLiveOriginAllowlist) {
		raw.push(csvList(env.AQA_LIVE_ALLOWLIST).filter(entryLooksLikeUrlOrHost));
	}
	return parseAllowlist(raw);
}

function collectOperatorAllowlist(opts = {}) {
	const env = opts.env || process.env;
	return parseAllowlist([
		opts.operatorAllowlist,
		env.AQA_TARGET_ALLOWLIST,
		env.AQA_EGRESS_ALLOWLIST,
		env.WEBUI_TARGET_ALLOWLIST,
	]);
}

function collectAllowlistRegistry(subject, opts = {}) {
	const env = opts.env || process.env;
	return [
		opts.allowlistRegistry,
		opts.targetAllowlistRegistry,
		env.AQA_TARGET_ALLOWLIST_REGISTRY,
		env.WEBUI_TARGET_ALLOWLIST_REGISTRY,
		subject?.egress?.allowlistRegistry,
		subject?.egress?.targetAllowlistRegistry,
		subject?.targetAllowlistRegistry,
		subject?.recipe?.egress?.allowlistRegistry,
		subject?.recipe?.egress?.targetAllowlistRegistry,
	].filter((value) => value != null && value !== '');
}

function tenantIdForSubject(subject, opts = {}) {
	const env = opts.env || process.env;
	return tenantIdFromValue(opts.tenantId
		|| subject?.tenantId
		|| subject?.tenant?.id
		|| subject?.actor?.tenantId
		|| env.WEBUI_TENANT_ID
		|| env.AQA_TENANT_ID);
}

function collectResolvedHosts(subject, opts = {}) {
	const env = opts.env || process.env;
	return [
		opts.resolvedHosts,
		opts.resolvedIps,
		opts.resolvedIpMap,
		env.AQA_EGRESS_RESOLVED_IPS,
		env.AQA_TARGET_RESOLVED_IPS,
		env.WEBUI_EGRESS_RESOLVED_IPS,
		subject?.egress?.resolvedHosts,
		subject?.egress?.resolvedIps,
		subject?.egress?.resolvedIpMap,
		subject?.recipe?.egress?.resolvedHosts,
		subject?.recipe?.egress?.resolvedIps,
		subject?.recipe?.egress?.resolvedIpMap,
	].filter((value) => value != null && value !== '');
}

function collectResolverEvidence(subject, opts = {}) {
	const env = opts.env || process.env;
	return [
		opts.resolverEvidence,
		opts.dnsEvidence,
		opts.resolvedEvidence,
		env.AQA_EGRESS_RESOLVER_EVIDENCE,
		env.AQA_EGRESS_DNS_EVIDENCE,
		env.WEBUI_EGRESS_RESOLVER_EVIDENCE,
		subject?.egress?.resolverEvidence,
		subject?.egress?.dnsEvidence,
		subject?.egress?.resolvedEvidence,
		subject?.recipe?.egress?.resolverEvidence,
		subject?.recipe?.egress?.dnsEvidence,
		subject?.recipe?.egress?.resolvedEvidence,
	].filter((value) => value != null && value !== '');
}

function collectConnectionEvidence(subject, opts = {}) {
	const env = opts.env || process.env;
	return [
		opts.connectionIps,
		opts.connectionIp,
		opts.connectedIps,
		opts.connectedIp,
		opts.connectionIpMap,
		opts.requestIpMap,
		env.AQA_EGRESS_CONNECTION_IPS,
		env.AQA_EGRESS_CONNECTION_IP_MAP,
		env.WEBUI_EGRESS_CONNECTION_IPS,
		subject?.egress?.connectionIps,
		subject?.egress?.connectionIpMap,
		subject?.egress?.requestIpMap,
		subject?.recipe?.egress?.connectionIps,
		subject?.recipe?.egress?.connectionIpMap,
		subject?.recipe?.egress?.requestIpMap,
	].filter((value) => value != null && value !== '');
}

function requireResolvedIps(subject, opts = {}) {
	const env = opts.env || process.env;
	if (opts.requireResolvedIps != null) return !!opts.requireResolvedIps;
	const explicit = subject?.egress?.requireResolvedIps ?? subject?.recipe?.egress?.requireResolvedIps;
	if (explicit != null) return !!explicit;
	return TRUE_RE.test(String(env.AQA_EGRESS_REQUIRE_RESOLVED_IPS || env.WEBUI_EGRESS_REQUIRE_RESOLVED_IPS || ''));
}

function requireFreshResolverEvidence(subject, opts = {}) {
	const env = opts.env || process.env;
	if (opts.requireFreshResolverEvidence != null) return !!opts.requireFreshResolverEvidence;
	if (opts.requireFreshDnsEvidence != null) return !!opts.requireFreshDnsEvidence;
	const explicit = subject?.egress?.requireFreshResolverEvidence ?? subject?.egress?.requireFreshDnsEvidence
		?? subject?.recipe?.egress?.requireFreshResolverEvidence ?? subject?.recipe?.egress?.requireFreshDnsEvidence;
	if (explicit != null) return !!explicit;
	return TRUE_RE.test(String(env.AQA_EGRESS_REQUIRE_FRESH_RESOLVER_EVIDENCE || env.AQA_EGRESS_REQUIRE_FRESH_DNS_EVIDENCE || env.WEBUI_EGRESS_REQUIRE_FRESH_RESOLVER_EVIDENCE || ''));
}

function requireConnectionIpEvidence(subject, opts = {}) {
	const env = opts.env || process.env;
	if (opts.requireConnectionIp != null) return !!opts.requireConnectionIp;
	if (opts.requireConnectionIpEvidence != null) return !!opts.requireConnectionIpEvidence;
	const explicit = subject?.egress?.requireConnectionIp ?? subject?.egress?.requireConnectionIpEvidence
		?? subject?.recipe?.egress?.requireConnectionIp ?? subject?.recipe?.egress?.requireConnectionIpEvidence;
	if (explicit != null) return !!explicit;
	return TRUE_RE.test(String(env.AQA_EGRESS_REQUIRE_CONNECTION_IP || env.AQA_EGRESS_REQUIRE_CONNECTION_IP_EVIDENCE || env.WEBUI_EGRESS_REQUIRE_CONNECTION_IP || ''));
}

function resolverEvidenceMaxAgeMs(subject, opts = {}) {
	const env = opts.env || process.env;
	const explicit = opts.resolverEvidenceMaxAgeMs ?? opts.dnsEvidenceMaxAgeMs
		?? subject?.egress?.resolverEvidenceMaxAgeMs ?? subject?.egress?.dnsEvidenceMaxAgeMs
		?? subject?.recipe?.egress?.resolverEvidenceMaxAgeMs ?? subject?.recipe?.egress?.dnsEvidenceMaxAgeMs
		?? env.AQA_EGRESS_RESOLVER_EVIDENCE_MAX_AGE_MS ?? env.AQA_EGRESS_DNS_EVIDENCE_MAX_AGE_MS
		?? env.WEBUI_EGRESS_RESOLVER_EVIDENCE_MAX_AGE_MS;
	return millisOption(explicit, DEFAULT_RESOLVER_EVIDENCE_MAX_AGE_MS);
}

function resolverEvidenceClockSkewMs(subject, opts = {}) {
	const env = opts.env || process.env;
	const explicit = opts.resolverEvidenceClockSkewMs ?? opts.dnsEvidenceClockSkewMs
		?? subject?.egress?.resolverEvidenceClockSkewMs ?? subject?.recipe?.egress?.resolverEvidenceClockSkewMs
		?? env.AQA_EGRESS_RESOLVER_EVIDENCE_CLOCK_SKEW_MS ?? env.WEBUI_EGRESS_RESOLVER_EVIDENCE_CLOCK_SKEW_MS;
	return millisOption(explicit, DEFAULT_RESOLVER_EVIDENCE_CLOCK_SKEW_MS);
}

module.exports = {
	defaultFlowProfile,
	defaultSystemProfile,
	profileFromSubject,
	collectAllowlist,
	collectOperatorAllowlist,
	collectAllowlistRegistry,
	tenantIdForSubject,
	collectResolvedHosts,
	collectResolverEvidence,
	collectConnectionEvidence,
	requireResolvedIps,
	requireFreshResolverEvidence,
	requireConnectionIpEvidence,
	resolverEvidenceMaxAgeMs,
	resolverEvidenceClockSkewMs,
};
