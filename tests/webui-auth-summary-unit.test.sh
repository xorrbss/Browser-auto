#!/usr/bin/env bash
# Browser-free unit for WebUI auth summaries: metadata only, no cookie/token/file-path exposure.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP="_authsum_$$"
STALE_APP="_authstale_$$"
MISSING_APP="_authmissing_$$"
CANON="$DIR/fixtures/auth/playwright/$APP.state.json"
LEGACY="$DIR/approve/$APP.pw-state.json"
STALE_CANON="$DIR/fixtures/auth/playwright/$STALE_APP.state.json"
trap 'rm -f "$CANON" "$LEGACY" "$STALE_CANON"' EXIT
mkdir -p "$DIR/fixtures/auth/playwright" "$DIR/approve"

cat > "$CANON" <<JSON
{
  "cookies": [
    { "name": "session", "value": "SECRET_COOKIE_VALUE_$APP", "domain": ".example.test" },
    { "name": "h_officeid", "value": "office-secret-$APP", "domain": "office.example.test" },
    { "name": "mfa_challenge", "value": "MFA_SECRET_$APP", "domain": ".example.test" }
  ],
  "origins": [
    {
      "origin": "https://login.example.test/path-not-exposed",
      "localStorage": [
        { "name": "otp_required", "value": "OTP_SECRET_$APP" }
      ]
    }
  ]
}
JSON
printf '{bad json' > "$LEGACY"

cat > "$STALE_CANON" <<JSON
{
  "cookies": [
    { "name": "session", "value": "STALE_SECRET_$STALE_APP", "domain": ".old.example.test" }
  ],
  "origins": []
}
JSON

( cd "$DIR" && APP="$APP" STALE_APP="$STALE_APP" MISSING_APP="$MISSING_APP" STALE_CANON="$STALE_CANON" node --input-type=module - <<'NODE'
import fs from 'node:fs';
import { AUTH_STALE_AFTER_MS, authReadinessForApp, listAuthReadinessSummaries, listAuthStates, listAuthStateSummaries } from './webui/auth.js';

const app = process.env.APP;
const staleApp = process.env.STALE_APP;
const missingApp = process.env.MISSING_APP;
const assert = (cond, msg) => { if (!cond) { console.error('  webui-auth-summary-unit: ' + msg); process.exit(1); } };

const old = new Date(Date.now() - AUTH_STALE_AFTER_MS - 60_000);
fs.utimesSync(process.env.STALE_CANON, old, old);

const apps = await listAuthStates();
assert(apps.includes(app), 'app appears in auth app list');
assert(apps.includes(staleApp), 'stale app appears in auth app list');

const states = (await listAuthStateSummaries()).filter((s) => s.app === app);
assert(states.length === 2, 'canonical and legacy summaries are visible as sources');
const canonical = states.find((s) => s.source === 'canonical');
const legacy = states.find((s) => s.source === 'legacy');
assert(canonical && canonical.valid === true, 'canonical JSON parses as valid');
assert(legacy && legacy.valid === false, 'legacy corrupt JSON reports invalid without content');
assert(canonical.engine === 'playwright', 'engine is present');
assert(canonical.state === 'ready' && canonical.ready === true && canonical.stale === false, 'fresh canonical state is ready');
assert(legacy.state === 'invalid' && legacy.ready === false, 'legacy corrupt JSON reports invalid readiness');
assert(canonical.domains.includes('example.test') && canonical.domains.includes('office.example.test') && canonical.domains.includes('login.example.test'), 'domains are summarized');
assert(Number.isFinite(canonical.createdAt) && Number.isFinite(canonical.modifiedAt), 'created/modified timestamps are present');
assert(Number.isFinite(canonical.createdAgeMs) && Number.isFinite(canonical.modifiedAgeMs), 'created/modified ages are present');
assert(canonical.updatedAt === canonical.modifiedAt && canonical.ageMs === canonical.modifiedAgeMs, 'legacy updatedAt/ageMs aliases still match modified metadata');
assert(canonical.otpMfa.localOnly === true && canonical.otpMfa.status === 'challenge-signal-detected' && canonical.otpMfa.challengeSignals === 2, 'OTP/MFA challenge signals are counted locally');

const stale = (await listAuthStateSummaries()).find((s) => s.app === staleApp && s.source === 'canonical');
assert(stale && stale.state === 'stale-auth' && stale.ready === true && stale.stale === true, 'old cached state is stale-auth but still ready');
assert(stale.modifiedAgeMs >= AUTH_STALE_AFTER_MS, 'stale auth exposes modified age metadata');
assert(stale.otpMfa.status === 'no-challenge-signal', 'MFA summary distinguishes no local challenge signal');

const missing = await authReadinessForApp(missingApp);
assert(missing.state === 'missing' && missing.ready === false && missing.present === false, 'per-app readiness reports missing when no cache exists');
assert(missing.modifiedAt === 0 && missing.modifiedAgeMs === null && missing.createdAgeMs === null, 'missing readiness has no fake timestamps');
assert(missing.otpMfa.status === 'missing' && missing.otpMfa.localOnly === true, 'missing auth has local-only MFA status');
assert(missing.sources.length === 2 && missing.sources.every((s) => s.state === 'missing'), 'missing readiness models both auth sources as missing');

const product = await listAuthReadinessSummaries([missingApp]);
assert(product.some((s) => s.app === app && s.state === 'ready'), 'product readiness includes effective ready auth');
assert(product.some((s) => s.app === staleApp && s.state === 'stale-auth'), 'product readiness includes stale-ish auth');
assert(product.some((s) => s.app === missingApp && s.state === 'missing'), 'product readiness includes requested missing auth');

const raw = JSON.stringify({ states, stale, missing, product });
assert(!raw.includes('SECRET_COOKIE_VALUE_'), 'cookie value is not exposed');
assert(!raw.includes('office-secret-'), 'legacy hint-like cookie value is not exposed');
assert(!raw.includes('MFA_SECRET_') && !raw.includes('OTP_SECRET_') && !raw.includes('STALE_SECRET_'), 'OTP/MFA and stale secret values are not exposed');
assert(!raw.includes('mfa_challenge') && !raw.includes('otp_required'), 'OTP/MFA key names are not exposed');
assert(!raw.includes('path-not-exposed'), 'origin path is not exposed');
assert(!raw.includes('fixtures/auth') && !raw.includes('approve/'), 'secret-bearing file paths are not exposed');
assert(!('hints' in canonical), 'cookie hints field is removed');

console.log('  webui-auth-summary-unit: auth readiness summaries expose metadata only');
NODE
)
