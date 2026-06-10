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
export const AUTH_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_SOURCES = Object.freeze([
	{ engine: 'playwright', dir: PLAYWRIGHT_AUTH_DIR, suffix: '.state.json', source: 'canonical' },
	{ engine: 'playwright', dir: LEGACY_PLAYWRIGHT_AUTH_DIR, suffix: '.pw-state.json', source: 'legacy' },
]);
const MFA_SIGNAL_RE = /(^|[^a-z0-9])(otp|mfa|2fa|totp|webauthn|challenge|verification|verify|two[-_ ]?factor|one[-_ ]?time)([^a-z0-9]|$)/i;

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

function safeAge(now, ms) {
	return Number.isFinite(ms) && ms > 0 ? Math.max(0, now - ms) : null;
}

function fileTimes(st, now) {
	const createdAt = Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0 ? st.birthtimeMs : (Number.isFinite(st.ctimeMs) ? st.ctimeMs : 0);
	const modifiedAt = Number.isFinite(st.mtimeMs) && st.mtimeMs > 0 ? st.mtimeMs : 0;
	return {
		createdAt,
		modifiedAt,
		updatedAt: modifiedAt,
		createdAgeMs: safeAge(now, createdAt),
		modifiedAgeMs: safeAge(now, modifiedAt),
		ageMs: safeAge(now, modifiedAt),
	};
}

function hostFromOrigin(origin) {
	try {
		return new URL(String(origin || '')).hostname.toLowerCase();
	} catch {
		return '';
	}
}

function storageItems(parsed) {
	const origins = Array.isArray(parsed?.origins) ? parsed.origins : [];
	const out = [];
	for (const origin of origins) {
		if (Array.isArray(origin?.localStorage)) out.push(...origin.localStorage);
		if (Array.isArray(origin?.sessionStorage)) out.push(...origin.sessionStorage);
	}
	return out;
}

function mfaSignals(parsed) {
	const cookies = Array.isArray(parsed?.cookies) ? parsed.cookies : [];
	let count = 0;
	for (const cookie of cookies) {
		if (MFA_SIGNAL_RE.test(String(cookie?.name || ''))) count += 1;
	}
	for (const item of storageItems(parsed)) {
		if (MFA_SIGNAL_RE.test(String(item?.name || ''))) count += 1;
	}
	return count;
}

function otpMfaSummary({ present, valid, signals }) {
	return {
		localOnly: true,
		status: !present ? 'missing' : !valid ? 'unknown' : signals > 0 ? 'challenge-signal-detected' : 'no-challenge-signal',
		challengeSignals: signals,
		liveAction: 'not-run',
	};
}

function domainsFor(parsed) {
	const cookies = Array.isArray(parsed?.cookies) ? parsed.cookies : [];
	const origins = Array.isArray(parsed?.origins) ? parsed.origins : [];
	return uniqSorted([
		...cookies.map((c) => String(c?.domain || '').replace(/^\./, '').toLowerCase()),
		...origins.map((o) => hostFromOrigin(o?.origin)),
	]);
}

function missingSummary(app, source, now = Date.now()) {
	return {
		app,
		engine: source.engine,
		domains: [],
		createdAt: 0,
		modifiedAt: 0,
		updatedAt: 0,
		createdAgeMs: null,
		modifiedAgeMs: null,
		ageMs: null,
		staleAfterMs: AUTH_STALE_AFTER_MS,
		stale: false,
		present: false,
		valid: false,
		ready: false,
		state: 'missing',
		readiness: 'missing',
		source: source.source,
		otpMfa: otpMfaSummary({ present: false, valid: false, signals: 0 }),
	};
}

async function summarizeEntry(entry, now = Date.now()) {
	const full = path.join(entry.dir, entry.file);
	let st;
	try {
		st = await stat(full);
	} catch {
		return missingSummary(entry.app, entry, now);
	}
	const times = fileTimes(st, now);
	try {
		const parsed = JSON.parse(await readFile(full, 'utf8'));
		const signals = mfaSignals(parsed);
		const stale = Number.isFinite(times.modifiedAgeMs) && times.modifiedAgeMs >= AUTH_STALE_AFTER_MS;
		const state = stale ? 'stale-auth' : 'ready';
		return {
			app: entry.app,
			engine: entry.engine,
			domains: domainsFor(parsed),
			...times,
			staleAfterMs: AUTH_STALE_AFTER_MS,
			stale,
			present: true,
			valid: true,
			ready: true,
			state,
			readiness: state,
			source: entry.source,
			otpMfa: otpMfaSummary({ present: true, valid: true, signals }),
		};
	} catch {
		return {
			app: entry.app,
			engine: entry.engine,
			domains: [],
			...times,
			staleAfterMs: AUTH_STALE_AFTER_MS,
			stale: false,
			present: true,
			valid: false,
			ready: false,
			state: 'invalid',
			readiness: 'invalid',
			source: entry.source,
			otpMfa: otpMfaSummary({ present: true, valid: false, signals: 0 }),
		};
	}
}

function entryForApp(source, app) {
	return { ...source, app, file: `${app}${source.suffix}` };
}

function summarySort(a, b) {
	return b.updatedAt - a.updatedAt || a.app.localeCompare(b.app) || a.engine.localeCompare(b.engine) || a.source.localeCompare(b.source);
}

export async function listAuthStateSummaries() {
	const out = [];
	const now = Date.now();
	for (const source of AUTH_SOURCES) {
		for (const entry of await stateEntries(source)) out.push(await summarizeEntry(entry, now));
	}
	return out.sort(summarySort);
}

function bestSourceSummary(summaries) {
	const ready = summaries.filter((s) => s.ready);
	return ready.find((s) => s.source === 'canonical' && s.state === 'ready')
		|| ready.find((s) => s.source === 'canonical')
		|| ready.find((s) => s.state === 'ready')
		|| ready[0]
		|| summaries.find((s) => s.present)
		|| summaries[0];
}

export async function authReadinessForApp(app) {
	if (!validApp(app)) return { ok: false, error: 'invalid app name' };
	const now = Date.now();
	const sources = [];
	for (const source of AUTH_SOURCES) sources.push(await summarizeEntry(entryForApp(source, app), now));
	const selected = bestSourceSummary(sources);
	return {
		app,
		engine: 'playwright',
		state: selected.state,
		readiness: selected.readiness,
		ready: selected.ready,
		present: selected.present,
		valid: selected.valid,
		stale: selected.stale,
		staleAfterMs: AUTH_STALE_AFTER_MS,
		source: selected.source,
		domains: selected.domains,
		createdAt: selected.createdAt,
		modifiedAt: selected.modifiedAt,
		updatedAt: selected.updatedAt,
		createdAgeMs: selected.createdAgeMs,
		modifiedAgeMs: selected.modifiedAgeMs,
		ageMs: selected.ageMs,
		otpMfa: selected.otpMfa,
		sources,
	};
}

export async function listAuthReadinessSummaries(apps = []) {
	const names = new Set([...(await listAuthStates()), ...apps].filter(validApp));
	const out = [];
	for (const app of names) out.push(await authReadinessForApp(app));
	return out.sort((a, b) => b.updatedAt - a.updatedAt || a.app.localeCompare(b.app));
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
