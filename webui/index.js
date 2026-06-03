// webui/index.js — read-only run index over artifacts/*/report.json.
//
// The filesystem is the single source of truth: run.sh writes
// artifacts/<RUN_ID>/report.json (a JSON array of {name,status,durationMs,artifacts})
// where RUN_ID = YYYYMMDD-HHMMSS-PID. This module only READS and parses it — no writes,
// no spawn, no DB. A process-lifetime Map cache keyed by the run dir's mtime means repeat
// calls re-parse only new/changed runs; the fs stays authoritative.
//
// URLs are DERIVED from runId + test name (artifacts/<runId>/<name>/video.webm), never
// from the report's absolute `artifacts` path string (which is host-specific).

import { readdir, readFile, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const PROBE_ROOT = path.resolve(import.meta.dirname, '..');
export const ARTIFACTS_DIR = path.join(PROBE_ROOT, 'artifacts');

// run.sh: RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
const RUN_ID_RE = /^\d{8}-\d{6}-\d+$/;

// Compare RUN_IDs (YYYYMMDD-HHMMSS-PID) ascending. The PID ($$) is variable-width, so a plain
// string sort mis-orders same-second runs (e.g. "-1000" < "-9"); compare the timestamp prefix
// lexicographically and the trailing PID numerically so prune/ordering pick the right run.
function cmpRunId(a, b) {
	const ai = a.lastIndexOf('-');
	const bi = b.lastIndexOf('-');
	const ap = a.slice(0, ai);
	const bp = b.slice(0, bi);
	if (ap !== bp) return ap < bp ? -1 : 1;
	return (Number(a.slice(ai + 1)) || 0) - (Number(b.slice(bi + 1)) || 0);
}

// runId -> { mtimeMs, data }
const cache = new Map();

// Parse RUN_ID's leading timestamp into an ISO string (local wall-clock, as run.sh stamps it).
// Round-trip every component because new Date(9999,98,99,...) silently ROLLS OVER into a
// valid far-future date rather than NaN — so a garbage dir name must yield null, not a
// nonsense timestamp.
function startedAtFromRunId(runId) {
	const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(runId);
	if (!m) return null;
	const [, Y, Mo, D, H, Mi, S] = m.map(Number);
	const d = new Date(Y, Mo - 1, D, H, Mi, S);
	if (
		d.getFullYear() !== Y || d.getMonth() !== Mo - 1 || d.getDate() !== D ||
		d.getHours() !== H || d.getMinutes() !== Mi || d.getSeconds() !== S
	) {
		return null;
	}
	return d.toISOString();
}

// Read + normalize one run's report.json into a detail object, or null if absent/invalid
// (run still in progress, or corrupt — never throw, just skip it from the index).
async function parseRun(runId) {
	const dir = path.join(ARTIFACTS_DIR, runId);
	let rows;
	try {
		rows = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8'));
	} catch {
		return null;
	}
	if (!Array.isArray(rows)) return null;

	const tests = rows.map((r) => {
		const name = typeof r?.name === 'string' ? r.name : '';
		const hasVideo = name ? existsSync(path.join(dir, name, 'video.webm')) : false;
		return {
			name,
			status: r?.status === 'pass' ? 'pass' : 'fail',
			durationMs: Number(r?.durationMs) || 0,
			hasVideo,
		};
	});
	const passed = tests.filter((t) => t.status === 'pass').length;
	return {
		runId,
		startedAt: startedAtFromRunId(runId),
		total: tests.length,
		passed,
		failed: tests.length - passed,
		durationMs: tests.reduce((a, t) => a + t.durationMs, 0),
		hasReport: existsSync(path.join(dir, 'report.json')),
		hasJunit: existsSync(path.join(dir, 'report.junit.xml')),
		tests,
	};
}

async function getRunCached(runId) {
	// Key the cache on report.json's OWN mtime, not the run dir's: a directory's mtime only
	// moves on entry add/remove, so an in-place rewrite of report.json (same filename) would
	// otherwise serve a stale parse. Statting the file also naturally returns null until the
	// report exists (run still in progress).
	const reportPath = path.join(ARTIFACTS_DIR, runId, 'report.json');
	let st;
	try {
		st = await stat(reportPath);
	} catch {
		cache.delete(runId);
		return null;
	}
	const hit = cache.get(runId);
	if (hit && hit.mtimeMs === st.mtimeMs) return hit.data;
	const data = await parseRun(runId);
	cache.set(runId, { mtimeMs: st.mtimeMs, data });
	return data;
}

// listRuns(): summaries (no per-test array), newest first.
export async function listRuns() {
	let entries;
	try {
		entries = await readdir(ARTIFACTS_DIR, { withFileTypes: true });
	} catch {
		return [];
	}
	const ids = entries.filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name)).map((e) => e.name);
	const runs = (await Promise.all(ids.map(getRunCached))).filter(Boolean);
	runs.sort((a, b) => cmpRunId(b.runId, a.runId)); // newest first (PID-numeric, same-second safe)
	return runs.map(({ tests, ...summary }) => summary);
}

// getRun(id): full detail (with per-test array) or null.
export async function getRun(runId) {
	if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return null;
	return getRunCached(runId);
}

// pruneArtifacts(keep): delete all but the newest `keep` RUN_ID dirs under artifacts/ (disk
// hygiene; the disk runs ~97% full). Only touches dirs matching RUN_ID_RE (never "standalone"
// or anything else), only under ARTIFACTS_DIR. Returns the dropped run ids.
export async function pruneArtifacts(keep) {
	// Never mass-delete on a bad/negative keep (a negative would otherwise clamp to "keep 0").
	if (!Number.isFinite(keep) || keep < 0) return { kept: 0, pruned: [] };
	let entries;
	try {
		entries = await readdir(ARTIFACTS_DIR, { withFileTypes: true });
	} catch {
		return { kept: 0, pruned: [] };
	}
	const ids = entries
		.filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
		.map((e) => e.name)
		.sort(cmpRunId); // ascending (oldest first), same-second safe
	const drop = ids.slice(0, Math.max(0, ids.length - Math.max(0, keep)));
	const pruned = [];
	for (const id of drop) {
		try {
			await rm(path.join(ARTIFACTS_DIR, id), { recursive: true, force: true });
			cache.delete(id);
			pruned.push(id);
		} catch {
			/* best-effort */
		}
	}
	return { kept: ids.length - pruned.length, pruned };
}

// getTrends(): pass-rate over time + per-test pass/fail history, oldest→newest. Read-only;
// reuses the same mtime-cached per-run parse. Pure aggregation over report.json.
export async function getTrends() {
	let entries;
	try {
		entries = await readdir(ARTIFACTS_DIR, { withFileTypes: true });
	} catch {
		return { runs: [], tests: {} };
	}
	const ids = entries
		.filter((e) => e.isDirectory() && RUN_ID_RE.test(e.name))
		.map((e) => e.name)
		.sort(cmpRunId); // chronological ascending (PID-numeric, same-second safe)
	const runs = [];
	const tests = {}; // testName -> [{ runId, startedAt, status }]
	for (const id of ids) {
		const r = await getRunCached(id);
		if (!r) continue;
		runs.push({
			runId: r.runId,
			startedAt: r.startedAt,
			total: r.total,
			passed: r.passed,
			failed: r.failed,
			passRate: r.total ? Math.round((r.passed / r.total) * 100) : 0,
		});
		for (const t of r.tests) {
			if (!t.name) continue; // skip nameless rows (report.sh drops them too) — no ghost trend row
			(tests[t.name] ||= []).push({ runId: r.runId, startedAt: r.startedAt, status: t.status });
		}
	}
	return { runs, tests };
}
