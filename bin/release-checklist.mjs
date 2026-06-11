#!/usr/bin/env node
// Build a release handoff from readiness metadata, deterministic run metadata,
// and git worktree state. This helper never parses raw run artifacts such as
// report.json, report.junit.xml, or results.tsv.

import { spawnSync } from 'node:child_process';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GENERATOR = 'release-checklist/v1';
const RUN_ID_RE = /^\d{8}-\d{6}-\d+$/;
const RAW_ARTIFACT_NAMES = new Set(['report.json', 'report.junit.xml', 'results.tsv']);
const KNOWN_ARTIFACT_FILES = Object.freeze({
	reportJson: 'report.json',
	junitXml: 'report.junit.xml',
	resultsTsv: 'results.tsv',
});
const DEFAULT_REQUIRED_COMMANDS = Object.freeze([
	'node --check bin/release-checklist.mjs',
	'bash tests/release-checklist-unit.test.sh',
]);
const DEFAULT_OPERATOR_ONLY_LANE = Object.freeze({
	id: 'operator-only',
	label: 'Operator-Only Live/Non-Local Lane',
	command: 'operator-approved named flow only',
	ciAllowed: false,
	ciBlockedReason: 'requires operator-owned auth/target allowlist and may contact non-local systems',
	liveAuthAllowed: true,
	nonLocalAllowed: true,
	liveActionAllowed: false,
});

function usage() {
	return `Usage: node bin/release-checklist.mjs [options]

Options:
  --repo <path>           Repository root. Defaults to the current directory.
  --readiness <json>      Readiness JSON input. Defaults to webui/readiness.js.
  --test-metadata <json>  Pre-summarized deterministic test metadata JSON.
  --artifacts-dir <path>  Artifact directory to metadata-scan when no test metadata is supplied.
  --format <json|markdown>
  --json                  Same as --format json.
  --markdown              Same as --format markdown.
  --out <path>            Write output to a file instead of stdout.
  --help                  Show this message.

Raw artifact files named report.json, report.junit.xml, or results.tsv are never accepted as
--test-metadata. Pass a metadata sidecar or let the helper scan artifact file metadata only.`;
}

function parseArgs(argv) {
	const opts = {
		repoRoot: process.cwd(),
		format: 'json',
	};
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		const next = () => {
			i += 1;
			if (i >= argv.length) throw new Error(`${arg} requires a value`);
			return argv[i];
		};
		if (arg === '--help' || arg === '-h') {
			opts.help = true;
		} else if (arg === '--repo') {
			opts.repoRoot = next();
		} else if (arg === '--readiness') {
			opts.readinessPath = next();
		} else if (arg === '--test-metadata') {
			opts.testMetadataPath = next();
		} else if (arg === '--artifacts-dir') {
			opts.artifactsDir = next();
		} else if (arg === '--format') {
			opts.format = next();
		} else if (arg === '--json') {
			opts.format = 'json';
		} else if (arg === '--markdown') {
			opts.format = 'markdown';
		} else if (arg === '--out') {
			opts.outPath = next();
		} else {
			throw new Error(`unknown option: ${arg}`);
		}
	}
	opts.repoRoot = path.resolve(opts.repoRoot);
	if (!['json', 'markdown'].includes(opts.format)) {
		throw new Error('--format must be json or markdown');
	}
	return opts;
}

async function readJsonFile(filePath) {
	const raw = await readFile(filePath, 'utf8');
	return JSON.parse(raw);
}

function assertNotRawArtifactMetadata(filePath) {
	const base = path.basename(String(filePath || '')).toLowerCase();
	if (RAW_ARTIFACT_NAMES.has(base)) {
		throw new Error(`refusing to read raw artifact file as metadata: ${base}`);
	}
}

async function loadReadiness(options = {}) {
	if (options.readiness) return options.readiness;
	if (options.readinessPath) {
		return readJsonFile(path.resolve(options.readinessPath));
	}
	const readinessModule = await import(new URL('../webui/readiness.js', import.meta.url));
	return readinessModule.getP0Readiness();
}

async function loadTestMetadata(options = {}) {
	if (options.testMetadata) {
		return normalizeTestMetadata(options.testMetadata, options.repoRoot);
	}
	if (options.testMetadataPath) {
		assertNotRawArtifactMetadata(options.testMetadataPath);
		return normalizeTestMetadata(await readJsonFile(path.resolve(options.testMetadataPath)), options.repoRoot);
	}
	return scanLatestArtifactMetadata(options.repoRoot, options.artifactsDir);
}

function pathToDisplay(repoRoot, value) {
	if (!value) return '';
	const raw = String(value);
	const absolute = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(repoRoot, raw);
	const rel = path.relative(repoRoot, absolute);
	if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
		return rel.split(path.sep).join('/');
	}
	return raw.split(path.sep).join('/');
}

function displayJoin(...parts) {
	return parts.filter(Boolean).join('/').replace(/\\/g, '/');
}

function numericOrNull(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function cleanSummary(input = {}) {
	const summary = input.summary || input.totals || input;
	const total = numericOrNull(summary.total ?? summary.tests ?? input.total);
	const passed = numericOrNull(summary.passed ?? summary.pass ?? input.passed);
	const failed = numericOrNull(summary.failed ?? summary.failures ?? summary.fail ?? input.failed);
	const skipped = numericOrNull(summary.skipped ?? input.skipped);
	const durationMs = numericOrNull(summary.durationMs ?? summary.duration ?? input.durationMs);
	const out = {};
	if (total !== null) out.total = total;
	if (passed !== null) out.passed = passed;
	if (failed !== null) out.failed = failed;
	if (skipped !== null) out.skipped = skipped;
	if (durationMs !== null) out.durationMs = durationMs;
	return out;
}

function inferRunStatus(raw = {}, summary = {}) {
	const explicit = String(raw.status || raw.result || raw.outcome || '').toLowerCase();
	if (['pass', 'passed', 'success', 'succeeded', 'green'].includes(explicit)) return 'pass';
	if (['fail', 'failed', 'failure', 'red'].includes(explicit)) return 'fail';
	if (['missing', 'none'].includes(explicit)) return 'missing';
	if (Number(summary.failed || 0) > 0) return 'fail';
	if (Number(summary.total || 0) > 0 && Number(summary.failed || 0) === 0) return 'pass';
	return raw.present === false ? 'missing' : 'metadata-only';
}

function normalizeTestMetadata(input = {}, repoRoot = process.cwd()) {
	const raw = input.lastRun || input.latestRun || input;
	const runId = raw.runId || raw.id || '';
	const paths = {
		reportJson: raw.paths?.reportJson || raw.reportJson || raw.reportPath || raw.summaryPath,
		junitXml: raw.paths?.junitXml || raw.junitXml || raw.junitPath,
		resultsTsv: raw.paths?.resultsTsv || raw.resultsTsv || raw.resultsPath,
	};
	if (!paths.reportJson && runId) paths.reportJson = displayJoin('artifacts', runId, 'report.json');
	if (!paths.junitXml && runId) paths.junitXml = displayJoin('artifacts', runId, 'report.junit.xml');
	if (!paths.resultsTsv && runId) paths.resultsTsv = displayJoin('artifacts', runId, 'results.tsv');

	const summary = cleanSummary(raw);
	const status = inferRunStatus(raw, summary);
	const normalizedPaths = {};
	for (const [key, value] of Object.entries(paths)) {
		if (value) normalizedPaths[key] = pathToDisplay(repoRoot, value);
	}
	return {
		source: raw.source || 'test-metadata-input',
		present: raw.present !== false && status !== 'missing',
		runId: String(runId || ''),
		status,
		deterministic: raw.deterministic !== false,
		summaryPath: normalizedPaths.reportJson || '',
		paths: normalizedPaths,
		summary,
		files: raw.files || {},
		metadataPath: raw.metadataPath ? pathToDisplay(repoRoot, raw.metadataPath) : undefined,
		rawContentsRead: false,
	};
}

function compareRunIdsDesc(a, b) {
	const [adate, atime, apid = '0'] = a.split('-');
	const [bdate, btime, bpid = '0'] = b.split('-');
	const stamp = `${bdate}-${btime}`.localeCompare(`${adate}-${atime}`);
	if (stamp !== 0) return stamp;
	return Number(bpid) - Number(apid);
}

async function safeFileMetadata(filePath) {
	try {
		const s = await stat(filePath);
		return {
			exists: true,
			bytes: s.size,
			mtimeMs: Math.round(s.mtimeMs),
			mtimeIso: s.mtime.toISOString(),
		};
	} catch {
		return { exists: false };
	}
}

async function scanLatestArtifactMetadata(repoRoot = process.cwd(), artifactsDirOption) {
	const artifactsDir = artifactsDirOption
		? path.resolve(repoRoot, artifactsDirOption)
		: path.join(repoRoot, 'artifacts');
	let entries = [];
	try {
		entries = await readdir(artifactsDir, { withFileTypes: true });
	} catch {
		return {
			source: 'artifacts-dir-metadata',
			present: false,
			runId: '',
			status: 'missing',
			deterministic: true,
			summaryPath: '',
			paths: {},
			summary: {},
			files: {},
			rawContentsRead: false,
		};
	}
	const runIds = entries.filter((entry) => entry.isDirectory() && RUN_ID_RE.test(entry.name)).map((entry) => entry.name).sort(compareRunIdsDesc);
	if (!runIds.length) {
		return {
			source: 'artifacts-dir-metadata',
			present: false,
			runId: '',
			status: 'missing',
			deterministic: true,
			summaryPath: '',
			paths: {},
			summary: {},
			files: {},
			rawContentsRead: false,
		};
	}
	const runId = runIds[0];
	const runDir = path.join(artifactsDir, runId);
	const paths = {};
	const files = {};
	for (const [key, fileName] of Object.entries(KNOWN_ARTIFACT_FILES)) {
		const full = path.join(runDir, fileName);
		paths[key] = pathToDisplay(repoRoot, full);
		files[key] = await safeFileMetadata(full);
	}
	return {
		source: 'artifacts-dir-metadata',
		present: files.reportJson.exists === true,
		runId,
		status: 'metadata-only',
		deterministic: true,
		summaryPath: paths.reportJson,
		paths,
		summary: {},
		files,
		rawContentsRead: false,
	};
}

function parseGitStatusLine(line) {
	if (!line || line.startsWith('## ')) return null;
	if (line.startsWith('?? ')) {
		return { code: '??', path: line.slice(3).trim(), staged: false, worktree: false, untracked: true };
	}
	const code = line.slice(0, 2);
	const filePath = line.slice(3).trim();
	const x = code[0] || ' ';
	const y = code[1] || ' ';
	return {
		code,
		path: filePath,
		staged: x !== ' ' && x !== '?',
		worktree: y !== ' ',
		untracked: false,
		deleted: x === 'D' || y === 'D',
		renamed: x === 'R' || y === 'R',
		conflicted: code.includes('U') || ['AA', 'DD'].includes(code),
	};
}

function dirtyCounts(entries) {
	const counts = {
		total: entries.length,
		staged: 0,
		modified: 0,
		untracked: 0,
		deleted: 0,
		renamed: 0,
		conflicted: 0,
	};
	for (const entry of entries) {
		if (entry.staged) counts.staged += 1;
		if (entry.worktree) counts.modified += 1;
		if (entry.untracked) counts.untracked += 1;
		if (entry.deleted) counts.deleted += 1;
		if (entry.renamed) counts.renamed += 1;
		if (entry.conflicted) counts.conflicted += 1;
	}
	return counts;
}

export function getDirtyWorktreeSummary(repoRoot = process.cwd()) {
	const result = spawnSync('git', ['-C', repoRoot, 'status', '--short', '--branch', '--untracked-files=all'], {
		encoding: 'utf8',
		maxBuffer: 1024 * 1024,
	});
	if (result.error || result.status !== 0) {
		return {
			available: false,
			dirty: true,
			branch: '',
			counts: { total: 0, staged: 0, modified: 0, untracked: 0, deleted: 0, renamed: 0, conflicted: 0 },
			entries: [],
			error: result.error?.message || String(result.stderr || 'git status failed').trim(),
		};
	}
	const lines = String(result.stdout || '').split(/\r?\n/).filter(Boolean);
	const branchLine = lines.find((line) => line.startsWith('## ')) || '';
	const branch = branchLine.replace(/^##\s+/, '').trim();
	const entries = lines.map(parseGitStatusLine).filter(Boolean);
	return {
		available: true,
		dirty: entries.length > 0,
		branch,
		counts: dirtyCounts(entries),
		entries: entries.slice(0, 50).map((entry) => ({
			code: entry.code,
			path: entry.path,
		})),
		truncated: entries.length > 50,
	};
}

function uniqueStrings(values) {
	const out = [];
	const seen = new Set();
	for (const value of values) {
		const s = String(value || '').trim();
		if (!s || seen.has(s)) continue;
		seen.add(s);
		out.push(s);
	}
	return out;
}

function readinessMatrix(readiness = {}) {
	return Array.isArray(readiness.matrix) ? readiness.matrix : [];
}

function releaseChecklist(readiness = {}) {
	return readiness.releaseChecklist && typeof readiness.releaseChecklist === 'object' ? readiness.releaseChecklist : {};
}

function normalizeCiLanes(readiness = {}) {
	const checklist = releaseChecklist(readiness);
	const lanes = Array.isArray(checklist.ciLanes)
		? checklist.ciLanes
		: Array.isArray(readiness.ciLanes)
			? readiness.ciLanes
			: [];
	const normalized = lanes.map((lane) => ({ ...lane }));
	const hasOperatorOnly = normalized.some((lane) => lane.id === 'operator-only');
	if (!hasOperatorOnly) normalized.push({ ...DEFAULT_OPERATOR_ONLY_LANE });
	return normalized;
}

function normalizeCiBlockedLanes(readiness = {}, lanes = []) {
	const checklist = releaseChecklist(readiness);
	const explicit = Array.isArray(checklist.ciBlockedLanes) ? checklist.ciBlockedLanes : [];
	const blocked = lanes
		.filter((lane) => lane.ciAllowed === false)
		.map((lane) => ({ id: lane.id, reason: lane.ciBlockedReason || lane.reason || 'operator-only' }));
	return uniqueBy([...explicit, ...blocked], (lane) => lane.id || lane.reason).map((lane) => ({
		id: lane.id,
		reason: lane.reason || lane.ciBlockedReason || 'operator-only',
	}));
}

function uniqueBy(values, keyFn) {
	const out = [];
	const seen = new Set();
	for (const value of values) {
		const key = keyFn(value);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(value);
	}
	return out;
}

function addBlocker(blockers, blocker) {
	const text = String(blocker.text || '').trim();
	if (!text) return;
	const key = `${blocker.type || ''}|${blocker.section || ''}|${text}`;
	if (blockers.some((existing) => `${existing.type || ''}|${existing.section || ''}|${existing.text || ''}` === key)) return;
	blockers.push({
		type: blocker.type || 'release-blocker',
		section: blocker.section || undefined,
		category: blocker.category || undefined,
		text,
		requiredCommand: blocker.requiredCommand || undefined,
		currentEvidence: blocker.currentEvidence || undefined,
		requiredEvidence: blocker.requiredEvidence || undefined,
		blockerReason: blocker.blockerReason || undefined,
	});
}

function readinessMissingEvidence(readiness = {}) {
	const checklist = releaseChecklist(readiness);
	const explicit = Array.isArray(checklist.missingEvidence) ? checklist.missingEvidence : [];
	const fromMatrix = readinessMatrix(readiness).flatMap((entry) => [
		...(entry.missingEvidence?.contractOnly || []),
		...(entry.missingEvidence?.externalBlocked || []),
	]);
	return uniqueBy([...explicit, ...fromMatrix], (item) => `${item.section || ''}|${item.category || ''}|${item.item || ''}|${item.requiredCommand || ''}`)
		.map((item) => ({
			section: item.section || item.id || '',
			category: item.category || '',
			item: item.item || item.text || '',
			requiredCommand: item.requiredCommand || '',
			currentEvidence: item.currentEvidence || '',
			requiredEvidence: item.requiredEvidence || '',
			blockerReason: item.blockerReason || '',
		}));
}

function isLocalCommand(value) {
	return /^(bash|node|npm|npx)\s+/.test(String(value || '').trim());
}

function collectReadinessBlockers(readiness = {}, blockers) {
	const checklist = releaseChecklist(readiness);
	for (const section of checklist.openSections || []) {
		addBlocker(blockers, {
			type: 'p0-open-section',
			section,
			text: `${section} has open P0 checklist items`,
		});
	}
	for (const section of checklist.contractOnly || []) {
		addBlocker(blockers, {
			type: 'p0-contract-only',
			section,
			text: `${section} is contract-only and not externally accepted`,
		});
	}
	for (const section of checklist.externalBlocked || []) {
		addBlocker(blockers, {
			type: 'p0-external-blocked',
			section,
			text: `${section} has external/operator-owned blockers`,
		});
	}
	for (const item of readinessMissingEvidence(readiness)) {
		addBlocker(blockers, {
			type: item.category === 'external-blocked' ? 'p0-external-evidence-missing' : 'p0-contract-evidence-missing',
			section: item.section,
			category: item.category,
			text: `${item.section}: ${item.item}`,
			requiredCommand: item.requiredCommand,
			currentEvidence: item.currentEvidence,
			requiredEvidence: item.requiredEvidence,
			blockerReason: item.blockerReason,
		});
	}
	for (const entry of readinessMatrix(readiness)) {
		const id = entry.id || entry.section;
		const open = Number(entry.checklist?.open || 0);
		if (open > 0) {
			addBlocker(blockers, {
				type: 'p0-open-section',
				section: id,
				text: `${id} has ${open} open checklist item(s)`,
			});
		}
		if (entry.status && entry.status !== 'implemented') {
			addBlocker(blockers, {
				type: 'p0-status',
				section: id,
				text: `${id} status is ${entry.status}`,
			});
		}
		if (Array.isArray(entry.externalBlocked) && entry.externalBlocked.length) {
			addBlocker(blockers, {
				type: 'p0-external-blocked',
				section: id,
				text: `${id} external blockers: ${entry.externalBlocked.join('; ')}`,
			});
		}
	}
	for (const item of readiness.blockers || []) {
		const section = item.section || item.id;
		addBlocker(blockers, {
			type: 'p0-checklist-item',
			section,
			text: section ? `${section}: ${item.text}` : item.text,
		});
	}
	if (readiness.decision === 'No-Go' && blockers.length === 0) {
		addBlocker(blockers, {
			type: 'readiness-no-go',
			text: 'readiness decision is No-Go',
		});
	}
}

function collectRunBlockers(lastRun = {}, blockers) {
	if (!lastRun.present || lastRun.status === 'missing') {
		addBlocker(blockers, {
			type: 'last-run-missing',
			text: 'no deterministic test run metadata was found',
		});
		return;
	}
	if (lastRun.deterministic === false) {
		addBlocker(blockers, {
			type: 'last-run-nondeterministic',
			text: 'last run metadata is not marked deterministic',
		});
	}
	if (lastRun.status === 'fail' || Number(lastRun.summary?.failed || 0) > 0) {
		addBlocker(blockers, {
			type: 'last-run-failed',
			text: `last deterministic run has ${Number(lastRun.summary?.failed || 0)} failing test(s)`,
		});
	}
}

function collectDirtyBlockers(dirtyWorktree = {}, blockers) {
	if (!dirtyWorktree.available) {
		addBlocker(blockers, {
			type: 'dirty-worktree-unavailable',
			text: `git status unavailable: ${dirtyWorktree.error || 'unknown error'}`,
		});
		return;
	}
	if (dirtyWorktree.dirty) {
		addBlocker(blockers, {
			type: 'dirty-worktree',
			text: `worktree has ${dirtyWorktree.counts?.total || 0} changed path(s)`,
		});
	}
}

function collectLaneBlockers(lanes = [], blockers) {
	const operatorOnly = lanes.find((lane) => lane.id === 'operator-only')
		|| lanes.find((lane) => /operator/i.test(String(lane.label || '')));
	if (!operatorOnly) {
		addBlocker(blockers, {
			type: 'operator-only-ci',
			text: 'operator-only lane is missing from CI lane metadata',
		});
		return;
	}
	if (operatorOnly.ciAllowed !== false) {
		addBlocker(blockers, {
			type: 'operator-only-ci',
			text: 'operator-only lane must be blocked from CI',
		});
	}
}

function collectBlockers({ readiness, lastRun, dirtyWorktree, ciLanes }) {
	const blockers = [];
	collectReadinessBlockers(readiness, blockers);
	collectRunBlockers(lastRun, blockers);
	collectDirtyBlockers(dirtyWorktree, blockers);
	collectLaneBlockers(ciLanes, blockers);
	return blockers;
}

function compactReadiness(readiness = {}) {
	const checklist = releaseChecklist(readiness);
	return {
		decision: readiness.decision || checklist.decision || '',
		state: readiness.state || '',
		document: readiness.document || '',
		total: readiness.total,
		checked: readiness.checked,
		open: readiness.open,
		matrix: readinessMatrix(readiness),
		releaseChecklist: {
			decision: checklist.decision || '',
			openSections: checklist.openSections || [],
			contractOnly: checklist.contractOnly || [],
			externalBlocked: checklist.externalBlocked || [],
			missingEvidence: readinessMissingEvidence(readiness),
		},
	};
}

export async function buildReleaseHandoff(options = {}) {
	const repoRoot = path.resolve(options.repoRoot || process.cwd());
	const readiness = await loadReadiness({ ...options, repoRoot });
	const lastRun = await loadTestMetadata({ ...options, repoRoot });
	const dirtyWorktree = options.dirtyWorktree || getDirtyWorktreeSummary(repoRoot);
	const ciLanes = normalizeCiLanes(readiness);
	const ciBlockedLanes = normalizeCiBlockedLanes(readiness, ciLanes);
	const operatorOnlyLane = ciLanes.find((lane) => lane.id === 'operator-only') || DEFAULT_OPERATOR_ONLY_LANE;
	const blockers = collectBlockers({ readiness, lastRun, dirtyWorktree, ciLanes });
	const requiredEvidence = readinessMissingEvidence(readiness);
	const requiredLocalCommands = uniqueStrings([
		...DEFAULT_REQUIRED_COMMANDS,
		...(releaseChecklist(readiness).requiredCommands || []),
		...requiredEvidence.map((item) => item.requiredCommand).filter(isLocalCommand),
	]);
	const decision = blockers.length ? 'No-Go' : 'Review Required';
	return {
		generator: GENERATOR,
		generatedAt: options.now || new Date().toISOString(),
		decision,
		state: decision === 'No-Go' ? 'no-go' : 'review-required',
		requiredLocalCommands,
		requiredEvidence,
		operatorOnlyLaneBlockedInCi: operatorOnlyLane.ciAllowed === false,
		operatorOnlyLane: {
			id: operatorOnlyLane.id,
			label: operatorOnlyLane.label,
			command: operatorOnlyLane.command,
			ciAllowed: operatorOnlyLane.ciAllowed === true,
			ciBlockedReason: operatorOnlyLane.ciBlockedReason || operatorOnlyLane.reason || '',
		},
		ciLanes,
		ciBlockedLanes,
		lastRun,
		dirtyWorktree,
		readiness: compactReadiness(readiness),
		blockers,
		artifactHandling: {
			mode: 'metadata-only',
			rawArtifactContentsRead: false,
			note: 'report.json, report.junit.xml, and results.tsv are referenced by path/stat metadata only',
		},
	};
}

function inlineCode(value) {
	return `\`${String(value || '').replace(/`/g, '\\`')}\``;
}

function matrixLine(entry) {
	const id = entry.id || entry.section || 'P0';
	const status = entry.status || 'unknown';
	const checklist = entry.checklist || {};
	const open = Number(checklist.open || 0);
	const external = Array.isArray(entry.externalBlocked) ? entry.externalBlocked.length : 0;
	const contractEvidence = Array.isArray(entry.missingEvidence?.contractOnly) ? entry.missingEvidence.contractOnly.length : 0;
	const externalEvidence = Array.isArray(entry.missingEvidence?.externalBlocked) ? entry.missingEvidence.externalBlocked.length : 0;
	return `- ${id}: ${status}; open=${open}; external blockers=${external}; missing evidence contract=${contractEvidence}, external=${externalEvidence}`;
}

function formatSummary(summary = {}) {
	const parts = [];
	for (const key of ['total', 'passed', 'failed', 'skipped', 'durationMs']) {
		if (summary[key] !== undefined) parts.push(`${key}=${summary[key]}`);
	}
	return parts.length ? parts.join(', ') : 'metadata only';
}

export function formatReleaseHandoffMarkdown(handoff) {
	const lines = [];
	lines.push('# Release Handoff');
	lines.push('');
	lines.push(`Decision: ${handoff.decision}`);
	lines.push(`Generated: ${handoff.generatedAt}`);
	lines.push('');
	lines.push('## Blockers');
	if (handoff.blockers.length) {
		for (const blocker of handoff.blockers) {
			const section = blocker.section ? `${blocker.section}: ` : '';
			lines.push(`- ${section}${blocker.text}`);
			if (blocker.requiredCommand) lines.push(`  Required command/evidence: ${inlineCode(blocker.requiredCommand)}`);
			if (blocker.blockerReason) lines.push(`  Reason: ${blocker.blockerReason}`);
		}
	} else {
		lines.push('- None; owner review is still required before external service open.');
	}
	lines.push('');
	lines.push('## Required Evidence');
	if (handoff.requiredEvidence.length) {
		for (const item of handoff.requiredEvidence) {
			lines.push(`- ${item.section} ${item.category}: ${item.item}`);
			lines.push(`  Required: ${item.requiredCommand ? inlineCode(item.requiredCommand) : item.requiredEvidence || 'owner evidence'}`);
			if (item.blockerReason) lines.push(`  Reason: ${item.blockerReason}`);
		}
	} else {
		lines.push('- None supplied by readiness metadata.');
	}
	lines.push('');
	lines.push('## Required Local Commands');
	for (const command of handoff.requiredLocalCommands) {
		lines.push(`- ${inlineCode(command)}`);
	}
	lines.push('');
	lines.push('## CI Lanes');
	for (const lane of handoff.ciLanes) {
		const status = lane.ciAllowed === false ? 'CI blocked' : 'CI allowed';
		const reason = lane.ciAllowed === false && (lane.ciBlockedReason || lane.reason) ? `: ${lane.ciBlockedReason || lane.reason}` : '';
		lines.push(`- ${lane.id || lane.label}: ${status}${reason}`);
	}
	lines.push('');
	lines.push('## Last Deterministic Run');
	lines.push(`- Run ID: ${handoff.lastRun.runId || 'none'}`);
	lines.push(`- Status: ${handoff.lastRun.status || 'unknown'}`);
	lines.push(`- Summary path: ${handoff.lastRun.summaryPath ? inlineCode(handoff.lastRun.summaryPath) : 'none'}`);
	lines.push(`- Summary: ${formatSummary(handoff.lastRun.summary)}`);
	lines.push(`- Raw artifact contents read: ${handoff.lastRun.rawContentsRead === true ? 'yes' : 'no'}`);
	lines.push('');
	lines.push('## Dirty Worktree');
	const dirty = handoff.dirtyWorktree || {};
	lines.push(`- Available: ${dirty.available === false ? 'no' : 'yes'}`);
	lines.push(`- Dirty: ${dirty.dirty ? 'yes' : 'no'}`);
	lines.push(`- Counts: total=${dirty.counts?.total || 0}, staged=${dirty.counts?.staged || 0}, modified=${dirty.counts?.modified || 0}, untracked=${dirty.counts?.untracked || 0}`);
	for (const entry of dirty.entries || []) {
		lines.push(`- ${entry.code} ${entry.path}`);
	}
	if (dirty.truncated) lines.push('- ... truncated');
	lines.push('');
	lines.push('## P0 Matrix');
	if (handoff.readiness.matrix.length) {
		for (const entry of handoff.readiness.matrix) lines.push(matrixLine(entry));
	} else {
		lines.push('- No matrix entries supplied.');
	}
	lines.push('');
	lines.push('## Artifact Handling');
	lines.push('- Mode: metadata-only');
	lines.push('- Raw report/JUnit/results content is not read by this helper.');
	return `${lines.join('\n')}\n`;
}

export function formatReleaseHandoffJson(handoff) {
	return `${JSON.stringify(handoff, null, 2)}\n`;
}

async function runCli(argv) {
	const options = parseArgs(argv);
	if (options.help) {
		return { text: `${usage()}\n`, outPath: options.outPath };
	}
	const handoff = await buildReleaseHandoff(options);
	const text = options.format === 'markdown'
		? formatReleaseHandoffMarkdown(handoff)
		: formatReleaseHandoffJson(handoff);
	return { text, outPath: options.outPath };
}

async function main() {
	try {
		const { text, outPath } = await runCli(process.argv.slice(2));
		if (outPath) {
			await writeFile(path.resolve(outPath), text, 'utf8');
		} else {
			process.stdout.write(text);
		}
	} catch (e) {
		process.stderr.write(`release-checklist: ${e.message}\n`);
		process.exitCode = 1;
	}
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
	main();
}

export const __filename = fileURLToPath(import.meta.url);
