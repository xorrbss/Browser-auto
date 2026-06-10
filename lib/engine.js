'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ENGINE = 'playwright';
const DEFAULT_FLOW_ENGINE = 'playwright';
const ENGINES = Object.freeze(['playwright']);
const ENGINE_SET = new Set(ENGINES);
const LEGACY_ENGINES = new Set(['agent-browser']);

function legacyEngineError(label, raw) {
	return new Error(`${label}: legacy engine "${raw}" is no longer supported. Migrate the flow/system to engine "playwright" and refresh auth with setup/auth.sh.`);
}

function normalizeEngine(value, label = 'engine') {
	const raw = value == null || value === '' ? DEFAULT_ENGINE : String(value).trim();
	if (ENGINE_SET.has(raw)) return raw;
	if (LEGACY_ENGINES.has(raw)) throw legacyEngineError(label, raw);
	throw new Error(`${label}: invalid engine "${raw}" (expected ${ENGINES.join(' or ')})`);
}

function isValidEngine(value) {
	try { normalizeEngine(value); return true; } catch { return false; }
}

function flowEngine(flow) {
	const raw = flow && flow.engine;
	return normalizeEngine(raw == null || raw === '' ? DEFAULT_FLOW_ENGINE : raw, 'flow.engine');
}

function systemEngine(system) {
	return normalizeEngine(system && system.engine, 'system.engine');
}

function assertFlowEngine(flow, expected) {
	const got = flowEngine(flow);
	const want = normalizeEngine(expected, 'expected engine');
	if (got !== want) throw new Error(`flow.engine is "${got}", not "${want}"`);
	return got;
}

function playwrightAuthRel(app) {
	return path.join('fixtures', 'auth', 'playwright', `${app}.state.json`);
}

function playwrightCompatAuthRel(app) {
	return path.join('approve', `${app}.pw-state.json`);
}

function authStateRel(engine, app, { forWrite = false } = {}) {
	const e = normalizeEngine(engine);
	if (forWrite) return playwrightAuthRel(app);
	return playwrightAuthRel(app);
}

function authStatePath(root, engine, app, opts = {}) {
	return path.join(root, authStateRel(engine, app, opts));
}

function resolveAuthStatePath(root, engine, app) {
	const e = normalizeEngine(engine);
	const primary = authStatePath(root, e, app);
	if (fs.existsSync(primary)) return primary;
	return path.join(root, playwrightCompatAuthRel(app));
}

function authStateExists(root, engine, app) {
	const e = normalizeEngine(engine);
	if (e === 'playwright') {
		return fs.existsSync(path.join(root, playwrightAuthRel(app))) || fs.existsSync(path.join(root, playwrightCompatAuthRel(app)));
	}
	return false;
}

module.exports = {
	DEFAULT_ENGINE,
	DEFAULT_FLOW_ENGINE,
	ENGINES,
	normalizeEngine,
	isValidEngine,
	flowEngine,
	systemEngine,
	assertFlowEngine,
	playwrightAuthRel,
	playwrightCompatAuthRel,
	authStateRel,
	authStatePath,
	resolveAuthStatePath,
	authStateExists,
};
