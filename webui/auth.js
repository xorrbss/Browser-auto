// webui/auth.js — list cached auth apps (read-only). The actual login is the existing
// setup/auth.sh (spawned through the serial queue, headed Chrome, human OTP). We only ever
// expose the APP NAME (the state file holds secrets and is gitignored — never its content).

import { readdir, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const PROBE_ROOT = path.resolve(import.meta.dirname, '..');
const AUTH_DIR = path.join(PROBE_ROOT, 'fixtures', 'auth');
const NAME_RE = /^[A-Za-z0-9_-]+$/;

export const validApp = (a) => typeof a === 'string' && NAME_RE.test(a);

export async function listAuthStates() {
	let entries;
	try {
		entries = await readdir(AUTH_DIR);
	} catch {
		return [];
	}
	return entries
		.filter((f) => f.endsWith('.state.json'))
		.map((f) => f.slice(0, -'.state.json'.length))
		.filter(validApp)
		.sort();
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
	let entries;
	try {
		entries = await readdir(AUTH_DIR);
	} catch {
		return [];
	}
	const out = [];
	for (const file of entries.filter((f) => f.endsWith('.state.json'))) {
		const app = file.slice(0, -'.state.json'.length);
		if (!validApp(app)) continue;
		const full = path.join(AUTH_DIR, file);
		try {
			const [raw, st] = await Promise.all([readFile(full, 'utf8'), stat(full)]);
			const parsed = JSON.parse(raw);
			const cookies = Array.isArray(parsed.cookies) ? parsed.cookies : [];
			out.push({
				app,
				domains: uniqSorted(cookies.map((c) => String(c.domain || '').replace(/^\./, '').toLowerCase())),
				hints: uniqSorted(cookies.map(safeCookieHint)),
				updatedAt: st.mtimeMs,
			});
		} catch {
			out.push({ app, domains: [], hints: [], updatedAt: 0 });
		}
	}
	return out.sort((a, b) => b.updatedAt - a.updatedAt || a.app.localeCompare(b.app));
}

// deleteAuthState(app): remove the cached fixtures/auth/<app>.state.json (validApp-guarded so
// the name can't traverse). Used by the Auth view's delete button.
export async function deleteAuthState(app) {
	if (!validApp(app)) return { ok: false, error: 'invalid app name' };
	try {
		await unlink(path.join(AUTH_DIR, `${app}.state.json`));
		return { ok: true };
	} catch (e) {
		return e.code === 'ENOENT' ? { ok: false, error: 'no such state' } : { ok: false, error: e.message };
	}
}
