// lib/llm.js — shared ON-PREM OpenAI-compatible chat client (reuses bin/summarize.js's pattern).
//
// Used by the NL command router (webui/agent.js) to classify a Korean command into a validated
// intent — and shareable elsewhere. CommonJS like lib/db.js so webui (ESM) reaches it via
// createRequire and bin/*.js (CJS) can require it directly. ZERO external deps (global fetch).
//
// CRITICAL (framework invariant): this is an operator-tool helper. It NEVER runs in tests/run.sh,
// never gates pass/fail, never drives the browser. The model reply is UNTRUSTED text — callers must
// extract/validate (see webui/agent.js) and degrade to "clarify" on any doubt, never to an action.
//
// Endpoint is the SAME on-prem model as summaries (nothing leaves it). Config (env), LLM_* first
// then the SUMMARY_* already in data/approvals.config:
//   LLM_API_URL / SUMMARY_API_URL   (default http://localhost:11434/v1)
//   LLM_MODEL   / SUMMARY_MODEL      (required to classify)
//   LLM_API_KEY / SUMMARY_API_KEY    (optional bearer)
'use strict';

// Read config LAZILY (at call time, not module load): a long-running consumer like the webui may
// load data/approvals.config into process.env AFTER this module is required, so capturing at import
// time would freeze stale/empty values. cfg() reflects the env as it is when chat() actually runs.
function cfg() {
	return {
		BASE: (process.env.LLM_API_URL || process.env.SUMMARY_API_URL || 'http://localhost:11434/v1').replace(/\/+$/, ''),
		MODEL: process.env.LLM_MODEL || process.env.SUMMARY_MODEL || '',
		API_KEY: process.env.LLM_API_KEY || process.env.SUMMARY_API_KEY || '',
		TIMEOUT_MS: Number(process.env.LLM_TIMEOUT_MS) || 60000,
	};
}

// chat(messages, {temperature}) -> assistant message content (string).
// Throws on a missing model, a network failure, or a non-OK response — callers treat ALL of these
// as "could not classify" and must degrade to clarify/deny (never proceed to an action).
async function chat(messages, { temperature = 0 } = {}) {
	const { BASE, MODEL, API_KEY, TIMEOUT_MS } = cfg();
	if (!MODEL) throw new Error('LLM_MODEL/SUMMARY_MODEL not set (configure the on-prem model)');
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	let res;
	try {
		res = await fetch(`${BASE}/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}) },
			body: JSON.stringify({ model: MODEL, messages, stream: false, temperature }),
			signal: ctrl.signal,
		});
	} finally {
		clearTimeout(timer);
	}
	if (!res.ok) {
		const t = await res.text().catch(() => '');
		throw new Error(`LLM HTTP ${res.status} ${res.statusText} ${t.slice(0, 200)}`);
	}
	const data = await res.json();
	const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
	return content == null ? '' : String(content);
}

// extractJson(text): pull the first balanced {...} object out of a model reply and parse it.
// The model reply is untrusted free text (it may wrap JSON in prose/fences); we never eval — just
// scan for the first balanced brace span and JSON.parse it. Returns null if none parses.
function extractJson(text) {
	const s = String(text || '');
	const start = s.indexOf('{');
	if (start < 0) return null;
	let depth = 0, inStr = false, esc = false;
	for (let i = start; i < s.length; i++) {
		const ch = s[i];
		if (inStr) {
			if (esc) esc = false;
			else if (ch === '\\') esc = true;
			else if (ch === '"') inStr = false;
		} else if (ch === '"') inStr = true;
		else if (ch === '{') depth++;
		else if (ch === '}') {
			depth--;
			if (depth === 0) {
				try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
			}
		}
	}
	return null;
}

module.exports = { chat, extractJson, cfg };
