// webui/auth.js — list cached auth apps (read-only). The actual login is approve/auth-pw.mjs
// (spawned through the serial queue, headed Chrome, human OTP), saving the canonical
// fixtures/auth/playwright/<app>.state.json. The compat read path also sees legacy
// approve/<app>.pw-state.json files, but summaries never expose file paths or state content.

import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const PROBE_ROOT = path.resolve(import.meta.dirname, '..');
const AUTH_DIR = path.join(PROBE_ROOT, 'fixtures', 'auth');
const PLAYWRIGHT_AUTH_DIR = path.join(AUTH_DIR, 'playwright');
const LEGACY_PLAYWRIGHT_AUTH_DIR = path.join(PROBE_ROOT, 'approve');
const NAME_RE = /^[A-Za-z0-9_-]+$/;
const AUTH_SOURCES = Object.freeze([
	{ engine: 'playwright', dir: PLAYWRIGHT_AUTH_DIR, suffix: '.state.json', source: 'canonical' },
	{ engine: 'playwright', dir: LEGACY_PLAYWRIGHT_AUTH_DIR, suffix: '.pw-state.json', source: 'legacy' },
]);

export const validApp = (a) => typeof a === 'string' && NAME_RE.test(a);

async function stateEntries(source) {
	try {
		const entries = await readdir(source.dir);
		return entries
			.filter((f) => f.endsWith(source.suffix))
			.map((file) => ({ ...source, file, app: file.slice(0, -source.suffix.length) }))
			.filter((e) => validApp(e.app));
	} catch {
		return [];
	}
}

export async function listAuthStates() {
	const names = new Set();
	for (const source of AUTH_SOURCES) {
		for (const entry of await stateEntries(source)) names.add(entry.app);
	}
	return [...names].sort();
}

function uniqSorted(values) {
	return [...new Set(values.filter(Boolean))].sort();
}

export async function listAuthStateSummaries() {
	const out = [];
	const now = Date.now();
	for (const source of AUTH_SOURCES) {
		for (const entry of await stateEntries(source)) {
			const full = path.join(source.dir, entry.file);
			try {
				const [raw, st] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
				const parsed = JSON.parse(raw);
				const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
				out.push({
					app: entry.app,
					engine: source.engine,
					domains: uniqSorted(cookies.map((c) => String(c.domain || '').replace(/^\./, '').toLowerCase())),
					updatedAt: st.mtimeMs,
					ageMs: Math.max(0, now - st.mtimeMs),
					valid: true,
					source: source.source,
				});
			} catch {
				let updatedAt = 0;
				try {
					updatedAt = (await stat(full)).mtimeMs;
				} catch {
					updatedAt = 0;
				}
				out.push({
					app: entry.app,
					engine: source.engine,
					domains: [],
					updatedAt,
					ageMs: updatedAt ? Math.max(0, now - updatedAt) : null,
					valid: false,
					source: source.source,
				});
			}
		}
	}
	return out.sort((a, b) => b.updatedAt - a.updatedAt || a.app.localeCompare(b.app) || a.engine.localeCompare(b.engine));
}

// deleteAuthState(app): remove the cached Playwright auth state (validApp-guarded so the name
// can't traverse). Used by the Auth view's delete button.
export async function deleteAuthState(app) {
	if (!validApp(app)) return { ok: false, error: 'invalid app name' };
	let deleted = false;
	const errors = [];
	const full = path.join(PLAYWRIGHT_AUTH_DIR, `${app}.state.json`);
	try {
		await unlink(full);
		deleted = true;
	} catch (e) {
		if (e.code !== 'ENOENT') errors.push(e.message);
	}
	if (deleted) return { ok: true };
	if (errors.length) return { ok: false, error: errors.join('; ') };
	return { ok: false, error: 'no such state' };
}
