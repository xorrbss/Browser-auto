#!/usr/bin/env bash
# Browser-free checks for WebUI redaction and audit summary surfaces.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

( cd "$DIR" && TMP="$TMP" node --input-type=module - <<'NODE'
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { redactObject, redactText } from './webui/redact.js';

const require = createRequire(import.meta.url);
const {
	assertFixtureArtifactClean,
	scanFixtureArtifact,
} = require('./tests/fixtures/p0-external-fixtures.cjs');

const assert = (cond, msg) => { if (!cond) { console.error('  webui-redact-unit: ' + msg); process.exit(1); } };

const text = redactText([
	'Authorization: Bearer abc.def-123',
	'Cookie: sid=s3cr3t; theme=light',
	'password=hunter2 token=tok_123 --api-key cli_secret',
	'"refresh_token":"json_refresh_secret"',
	'OTP 123456 verification code: 654321',
	'https://example.test/path?session=secret&user=me',
	'C:\\project\\Browser-auto\\fixtures\\auth\\playwright\\app.state.json',
	'flows/demo.values.json',
	'user@example.com 010-1234-5678 900101-1234567',
].join(' '), '', 2000);

for (const raw of ['abc.def-123', 's3cr3t', 'hunter2', 'tok_123', 'cli_secret', 'json_refresh_secret', '123456', '654321', 'session=secret', 'app.state.json', 'demo.values.json', 'user@example.com', '010-1234-5678', '900101-1234567']) {
	assert(!text.includes(raw), `redacted text must not contain ${raw}`);
}
assert(text.includes('authorization: [redacted]'), 'authorization header is redacted');
assert(text.includes('Cookie: [redacted]'), 'cookie header is redacted');
assert(text.includes('https://example.test/path?[redacted]'), 'URL query string is redacted');
assert(text.includes('[REDACTED_SECRET_PATH]'), 'secret-bearing paths are redacted');
assert(text.includes('[REDACTED_EMAIL]') && text.includes('[REDACTED_PHONE]') && text.includes('[REDACTED_ID]'), 'PII markers are present');
assertFixtureArtifactClean(text, 'redacted text sample');

for (const [label, sample] of [
	['auth header', 'Authorization: Bearer abc.def-123'],
	['cookie header', 'Cookie: sid=s3cr3t'],
	['bearer token', 'bearer abcdef123456'],
	['otp code', 'OTP 123456'],
	['password assignment', 'password=hunter2'],
	['secret path', 'fixtures/auth/playwright/app.state.json'],
]) {
	const scan = scanFixtureArtifact(sample, label);
	assert(!scan.ok, `${label} sample must fail fixture secret scan`);
}

for (const [label, sample] of [
	['redacted auth', redactText('Authorization: Bearer abc.def-123')],
	['redacted cookie', redactText('Cookie: sid=s3cr3t')],
	['redacted bearer', redactText('bearer abcdef123456')],
	['redacted otp', redactText('OTP 123456')],
	['redacted password', redactText('password=hunter2')],
	['redacted path', redactText('fixtures/auth/playwright/app.state.json')],
]) {
	assertFixtureArtifactClean(sample, label);
}

// Regression: a comma-joined cookie value must be fully redacted, not truncated at the first comma.
const cookieComma = redactText('Cookie: theme=light, sid=SECRETSESSION12345');
assert(!cookieComma.includes('SECRETSESSION12345'), 'comma-joined cookie value is fully redacted');
assert(cookieComma.includes('[redacted]'), 'comma-joined cookie header reports redaction');
// Diagnostic codes (HTTP status, error constants) must survive: "code" is not a blanket secret word.
assert(redactText('status code: 404 detail').includes('404'), 'HTTP status code survives redaction');
assert(redactText('result code: ECONNREFUSED at host').includes('ECONNREFUSED'), 'error code constant survives redaction');
// preserveWhitespace keeps TSV/aligned columns intact while still redacting secrets.
const tsvLine = redactText('login\tpass\t0.42\tok', '', 0, { preserveWhitespace: true });
assert(tsvLine === 'login\tpass\t0.42\tok', 'preserveWhitespace leaves clean tab-delimited rows untouched');
assert(redactText('user\tBearer abc.def-123\tok', '', 0, { preserveWhitespace: true }) === 'user\tBearer [redacted]\tok', 'preserveWhitespace redacts secrets without collapsing tabs');

const obj = redactObject({
	password: 'hunter2',
	nested: {
		access_token: 'tok_123',
		detail: 'contact user@example.com bearer abcdef',
		url: 'https://example.test/path?token=url_secret',
	},
	values_json: { input_1: 'secret form value' },
	headers: { Authorization: 'Bearer header_secret', Cookie: 'sid=cookie_secret' },
	rawPath: 'data/approvals.sqlite',
});
assert(obj.password === '[redacted]', 'sensitive top-level key is redacted');
assert(obj.nested.access_token === '[redacted]', 'nested token key is redacted');
assert(obj.values_json === '[redacted]', 'flow values sidecar key is redacted');
assert(obj.nested.detail.includes('[REDACTED_EMAIL]') && !obj.nested.detail.includes('abcdef'), 'nested string value is redacted');
assert(obj.nested.url === 'https://example.test/path?[redacted]', 'nested URL query is redacted');
assert(obj.headers.Authorization === '[redacted]' && obj.headers.Cookie === '[redacted]', 'header object values are redacted by key');
assert(obj.rawPath === '[REDACTED_SECRET_PATH]', 'object string paths are redacted');
assertFixtureArtifactClean(obj, 'redacted object sample');

const rawArtifactSample = {
	log: 'Authorization: Bearer artifact_secret Cookie: sid=artifact_cookie OTP 123456 password=artifact_password',
	path: 'fixtures/auth/playwright/artifact.state.json',
};
assert(!scanFixtureArtifact(rawArtifactSample, 'raw artifact sample').ok, 'raw artifact sample fails fixture secret scan');
assertFixtureArtifactClean(redactObject(rawArtifactSample), 'redacted artifact sample');

const clipped = redactText('x'.repeat(50), '', 12);
assert(clipped.length === 12 && clipped.endsWith('...'), 'long redacted text is clipped');

const { approveGet, summarizeAuditEntries } = await import('./webui/routes-approve.js');
const summary = summarizeAuditEntries([
	{ at: '2026-06-10T01:00:00.000Z', stage: 'requested password=hunter2', live: false, status: 'ok' },
	{ at: '2026-06-10T02:00:00.000Z', stage: 'clicked', live: true, ok: true },
	{ at: '2026-06-10T03:00:00.000Z', stage: 'clicked', dryRun: false, outcome: 'confirmed' },
], 1);
assert(summary.total === 3 && summary.malformed === 1, 'audit summary keeps total and malformed counts');
assert(summary.latestAt === '2026-06-10T03:00:00.000Z', 'audit summary exposes latest timestamp');
assert(summary.live === 2 && summary.dryRun === 1, 'audit summary counts live/dry-run modes');
assert(summary.byStage.clicked === 2 && summary.byStatus.confirmed === 1, 'audit summary counts stages and statuses');
assert(!JSON.stringify(summary).includes('hunter2'), 'audit summary keys are redacted');

const auditFile = path.join(process.env.TMP, 'approve-audit.jsonl');
process.env.WEBUI_APPROVE_AUDIT_PATH = auditFile;
fs.writeFileSync(auditFile, [
	JSON.stringify({
		at: '2026-06-10T04:00:00.000Z',
		stage: 'clicked',
		status: 'failed',
		authorization: 'Bearer audit_secret',
		cookie: 'sid=audit_cookie',
		password: 'audit_password',
		url: 'https://example.test/approve?token=audit_url_secret',
		otp: '123456',
		path: 'fixtures/auth/playwright/audit.state.json',
	}),
	'{bad json',
	'',
].join('\n'));
let payload = null;
const res = {};
const sendJson = (_res, code, obj) => { payload = { code, obj }; };
const handled = approveGet('/api/approve/audit', new URL('http://127.0.0.1/api/approve/audit?limit=10'), res, { sendJson });
assert(handled && payload.code === 200, 'audit route handled fake audit file');
const rawAudit = JSON.stringify(payload.obj);
for (const raw of ['audit_secret', 'audit_cookie', 'audit_password', 'audit_url_secret', '123456', 'audit.state.json']) {
	assert(!rawAudit.includes(raw), `audit readback must not expose ${raw}`);
}
assert(payload.obj.malformed === undefined && payload.obj.summary.malformed === 1, 'audit readback reports malformed count only in summary');
assert(payload.obj.redactionPolicy?.applied === true, 'audit readback declares redaction policy');

console.log('  webui-redact-unit: all checks passed');
NODE
)
