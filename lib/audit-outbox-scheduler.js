'use strict';

const dbm = require('./db.js');
const auditOutboxWorker = require('./audit-outbox-worker.js');

const DEFAULT_INTERVAL_MS = 30000;
const DEFAULT_BACKOFF_MAX_MS = 5 * 60 * 1000;
const DISABLED_AUDIT_MODES = new Set(['', 'local', 'none', 'disabled']);
const FALSE_RE = /^(0|false|no|off|disabled)$/i;
const TRUE_RE = /^(1|true|yes|on|enabled)$/i;

function _firstEnv(env, names) {
	for (const name of names) {
		if (env && Object.prototype.hasOwnProperty.call(env, name)) return String(env[name] || '').trim();
	}
	return '';
}

function _auditMode(env) {
	return _firstEnv(env, ['WEBUI_AUDIT_SINK', 'AQA_AUDIT_SINK']).toLowerCase() || 'local';
}

function _positiveInt(value, fallback, { min = 1, max = 24 * 60 * 60 * 1000 } = {}) {
	const n = Number(value);
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, Math.trunc(n)));
}

function _redactErrorMessage(error) {
	return String((error && error.message) || error || 'audit outbox scheduler failed')
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
		.replace(/\b(password|passwd|pwd|otp|token|secret|api[-_\s]?key|authorization|cookie)\b\s*[:=]\s*([^\s,;]+)/gi, '$1=[redacted]');
}

function auditOutboxSchedulerConfig(options = {}) {
	const env = options.env || process.env;
	const mode = _auditMode(env);
	const switchValue = _firstEnv(env, ['WEBUI_AUDIT_OUTBOX_SCHEDULER', 'AQA_AUDIT_OUTBOX_SCHEDULER']);
	const explicitEnabled = options.enabled;
	let disabledReason = '';
	if (explicitEnabled === false || FALSE_RE.test(switchValue)) {
		disabledReason = 'disabled-by-config';
	} else if (explicitEnabled !== true && !TRUE_RE.test(switchValue) && DISABLED_AUDIT_MODES.has(mode)) {
		disabledReason = `audit-sink-${mode || 'local'}`;
	}
	const intervalMs = _positiveInt(options.intervalMs ?? _firstEnv(env, ['WEBUI_AUDIT_OUTBOX_INTERVAL_MS', 'AQA_AUDIT_OUTBOX_INTERVAL_MS']), DEFAULT_INTERVAL_MS);
	const backoffMs = _positiveInt(options.backoffMs ?? _firstEnv(env, ['WEBUI_AUDIT_OUTBOX_BACKOFF_MS', 'AQA_AUDIT_OUTBOX_BACKOFF_MS']), intervalMs);
	const maxBackoffMs = _positiveInt(
		options.maxBackoffMs ?? _firstEnv(env, ['WEBUI_AUDIT_OUTBOX_MAX_BACKOFF_MS', 'AQA_AUDIT_OUTBOX_MAX_BACKOFF_MS']),
		Math.max(backoffMs, DEFAULT_BACKOFF_MAX_MS),
		{ min: backoffMs },
	);
	return {
		enabled: !disabledReason,
		disabled: !!disabledReason,
		disabledReason,
		mode,
		intervalMs,
		backoffMs,
		maxBackoffMs,
	};
}

function _resultFailed(result) {
	if (!result || result.error) return true;
	return result.ok === false || (result.failed || 0) > 0 || (result.deadLettered || 0) > 0;
}

function _backoffDelay(config, failureStreak) {
	if (failureStreak <= 0) return config.intervalMs;
	return Math.min(config.maxBackoffMs, config.backoffMs * (2 ** Math.min(failureStreak - 1, 12)));
}

function createAuditOutboxScheduler(options = {}) {
	const env = options.env || process.env;
	const config = auditOutboxSchedulerConfig({ ...options, env });
	const openDb = options.openDb || dbm.openDb;
	const closeDb = options.closeDb || dbm.closeDb;
	const worker = options.worker || auditOutboxWorker.createAuditOutboxDrainWorker({
		env,
		tenantId: options.tenantId,
		limit: options.limit,
		connector: options.connector,
		maxAttempts: options.maxAttempts,
		baseDelayMs: options.baseDelayMs,
		maxDelayMs: options.maxDelayMs,
		validateAuditSinkConfig: options.validateAuditSinkConfig,
	});
	const baseRunOptions = {
		env,
		tenantId: options.tenantId,
		limit: options.limit,
		connector: options.connector,
		maxAttempts: options.maxAttempts,
		baseDelayMs: options.baseDelayMs,
		maxDelayMs: options.maxDelayMs,
		validateAuditSinkConfig: options.validateAuditSinkConfig,
	};
	const dbPath = options.dbPath;
	const sharedDb = options.db || null;
	const now = options.now;

	let timer = null;
	let inFlight = null;
	let started = false;
	let stopped = false;
	let tickCount = 0;
	let skippedInFlight = 0;
	let failureStreak = 0;
	let lastTickAt = null;
	let lastFinishAt = null;
	let lastResult = null;
	let lastDelayMs = config.intervalMs;
	let nextTickAt = null;

	function state() {
		return {
			enabled: config.enabled,
			disabled: config.disabled,
			disabledReason: config.disabledReason,
			mode: config.mode,
			started,
			stopped,
			running: !!inFlight,
			intervalMs: config.intervalMs,
			backoffMs: config.backoffMs,
			maxBackoffMs: config.maxBackoffMs,
			lastDelayMs,
			nextTickAt,
			tickCount,
			skippedInFlight,
			failureStreak,
			lastTickAt,
			lastFinishAt,
			lastResult,
		};
	}

	function _clearTimer() {
		if (timer) clearTimeout(timer);
		timer = null;
		nextTickAt = null;
	}

	function _schedule(delayMs) {
		_clearTimer();
		if (!started || stopped || config.disabled) return;
		const delay = _positiveInt(delayMs, config.intervalMs);
		nextTickAt = Date.now() + delay;
		timer = setTimeout(() => {
			timer = null;
			nextTickAt = null;
			tick().finally(() => {
				if (started && !stopped) _schedule(lastDelayMs);
			});
		}, delay);
		if (typeof timer.unref === 'function') timer.unref();
	}

	async function _runOnce(overrides = {}) {
		const existingDb = overrides.db || sharedDb;
		let db = existingDb;
		let owned = false;
		if (!db) {
			db = dbPath ? openDb(dbPath) : openDb();
			owned = true;
		}
		try {
			return await worker.runOnce(db, {
				...baseRunOptions,
				now,
				...overrides,
			});
		} finally {
			if (owned && db) closeDb(db);
		}
	}

	async function tick(overrides = {}) {
		if (config.disabled) {
			lastResult = {
				ok: true,
				disabled: true,
				skipped: true,
				reason: config.disabledReason,
				checked: 0,
				delivered: 0,
				failed: 0,
				deadLettered: 0,
			};
			return lastResult;
		}
		if (stopped && !overrides.allowAfterStop) {
			lastResult = { ok: true, stopped: true, skipped: true, reason: 'stopped' };
			return lastResult;
		}
		if (inFlight) {
			skippedInFlight += 1;
			return {
				ok: true,
				skipped: true,
				reason: 'in-flight',
				inFlight: true,
				tickCount,
			};
		}
		lastTickAt = new Date().toISOString();
		tickCount += 1;
		inFlight = (async () => {
			try {
				const raw = await _runOnce(overrides);
				const failed = _resultFailed(raw);
				failureStreak = failed ? failureStreak + 1 : 0;
				lastDelayMs = failed ? _backoffDelay(config, failureStreak) : config.intervalMs;
				lastResult = {
					...raw,
					ok: !failed,
					drainOk: raw?.ok !== false,
					schedulerBackoffMs: lastDelayMs,
					failureStreak,
				};
				return lastResult;
			} catch (e) {
				failureStreak += 1;
				lastDelayMs = _backoffDelay(config, failureStreak);
				lastResult = {
					ok: false,
					error: _redactErrorMessage(e),
					errorCode: e && e.code ? String(e.code) : null,
					schedulerBackoffMs: lastDelayMs,
					failureStreak,
					checked: 0,
					delivered: 0,
					failed: 0,
					deadLettered: 0,
				};
				return lastResult;
			} finally {
				lastFinishAt = new Date().toISOString();
				inFlight = null;
			}
		})();
		return inFlight;
	}

	function start({ immediate = true } = {}) {
		if (config.disabled) return state();
		if (started && !stopped) return state();
		started = true;
		stopped = false;
		if (immediate) {
			tick().finally(() => {
				if (started && !stopped) _schedule(lastDelayMs);
			});
		} else {
			_schedule(config.intervalMs);
		}
		return state();
	}

	async function stop({ wait = true } = {}) {
		stopped = true;
		started = false;
		_clearTimer();
		if (wait && inFlight) {
			try { await inFlight; } catch {}
		}
		return state();
	}

	return {
		start,
		stop,
		shutdown: stop,
		tick,
		runOnce: tick,
		state,
		config: () => ({ ...config }),
	};
}

module.exports = {
	auditOutboxSchedulerConfig,
	createAuditOutboxScheduler,
	createAuditOutboxDrainScheduler: createAuditOutboxScheduler,
};
