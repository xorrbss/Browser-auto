#!/usr/bin/env bash
# Fail-loud scope guards of bin/pw-record.mjs:
#   1) a popup/new tab during recording  -> FATAL, no flow written
#   2) a mid-recording top-level cross-origin navigation -> FATAL, no flow written
# Both used to be silently-dropped events (fail-open) after the Playwright migration. Runs the real
# recorder headless via the AQA_PW_RECORD_HEADLESS test seam against two local http origins.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NAME_POP="_pwg_pop_$$"
NAME_XO="_pwg_xo_$$"
cleanup(){ rm -f "$DIR/flows/$NAME_POP.flow.json" "$DIR/flows/$NAME_XO.flow.json" "$DIR/flows/$NAME_POP.candidates.json" "$DIR/flows/$NAME_XO.candidates.json" "$DIR/flows/$NAME_POP.values.json" "$DIR/flows/$NAME_XO.values.json"; }
trap cleanup EXIT

OUT="$(cd "$DIR" && NAME_POP="$NAME_POP" NAME_XO="$NAME_XO" node --input-type=module - <<'NODE' 2>&1
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const fail = (msg) => { console.error('  pw-record-guards-unit: ' + msg); process.exit(1); };

function serve(htmlFor) {
	return new Promise((resolve) => {
		const s = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(htmlFor(req)); });
		s.listen(0, '127.0.0.1', () => resolve(s));
	});
}
const originOf = (s) => `http://127.0.0.1:${s.address().port}`;

function runRecorder(name, url) {
	return new Promise((resolve) => {
		const child = spawn(process.execPath, ['bin/pw-record.mjs', '--name', name, '--url', url, '--seconds', '20'], {
			cwd: ROOT,
			env: { ...process.env, AQA_PW_RECORD_HEADLESS: '1' },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		let out = '';
		child.stdout.on('data', (d) => { out += d; });
		child.stderr.on('data', (d) => { out += d; });
		child.on('close', (code) => resolve({ code, out }));
	});
}
function assertNoFlowArtifacts(name, label) {
	for (const ext of ['flow.json', 'candidates.json', 'values.json']) {
		const p = path.join(ROOT, 'flows', `${name}.${ext}`);
		if (fs.existsSync(p)) fail(`${label}: ${ext} was written despite the violation`);
	}
}

const srvB = await serve(() => '<!doctype html><p>other origin</p>');
const srvA = await serve((req) =>
	req.url.startsWith('/xo')
		? `<!doctype html><p>xo</p><script>setTimeout(() => { location.href = '${originOf(srvB)}/'; }, 700);</script>`
		: `<!doctype html><p>pop</p><script>setTimeout(() => { window.open('/second'); }, 700);</script>`);

try {
	// 1) popup/new tab -> FATAL, early stop, no flow written
	const pop = await runRecorder(process.env.NAME_POP, `${originOf(srvA)}/`);
	if (/Executable doesn't exist|Chromium distribution|not found at/.test(pop.out)) { console.log('SKIP_NO_BROWSER'); process.exit(0); }
	if (pop.code === 0) fail('popup case: recorder exited 0 (guard missing)');
	if (!pop.out.includes('new tab/popup opened during recording')) fail('popup case: missing fail-loud message; got: ' + pop.out.slice(-400));
	assertNoFlowArtifacts(process.env.NAME_POP, 'popup case');

	// 2) mid-recording top-level cross-origin navigation -> FATAL, no flow written
	const xo = await runRecorder(process.env.NAME_XO, `${originOf(srvA)}/xo`);
	if (xo.code === 0) fail('cross-origin case: recorder exited 0 (guard missing)');
	if (!xo.out.includes('cross-origin navigation during recording')) fail('cross-origin case: missing fail-loud message; got: ' + xo.out.slice(-400));
	assertNoFlowArtifacts(process.env.NAME_XO, 'cross-origin case');

	console.log('OK_GUARDS');
} finally {
	srvA.close();
	srvB.close();
}
NODE
)"
RC=$?
case "$OUT" in
	*SKIP_NO_BROWSER*) echo "  pw-record-guards-unit: skipped (Playwright Chrome channel unavailable)"; exit 0 ;;
	*OK_GUARDS*) echo "  pw-record-guards-unit: popup + cross-origin scope guards fail loud, no flow written"; exit 0 ;;
	*) printf '%s\n' "$OUT" | sed 's/^/    /' >&2; echo "  pw-record-guards-unit: failed (rc=$RC)" >&2; exit 1 ;;
esac
