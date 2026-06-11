#!/usr/bin/env bash
# Fixture-only P0 security gate. Keep this AI-free, deterministic, and local:
# no live auth, no non-local targets, no live-action execution.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

AQA_PREFLIGHT_MANUAL=1
AQA_PREFLIGHT_ENTRYPOINT="tests/security-p0-gate.test.sh"
source "$DIR/lib/preflight.sh"
preflight_require_core_tools

TESTS=(
	"flow-runner-unit"
	"blocked-flow-report-unit"
	"webui-blocked-flow-route-unit"
	"play-flow-smoke"
	"webui-security-unit"
	"webui-idp-verifier-unit"
	"webui-auth-context-unit"
	"webui-auth-summary-unit"
	"webui-artifact-boundary-unit"
	"webui-secret-store-unit"
	"webui-secret-broker-unit"
	"webui-secret-migration-inventory-unit"
	"webui-secret-migration-workflow-unit"
	"webui-secret-migration-api-unit"
	"webui-secret-migration-route-unit"
	"webui-external-secret-mode-unit"
	"webui-export-gate-unit"
	"webui-retention-delete-unit"
	"webui-tenant-deletion-unit"
	"webui-tenant-deletion-api-unit"
	"webui-tenant-deletion-route-unit"
	"docker-entrypoint-unit"
	"local-external-rehearsal-unit"
	"local-external-runner-e2e"
	"novnc-boundary-unit"
	"novnc-cleanup-unit"
	"egress-policy-unit"
	"egress-resolver-unit"
	"egress-runtime-unit"
	"jobs-result-unit"
	"jobs-durable-unit"
	"audit-outbox-worker-unit"
	"audit-outbox-scheduler-unit"
	"runner-contract-unit"
	"runner-api-unit"
	"runner-api-route-unit"
	"runner-worker-unit"
	"webui-rbac-unit"
	"approve-session-gate-unit"
	"command-confirm-session-route-unit"
	"webui-redact-unit"
	"webui-flows-unit"
	"webui-readiness-unit"
	"webui-ops-dashboard-unit"
	"release-checklist-unit"
	"webui-release-checklist-unit"
	"ci-lanes-unit"
	"staging-readonly-lane-unit"
	"dev-integration-readonly-lane-unit"
)

echo "  security-p0-gate: running fixture-only P0 security checks"
failed=0
for name in "${TESTS[@]}"; do
	test_path="$DIR/tests/$name.test.sh"
	if [ ! -s "$test_path" ]; then
		echo "  security-p0-gate: missing $test_path" >&2
		failed=1
		continue
	fi
	echo "  security-p0-gate: $name"
	if bash "$test_path"; then
		echo "  security-p0-gate: pass $name"
	else
		echo "  security-p0-gate: fail $name" >&2
		failed=1
	fi
done

if [ "$failed" -ne 0 ]; then
	echo "  security-p0-gate: one or more fixture-only P0 security checks failed" >&2
	exit 1
fi

echo "  security-p0-gate: all fixture-only P0 security checks passed"
