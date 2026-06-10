#!/usr/bin/env bash
# Browser-free unit coverage for bin/pw-rpa.mjs orchestration. Uses fake pages,
# snapshots, storage callbacks, and temp analyze output only; no auth, DB, live site, or artifacts.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if command -v wslpath >/dev/null 2>&1; then
	RPA_TMP="$(wslpath -w "$TMP")"
else
	RPA_TMP="$(cd "$TMP" && pwd -W 2>/dev/null || pwd)"
fi

(
	cd "$DIR"
	RPA_TMP="$RPA_TMP" node --input-type=module - <<'NODE'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { analyze, enrich, openRecord, sync } from './bin/pw-rpa.mjs';

const tmp = process.env.RPA_TMP;
const list = (...keys) => ({ items: keys.map((key) => ({ key, data: { id: key } })), sig: [...keys].sort().join(',') });
const browserStub = () => ({ closed: false, async close() { this.closed = true; } });
const readSeq = (pages, getPage) => {
	const seen = new Map();
	return async () => {
		const p = getPage();
		const reads = pages[p] || [];
		const i = seen.get(p) || 0;
		seen.set(p, i + 1);
		const r = reads[Math.min(i, reads.length - 1)];
		if (r instanceof Error) throw r;
		return r;
	};
};

const system = {
	name: 'tickets',
	target_url: 'https://example.test/tickets',
	recipe: {
		ready: { text: 'Tickets ready', timeout: 2 },
		pagination: { mode: 'combobox' },
		detail: {
			idLabel: 'id',
			ready: { text: 'Detail ready', timeout: 3 },
			urlGlob: '**/tickets/detail/**',
			fields: { dept: 'Dept' },
			bodyFromHeadingLevel: 1,
		},
	},
};

{
	const browser = browserStub();
	const calls = { goto: [], wait: [] };
	await analyze(system, 'recipe.json', {
		dataDir: tmp,
		newPage: async () => ({ browser, page: { url: () => system.target_url } }),
		gotoTarget: async (page, url, prefix) => calls.goto.push({ url, prefix }),
		waitText: async (page, text, seconds) => calls.wait.push({ text, seconds }),
		snapshotData: async () => ({ url: system.target_url, origin: 'https://example.test', refs: [], snapshot: '- table "Tickets"' }),
		runJson: (script, args, input, label) => {
			assert.equal(label, 'propose-recipe');
			assert.equal(JSON.parse(input).snapshot, '- table "Tickets"');
			return { proposedBy: 'unit', tables: [{ name: 'Tickets', headers: ['id'], rowCount: 1 }] };
		},
	});
	assert.equal(browser.closed, true, 'analyze closes browser');
	assert.deepEqual(calls.goto, [{ url: system.target_url, prefix: 'analyze' }], 'analyze navigates target');
	assert.deepEqual(calls.wait, [{ text: 'Tickets ready', seconds: 2 }], 'analyze honors ready timeout');
	assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'tickets.snapshot.json'), 'utf8')).snapshot, '- table "Tickets"', 'analyze writes snapshot');
	assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'tickets.proposed.json'), 'utf8')).proposedBy, 'unit', 'analyze writes proposal');
}

{
	const browser = browserStub();
	const page = { waitForTimeout: async () => {} };
	let currentPage = 1;
	const selected = [];
	const reads = readSeq({
		1: [list('A'), list('A')],
		2: [list('A'), list('B'), list('B')],
	}, () => currentPage);
	let upserted = null;
	let dualWritten = null;
	await sync(system, 'recipe.json', {
		newPage: async () => ({ browser, page }),
		gotoTarget: async () => {},
		waitText: async () => {},
		snapshotList: reads,
		pagerInfo: async () => ({ locator: {}, total: 2 }),
		selectPage: async (pager, p) => { selected.push(p); currentPage = p; },
		settleWait: async () => {},
		settleTries: 8,
		upsert: (systemName, items, prefix) => { upserted = { systemName, items, prefix }; },
		approvalsDualWrite: (systemName, items, prefix) => { dualWritten = { systemName, items, prefix }; },
	});
	assert.equal(browser.closed, true, 'sync closes browser');
	assert.deepEqual(selected, [2], 'sync drives page 2');
	assert.deepEqual(upserted.items.map((x) => x.key), ['A', 'B'], 'sync stores unique paginated rows');
	assert.equal(upserted.prefix, 'sync-system', 'sync storage prefix');
	assert.deepEqual(dualWritten.items.map((x) => x.key), ['A', 'B'], 'sync dual-write receives same rows');
}

{
	const browser = browserStub();
	const page = { waitForTimeout: async () => {} };
	let currentPage = 1;
	const reads = readSeq({
		1: [list('A'), list('A')],
		2: [list('A'), list('A'), list('A'), list('A')],
	}, () => currentPage);
	let upsertCalls = 0;
	await assert.rejects(
		() => sync(system, 'recipe.json', {
			newPage: async () => ({ browser, page }),
			gotoTarget: async () => {},
			waitText: async () => {},
			snapshotList: reads,
			pagerInfo: async () => ({ locator: {}, total: 2 }),
			selectPage: async (pager, p) => { currentPage = p; },
			settleWait: async () => {},
			settleTries: 4,
			upsert: () => { upsertCalls++; },
			approvalsDualWrite: () => {},
		}),
		/sync pagination page 2\/2 did not settle.*refusing to store partial pagination results/,
		'sync fails closed on unsettled page 2',
	);
	assert.equal(browser.closed, true, 'failed sync closes browser');
	assert.equal(upsertCalls, 0, 'failed sync does not store partial pages');
}

{
	let currentPage = 1;
	const selected = [];
	const clicked = [];
	const page = {
		waitForTimeout: async () => {},
		goto: async () => { currentPage = 1; },
		getByText: (text) => ({
			first: () => ({
				count: async () => (text === 'DOC-2' && currentPage === 2 ? 1 : 0),
				click: async () => clicked.push({ text, page: currentPage }),
			}),
		}),
	};
	const reads = readSeq({
		1: [list('DOC-1'), list('DOC-1')],
		2: [list('DOC-1'), list('DOC-2'), list('DOC-2')],
	}, () => currentPage);
	const opened = await openRecord(page, system, 'recipe.json', 'DOC-2', 'Tickets ready', {
		waitText: async () => {},
		snapshotList: reads,
		pagerInfo: async () => ({ locator: {}, total: 2 }),
		selectPage: async (pager, p) => { selected.push(p); currentPage = p; },
		settleWait: async () => {},
		settleTries: 8,
	});
	assert.equal(opened, true, 'openRecord finds the target on a later page');
	assert.deepEqual(selected, [2], 'openRecord paginates before detail click');
	assert.deepEqual(clicked, [{ text: 'DOC-2', page: 2 }], 'openRecord clicks the target key on page 2');
}

{
	const browser = browserStub();
	const opened = [];
	const waits = [];
	let upserted = null;
	let dualWritten = null;
	await enrich(system, 'recipe.json', {
		summaryModel: '',
		recordsToEnrich: (systemName) => {
			assert.equal(systemName, 'tickets');
			return ['DOC-2'];
		},
		newPage: async () => ({ browser, page: {} }),
		openRecord: async (page, sys, recipePath, key, listReady) => {
			opened.push({ name: sys.name, recipePath, key, listReady });
			return true;
		},
		waitUrl: async (page, want, seconds) => {
			waits.push({ kind: 'url', want, seconds });
			return true;
		},
		waitText: async (page, text, seconds) => waits.push({ kind: 'text', text, seconds }),
		snapshotData: async () => ({ snapshot: '- heading "Detail"' }),
		extractDetail: (data, recipePath, key) => {
			assert.equal(key, 'DOC-2');
			return { dept: 'Ops', raw_text: 'Body' };
		},
		runJson: () => { throw new Error('summarizer should not run without SUMMARY_MODEL'); },
		upsert: (systemName, items, prefix) => { upserted = { systemName, items, prefix }; },
		approvalsDualWrite: (systemName, items, prefix) => { dualWritten = { systemName, items, prefix }; },
	});
	assert.equal(browser.closed, true, 'enrich closes browser');
	assert.deepEqual(opened, [{ name: 'tickets', recipePath: 'recipe.json', key: 'DOC-2', listReady: 'Tickets ready' }], 'enrich opens the requested record');
	assert.deepEqual(waits, [
		{ kind: 'url', want: '**/tickets/detail/**', seconds: 12 },
		{ kind: 'text', text: 'Detail ready', seconds: 3 },
	], 'enrich waits for detail URL and ready text');
	assert.equal(upserted.prefix, 'enrich-system', 'enrich storage prefix');
	assert.deepEqual(upserted.items, [{ key: 'DOC-2', summary: null, data: { dept: 'Ops', raw_text: 'Body' } }], 'enrich stores extracted detail fields');
	assert.deepEqual(dualWritten.items, upserted.items, 'enrich dual-write receives wrapped records');
}

console.log('  ok pw-rpa-orchestration: analyze/sync/enrich/detail-open covered without live dependencies');
NODE
)
