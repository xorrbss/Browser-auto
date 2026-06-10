#!/usr/bin/env bash
# Local-only RPA product path: record/build-flow/verify/compile/run plus analyze/sync/enrich.
# Uses localhost fixture pages, a temporary DB, and temporary auth/flow artifacts only.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

set +e
OUT="$(cd "$DIR" && node --input-type=module - <<'NODE' 2>&1
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createRpaFixture, rpaFixtureRecipe } from './fixtures/rpa/local-fixture.mjs';
import { dedupeByOrigin } from './bin/pw-record.mjs';

const ROOT = process.cwd();
const rootRequire = createRequire(import.meta.url);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aqa-rpa-fixture-'));
const flowName = `_rpa_fixture_${process.pid}`;
const reviewName = `_rpa_review_${process.pid}`;
const systemName = `_rpa_sys_${process.pid}`;
const authState = path.join(ROOT, 'fixtures', 'auth', 'playwright', `${systemName}.state.json`);
const cleanup = [
	path.join(ROOT, 'flows', `${flowName}.flow.json`),
	path.join(ROOT, 'flows', `${flowName}.values.json`),
	path.join(ROOT, 'flows', `${flowName}.candidates.json`),
	path.join(ROOT, 'tests', `${flowName}.test.sh`),
	path.join(ROOT, 'flows', `${reviewName}.flow.json`),
	path.join(ROOT, 'flows', `${reviewName}.values.json`),
	path.join(ROOT, 'flows', `${reviewName}.candidates.json`),
	authState,
	path.join(ROOT, 'data', `${systemName}.snapshot.json`),
	path.join(ROOT, 'data', `${systemName}.proposed.json`),
];
let fixture = null;
let browser = null;

const bashPath = fs.existsSync('C:/Program Files/Git/bin/bash.exe') ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
const ok = (cond, msg) => {
	if (!cond) {
		console.error(`  rpa-local-fixture-e2e: ${msg}`);
		process.exit(1);
	}
	console.log(`  ok ${msg}`);
};
const skip = (msg) => {
	console.log(`SKIP_RPA_FIXTURE: ${msg}`);
	throw Object.assign(new Error(msg), { skip: true });
};
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
	const child = spawn(cmd, args, {
		cwd: ROOT,
		windowsHide: true,
		env: { ...process.env, ...(opts.env || {}) },
	});
	let out = '';
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		child.kill();
	}, opts.timeout || 60000);
	child.stdout?.on('data', (d) => { out += d.toString(); });
	child.stderr?.on('data', (d) => { out += d.toString(); });
	child.on('error', (err) => {
		clearTimeout(timer);
		reject(new Error(`${cmd} ${args.join(' ')} failed to start: ${err.message}\n${out}`));
	});
	child.on('close', (code, signal) => {
		clearTimeout(timer);
		const status = timedOut ? -1 : (code == null ? -1 : code);
		if (opts.allowFail) return resolve({ code: status, out });
		if (timedOut || status !== 0) {
			console.error(out);
			const suffix = timedOut ? `timed out after ${opts.timeout || 60000}ms` : `failed with ${status}${signal ? ` (${signal})` : ''}`;
			return reject(new Error(`${cmd} ${args.join(' ')} ${suffix}`));
		}
		return resolve({ code: status, out });
	});
	if (opts.input != null) child.stdin.end(opts.input);
	else child.stdin.end();
});

async function drainCaptureBuffers(page) {
	const drained = [];
	for (const frame of page.frames()) {
		const data = await frame.evaluate(() => ({
			url: location.href,
			isTop: window.top === window.self,
			crossOriginFrame: (() => {
				try { return window.top !== window.self && !window.frameElement; }
				catch { return true; }
			})(),
			buf: JSON.parse(sessionStorage.getItem('__aqa_buf') || '[]'),
			seq: parseInt(sessionStorage.getItem('__aqa_seq') || '0', 10) || 0,
		}));
		if (data.seq > data.buf.length) throw new Error(`capture health failed for ${data.url}`);
		drained.push(data);
	}
	return dedupeByOrigin(drained).buf;
}

async function resetCapture(page) {
	await page.evaluate(() => {
		sessionStorage.setItem('__aqa_buf', '[]');
		sessionStorage.setItem('__aqa_seq', '0');
		sessionStorage.setItem('__aqa_prevurl', location.href);
	});
}

async function buildFlow(name, startUrl, records) {
	const recPath = path.join(TMP, `${name}.records.json`);
	fs.writeFileSync(recPath, JSON.stringify(records, null, 2) + '\n');
	await run(process.execPath, ['bin/build-flow.js', name, startUrl, '', recPath, path.join(ROOT, 'flows'), 'playwright']);
	return path.join(ROOT, 'flows', `${name}.flow.json`);
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

try {
	let chromium;
	try { chromium = createRequire(path.join(ROOT, 'approve', 'package.json'))('playwright').chromium; }
	catch { skip('Playwright package unavailable'); }
	try { browser = await chromium.launch({ headless: true, channel: process.env.AQA_PW_CHANNEL || 'chrome' }); }
	catch (e) {
		if (/Executable doesn't exist|Chromium distribution|not found at/.test(String(e && e.message))) skip('Playwright Chrome channel unavailable');
		throw e;
	}

	fixture = await createRpaFixture();
	const ctx = await browser.newContext();
	await ctx.addInitScript({ path: path.join(ROOT, 'bin', 'capture.js') });
	const page = await ctx.newPage();

	// Record a business journey against localhost: paginate, open detail, fill form, save.
	await page.goto(`${fixture.origin}/tickets`, { waitUntil: 'domcontentloaded' });
	await resetCapture(page);
	await page.getByLabel('Page').selectOption('2');
	await page.getByTitle('RPA-2001').click();
	await page.waitForURL('**/tickets/RPA-2001');
	await page.getByLabel('Resolution note').fill('Approved locally');
	await page.getByRole('button', { name: 'Save resolution' }).click();
	await page.getByText('Resolution saved: Approved locally').waitFor();
	const records = await drainCaptureBuffers(page);
	ok(records.length >= 4, `recorded local business journey (${records.length} events)`);

	const flowPath = await buildFlow(flowName, `${fixture.origin}/tickets`, records);
	const flow = readJson(flowPath);
	flow.asserts = [...(flow.asserts || []), { kind: 'text', value: 'Resolution saved: Approved locally' }];
	fs.writeFileSync(flowPath, JSON.stringify(flow, null, 2) + '\n');
	ok(!JSON.stringify(flow).includes('@e'), 'built flow contains no transient @e refs');
	await run(bashPath, ['bin/probe-record.sh', 'verify', `flows/${flowName}.flow.json`]);
	await run(bashPath, ['bin/probe-record.sh', 'compile', `flows/${flowName}.flow.json`]);
	await run(bashPath, [`tests/${flowName}.test.sh`]);
	ok(true, 'record -> build-flow -> verify -> compile -> run passed on localhost');

	// Cross-origin iframe action must become needs_review and refuse compile.
	await page.goto(`${fixture.origin}/needs-review`, { waitUntil: 'domcontentloaded' });
	await resetCapture(page);
	await page.frameLocator('iframe#xoFrame').getByTestId('xo-approve').click();
	await page.waitForTimeout(100);
	const reviewRecords = await drainCaptureBuffers(page);
	const reviewPath = await buildFlow(reviewName, `${fixture.origin}/needs-review`, reviewRecords);
	const reviewFlow = readJson(reviewPath);
	ok(reviewFlow.steps[0]?.needs_review === true, 'cross-origin iframe record became needs_review');
	const refused = await run(bashPath, ['bin/probe-record.sh', 'compile', `flows/${reviewName}.flow.json`], { allowFail: true });
	ok(refused.code !== 0 && /needs_review/.test(refused.out), 'compile refuses unresolved needs_review');

	// Same fixture also exposes headerless extraction.
	await page.goto(`${fixture.origin}/headerless`, { waitUntil: 'domcontentloaded' });
	const headerlessSnapshot = await page.locator('body').ariaSnapshot({ timeout: 10000 });
	const headerlessRecipe = JSON.stringify({
		collection: { name: 'Headerless Work' },
		key: 'id',
		columns: { id: 'id', subject: 'subject', owner: 'owner' },
		columnIndexes: { id: 1, subject: 2, owner: 3 },
	});
	const headerless = await run(process.execPath, ['bin/extract-list.js', headerlessRecipe], {
		env: {},
		input: JSON.stringify({ snapshot: headerlessSnapshot }),
	});

	await ctx.close();
	await browser.close();
	browser = null;
	const headerlessItems = JSON.parse(headerless.out || '[]');
	ok(headerlessItems.length === 2 && headerlessItems[1].key === 'HL-2', 'headerless table extracts by columnIndexes');

	// Analyze/sync/enrich through the generic system path with temp DB and temp auth state.
	const dbPath = path.join(TMP, 'rpa.db');
	process.env.AQA_DB_PATH = dbPath;
	const dbm = rootRequire('./lib/db.js');
	fs.mkdirSync(path.dirname(authState), { recursive: true });
	fs.writeFileSync(authState, JSON.stringify({ cookies: [], origins: [] }) + '\n');
	let db = dbm.openDb(dbPath);
	dbm.registerSystem(db, {
		name: systemName,
		label: 'Local RPA Fixture',
		engine: 'playwright',
		login_url: `${fixture.origin}/login`,
		success_url: `${fixture.origin}/tickets`,
		target_url: `${fixture.origin}/tickets`,
		recipe: rpaFixtureRecipe(),
	});
	dbm.closeDb(db);
	const env = { AQA_DB_PATH: dbPath, LLM_MODEL: '', SUMMARY_MODEL: '' };
	await run(process.execPath, ['bin/pw-rpa.mjs', 'analyze', '--system', systemName], { env });
	await run(process.execPath, ['bin/pw-rpa.mjs', 'sync', '--system', systemName], { env });
	db = dbm.openDb(dbPath);
	ok(dbm.countRecords(db, systemName) === 4, 'sync stored all paginated fixture records');
	dbm.closeDb(db);
	await run(process.execPath, ['bin/pw-rpa.mjs', 'enrich', '--system', systemName, '--key', 'RPA-2001'], { env });
	db = dbm.openDb(dbPath);
	const enriched = dbm.getRecord(db, systemName, 'RPA-2001');
	dbm.closeDb(db);
	ok(enriched?.data?.owner === 'Carol', 'enrich stored detail owner for page-2 record');
	ok(String(enriched?.data?.raw_text || '').includes('Quarterly approval'), 'enrich stored detail raw_text');

	console.log('OK_RPA_LOCAL_FIXTURE');
} catch (e) {
	if (e && e.skip) {
		// Printed above; cleanup still runs in finally.
	} else {
		throw e;
	}
} finally {
	try { if (browser) await browser.close(); } catch {}
	try { if (fixture) await fixture.close(); } catch {}
	for (const p of cleanup) {
		try { fs.rmSync(p, { force: true }); } catch {}
	}
	try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
}
NODE
)"
RC=$?
set -e
printf '%s\n' "$OUT" | sed 's/^/  /'
case "$OUT" in
	*SKIP_RPA_FIXTURE*) exit 0 ;;
	*OK_RPA_LOCAL_FIXTURE*) echo "  rpa-local-fixture-e2e: passed"; exit 0 ;;
	*) echo "  rpa-local-fixture-e2e: failed (rc=$RC)" >&2; exit 1 ;;
esac
