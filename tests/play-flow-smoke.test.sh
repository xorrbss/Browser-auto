#!/usr/bin/env bash
# Minimal local HTML smoke for bin/play-flow.mjs (Playwright engine replay).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
NAME="_pw_smoke_$$"
NAME2="_pw_smoke_verifyneg_$$"
NAME3="_pw_smoke_verifyirr_$$"
NAME4="_pw_smoke_playneg_$$"
NAME5="_pw_smoke_livegate_$$"
NAME6="_pw_smoke_egress_$$"
NAME7="_pw_smoke_egress_iframe_$$"
NAME8="_pw_smoke_egress_initial_$$"
NAME9="_pw_smoke_egress_mismatch_$$"
NAME10="_pw_smoke_auditfail_$$"
SERVER_PID=""
cleanup(){
	if [ -n "${SERVER_PID:-}" ]; then kill "$SERVER_PID" >/dev/null 2>&1 || true; fi
	rm -rf "$TMP"; rm -f "$DIR/flows/$NAME.flow.json" "$DIR/flows/$NAME.values.json" "$DIR/tests/$NAME.test.sh" "$DIR/flows/$NAME2.flow.json" "$DIR/flows/$NAME2.values.json" "$DIR/flows/$NAME3.flow.json" "$DIR/flows/$NAME3.values.json" "$DIR/flows/$NAME4.flow.json" "$DIR/flows/$NAME4.values.json" "$DIR/flows/$NAME5.flow.json" "$DIR/flows/$NAME5.values.json" "$DIR/flows/$NAME6.flow.json" "$DIR/flows/$NAME6.values.json" "$DIR/flows/$NAME7.flow.json" "$DIR/flows/$NAME7.values.json" "$DIR/flows/$NAME8.flow.json" "$DIR/flows/$NAME8.values.json" "$DIR/flows/$NAME9.flow.json" "$DIR/flows/$NAME9.values.json" "$DIR/flows/$NAME10.flow.json" "$DIR/flows/$NAME10.values.json"
}
trap cleanup EXIT

HTML="$TMP/smoke.html"
cat > "$HTML" <<'HTML'
<!doctype html>
<meta charset="utf-8">
<label>Name <input id="name"></label>
<button type="button" onclick="document.querySelector('#status').textContent='Saved '+document.querySelector('#name').value">Save</button>
<div id="status">Idle</div>
HTML
URL="$(node -e "const {pathToFileURL}=require('node:url'); console.log(pathToFileURL(process.argv[1]).href)" "$HTML")"

cat > "$DIR/flows/$NAME.flow.json" <<JSON
{
  "name": "$NAME",
  "engine": "playwright",
  "environment": "local",
  "riskClass": "read",
  "startUrl": "$URL",
  "steps": [
    { "kind": "find", "by": "label", "value": "Name", "action": "fill", "text": "{{input_1}}" },
    { "kind": "find", "by": "role", "value": "button", "name": "Save", "action": "click" },
    { "kind": "wait", "until": "text", "value": "Saved {{input_1}}" }
  ],
  "asserts": [
    { "kind": "text", "value": "Saved Ada" },
    { "kind": "value", "selector": "#name", "text": "Ada" }
  ]
}
JSON
printf '%s\n' '{"input_1":"Ada"}' > "$DIR/flows/$NAME.values.json"

set +e
OUT="$(node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$NAME.flow.json" 2>&1)"
RC=$?
set -e
if [ "$RC" -ne 0 ]; then
	case "$OUT" in
		*"Executable doesn't exist"*|*"Chromium distribution"*|*"not found at"*)
			echo "  play-flow-smoke: skipped (Playwright Chrome channel unavailable)"
			exit 0
			;;
	esac
	printf '%s\n' "$OUT" | sed 's/^/    /' >&2
	echo "  play-flow-smoke: failed" >&2
	exit "$RC"
fi
case "$OUT" in *AQA_JOB_RESULT*'"status":"ok"'*) ;; *) printf '%s\n' "$OUT" >&2; echo "  play-flow-smoke: missing ok result" >&2; exit 1 ;; esac
echo "  play-flow-smoke: passed"

# Live replay failures should identify the exact failed step, not just bubble up a browser error.
cat > "$DIR/flows/$NAME4.flow.json" <<JSON
{
  "name": "$NAME4",
  "engine": "playwright",
  "environment": "local",
  "riskClass": "read",
  "startUrl": "$URL",
  "steps": [
    { "kind": "find", "by": "label", "value": "Name", "action": "fill", "text": "{{input_1}}" },
    { "kind": "press", "value": "ThisKeyDoesNotExist" }
  ],
  "asserts": []
}
JSON
printf '%s\n' '{"input_1":"Ada"}' > "$DIR/flows/$NAME4.values.json"

set +e
OUT4="$(node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$NAME4.flow.json" 2>&1)"
RC4=$?
set -e
if [ "$RC4" -eq 0 ]; then printf '%s\n' "$OUT4" >&2; echo "  play-flow-smoke play-negative: replay WRONGLY reported success" >&2; exit 1; fi
case "$OUT4" in *'"status":"failed"'*) ;; *) printf '%s\n' "$OUT4" >&2; echo "  play-flow-smoke play-negative: expected a failed status" >&2; exit 1 ;; esac
case "$OUT4" in *'step 1 (press ThisKeyDoesNotExist) failed'*) ;; *) printf '%s\n' "$OUT4" >&2; echo "  play-flow-smoke play-negative: missing step-index diagnostic" >&2; exit 1 ;; esac
echo "  play-flow-smoke play-negative: passed"

# --verify must FAIL LOUD when a NON-find step diverges at replay (regression for the verifyFlow
# silent-OK bug: a failing wait/press/scroll used to break the loop with promoted=0 ⇒ status:'ok').
# The bad `press` key throws at replay; verify must report failed + exit non-zero.
cat > "$DIR/flows/$NAME2.flow.json" <<JSON
{
  "name": "$NAME2",
  "engine": "playwright",
  "environment": "local",
  "riskClass": "read",
  "startUrl": "$URL",
  "steps": [
    { "kind": "find", "by": "label", "value": "Name", "action": "fill", "text": "{{input_1}}" },
    { "kind": "press", "value": "ThisKeyDoesNotExist" }
  ],
  "asserts": []
}
JSON
printf '%s\n' '{"input_1":"Ada"}' > "$DIR/flows/$NAME2.values.json"

set +e
OUT2="$(node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$NAME2.flow.json" --verify 2>&1)"
RC2=$?
set -e
case "$OUT2" in
	*"Executable doesn't exist"*|*"Chromium distribution"*|*"not found at"*)
		echo "  play-flow-smoke verify-negative: skipped (Playwright Chrome channel unavailable)"
		exit 0
		;;
esac
if [ "$RC2" -eq 0 ]; then printf '%s\n' "$OUT2" >&2; echo "  play-flow-smoke verify-negative: verify WRONGLY reported success on a diverged journey" >&2; exit 1; fi
case "$OUT2" in *'"status":"failed"'*) ;; *) printf '%s\n' "$OUT2" >&2; echo "  play-flow-smoke verify-negative: expected a failed status" >&2; exit 1 ;; esac
echo "  play-flow-smoke verify-negative: passed"

# --verify must STOP BEFORE a flow-declared irreversibleAt (side-door regression: verify used to re-drive
# every step with a blanket reversible:true, executing a declared point-of-no-return un-audited/un-capped).
# Here step 1 (the Save click) is the point-of-no-return: verify must verify only step 0, report
# stoppedBeforeIrreversible, and exit 0 WITHOUT clicking Save.
cat > "$DIR/flows/$NAME3.flow.json" <<JSON
{
  "name": "$NAME3",
  "engine": "playwright",
  "environment": "live-action",
  "riskClass": "effectful",
  "egress": { "profile": "local" },
  "startUrl": "$URL",
  "irreversibleAt": 1,
  "steps": [
    { "kind": "find", "by": "label", "value": "Name", "action": "fill", "text": "{{input_1}}" },
    { "kind": "find", "by": "role", "value": "button", "name": "Save", "action": "click" }
  ],
  "asserts": []
}
JSON
printf '%s\n' '{"input_1":"Ada"}' > "$DIR/flows/$NAME3.values.json"

set +e
OUT3="$(node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$NAME3.flow.json" --verify 2>&1)"
RC3=$?
set -e
if [ "$RC3" -ne 0 ]; then printf '%s\n' "$OUT3" | sed 's/^/    /' >&2; echo "  play-flow-smoke verify-irreversible: verify failed (expected gated ok)" >&2; exit 1; fi
case "$OUT3" in *'"stoppedBeforeIrreversible":true'*) ;; *) printf '%s\n' "$OUT3" >&2; echo "  play-flow-smoke verify-irreversible: missing stoppedBeforeIrreversible (side door open?)" >&2; exit 1 ;; esac
case "$OUT3" in *'"verified":1'*) ;; *) printf '%s\n' "$OUT3" >&2; echo "  play-flow-smoke verify-irreversible: expected exactly 1 verified pre-commit step" >&2; exit 1 ;; esac
echo "  play-flow-smoke verify-irreversible: passed"

# Actual live-action replay must fail closed before browser launch unless every operator gate is explicit:
# run mode, allowlist, dry-run evidence, and human approval. These are policy-only negative checks; they
# do not open a live target or perform a business action.
cat > "$DIR/flows/$NAME5.flow.json" <<JSON
{
  "name": "$NAME5",
  "engine": "playwright",
  "environment": "live-action",
  "riskClass": "effectful",
  "egress": { "profile": "local" },
  "startUrl": "$URL",
  "irreversibleAt": 1,
  "steps": [
    { "kind": "find", "by": "label", "value": "Name", "action": "fill", "text": "{{input_1}}" },
    { "kind": "find", "by": "role", "value": "button", "name": "Save", "action": "click" }
  ],
  "asserts": []
}
JSON
printf '%s\n' '{"input_1":"Ada"}' > "$DIR/flows/$NAME5.values.json"

expect_live_gate_refusal() {
  local label="$1" needle="$2"
  shift 2
  set +e
  OUT5="$(env "$@" node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$NAME5.flow.json" 2>&1)"
  RC5=$?
  set -e
  if [ "$RC5" -eq 0 ]; then printf '%s\n' "$OUT5" >&2; echo "  play-flow-smoke live-gates: $label WRONGLY reported success" >&2; exit 1; fi
  case "$OUT5" in *"$needle"*) ;; *) printf '%s\n' "$OUT5" >&2; echo "  play-flow-smoke live-gates: $label missing refusal: $needle" >&2; exit 1 ;; esac
}

expect_live_gate_refusal "run-mode" 'run mode "local" does not allow environment "live-action"'
expect_live_gate_refusal "allowlist" 'live-action flow is not in AQA_LIVE_ALLOWLIST' AQA_RUN_MODE=live-action
expect_live_gate_refusal "dry-run" 'live-action flow requires AQA_LIVE_DRY_RUN_PASSED=1 or the flow name' AQA_RUN_MODE=live-action AQA_LIVE_ALLOWLIST="$NAME5"
expect_live_gate_refusal "human-approval" 'live-action flow requires AQA_LIVE_ACTION_APPROVE=1 or the flow name' AQA_RUN_MODE=live-action AQA_LIVE_ALLOWLIST="$NAME5" AQA_LIVE_DRY_RUN_PASSED="$NAME5"
echo "  play-flow-smoke live-gates: passed"

# An irreversible live-action replay must fail closed if the pre-commit audit cannot be written.
# The target is still the local HTML fixture; the audit path is a directory, forcing fs.openSync to fail.
cat > "$DIR/flows/$NAME10.flow.json" <<JSON
{
  "name": "$NAME10",
  "engine": "playwright",
  "environment": "live-action",
  "riskClass": "effectful",
  "egress": { "profile": "local" },
  "startUrl": "$URL?token=audit-secret#frag",
  "irreversibleAt": 0,
  "steps": [
    { "kind": "find", "by": "role", "value": "button", "name": "Save", "action": "click" }
  ],
  "asserts": []
}
JSON
printf '%s\n' '{}' > "$DIR/flows/$NAME10.values.json"
mkdir -p "$TMP/audit-dir"
set +e
OUT10="$(env AQA_RUN_MODE=live-action AQA_LIVE_ALLOWLIST="$NAME10" AQA_LIVE_DRY_RUN_PASSED="$NAME10" AQA_LIVE_ACTION_APPROVE="$NAME10" AQA_PLAY_AUDIT_PATH="$TMP/audit-dir" node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$NAME10.flow.json" 2>&1)"
RC10=$?
set -e
if [ "$RC10" -eq 0 ]; then printf '%s\n' "$OUT10" >&2; echo "  play-flow-smoke audit-fail: replay WRONGLY reported success" >&2; exit 1; fi
case "$OUT10" in *'play audit write failed before irreversible step 0'*) ;; *) printf '%s\n' "$OUT10" >&2; echo "  play-flow-smoke audit-fail: missing fail-closed audit error" >&2; exit 1 ;; esac
case "$OUT10" in *'audit-secret'*) printf '%s\n' "$OUT10" >&2; echo "  play-flow-smoke audit-fail: raw startUrl query leaked" >&2; exit 1 ;; *) ;; esac
echo "  play-flow-smoke audit-fail: passed"

# Redirect/request-level egress guard: a local fixture is allowed, but a redirect to an allowlisted
# hostname whose injected resolved IP is cloud metadata is blocked before DNS or external contact.
SERVER_JS="$TMP/redirect-server.mjs"
ORIGIN_FILE="$TMP/redirect-origin.txt"
cat > "$SERVER_JS" <<'NODE'
import fs from 'node:fs';
import http from 'node:http';

const out = process.argv[2];
const server = http.createServer((req, res) => {
	if (req.url === '/initial-redirect') {
		res.writeHead(302, { Location: 'http://initial-rebind.test/latest/meta-data/' });
		res.end();
		return;
	}
	if (req.url === '/redirect') {
		res.writeHead(302, { Location: 'http://rebind.test/latest/meta-data/' });
		res.end();
		return;
	}
	if (req.url === '/redirect-mismatch') {
		res.writeHead(302, { Location: 'http://mismatch-rebind.test/app?token=top-secret' });
		res.end();
		return;
	}
	if (req.url === '/iframe') {
		res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
		res.end('<!doctype html><meta charset="utf-8"><div>Host page</div><iframe title="Blocked frame" src="http://frame-rebind.test/latest/meta-data/"></iframe>');
		return;
	}
	res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
	res.end('<!doctype html><meta charset="utf-8"><a href="/redirect">Go blocked</a>');
});
server.listen(0, '127.0.0.1', () => {
	const addr = server.address();
	fs.writeFileSync(out, `http://127.0.0.1:${addr.port}`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
NODE
node "$SERVER_JS" "$ORIGIN_FILE" &
SERVER_PID=$!
for _ in $(seq 1 50); do [ -s "$ORIGIN_FILE" ] && break; sleep 0.1; done
if [ ! -s "$ORIGIN_FILE" ]; then echo "  play-flow-smoke egress-redirect: fixture server did not start" >&2; exit 1; fi
REDIRECT_ORIGIN="$(cat "$ORIGIN_FILE")"

cat > "$DIR/flows/$NAME6.flow.json" <<JSON
{
  "name": "$NAME6",
  "engine": "playwright",
  "environment": "local",
  "riskClass": "read",
  "startUrl": "$REDIRECT_ORIGIN/",
  "steps": [
    { "kind": "find", "by": "text", "value": "Go blocked", "action": "click" },
    { "kind": "wait", "until": "url", "value": "http://rebind.test/**", "timeoutMs": 5000 }
  ],
  "asserts": []
}
JSON
printf '%s\n' '{}' > "$DIR/flows/$NAME6.values.json"

set +e
OUT6="$(env AQA_TARGET_ALLOWLIST="http://rebind.test" AQA_EGRESS_RESOLVED_IPS='{"rebind.test":["169.254.169.254"]}' node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$NAME6.flow.json" 2>&1)"
RC6=$?
set -e
if [ "$RC6" -eq 0 ]; then printf '%s\n' "$OUT6" >&2; echo "  play-flow-smoke egress-redirect: blocked redirect WRONGLY reported success" >&2; exit 1; fi
case "$OUT6" in *'egress policy refused request:'*'rebind.test'*'169.254.169.254'*) ;; *) printf '%s\n' "$OUT6" >&2; echo "  play-flow-smoke egress-redirect: missing resolved-IP metadata egress refusal" >&2; exit 1 ;; esac
echo "  play-flow-smoke egress-redirect: passed"

cat > "$DIR/flows/$NAME7.flow.json" <<JSON
{
  "name": "$NAME7",
  "engine": "playwright",
  "environment": "local",
  "riskClass": "read",
  "startUrl": "$REDIRECT_ORIGIN/iframe",
  "steps": [
    { "kind": "wait", "until": "text", "value": "Host page", "timeoutMs": 5000 }
  ],
  "asserts": []
}
JSON
printf '%s\n' '{}' > "$DIR/flows/$NAME7.values.json"

set +e
OUT7="$(env AQA_TARGET_ALLOWLIST="http://frame-rebind.test" AQA_EGRESS_RESOLVED_IPS='{"frame-rebind.test":["169.254.169.254"]}' node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$NAME7.flow.json" 2>&1)"
RC7=$?
set -e
if [ "$RC7" -eq 0 ]; then printf '%s\n' "$OUT7" >&2; echo "  play-flow-smoke egress-iframe: blocked iframe WRONGLY reported success" >&2; exit 1; fi
case "$OUT7" in *'egress policy refused request:'*'frame-rebind.test'*'169.254.169.254'*) ;; *) printf '%s\n' "$OUT7" >&2; echo "  play-flow-smoke egress-iframe: missing resolved-IP metadata egress refusal" >&2; exit 1 ;; esac
echo "  play-flow-smoke egress-iframe: passed"

cat > "$DIR/flows/$NAME8.flow.json" <<JSON
{
  "name": "$NAME8",
  "engine": "playwright",
  "environment": "local",
  "riskClass": "read",
  "startUrl": "$REDIRECT_ORIGIN/initial-redirect",
  "steps": [
    { "kind": "wait", "until": "load", "value": "networkidle", "timeoutMs": 5000 }
  ],
  "asserts": []
}
JSON
printf '%s\n' '{}' > "$DIR/flows/$NAME8.values.json"

set +e
OUT8="$(env AQA_TARGET_ALLOWLIST="http://initial-rebind.test" AQA_EGRESS_RESOLVED_IPS='{"initial-rebind.test":["169.254.169.254"]}' node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$NAME8.flow.json" 2>&1)"
RC8=$?
set -e
if [ "$RC8" -eq 0 ]; then printf '%s\n' "$OUT8" >&2; echo "  play-flow-smoke egress-initial-redirect: blocked initial redirect WRONGLY reported success" >&2; exit 1; fi
case "$OUT8" in *'egress policy refused request:'*'initial-rebind.test'*'169.254.169.254'*) ;; *) printf '%s\n' "$OUT8" >&2; echo "  play-flow-smoke egress-initial-redirect: missing resolved-IP metadata egress refusal" >&2; exit 1 ;; esac
echo "  play-flow-smoke egress-initial-redirect: passed"

cat > "$DIR/flows/$NAME9.flow.json" <<JSON
{
  "name": "$NAME9",
  "engine": "playwright",
  "environment": "local",
  "riskClass": "read",
  "startUrl": "$REDIRECT_ORIGIN/redirect-mismatch",
  "steps": [
    { "kind": "wait", "until": "load", "value": "networkidle", "timeoutMs": 5000 }
  ],
  "asserts": []
}
JSON
printf '%s\n' '{}' > "$DIR/flows/$NAME9.values.json"

set +e
OUT9="$(env AQA_TARGET_ALLOWLIST="http://mismatch-rebind.test" AQA_EGRESS_RESOLVER_EVIDENCE='{"mismatch-rebind.test":{"addresses":["93.184.216.34"]}}' AQA_EGRESS_CONNECTION_IPS='{"mismatch-rebind.test":["93.184.216.35"]}' node "$DIR/bin/play-flow.mjs" --flow "$DIR/flows/$NAME9.flow.json" 2>&1)"
RC9=$?
set -e
if [ "$RC9" -eq 0 ]; then printf '%s\n' "$OUT9" >&2; echo "  play-flow-smoke egress-connection-mismatch: blocked redirect WRONGLY reported success" >&2; exit 1; fi
case "$OUT9" in *'egress policy refused request:'*'mismatch-rebind.test'*'connection IP 93.184.216.35'*'does not match'*) ;; *) printf '%s\n' "$OUT9" >&2; echo "  play-flow-smoke egress-connection-mismatch: missing connection-IP mismatch refusal" >&2; exit 1 ;; esac
case "$OUT9" in *'top-secret'*) printf '%s\n' "$OUT9" >&2; echo "  play-flow-smoke egress-connection-mismatch: denial leaked URL secret" >&2; exit 1 ;; *) ;; esac
echo "  play-flow-smoke egress-connection-mismatch: passed"
