#!/usr/bin/env bash
# Browser-free unit for WebUI auth summaries: metadata only, no cookie/token/file-path exposure.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="_authsum_$$"
CANON="$DIR/fixtures/auth/playwright/$APP.state.json"
LEGACY="$DIR/approve/$APP.pw-state.json"
trap 'rm -f "$CANON" "$LEGACY"' EXIT
mkdir -p "$DIR/fixtures/auth/playwright" "$DIR/approve"

cat > "$CANON" <<JSON
{
  "cookies": [
    { "name": "session", "value": "SECRET_COOKIE_VALUE_$APP", "domain": ".example.test" },
    { "name": "h_officeid", "value": "office-secret-$APP", "domain": "office.example.test" }
  ],
  "origins": []
}
JSON
printf '{bad json' > "$LEGACY"

( cd "$DIR" && APP="$APP" node --input-type=module - <<'NODE'
import { listAuthStates, listAuthStateSummaries } from './webui/auth.js';

const app = process.env.APP;
const assert = (cond, msg) => { if (!cond) { console.error('  webui-auth-summary-unit: ' + msg); process.exit(1); } };

const apps = await listAuthStates();
assert(apps.includes(app), 'app appears in auth app list');

const states = (await listAuthStateSummaries()).filter((s) => s.app === app);
assert(states.length === 2, 'canonical and legacy summaries are visible as sources');
const canonical = states.find((s) => s.source === 'canonical');
const legacy = states.find((s) => s.source === 'legacy');
assert(canonical && canonical.valid === true, 'canonical JSON parses as valid');
assert(legacy && legacy.valid === false, 'legacy corrupt JSON reports invalid without content');
assert(canonical.engine === 'playwright', 'engine is present');
assert(canonical.domains.includes('example.test') && canonical.domains.includes('office.example.test'), 'domains are summarized');
assert(Number.isFinite(canonical.updatedAt) && Number.isFinite(canonical.ageMs), 'updatedAt/ageMs are present');
const raw = JSON.stringify(states);
assert(!raw.includes('SECRET_COOKIE_VALUE_'), 'cookie value is not exposed');
assert(!raw.includes('office-secret-'), 'legacy hint-like cookie value is not exposed');
assert(!raw.includes('fixtures/auth') && !raw.includes('approve/'), 'secret-bearing file paths are not exposed');
assert(!('hints' in canonical), 'cookie hints field is removed');

console.log('  webui-auth-summary-unit: auth summaries expose metadata only');
NODE
)
