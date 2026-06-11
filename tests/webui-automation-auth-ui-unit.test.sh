#!/usr/bin/env bash
# Browser-free checks for the WebUI automation auth controls.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail(){ echo "  webui-automation-auth-ui-unit: $1" >&2; exit 1; }

node --check "$DIR/webui/public/app.js" || fail "app syntax failed"

( cd "$DIR" && node --input-type=module - <<'NODE' ) || fail "automation auth UI contract failed"
import assert from 'node:assert/strict';
import fs from 'node:fs';

const appJs = fs.readFileSync('webui/public/app.js', 'utf8');

assert.match(
	appJs,
	/const app = manualApp \|\| autoApp \|\| matchedApp;/,
	'automatic app id is based on the current URLs before saved-auth matches',
);
assert.doesNotMatch(
	appJs,
	/authBtn\.disabled\s*=\s*loggedIn\s*\|\|/,
	'saved auth must not disable the login/refresh button',
);
assert.doesNotMatch(
	appJs,
	/if \(automationLoggedIn\(form\)\) return alert/,
	'login handler must allow refreshing an existing saved login',
);
assert.doesNotMatch(
	appJs,
	/node\.disabled\s*=\s*loggedIn/,
	'saved auth must not lock login URL or success URL inputs',
);
assert.match(appJs, /loggedIn \? '로그인 갱신'/, 'saved auth presents a refresh action');
assert.match(appJs, /저장된 로그인 있음/, 'saved auth badge is descriptive rather than a hard block');
NODE

echo "  webui-automation-auth-ui-unit: auth controls remain refreshable"
