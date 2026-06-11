#!/usr/bin/env bash
# Operator-only non-local read lane. Never run this from CI.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
	cat <<'EOF'
Usage: bash bin/operator-staging-readonly.sh [--validate-only] <flow-name>

Requires:
  AQA_RUN_MODE=staging|live-readonly
  AQA_TARGET_ALLOWLIST=https://host[:port][,...]

The named flow must be environment staging/live-readonly with riskClass read. The wrapper refuses CI,
live-action approval env, missing allowlists, wrong run modes, and destructive-looking read-only steps.
EOF
}

fail() {
	echo "operator-staging-readonly: refused: $*" >&2
	exit 1
}

is_truthy() {
	case "${1:-}" in
		1|true|TRUE|yes|YES|on|ON) return 0 ;;
		*) return 1 ;;
	esac
}

validate_only=0
flow_name=""
while [ "$#" -gt 0 ]; do
	case "$1" in
		--validate-only) validate_only=1 ;;
		--help|-h) usage; exit 0 ;;
		-*) fail "unknown option $1" ;;
		*)
			if [ -n "$flow_name" ]; then fail "only one flow name is accepted"; fi
			flow_name="$1"
			;;
	esac
	shift
done

[ -n "$flow_name" ] || { usage >&2; exit 2; }
[[ "$flow_name" =~ ^[A-Za-z0-9_-]+$ ]] || fail "flow name must match [A-Za-z0-9_-]"

if is_truthy "${CI:-}" || is_truthy "${GITHUB_ACTIONS:-}" || is_truthy "${BUILDKITE:-}" || is_truthy "${GITLAB_CI:-}" || is_truthy "${TF_BUILD:-}"; then
	fail "operator-only staging/live-readonly lane must not run in CI"
fi

case "${AQA_RUN_MODE:-}" in
	staging|live-readonly) ;;
	'') fail "AQA_RUN_MODE=staging or live-readonly is required" ;;
	*) fail "AQA_RUN_MODE must be staging or live-readonly" ;;
esac

[ -n "${AQA_TARGET_ALLOWLIST:-}" ] || fail "AQA_TARGET_ALLOWLIST is required"
[ -z "${AQA_LIVE_ACTION_APPROVE:-}" ] || fail "AQA_LIVE_ACTION_APPROVE is live-action only"
[ -z "${AQA_LIVE_DRY_RUN_PASSED:-}" ] || fail "AQA_LIVE_DRY_RUN_PASSED is live-action only"
[ -z "${AQA_LIVE_ALLOWLIST:-}" ] || fail "AQA_LIVE_ALLOWLIST is live-action only"

flow_file="$ROOT/flows/$flow_name.flow.json"
test_file="$ROOT/tests/$flow_name.test.sh"
[ -s "$flow_file" ] || fail "missing flow file flows/$flow_name.flow.json"
[ -s "$test_file" ] || fail "missing compiled test tests/$flow_name.test.sh; run probe-record compile first"

cd "$ROOT"
node --input-type=module - "$flow_file" <<'NODE'
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
	isDestructiveStep,
	validateFlowRunPolicy,
} = require('./lib/flow-policy.js');

const flowPath = process.argv[2];
const flow = JSON.parse(fs.readFileSync(flowPath, 'utf8'));
const env = flow.environment;
const runMode = process.env.AQA_RUN_MODE || '';
const allowlist = process.env.AQA_TARGET_ALLOWLIST || process.env.AQA_EGRESS_ALLOWLIST || '';

function refuse(reason) {
	console.error(`operator-staging-readonly: refused: ${reason}`);
	process.exit(1);
}

if (!['staging', 'live-readonly'].includes(env)) refuse(`flow.environment must be staging or live-readonly, got ${env || '(empty)'}`);
if (flow.riskClass !== 'read') refuse(`flow.riskClass must be read, got ${flow.riskClass || '(empty)'}`);
if (runMode !== env) refuse(`AQA_RUN_MODE=${runMode || '(empty)'} does not match flow.environment ${env}`);
if (!allowlist.trim()) refuse('AQA_TARGET_ALLOWLIST is required');
if (flow.irreversibleAt != null) refuse('read-only lane refuses irreversibleAt');

const steps = Array.isArray(flow.steps) ? flow.steps : [];
for (let i = 0; i < steps.length; i += 1) {
	if (isDestructiveStep(steps[i])) refuse(`step ${i} looks destructive and cannot run in staging-readonly lane`);
}

const policy = validateFlowRunPolicy(flow, {
	phase: 'run',
	runMode,
	egress: {
		phase: 'run',
		runMode,
		allowlist,
		profile: process.env.AQA_EGRESS_PROFILE || '',
	},
	scheduledNoLive: process.env.AQA_SCHEDULED_NO_LIVE === '1',
});
if (!policy.ok) refuse(policy.reason);
NODE

node bin/play-flow.mjs --flow "flows/$flow_name.flow.json" --validate-only >/dev/null

if [ "$validate_only" -eq 1 ]; then
	echo "operator-staging-readonly: validate-only OK for $flow_name"
	exit 0
fi

export AQA_INCLUDE_NONLOCAL=1
exec bash run.sh "$flow_name"
