// WebUI adapter for the release checklist CLI.
//
// This module exposes bin/release-checklist.mjs output to the control plane without
// adding another source of truth or reading raw report/JUnit/results contents.

import path from 'node:path';
import {
	buildReleaseHandoff,
	formatReleaseHandoffJson,
	formatReleaseHandoffMarkdown,
} from '../bin/release-checklist.mjs';
import { getP0Readiness } from './readiness.js';

const PROBE_ROOT = path.resolve(import.meta.dirname, '..');
const RAW_ARTIFACT_NAMES = new Set(['report.json', 'report.junit.xml', 'results.tsv']);

export const RELEASE_CHECKLIST_API_ROUTE = '/api/release-checklist';

function basenamePortable(value) {
	return String(value || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
}

export function assertMetadataOnlyReleaseChecklistOptions(options = {}) {
	for (const key of ['testMetadataPath', 'metadataPath']) {
		const value = options[key];
		if (!value) continue;
		const base = basenamePortable(value);
		if (RAW_ARTIFACT_NAMES.has(base)) {
			throw new Error(`refusing raw artifact file as release checklist metadata: ${base}`);
		}
	}
}

export function normalizeReleaseChecklistFormat(value = 'json') {
	const normalized = String(value || 'json').trim().toLowerCase();
	if (normalized === 'json' || normalized === 'application/json') return 'json';
	if (normalized === 'markdown' || normalized === 'md' || normalized === 'text/markdown' || normalized === 'text/x-markdown') {
		return 'markdown';
	}
	throw new Error('release checklist format must be json or markdown');
}

export function releaseChecklistFormatForRequest(url, headers = {}) {
	const queryFormat = url?.searchParams?.get('format')
		|| (url?.searchParams?.has('markdown') ? 'markdown' : '')
		|| (url?.searchParams?.has('json') ? 'json' : '');
	if (queryFormat) return normalizeReleaseChecklistFormat(queryFormat);
	const accept = String(headers.accept || '').toLowerCase();
	if (accept.includes('text/markdown') || accept.includes('text/x-markdown')) return 'markdown';
	return 'json';
}

export async function buildWebuiReleaseChecklist(options = {}) {
	assertMetadataOnlyReleaseChecklistOptions(options);
	const repoRoot = path.resolve(options.repoRoot || PROBE_ROOT);
	const readiness = options.readiness || await getP0Readiness();
	return buildReleaseHandoff({
		...options,
		repoRoot,
		readiness,
	});
}

export function renderWebuiReleaseChecklist(handoff, format = 'json') {
	const normalized = normalizeReleaseChecklistFormat(format);
	if (normalized === 'markdown') {
		return {
			format: normalized,
			contentType: 'text/markdown; charset=utf-8',
			body: formatReleaseHandoffMarkdown(handoff),
			json: null,
		};
	}
	return {
		format: normalized,
		contentType: 'application/json; charset=utf-8',
		body: formatReleaseHandoffJson(handoff),
		json: handoff,
	};
}

export async function getWebuiReleaseChecklist(options = {}) {
	const handoff = await buildWebuiReleaseChecklist(options);
	return renderWebuiReleaseChecklist(handoff, options.format || 'json');
}

function writeRendered(res, code, rendered) {
	const body = rendered.body;
	const headers = {
		'Content-Type': rendered.contentType,
		'Content-Length': Buffer.byteLength(body),
		'Cache-Control': 'no-store',
		'X-AQA-Artifact-Handling': 'metadata-only',
	};
	if (typeof res.writeHead === 'function') res.writeHead(code, headers);
	if (typeof res.end === 'function') res.end(body);
}

export async function releaseChecklistGet(p, url, res, deps = {}) {
	if (p !== RELEASE_CHECKLIST_API_ROUTE) return false;
	const format = releaseChecklistFormatForRequest(url, deps.headers || deps.req?.headers || {});
	const handoff = await buildWebuiReleaseChecklist(deps.options || {});
	if (format === 'json' && typeof deps.sendJson === 'function') {
		if (typeof res.setHeader === 'function') {
			res.setHeader('Cache-Control', 'no-store');
			res.setHeader('X-AQA-Artifact-Handling', 'metadata-only');
		}
		deps.sendJson(res, 200, handoff);
		return true;
	}
	writeRendered(res, 200, renderWebuiReleaseChecklist(handoff, format));
	return true;
}
