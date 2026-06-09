'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ENGINE = 'agent-browser';
const ENGINES = Object.freeze(['agent-browser', 'playwright']);
const ENGINE_SET = new Set(ENGINES);

function normalizeEngine(value, label = 'engine') {
	const raw = value == null || value === '' ? DEFAULT_ENGINE : String(value).trim();
	if (ENGINE_SET.has(raw)) return raw;
	throw new Error(`${label}: invalid engine "${raw}" (expected ${ENGINES.join(' or ')})`);
}

function isValidEngine(value) {
	try { normalizeEngine(value); return true; } catch { return false; }
}

function flowEngine(flow) {
	return normalizeEngine(flow && flow.engine, 'flow.engine');
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

function agentBrowserAuthRel(app) {
	return path.join('fixtures', 'auth', `${app}.state.json`);
}

function playwrightAuthRel(app) {
	return path.join('fixtures', 'auth', 'playwright', `${app}.state.json`);
}

function playwrightCompatAuthRel(app) {
	return path.join('approve', `${app}.pw-state.json`);
}

function authStateRel(engine, app, { forWrite = false } = {}) {
	const e = normalizeEngine(engine);
	if (e === 'agent-browser') return agentBrowserAuthRel(app);
	if (forWrite) return playwrightAuthRel(app);
	return playwrightAuthRel(app);
}

function authStatePath(root, engine, app, opts = {}) {
	return path.join(root, authStateRel(engine, app, opts));
}

function resolveAuthStatePath(root, engine, app) {
	const e = normalizeEngine(engine);
	if (e === 'agent-browser') return authStatePath(root, e, app);
	const primary = authStatePath(root, e, app);
	if (fs.existsSync(primary)) return primary;
	return path.join(root, playwrightCompatAuthRel(app));
}

function authStateExists(root, engine, app) {
	const e = normalizeEngine(engine);
	if (e === 'playwright') {
		return fs.existsSync(path.join(root, playwrightAuthRel(app))) || fs.existsSync(path.join(root, playwrightCompatAuthRel(app)));
	}
	return fs.existsSync(path.join(root, agentBrowserAuthRel(app)));
}

module.exports = {
	DEFAULT_ENGINE,
	ENGINES,
	normalizeEngine,
	isValidEngine,
	flowEngine,
	systemEngine,
	assertFlowEngine,
	agentBrowserAuthRel,
	playwrightAuthRel,
	playwrightCompatAuthRel,
	authStateRel,
	authStatePath,
	resolveAuthStatePath,
	authStateExists,
};
