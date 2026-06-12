#!/usr/bin/env bash
# Lightweight manual development lane for read-only system integration.
# It reuses bin/play-flow.mjs and the compiled test wrapper; it does not bypass
# flow policy, egress policy, auth readiness, needs_review, or live-action gates.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORIGINAL_ARGS=( "$@" )

usage() {
	cat <<'EOF'
Usage: bash bin/dev-integration-readonly.sh [--validate-only] [--headed] [--keep-open-ms N] [--allowlist https://host[:port]] <flow-name|flows/name.flow.json>

Development-only read lane:
  - accepts local, staging, and live-readonly flows with riskClass read
  - derives an exact AQA_TARGET_ALLOWLIST from startUrl for http(s) targets unless one is supplied
  - accepts only exact http(s) origin allowlist entries; no wildcards, paths, queries, or credentials
  - refuses live-action, destructive-looking read steps, CI, scheduled, and external-runner contexts
  - --headed opens Chrome for visual inspection; --keep-open-ms keeps it open after replay
  - writes a minimal run record under artifacts/<RUN_ID>/

No owner approval packet or evidence pack is required for this manual read-only development lane.
Production open, unattended/scheduled runs, external runners, and approve/reject/write actions remain outside this wrapper.
EOF
}

fail() {
	echo "dev-integration-readonly: refused: $*" >&2
	exit 1
}

is_truthy() {
	case "${1:-}" in
		1|true|TRUE|yes|YES|on|ON) return 0 ;;
		*) return 1 ;;
	esac
}

shell_quote_command() {
	local out="bash bin/dev-integration-readonly.sh"
	local arg
	for arg in "${ORIGINAL_ARGS[@]}"; do
		printf -v arg '%q' "$arg"
		out+=" $arg"
	done
	printf '%s' "$out"
}

validate_only=0
allowlist_override=""
headed=0
keep_open_ms=""
flow_arg=""
while [ "$#" -gt 0 ]; do
	case "$1" in
		--validate-only) validate_only=1 ;;
		--headed) headed=1 ;;
		--keep-open-ms)
			shift
			[ "$#" -gt 0 ] || fail "--keep-open-ms requires milliseconds"
			keep_open_ms="$1"
			;;
		--allowlist)
			shift
			[ "$#" -gt 0 ] || fail "--allowlist requires an origin"
			allowlist_override="$1"
			;;
		--help|-h) usage; exit 0 ;;
		-*) fail "unknown option $1" ;;
		*)
			if [ -n "$flow_arg" ]; then fail "only one flow is accepted"; fi
			flow_arg="$1"
			;;
	esac
	shift
done

[ -n "$flow_arg" ] || { usage >&2; exit 2; }

if [ -n "$keep_open_ms" ]; then
	[[ "$keep_open_ms" =~ ^[0-9]+$ ]] || fail "--keep-open-ms must be a non-negative integer"
	[ "$keep_open_ms" -le 3600000 ] || fail "--keep-open-ms must be between 0 and 3600000"
	if [ "$keep_open_ms" -gt 0 ]; then headed=1; fi
fi

if is_truthy "${CI:-}" || is_truthy "${GITHUB_ACTIONS:-}" || is_truthy "${BUILDKITE:-}" || is_truthy "${GITLAB_CI:-}" || is_truthy "${TF_BUILD:-}"; then
	fail "development integration read-only replay is a manual local-shell lane, not CI"
fi
if is_truthy "${AQA_SCHEDULED_NO_LIVE:-}"; then
	fail "scheduled/unattended contexts must use the scheduled read/sync lane, not this development wrapper"
fi
if is_truthy "${WEBUI_EXTERNAL_MODE:-}" || is_truthy "${AQA_EXTERNAL_MODE:-}" || is_truthy "${WEBUI_SERVICE_MODE:-}" || is_truthy "${AQA_SERVICE_MODE:-}" || is_truthy "${WEBUI_REQUIRE_DURABLE_JOBS:-}"; then
	fail "external/service mode requires the production/operator workflow, not this development wrapper"
fi
if [ -n "${WEBUI_RUNNER_ID:-}${AQA_RUNNER_ID:-}${WEBUI_RUNNER_API_AUTH_TOKEN:-}${AQA_RUNNER_API_AUTH_TOKEN:-}" ]; then
	fail "external runner context is not allowed for this development wrapper"
fi
[ -z "${AQA_LIVE_ACTION_APPROVE:-}" ] || fail "AQA_LIVE_ACTION_APPROVE is live-action only"
[ -z "${AQA_LIVE_DRY_RUN_PASSED:-}" ] || fail "AQA_LIVE_DRY_RUN_PASSED is live-action only"
[ -z "${AQA_LIVE_ALLOWLIST:-}" ] || fail "AQA_LIVE_ALLOWLIST is live-action only"

# This development wrapper must not inherit production evidence-pack requirements
# from the caller. Supplied resolver/IP evidence is still honored by egress policy;
# only the "fresh evidence is mandatory" switches are cleared here.
unset AQA_EGRESS_REQUIRE_RESOLVED_IPS
unset WEBUI_EGRESS_REQUIRE_RESOLVED_IPS
unset AQA_EGRESS_REQUIRE_FRESH_RESOLVER_EVIDENCE
unset AQA_EGRESS_REQUIRE_FRESH_DNS_EVIDENCE
unset WEBUI_EGRESS_REQUIRE_FRESH_RESOLVER_EVIDENCE
unset AQA_EGRESS_REQUIRE_CONNECTION_IP
unset AQA_EGRESS_REQUIRE_CONNECTION_IP_EVIDENCE
unset WEBUI_EGRESS_REQUIRE_CONNECTION_IP

case "$flow_arg" in
	*/*|*\\*|*.json)
		flow_file="${flow_arg//\\//}"
		case "$flow_file" in
			/*|[A-Za-z]:/*) ;;
			*) flow_file="$ROOT/$flow_file" ;;
		esac
		;;
	*)
		[[ "$flow_arg" =~ ^[A-Za-z0-9_-]+$ ]] || fail "flow name must match [A-Za-z0-9_-]"
		flow_file="$ROOT/flows/$flow_arg.flow.json"
		;;
esac

[ -s "$flow_file" ] || fail "missing flow file $flow_file"

META="$(cd "$ROOT" && node --input-type=module - "$flow_file" "$allowlist_override" <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
	isDestructiveStep,
	validateFlowRunPolicy,
} = require('./lib/flow-policy.js');

const flowPath = process.argv[2];
const allowlistOverride = process.argv[3] || '';
const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));

function refuse(reason) {
	console.error(`dev-integration-readonly: refused: ${reason}`);
	process.exit(1);
}

function normalizeExactAllowlist(raw, label, requiredOrigin) {
	const s = String(raw || '').trim();
	if (!s) return '';
	const origins = [];
	for (const entry of s.split(',').map((part) => part.trim()).filter(Boolean)) {
		if (entry.includes('*')) refuse(`${label} must use exact origins, not wildcards`);
		let url;
		try {
			url = new URL(entry);
		} catch {
			refuse(`${label} entries must be absolute http(s) origins`);
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') refuse(`${label} must be an http(s) origin`);
		if (url.username || url.password) refuse(`${label} entries must not contain credentials`);
		if (url.pathname !== '/' || url.search || url.hash) refuse(`${label} entries must be origins only`);
		origins.push(url.origin);
	}
	if (!requiredOrigin) refuse(`${label} is only accepted for http(s) flow startUrl values`);
	const unique = [...new Set(origins)];
	if (!unique.includes(requiredOrigin)) refuse(`${label} must include startUrl origin ${requiredOrigin}`);
	return unique.join(',');
}

const name = String(flow.name || path.basename(flowPath).replace(/\.flow\.json$/i, '')).trim();
if (!/^[A-Za-z0-9_-]+$/.test(name)) refuse(`flow.name must match [A-Za-z0-9_-], got ${name || '(empty)'}`);

const environment = String(flow.environment || '').trim();
if (!['local', 'staging', 'live-readonly'].includes(environment)) {
	refuse(`flow.environment must be local, staging, or live-readonly for development read-only runs; got ${environment || '(empty)'}`);
}
if (flow.riskClass !== 'read') refuse(`flow.riskClass must be read, got ${flow.riskClass || '(empty)'}`);
if (flow.irreversibleAt != null) refuse('read-only development lane refuses irreversibleAt');
if (!flow.startUrl) refuse('flow.startUrl is required');

const steps = Array.isArray(flow.steps) ? flow.steps : [];
for (let i = 0; i < steps.length; i += 1) {
	if (isDestructiveStep(steps[i])) refuse(`step ${i} looks destructive and cannot run in development read-only lane`);
}

let start;
try {
	start = new URL(String(flow.startUrl));
} catch {
	refuse('flow.startUrl must be an absolute URL');
}
const exactOrigin = ['http:', 'https:'].includes(start.protocol) ? start.origin : '';
const providedAllowlists = [
	['--allowlist', allowlistOverride],
	['AQA_TARGET_ALLOWLIST', process.env.AQA_TARGET_ALLOWLIST || ''],
	['AQA_EGRESS_ALLOWLIST', process.env.AQA_EGRESS_ALLOWLIST || ''],
]
	.map(([label, value]) => [label, normalizeExactAllowlist(value, label, exactOrigin)])
	.filter(([, value]) => value);
let exactAllowlist = '';
for (const [label, value] of providedAllowlists) {
	if (exactAllowlist && value !== exactAllowlist) refuse(`${label} must match the other provided exact allowlist (${exactAllowlist})`);
	exactAllowlist = value;
}
if (!exactAllowlist) exactAllowlist = exactOrigin;

const runMode = environment === 'local' ? 'local' : environment;
const policy = validateFlowRunPolicy(flow, {
	phase: 'run',
	runMode,
	scheduledNoLive: process.env.AQA_SCHEDULED_NO_LIVE === '1',
	egress: {
		phase: 'run',
		runMode,
		allowlist: exactAllowlist,
		profile: process.env.AQA_EGRESS_PROFILE || '',
	},
});
if (!policy.ok) refuse(policy.reason);

console.log([name, environment, flow.riskClass, runMode, exactAllowlist].join('\t'));
NODE
)"

IFS=$'\t' read -r flow_name flow_environment flow_risk run_mode exact_allowlist <<EOF
$META
EOF

test_file="$ROOT/tests/$flow_name.test.sh"
if [ "$validate_only" -ne 1 ] && [ ! -s "$test_file" ]; then
	fail "missing compiled test tests/$flow_name.test.sh; run probe-record compile first or use --validate-only"
fi

RUN_ID="${RUN_ID:-dev-$(date +%Y%m%d-%H%M%S)-$$}"
export RUN_ID
export PROBE_ROOT="$ROOT"
RUN_DIR="$ROOT/artifacts/$RUN_ID"
mkdir -p "$RUN_DIR"
OUT_LOG="$RUN_DIR/dev-integration-readonly.stdout.log"
ERR_LOG="$RUN_DIR/dev-integration-readonly.stderr.log"
RESULT_JSON="$RUN_DIR/dev-integration-readonly.json"

commit="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
wrapper_command="$(shell_quote_command)"
if [ -n "$exact_allowlist" ]; then
	export AQA_TARGET_ALLOWLIST="$exact_allowlist"
else
	unset AQA_TARGET_ALLOWLIST
fi
export AQA_RUN_MODE="$run_mode"
export AQA_INCLUDE_NONLOCAL=1
export AQA_DEV_INTEGRATION_READONLY=1
if [ "$validate_only" -ne 1 ] && [ "$headed" -eq 1 ]; then
	export AQA_PW_HEADLESS=0
fi
if [ "$validate_only" -ne 1 ] && [ -n "$keep_open_ms" ]; then
	export AQA_PW_KEEP_OPEN_MS="$keep_open_ms"
fi

write_record() {
	local result="$1"
	local rc="$2"
	local next_action="$3"
	AQA_DEV_RECORD_PATH="$RESULT_JSON" \
	AQA_DEV_RECORD_COMMIT="$commit" \
	AQA_DEV_RECORD_COMMAND="$wrapper_command" \
	AQA_DEV_RECORD_RUN_MODE="$run_mode" \
	AQA_DEV_RECORD_ALLOWLIST="$exact_allowlist" \
	AQA_DEV_RECORD_RESULT="$result" \
	AQA_DEV_RECORD_RUN_ID="$RUN_ID" \
	AQA_DEV_RECORD_RESULT_JSON="$RESULT_JSON" \
	AQA_DEV_RECORD_STDOUT="$OUT_LOG" \
	AQA_DEV_RECORD_STDERR="$ERR_LOG" \
	AQA_DEV_RECORD_FLOW="$flow_file" \
	AQA_DEV_RECORD_RC="$rc" \
	AQA_DEV_RECORD_NEXT_ACTION="$next_action" \
	node <<'NODE'
const fs = require('node:fs');
const record = {
	commit: process.env.AQA_DEV_RECORD_COMMIT || 'unknown',
	command: process.env.AQA_DEV_RECORD_COMMAND || '',
	run_mode: process.env.AQA_DEV_RECORD_RUN_MODE || '',
	allowlist: process.env.AQA_DEV_RECORD_ALLOWLIST || '',
	result: process.env.AQA_DEV_RECORD_RESULT || '',
	RUN_ID: process.env.AQA_DEV_RECORD_RUN_ID || '',
	artifact_paths: {
		record: process.env.AQA_DEV_RECORD_RESULT_JSON || '',
		stdout: process.env.AQA_DEV_RECORD_STDOUT || '',
		stderr: process.env.AQA_DEV_RECORD_STDERR || '',
		flow: process.env.AQA_DEV_RECORD_FLOW || '',
	},
	issues_found: process.env.AQA_DEV_RECORD_RC === '0' ? [] : [`command exited with ${process.env.AQA_DEV_RECORD_RC || 'unknown'}`],
	next_action: process.env.AQA_DEV_RECORD_NEXT_ACTION || '',
};
fs.writeFileSync(process.env.AQA_DEV_RECORD_PATH, JSON.stringify(record, null, 2) + '\n');
NODE
}

echo "dev-integration-readonly: RUN_ID=$RUN_ID"
echo "dev-integration-readonly: flow=$flow_name environment=$flow_environment riskClass=$flow_risk run_mode=$run_mode"
if [ -n "$exact_allowlist" ]; then
	echo "dev-integration-readonly: allowlist=$exact_allowlist"
else
	echo "dev-integration-readonly: allowlist=(local/file target)"
fi
echo "dev-integration-readonly: artifacts=$RUN_DIR"
if [ "$validate_only" -ne 1 ] && [ "$headed" -eq 1 ]; then
	echo "dev-integration-readonly: browser=headed"
fi
if [ "$validate_only" -ne 1 ] && [ -n "$keep_open_ms" ]; then
	echo "dev-integration-readonly: keep_open_ms=$keep_open_ms"
fi

set +e
if [ "$validate_only" -eq 1 ]; then
	( cd "$ROOT" && node bin/play-flow.mjs --flow "$flow_file" --validate-only ) >"$OUT_LOG" 2>"$ERR_LOG"
	rc=$?
else
	( cd "$ROOT" && bash "$test_file" ) >"$OUT_LOG" 2>"$ERR_LOG"
	rc=$?
fi
set -e

cat "$OUT_LOG"
cat "$ERR_LOG" >&2

if [ "$rc" -eq 0 ]; then
	if [ "$validate_only" -eq 1 ]; then
		write_record "pass" "$rc" "Run without --validate-only for deterministic replay."
		echo "dev-integration-readonly: validate-only OK"
	else
		write_record "pass" "$rc" "Review the local artifact record, then continue development integration."
		echo "dev-integration-readonly: replay OK"
	fi
	echo "dev-integration-readonly: record=$RESULT_JSON"
	exit 0
fi

write_record "fail" "$rc" "Inspect stderr/stdout artifacts and resolve the reported flow or policy issue."
echo "dev-integration-readonly: failed rc=$rc" >&2
echo "dev-integration-readonly: record=$RESULT_JSON" >&2
exit "$rc"
