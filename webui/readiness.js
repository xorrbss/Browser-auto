// webui/readiness.js - read-only P0 service-open checklist summary.
//
// This intentionally reports documentation checklist state only. It is not a security attestation
// and never upgrades external-service readiness to green unless the source checklist is explicitly
// complete and independently reviewed.

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { securityModeSummary } from './security.js';

const PROBE_ROOT = path.resolve(import.meta.dirname, '..');
const P0_DOC_REL = 'dev/active/productization/P0-SERVICE-OPEN.md';
const P0_DOC = path.join(PROBE_ROOT, P0_DOC_REL);

function checkboxState(mark) {
	return /^[xX]$/.test(String(mark || '')) ? 'checked' : 'open';
}

function parseSections(raw) {
	const lines = String(raw || '').split(/\r?\n/);
	const sections = [];
	let current = null;
	for (const line of lines) {
		const heading = /^##\s+(P0-[A-H])\s+(.+)$/.exec(line);
		if (heading) {
			current = { id: heading[1], title: heading[2].trim(), items: [] };
			sections.push(current);
			continue;
		}
		if (/^##\s+/.test(line)) {
			current = null;
			continue;
		}
		const item = /^-\s+\[([ xX])\]\s+(.+)$/.exec(line);
		if (current && item) {
			current.items.push({ text: item[2].trim(), state: checkboxState(item[1]) });
		}
	}
	return sections.map((section) => {
		const total = section.items.length;
		const checked = section.items.filter((item) => item.state === 'checked').length;
		const open = total - checked;
		return {
			id: section.id,
			title: section.title,
			total,
			checked,
			open,
			state: open === 0 && total > 0 ? 'document-complete' : 'no-go',
			items: section.items,
		};
	});
}

function openBlockers(sections, limit = 12) {
	const out = [];
	for (const section of sections) {
		for (const item of section.items) {
			if (item.state !== 'open') continue;
			out.push({ section: section.id, text: item.text });
			if (out.length >= limit) return out;
		}
	}
	return out;
}

export async function getP0Readiness() {
	let raw = '';
	let updatedAt = 0;
	try {
		[raw, updatedAt] = await Promise.all([
			readFile(P0_DOC, 'utf8'),
			stat(P0_DOC).then((s) => s.mtimeMs),
		]);
	} catch (e) {
		return {
			decision: 'No-Go',
			state: 'no-go',
			document: P0_DOC_REL,
			valid: false,
			error: 'P0 checklist unavailable',
			updatedAt: 0,
			sections: [],
			blockers: [],
			artifactPolicy: artifactPolicySummary(),
			securityMode: securityModeSummary(),
		};
	}
	const sections = parseSections(raw);
	const total = sections.reduce((sum, section) => sum + section.total, 0);
	const checked = sections.reduce((sum, section) => sum + section.checked, 0);
	const open = total - checked;
	return {
		decision: open === 0 && total > 0 ? 'Review Required' : 'No-Go',
		state: open === 0 && total > 0 ? 'review-required' : 'no-go',
		document: P0_DOC_REL,
		valid: true,
		updatedAt,
		total,
		checked,
		open,
		sections,
		blockers: openBlockers(sections),
		artifactPolicy: artifactPolicySummary(),
		securityMode: securityModeSummary(),
	};
}

function artifactPolicySummary() {
	const keep = Number(process.env.WEBUI_KEEP_RUNS);
	return {
		mode: 'read-only metadata',
		rawExport: 'blocked until secret scan and redaction policy is implemented',
		prune: Number.isFinite(keep) && keep >= 0 ? `keep newest ${Math.floor(keep)} artifact run(s)` : 'keep newest 50 artifact run(s)',
	};
}
