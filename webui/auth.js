// webui/auth.js — list cached auth apps (read-only). The actual login is the existing
// setup/auth.sh (spawned through the serial queue, headed Chrome, human OTP). We only ever
// expose the APP NAME (the state file holds secrets and is gitignored — never its content).

import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const PROBE_ROOT = path.resolve(import.meta.dirname, '..');
const AUTH_DIR = path.join(PROBE_ROOT, 'fixtures', 'auth');
const PLAYWRIGHT_AUTH_DIR = path.join(AUTH_DIR, 'playwright');
const NAME_RE = /^[A-Za-z0-9_-]+$/;
const AUTH_SOURCES = Object.freeze([
	{ engine: 'playwright', dir: PLAYWRIGHT_AUTH_DIR },
]);

export const validApp = (a) => typeof a === 'string' && NAME_RE.test(a);

async function stateEntries(source) {
	try {
		const entries = await readdir(source.dir);
		return entries
			.filter((f) => f.endsWith('.state.json'))
			.map((file) => ({ ...source, file, app: file.slice(0, -'.state.json'.length) }))
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

function safeCookieHint(cookie) {
	if (!cookie || cookie.name !== 'h_officeid') return '';
	const value = String(cookie.value || '').trim();
	return /^[A-Za-z0-9._-]{2,128}$/.test(value) ? value : '';
}

export async function listAuthStateSummaries() {
	const out = [];
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
					hints: uniqSorted(cookies.map(safeCookieHint)),
					updatedAt: st.mtimeMs,
				});
			} catch {
				out.push({ app: entry.app, engine: source.engine, domains: [], hints: [], updatedAt: 0 });
			}
		}
	}
	return out.sort((a, b) => b.updatedAt - a.updatedAt || a.app.localeCompare(b.app) || a.engine.localeCompare(b.engine));
}

// deleteAuthState(app): remove cached generic auth states for both engines (validApp-guarded so
// the name can't traverse). Used by the Auth view's delete button.
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
