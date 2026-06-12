#!/usr/bin/env bash
# Browser-free checks for the manual development read-only integration wrapper.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMPROOT="$(mktemp -d "${TMPDIR:-/tmp}/aqa-dev-readonly.XXXXXX")"
NAME="dev_readonly_tmp_$$"
BAD_NAME="dev_readonly_bad_tmp_$$"
LIVE_NAME="dev_readonly_live_tmp_$$"
FLOW_TMP="$DIR/flows/$NAME.flow.json"
BAD_FLOW_TMP="$DIR/flows/$BAD_NAME.flow.json"
LIVE_FLOW_TMP="$DIR/flows/$LIVE_NAME.flow.json"
TEST_TMP="$DIR/tests/$NAME.test.sh"
RUN_PREFIX="dev-readonly-unit-$$"
cleanup() {
	rm -rf "$TMPROOT"
	rm -f "$FLOW_TMP" "$BAD_FLOW_TMP" "$LIVE_FLOW_TMP" "$TEST_TMP"
	rm -rf "$DIR/artifacts/$RUN_PREFIX" "$DIR/artifacts/$RUN_PREFIX-"*
}
trap cleanup EXIT

REAL_BASH="$(command -v bash)"
LOG="$TMPROOT/compiled-test.log"

cat > "$FLOW_TMP" <<JSON
{
  "name": "$NAME",
  "engine": "playwright",
  "environment": "live-readonly",
  "riskClass": "read",
  "startUrl": "https://example.com",
  "steps": [
    { "kind": "find", "by": "text", "value": "Example Domain", "action": "hover" }
  ],
  "asserts": []
}
JSON

cat > "$TEST_TMP" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf 'run_mode=%s\n' "${AQA_RUN_MODE:-}" >> "$AQA_DEV_WRAPPER_LOG"
printf 'allowlist=%s\n' "${AQA_TARGET_ALLOWLIST:-}" >> "$AQA_DEV_WRAPPER_LOG"
printf 'run_id=%s\n' "${RUN_ID:-}" >> "$AQA_DEV_WRAPPER_LOG"
printf 'dev_marker=%s\n' "${AQA_DEV_INTEGRATION_READONLY:-}" >> "$AQA_DEV_WRAPPER_LOG"
printf 'headless=%s\n' "${AQA_PW_HEADLESS:-}" >> "$AQA_DEV_WRAPPER_LOG"
printf 'keep_open_ms=%s\n' "${AQA_PW_KEEP_OPEN_MS:-}" >> "$AQA_DEV_WRAPPER_LOG"
echo 'AQA_JOB_RESULT={"status":"ok","mode":"unit"}'
SH

cat > "$BAD_FLOW_TMP" <<JSON
{
  "name": "$BAD_NAME",
  "engine": "playwright",
  "environment": "staging",
  "riskClass": "read",
  "startUrl": "https://example.com",
  "steps": [
    { "kind": "find", "by": "role", "value": "button", "name": "Approve", "action": "click" }
  ],
  "asserts": []
}
JSON

cat > "$LIVE_FLOW_TMP" <<JSON
{
  "name": "$LIVE_NAME",
  "engine": "playwright",
  "environment": "live-action",
  "riskClass": "effectful",
  "startUrl": "https://example.com",
  "irreversibleAt": 0,
  "steps": [
    { "kind": "find", "by": "role", "value": "button", "name": "Confirm", "action": "click" }
  ],
  "asserts": []
}
JSON

assert_file_contains() {
	local file="$1"
	local needle="$2"
	if ! grep -Fq "$needle" "$file"; then
		echo "  dev-integration-readonly-lane-unit: expected '$needle' in $file" >&2
		cat "$file" >&2 || true
		exit 1
	fi
}

assert_refused() {
	local label="$1"
	shift
	: > "$LOG"
	if "$@" > "$TMPROOT/$label.out" 2> "$TMPROOT/$label.err"; then
		echo "  dev-integration-readonly-lane-unit: $label unexpectedly succeeded" >&2
		exit 1
	fi
	if [[ -s "$LOG" ]]; then
		echo "  dev-integration-readonly-lane-unit: $label reached compiled replay after guard refusal" >&2
		cat "$LOG" >&2
		exit 1
	fi
	grep -q 'refused' "$TMPROOT/$label.err"
}

( cd "$DIR" && "$REAL_BASH" -n bin/dev-integration-readonly.sh )

RUN_ID="$RUN_PREFIX-validate" \
"$REAL_BASH" "$DIR/bin/dev-integration-readonly.sh" --validate-only "$NAME" > "$TMPROOT/validate.out" 2> "$TMPROOT/validate.err"
assert_file_contains "$TMPROOT/validate.out" "RUN_ID=$RUN_PREFIX-validate"
assert_file_contains "$TMPROOT/validate.out" "allowlist=https://example.com"
test -s "$DIR/artifacts/$RUN_PREFIX-validate/dev-integration-readonly.json"

RUN_ID="$RUN_PREFIX-multi" \
"$REAL_BASH" "$DIR/bin/dev-integration-readonly.sh" --validate-only --allowlist "https://example.com,https://static.example" "$NAME" > "$TMPROOT/multi.out" 2> "$TMPROOT/multi.err"
assert_file_contains "$TMPROOT/multi.out" "allowlist=https://example.com,https://static.example"

: > "$LOG"
RUN_ID="$RUN_PREFIX-replay" \
AQA_DEV_WRAPPER_LOG="$LOG" \
"$REAL_BASH" "$DIR/bin/dev-integration-readonly.sh" "$NAME" > "$TMPROOT/replay.out" 2> "$TMPROOT/replay.err"
assert_file_contains "$LOG" "run_mode=live-readonly"
assert_file_contains "$LOG" "allowlist=https://example.com"
assert_file_contains "$LOG" "run_id=$RUN_PREFIX-replay"
assert_file_contains "$LOG" "dev_marker=1"
test -s "$DIR/artifacts/$RUN_PREFIX-replay/dev-integration-readonly.json"

: > "$LOG"
RUN_ID="$RUN_PREFIX-headed" \
AQA_DEV_WRAPPER_LOG="$LOG" \
"$REAL_BASH" "$DIR/bin/dev-integration-readonly.sh" --headed --keep-open-ms 1234 "$NAME" > "$TMPROOT/headed.out" 2> "$TMPROOT/headed.err"
assert_file_contains "$TMPROOT/headed.out" "browser=headed"
assert_file_contains "$TMPROOT/headed.out" "keep_open_ms=1234"
assert_file_contains "$LOG" "headless=0"
assert_file_contains "$LOG" "keep_open_ms=1234"

node - "$DIR/artifacts/$RUN_PREFIX-replay/dev-integration-readonly.json" <<'NODE'
const fs = require('node:fs');
const assert = require('node:assert/strict');
const record = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
assert.equal(record.run_mode, 'live-readonly');
assert.equal(record.allowlist, 'https://example.com');
assert.equal(record.result, 'pass');
assert.deepEqual(record.issues_found, []);
assert.match(record.command, /dev-integration-readonly\.sh/);
NODE

assert_refused wildcard "$REAL_BASH" "$DIR/bin/dev-integration-readonly.sh" --validate-only --allowlist "*" "$NAME"
assert_refused credential-allowlist "$REAL_BASH" "$DIR/bin/dev-integration-readonly.sh" --validate-only --allowlist "https://user:pass@example.com" "$NAME"
assert_refused path-env env AQA_TARGET_ALLOWLIST="https://example.com/path" "$REAL_BASH" "$DIR/bin/dev-integration-readonly.sh" --validate-only "$NAME"
assert_refused ci env CI=true "$REAL_BASH" "$DIR/bin/dev-integration-readonly.sh" --validate-only "$NAME"
assert_refused scheduled env AQA_SCHEDULED_NO_LIVE=1 "$REAL_BASH" "$DIR/bin/dev-integration-readonly.sh" --validate-only "$NAME"
assert_refused external-runner env WEBUI_RUNNER_ID=runner-a "$REAL_BASH" "$DIR/bin/dev-integration-readonly.sh" --validate-only "$NAME"
assert_refused live-action-env env AQA_LIVE_ACTION_APPROVE=1 "$REAL_BASH" "$DIR/bin/dev-integration-readonly.sh" --validate-only "$NAME"
assert_refused destructive "$REAL_BASH" "$DIR/bin/dev-integration-readonly.sh" --validate-only "$BAD_NAME"
assert_refused live-action-flow "$REAL_BASH" "$DIR/bin/dev-integration-readonly.sh" --validate-only "$LIVE_NAME"

echo "  dev-integration-readonly-lane-unit: manual read-only wrapper is narrow and records artifacts"
