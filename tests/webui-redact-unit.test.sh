#!/usr/bin/env bash
# Browser-free checks for WebUI redaction and audit summary surfaces.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

( cd "$DIR" && node --input-type=module - <<'NODE'
import { redactObject, redactText } from './webui/redact.js';
import { summarizeAuditEntries } from './webui/routes-approve.js';

const assert = (cond, msg) => { if (!cond) { console.error('  webui-redact-unit: ' + msg); process.exit(1); } };

const text = redactText([
	'Authorization: Bearer abc.def-123',
	'Cookie: sid=s3cr3t; theme=light',
	'password=hunter2 token=tok_123',
	'https://example.test/path?session=secret&user=me',
	'user@example.com 010-1234-5678 900101-1234567',
].join(' '), '', 2000);

for (const raw of ['abc.def-123', 's3cr3t', 'hunter2', 'tok_123', 'session=secret', 'user@example.com', '010-1234-5678', '900101-1234567']) {
	assert(!text.includes(raw), `redacted text must not contain ${raw}`);
}
assert(text.includes('authorization: [redacted]'), 'authorization header is redacted');
assert(text.includes('Cookie: [redacted]'), 'cookie header is redacted');
assert(text.includes('https://example.test/path?[redacted]'), 'URL query string is redacted');
assert(text.includes('[REDACTED_EMAIL]') && text.includes('[REDACTED_PHONE]') && text.includes('[REDACTED_ID]'), 'PII markers are present');

const obj = redactObject({
	password: 'hunter2',
	nested: {
		access_token: 'tok_123',
		detail: 'contact user@example.com bearer abcdef',
	},
	values_json: { input_1: 'secret form value' },
});
assert(obj.password === '[redacted]', 'sensitive top-level key is redacted');
assert(obj.nested.access_token === '[redacted]', 'nested token key is redacted');
assert(obj.values_json === '[redacted]', 'flow values sidecar key is redacted');
assert(obj.nested.detail.includes('[REDACTED_EMAIL]') && !obj.nested.detail.includes('abcdef'), 'nested string value is redacted');

const clipped = redactText('x'.repeat(50), '', 12);
assert(clipped.length === 12 && clipped.endsWith('...'), 'long redacted text is clipped');

const summary = summarizeAuditEntries([
	{ at: '2026-06-10T01:00:00.000Z', stage: 'requested', live: false, status: 'ok' },
	{ at: '2026-06-10T02:00:00.000Z', stage: 'clicked', live: true, ok: true },
	{ at: '2026-06-10T03:00:00.000Z', stage: 'clicked', dryRun: false, outcome: 'confirmed' },
], 1);
assert(summary.total === 3 && summary.malformed === 1, 'audit summary keeps total and malformed counts');
assert(summary.latestAt === '2026-06-10T03:00:00.000Z', 'audit summary exposes latest timestamp');
assert(summary.live === 2 && summary.dryRun === 1, 'audit summary counts live/dry-run modes');
assert(summary.byStage.clicked === 2 && summary.byStatus.confirmed === 1, 'audit summary counts stages and statuses');

console.log('  webui-redact-unit: all checks passed');
NODE
)
