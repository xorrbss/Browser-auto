// webui/auth.js — auth-state inventory plus backend-aware store/get/delete helpers.
// setup/auth.sh performs the headed Chrome/human OTP capture. Local pilot mode saves
// fixtures/auth/playwright/<app>.state.json; external/encrypted mode imports capture output
// into the configured secret backend. The compat read path also sees legacy
// approve/<app>.pw-state.json files, but summaries never expose file paths or state content.

import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createSecretStore } from './secrets.js';

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
const RUNNER_SECRET_BROKER_PURPOSE = 'runner-secret-broker';
const secretStore = createSecretStore();

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
	for (const entry of await encryptedStateEntries()) names.add(entry.app);
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

function localSecretMetadataForEntry(entry, st = null) {
	return secretStore.describeLocalFile({
		kind: 'auth-state',
		name: `${entry.source}:${entry.app}`,
		filePath: path.join(entry.dir, entry.file),
		stat: st,
	});
}

function useEncryptedBackendOnly() {
	return secretStore.secureBackend && secretStore.configured && !secretStore.policy?.plaintextAllowed;
}

function plaintextBlocked() {
	return secretStore.policy?.external && !secretStore.policy?.plaintextAllowed;
}

function secureBackendConfigBlockedReason() {
	if (!secretStore.secureBackend || secretStore.policy?.configOk) return '';
	const errors = Array.isArray(secretStore.policy?.configErrors) ? secretStore.policy.configErrors.filter(Boolean) : [];
	return `secret backend configuration is not ready: ${errors.join('; ') || 'secure secret backend is unavailable'}`;
}

function authSecretNames(entry) {
	return [`${entry.source}:${entry.app}`, entry.app];
}

function authSecretName(app, source = 'canonical') {
	return source === 'canonical' ? `canonical:${app}` : source === 'legacy' ? `legacy:${app}` : `${source}:${app}`;
}

function authSourceByName(source = 'canonical') {
	return AUTH_SOURCES.find((s) => s.source === source) || AUTH_SOURCES[0];
}

function backendAuthSecretNames(app) {
	return uniqSorted([
		authSecretName(app, 'canonical'),
		authSecretName(app, 'legacy'),
		app,
	]);
}

export function authStateSecretRef(app, source = 'canonical') {
	if (!validApp(app)) return null;
	return secretStore.ref('auth-state', authSecretName(app, source));
}

export function authStateStoreMode() {
	const configBlockedReason = secureBackendConfigBlockedReason();
	if (configBlockedReason) {
		return {
			ok: false,
			mode: 'blocked',
			backend: secretStore.backend,
			error: configBlockedReason,
			secretRefRequired: true,
		};
	}
	if (useEncryptedBackendOnly()) {
		return {
			ok: true,
			mode: 'secret',
			backend: secretStore.backend,
			secretRefRequired: true,
			plaintextAllowed: false,
		};
	}
	if (plaintextBlocked()) {
		return {
			ok: false,
			mode: 'blocked',
			backend: secretStore.backend,
			error: secretStore.policy?.plaintextBlockReason || 'local plaintext auth state is blocked in external mode',
			secretRefRequired: true,
		};
	}
	return {
		ok: true,
		mode: 'local-pilot-file',
		backend: secretStore.backend,
		secretRefRequired: false,
		plaintextAllowed: true,
	};
}

async function encryptedMetadataForEntry(entry) {
	if (!secretStore.secureBackend) return null;
	let fallback = null;
	for (const name of authSecretNames(entry)) {
		const meta = await secretStore.describeSecret({ kind: 'auth-state', name });
		if (!fallback) fallback = meta;
		if (meta.present && meta.usable) return meta;
	}
	return fallback;
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

function encryptedOtpMfaSummary({ present }) {
	return {
		localOnly: false,
		status: present ? 'secret-backend-not-inspected' : 'missing',
		challengeSignals: 0,
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

function missingSummary(app, source, now = Date.now(), secretStorage = null, extra = {}) {
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
		secretStorage: secretStorage || localSecretMetadataForEntry(entryForApp(source, app)),
		otpMfa: otpMfaSummary({ present: false, valid: false, signals: 0 }),
		...extra,
	};
}

function encryptedReadySummary(entry, secretStorage, now = Date.now()) {
	const modifiedAt = Number(secretStorage.updatedAt || secretStorage.modifiedAt || 0);
	const createdAt = Number(secretStorage.createdAt || modifiedAt || 0);
	return {
		app: entry.app,
		engine: entry.engine,
		domains: [],
		createdAt,
		modifiedAt,
		updatedAt: modifiedAt,
		createdAgeMs: safeAge(now, createdAt),
		modifiedAgeMs: safeAge(now, modifiedAt),
		ageMs: safeAge(now, modifiedAt),
		staleAfterMs: AUTH_STALE_AFTER_MS,
		stale: false,
		present: true,
		valid: true,
		ready: true,
		state: 'ready',
		readiness: 'ready',
		source: entry.source,
		secretStorage,
		storageSource: secretStorage.backend || secretStore.backend,
		otpMfa: encryptedOtpMfaSummary({ present: true }),
	};
}

function blockedPlaintextSummary(entry, now, localPlaintextStorage, encryptedStorage = null) {
	const times = localPlaintextStorage?.present
		? {
			createdAt: 0,
			modifiedAt: localPlaintextStorage.modifiedAt || 0,
			updatedAt: localPlaintextStorage.modifiedAt || 0,
			createdAgeMs: null,
			modifiedAgeMs: safeAge(now, localPlaintextStorage.modifiedAt || 0),
			ageMs: safeAge(now, localPlaintextStorage.modifiedAt || 0),
		}
		: {
			createdAt: 0,
			modifiedAt: 0,
			updatedAt: 0,
			createdAgeMs: null,
			modifiedAgeMs: null,
			ageMs: null,
		};
	return {
		app: entry.app,
		engine: entry.engine,
		domains: [],
		...times,
		staleAfterMs: AUTH_STALE_AFTER_MS,
		stale: false,
		present: !!localPlaintextStorage?.present,
		valid: false,
		ready: false,
		state: encryptedStorage?.present ? 'encrypted-secret-unusable' : 'blocked-plaintext-secret',
		readiness: encryptedStorage?.present ? 'encrypted-secret-unusable' : 'blocked-plaintext-secret',
		source: entry.source,
		secretStorage: encryptedStorage || localPlaintextStorage,
		localPlaintextStorage,
		otpMfa: encryptedOtpMfaSummary({ present: false }),
	};
}

function backendUnavailableSummary(entry, now, secretStorage, localPlaintextStorage, reason) {
	const modifiedAt = Number(localPlaintextStorage?.modifiedAt || secretStorage?.modifiedAt || secretStorage?.updatedAt || 0);
	return {
		app: entry.app,
		engine: entry.engine,
		domains: [],
		createdAt: 0,
		modifiedAt,
		updatedAt: modifiedAt,
		createdAgeMs: null,
		modifiedAgeMs: safeAge(now, modifiedAt),
		ageMs: safeAge(now, modifiedAt),
		staleAfterMs: AUTH_STALE_AFTER_MS,
		stale: false,
		present: !!localPlaintextStorage?.present || !!secretStorage?.present,
		valid: false,
		ready: false,
		state: 'secret-backend-unavailable',
		readiness: 'secret-backend-unavailable',
		source: entry.source,
		secretStorage: secretStorage || localPlaintextStorage,
		localPlaintextStorage,
		backendConfigOk: false,
		backendConfigErrors: secretStore.policy?.configErrors || [],
		blockReason: reason,
		otpMfa: encryptedOtpMfaSummary({ present: false }),
	};
}

async function summarizeEntry(entry, now = Date.now()) {
	const full = path.join(entry.dir, entry.file);
	let st;
	try {
		st = await stat(full);
	} catch {
		st = null;
	}

	const configBlockedReason = secureBackendConfigBlockedReason();
	if (configBlockedReason) {
		const localStorage = localSecretMetadataForEntry(entry, st);
		return backendUnavailableSummary(entry, now, await encryptedMetadataForEntry(entry), localStorage, configBlockedReason);
	}

	if (useEncryptedBackendOnly()) {
		const encryptedStorage = await encryptedMetadataForEntry(entry);
		if (encryptedStorage?.present && encryptedStorage.usable) return encryptedReadySummary(entry, encryptedStorage, now);
		const localStorage = localSecretMetadataForEntry(entry, st);
		if (st) return blockedPlaintextSummary(entry, now, localStorage, encryptedStorage);
		return missingSummary(entry.app, entry, now, encryptedStorage || localStorage, { storageSource: secretStore.backend });
	}

	const localStorage = localSecretMetadataForEntry(entry, st);
	if (plaintextBlocked()) {
		if (st) return blockedPlaintextSummary(entry, now, localStorage, await encryptedMetadataForEntry(entry));
		return missingSummary(entry.app, entry, now, localStorage);
	}

	if (!st) {
		return missingSummary(entry.app, entry, now, localStorage);
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
			secretStorage: localStorage,
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
			secretStorage: localStorage,
			otpMfa: otpMfaSummary({ present: true, valid: false, signals: 0 }),
		};
	}
}

function ensureAuthStateBytes(bytes) {
	const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
	if (!buf.length) throw new Error('empty auth state');
	try {
		const parsed = JSON.parse(buf.toString('utf8'));
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object');
	} catch {
		throw new Error('auth state must be a JSON object');
	}
	return buf;
}

export async function storeAuthState(app, bytes, opts = {}) {
	if (!validApp(app)) return { ok: false, error: 'invalid app name' };
	const source = opts.source === 'legacy' ? 'legacy' : 'canonical';
	const mode = authStateStoreMode();
	if (!mode.ok) return { ok: false, error: mode.error, backend: mode.backend };
	let buf;
	try {
		buf = ensureAuthStateBytes(bytes);
	} catch (e) {
		return { ok: false, error: e.message };
	}
	if (mode.mode === 'secret') {
		try {
			const secretStorage = await secretStore.putBytes({
				kind: 'auth-state',
				name: authSecretName(app, source),
				bytes: buf,
			});
			return { ok: true, storageMode: mode.mode, secretStorage };
		} catch (e) {
			return { ok: false, error: e.message || String(e), backend: mode.backend };
		}
	}

	const src = authSourceByName(source);
	const entry = entryForApp(src, app);
	const full = path.join(src.dir, entry.file);
	try {
		await mkdir(src.dir, { recursive: true });
		await writeFile(full, buf, { encoding: 'utf8', mode: 0o600 });
		return { ok: true, storageMode: mode.mode, secretStorage: localSecretMetadataForEntry(entry) };
	} catch (e) {
		return { ok: false, error: e.message || String(e) };
	}
}

export async function storeAuthStateFromFile(app, filePath, opts = {}) {
	if (!validApp(app)) return { ok: false, error: 'invalid app name' };
	let bytes;
	try {
		bytes = await readFile(filePath);
	} catch (e) {
		return { ok: false, error: e.message || String(e) };
	}
	return storeAuthState(app, bytes, opts);
}

export async function getAuthState(app, opts = {}) {
	if (!validApp(app)) return { ok: false, error: 'invalid app name' };
	if (opts.purpose !== RUNNER_SECRET_BROKER_PURPOSE) {
		return { ok: false, error: 'auth state bytes require runner secret broker purpose' };
	}
	const mode = authStateStoreMode();
	if (!mode.ok) return { ok: false, error: mode.error, backend: mode.backend };
	if (mode.mode === 'secret') {
		const sourceNames = opts.source ? [authSecretName(app, opts.source)] : backendAuthSecretNames(app);
		for (const name of sourceNames) {
			const meta = await secretStore.describeSecret({ kind: 'auth-state', name });
			if (!meta.present || !meta.usable) continue;
			try {
				const bytes = await secretStore.getBytes({ kind: 'auth-state', name }, { purpose: RUNNER_SECRET_BROKER_PURPOSE });
				return { ok: true, storageMode: mode.mode, source: name.startsWith('legacy:') ? 'legacy' : 'canonical', bytes, secretStorage: meta };
			} catch (e) {
				return { ok: false, error: e.message || String(e), secretStorage: meta };
			}
		}
		return { ok: false, error: 'no such state', storageMode: mode.mode };
	}

	const sources = opts.source ? [authSourceByName(opts.source)] : AUTH_SOURCES;
	for (const source of sources) {
		const entry = entryForApp(source, app);
		try {
			const bytes = await readFile(path.join(entry.dir, entry.file));
			return { ok: true, storageMode: mode.mode, source: source.source, bytes, secretStorage: localSecretMetadataForEntry(entry) };
		} catch {
			/* try next compat source */
		}
	}
	return { ok: false, error: 'no such state', storageMode: mode.mode };
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
	const seen = new Set();
	for (const entry of await allStateEntries()) {
		const key = `${entry.source}:${entry.app}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(await summarizeEntry(entry, now));
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

// deleteAuthState(app): remove cached Playwright auth state from the configured backend and any
// local pilot/compat files (validApp-guarded so the name can't traverse). Used by the Auth view.
export async function deleteAuthState(app) {
	if (!validApp(app)) return { ok: false, error: 'invalid app name' };
	let deleted = false;
	const errors = [];
	const backendDeleted = [];
	if (secretStore.secureBackend) {
		if (!secretStore.configured) {
			const reason = secureBackendConfigBlockedReason() || 'secure secret backend is unavailable';
			return { ok: false, error: reason };
		}
		for (const name of backendAuthSecretNames(app)) {
			try {
				const result = await secretStore.delete({ kind: 'auth-state', name });
				if (result?.deleted) {
					deleted = true;
					backendDeleted.push(result.ref || secretStore.ref('auth-state', name));
				}
			} catch (e) {
				errors.push(e.message || String(e));
			}
		}
	}
	let localDeleted = 0;
	for (const source of AUTH_SOURCES) {
		const full = path.join(source.dir, `${app}${source.suffix}`);
		try {
			await unlink(full);
			deleted = true;
			localDeleted += 1;
		} catch (e) {
			if (e.code !== 'ENOENT') errors.push(e.message);
		}
	}
	if (deleted) return { ok: true, backendDeleted: backendDeleted.length, localDeleted };
	if (errors.length) return { ok: false, error: errors.join('; ') };
	return { ok: false, error: 'no such state' };
}

async function encryptedStateEntries() {
	if (!secretStore.secureBackend || !secretStore.configured) return [];
	const out = [];
	const sourcesByName = new Map(AUTH_SOURCES.map((source) => [source.source, source]));
	for (const meta of await secretStore.list({ kind: 'auth-state' })) {
		let sourceName = 'canonical';
		let app = meta.name;
		const m = /^(canonical|legacy):(.+)$/.exec(meta.name);
		if (m) {
			sourceName = m[1];
			app = m[2];
		}
		if (!validApp(app)) continue;
		const source = sourcesByName.get(sourceName) || AUTH_SOURCES[0];
		out.push(entryForApp(source, app));
	}
	return out;
}

async function allStateEntries() {
	const out = [];
	for (const source of AUTH_SOURCES) out.push(...await stateEntries(source));
	out.push(...await encryptedStateEntries());
	return out;
}
