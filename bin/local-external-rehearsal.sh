#!/usr/bin/env bash
# Start the WebUI in local external-mode rehearsal: loopback-only, authenticated,
# durable-job oriented, noVNC disabled, encrypted local secrets, and jsonl audit.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
	cat <<'EOF'
Usage: bash bin/local-external-rehearsal.sh [--check-config|--print-env|--help]

Starts webui/server.js with local external-mode guardrails on loopback.

Options:
  --check-config   Validate the exported rehearsal environment and exit.
  --print-env      Print the effective local operator/runner command hints and exit.
  --help           Show this message.
EOF
}

DEFAULT_AUTH_USERS='[{"token":"viewer0000000001","id":"viewer1","role":"viewer","tenantId":"tenant_a"},{"token":"operator00000001","id":"operator1","role":"operator","tenantId":"tenant_a"},{"token":"owner00000000001","id":"owner1","role":"owner","tenantId":"tenant_a"},{"token":"admin00000000001","id":"admin1","role":"admin","tenantId":"tenant_a"}]'
DATA_ROOT="${WEBUI_LOCAL_EXTERNAL_DATA_DIR:-$DIR/data/local-external}"
SECRET_DIR="${WEBUI_SECRET_STORE_DIR:-$DATA_ROOT/secrets}"
AUDIT_DIR="${WEBUI_LOCAL_EXTERNAL_AUDIT_DIR:-$DATA_ROOT/audit}"
BROWSER_ROOT="${WEBUI_NOVNC_BROWSER_ROOT:-$DATA_ROOT/browser-sessions}"

mkdir -p "$SECRET_DIR" "$AUDIT_DIR" "$BROWSER_ROOT"

export WEBUI_LOCAL_EXTERNAL_REHEARSAL=1
export WEBUI_EXTERNAL_MODE="${WEBUI_EXTERNAL_MODE:-1}"
export AQA_EXTERNAL_MODE="${AQA_EXTERNAL_MODE:-$WEBUI_EXTERNAL_MODE}"
export WEBUI_SERVICE_MODE="${WEBUI_SERVICE_MODE:-1}"
export WEBUI_REQUIRE_DURABLE_JOBS="${WEBUI_REQUIRE_DURABLE_JOBS:-1}"
export WEBUI_HOST="${WEBUI_HOST:-127.0.0.1}"
export WEBUI_PORT="${WEBUI_PORT:-4310}"
export WEBUI_PUBLIC_URL="${WEBUI_PUBLIC_URL:-https://console.local.test}"
export WEBUI_ALLOWED_HOSTS="${WEBUI_ALLOWED_HOSTS:-127.0.0.1:$WEBUI_PORT,localhost:$WEBUI_PORT,127.0.0.1,localhost}"
export WEBUI_ALLOWED_ORIGINS="${WEBUI_ALLOWED_ORIGINS:-http://127.0.0.1:$WEBUI_PORT,http://localhost:$WEBUI_PORT}"
export WEBUI_AUTH_PROVIDER="${WEBUI_AUTH_PROVIDER:-static}"
export WEBUI_TENANT_ID="${WEBUI_TENANT_ID:-tenant_a}"
export WEBUI_AUTH_USERS="${WEBUI_AUTH_USERS:-$DEFAULT_AUTH_USERS}"
export WEBUI_SECRET_STORE_BACKEND="${WEBUI_SECRET_STORE_BACKEND:-encrypted-local}"
export WEBUI_SECRET_STORE_KEY="${WEBUI_SECRET_STORE_KEY:-local-external-rehearsal-dev-key-material}"
export WEBUI_SECRET_STORE_KEY_ID="${WEBUI_SECRET_STORE_KEY_ID:-local-external-rehearsal-key}"
export WEBUI_SECRET_STORE_DIR="$SECRET_DIR"
export NOVNC_DISABLE="${NOVNC_DISABLE:-1}"
export WEBUI_NOVNC_BROWSER_ROOT="$BROWSER_ROOT"
export WEBUI_AUDIT_SINK="${WEBUI_AUDIT_SINK:-jsonl}"
export WEBUI_AUDIT_SINK_PATH="${WEBUI_AUDIT_SINK_PATH:-$AUDIT_DIR/audit.jsonl}"
export AQA_DB_PATH="${AQA_DB_PATH:-$DATA_ROOT/webui.sqlite}"
export WEBUI_KEEP_RUNS="${WEBUI_KEEP_RUNS:-1000}"
export WEBUI_RUNNER_MODE="${WEBUI_RUNNER_MODE:-production}"
export WEBUI_RUNNER_ID="${WEBUI_RUNNER_ID:-runner-local}"
export WEBUI_RUNNER_TENANT_ID="${WEBUI_RUNNER_TENANT_ID:-$WEBUI_TENANT_ID}"
export WEBUI_RUNNER_DEPLOYMENT_ID="${WEBUI_RUNNER_DEPLOYMENT_ID:-local-external}"
export WEBUI_RUNNER_TOKEN_REF="${WEBUI_RUNNER_TOKEN_REF:-aqa-secret:tenant_a/runner-local}"
export WEBUI_RUNNER_API_AUTH_TOKEN="${WEBUI_RUNNER_API_AUTH_TOKEN:-operator00000001}"

append_wslenv() {
	local current="${WSLENV:-}"
	local entry
	for entry in "$@"; do
		case ":$current:" in
			*":$entry:"*) ;;
			*) current="${current:+$current:}$entry" ;;
		esac
	done
	export WSLENV="$current"
}

if grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
	append_wslenv \
		WEBUI_LOCAL_EXTERNAL_REHEARSAL \
		WEBUI_EXTERNAL_MODE \
		AQA_EXTERNAL_MODE \
		WEBUI_SERVICE_MODE \
		WEBUI_REQUIRE_DURABLE_JOBS \
		WEBUI_HOST \
		WEBUI_PORT \
		WEBUI_PUBLIC_URL \
		WEBUI_ALLOWED_HOSTS \
		WEBUI_ALLOWED_ORIGINS \
		WEBUI_AUTH_PROVIDER \
		WEBUI_TENANT_ID \
		WEBUI_AUTH_USERS \
		WEBUI_SECRET_STORE_BACKEND \
		WEBUI_SECRET_STORE_KEY \
		WEBUI_SECRET_STORE_KEY_ID \
		WEBUI_SECRET_STORE_DIR/p \
		NOVNC_DISABLE \
		WEBUI_NOVNC_BROWSER_ROOT/p \
		WEBUI_AUDIT_SINK \
		WEBUI_AUDIT_SINK_PATH/p \
		AQA_DB_PATH/p \
		WEBUI_KEEP_RUNS \
		WEBUI_RUNNER_MODE \
		WEBUI_RUNNER_ID \
		WEBUI_RUNNER_TENANT_ID \
		WEBUI_RUNNER_DEPLOYMENT_ID \
		WEBUI_RUNNER_TOKEN_REF \
		WEBUI_RUNNER_API_AUTH_TOKEN
fi

check_config() {
	NODE_NO_WARNINGS=1 node --input-type=module - <<'NODE'
import { createRequire } from 'node:module';
import { securityModeSummary } from './webui/security.js';
import { createSecretStore } from './webui/secrets.js';
import { noVncRegistryFromEnv } from './webui/novnc.js';

const require = createRequire(import.meta.url);
const auditSink = require('./lib/audit-sink.js');
const trueRe = /^(1|true|yes|on)$/i;
const problems = [];

const security = securityModeSummary(process.env);
if (!security.external) problems.push('WEBUI_EXTERNAL_MODE must be enabled');
if (!security.configured) problems.push(`external auth/CORS must be configured: ${security.authConfigError || 'unknown error'}`);

const secretStore = createSecretStore({ env: process.env, tenantId: process.env.WEBUI_TENANT_ID });
if (secretStore.backend !== 'encrypted-local') problems.push('WEBUI_SECRET_STORE_BACKEND must be encrypted-local');
if (!secretStore.configured) problems.push('WEBUI_SECRET_STORE_KEY must configure encrypted-local secrets');
if (secretStore.policy?.plaintextAllowed) problems.push('plaintext secret storage must stay disabled');

const noVnc = noVncRegistryFromEnv(process.env);
if (noVnc.error) problems.push(noVnc.error);
if (!trueRe.test(process.env.NOVNC_DISABLE || '')) problems.push('NOVNC_DISABLE=1 is required for local external rehearsal');

let audit = null;
try {
	audit = auditSink.validateAuditSinkConfig(process.env);
	if (audit.mode !== 'jsonl' || !audit.path) problems.push('WEBUI_AUDIT_SINK=jsonl with WEBUI_AUDIT_SINK_PATH is required');
} catch (e) {
	problems.push((e && e.message) || String(e));
}

if (!process.env.AQA_DB_PATH) problems.push('AQA_DB_PATH must point at the local rehearsal database');

if (problems.length) {
	console.error(JSON.stringify({ ok: false, problems }, null, 2));
	process.exit(1);
}

console.log(JSON.stringify({
	ok: true,
	mode: security.mode,
	auth: security.auth,
	tenantId: security.tenantId,
	secretStore: secretStore.backend,
	noVnc: 'disabled',
	auditSink: audit.mode,
	dbConfigured: true,
}, null, 2));
NODE
}

print_env() {
	cat <<EOF
Local external-mode rehearsal
  WebUI: http://$WEBUI_HOST:$WEBUI_PORT
  Operator header: Authorization: Bearer operator00000001
  Data root: $DATA_ROOT
  Audit sink: $WEBUI_AUDIT_SINK_PATH

Runner worker in another shell:
  WEBUI_RUNNER_ID=$WEBUI_RUNNER_ID \\
  WEBUI_RUNNER_TENANT_ID=$WEBUI_RUNNER_TENANT_ID \\
  WEBUI_RUNNER_DEPLOYMENT_ID=$WEBUI_RUNNER_DEPLOYMENT_ID \\
  WEBUI_RUNNER_TOKEN_REF=$WEBUI_RUNNER_TOKEN_REF \\
  WEBUI_RUNNER_API_AUTH_TOKEN=$WEBUI_RUNNER_API_AUTH_TOKEN \\
  node bin/runner-worker.mjs --api http://$WEBUI_HOST:$WEBUI_PORT/api/runner
EOF
}

case "${1:-}" in
	'')
		check_config >/dev/null
		print_env
		exec node "$DIR/webui/server.js"
		;;
	--check-config)
		check_config
		;;
	--print-env)
		print_env
		;;
	--help|-h)
		usage
		;;
	*)
		usage >&2
		exit 2
		;;
esac
