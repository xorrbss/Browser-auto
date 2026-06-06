#!/usr/bin/env node
'use strict';
// bin/summarize.js — fill each 결재 item's `summary` from a LOCAL / on-prem LLM (NOT Anthropic).
//
// The approval body is confidential (financial/HR), so this talks ONLY to a configured
// OpenAI-compatible endpoint (Ollama, vLLM, LM Studio, or a 사내 model server) — the body never
// leaves that endpoint. Zero external deps (global fetch). Sits OFF the deterministic read path:
// it is best-effort enrichment, never a pass/fail gate.
//
//   stdin : JSON array of items (each { doc_id, title?, raw_text?, ... }).
//   stdout : the SAME array with `.summary` filled for items that had raw_text.
//   config (env):
//     SUMMARY_API_URL   base URL, OpenAI-compatible (default http://localhost:11434/v1 = Ollama)
//     SUMMARY_MODEL     model id (REQUIRED, e.g. qwen2.5:7b / gemma2:9b / a 사내 model)
//     SUMMARY_API_KEY   optional bearer token (for a 사내 gateway; Ollama ignores it)
//     SUMMARY_TIMEOUT_MS per-request timeout (default 60000)
//
// A network failure (endpoint down/misconfigured) is FATAL (exit 1) with setup guidance — nothing
// can be summarized. A per-item model error (the endpoint answered but errored on one doc) is a
// WARNING: that item keeps summary=null and the batch continues (raw_text is still stored).

const BASE = (process.env.SUMMARY_API_URL || 'http://localhost:11434/v1').replace(/\/+$/, '');
const MODEL = process.env.SUMMARY_MODEL || '';
const API_KEY = process.env.SUMMARY_API_KEY || '';
const TIMEOUT_MS = Number(process.env.SUMMARY_TIMEOUT_MS) || 60000;

const SYSTEM =
	'당신은 기업 전자결재 문서를 결재자에게 핵심만 간결히 요약하는 비서입니다. ' +
	'한국어로 2~3문장 이내, 문서의 목적·금액·중요 일자·요청 사항 위주로 사실만 요약하세요. ' +
	'본문에 없는 내용은 추측하지 말고, 군더더기 없이 요약문만 출력하세요.';

async function summarizeOne(title, body) {
	const user = (title ? `제목: ${title}\n\n` : '') + `다음 전자결재 문서를 요약하세요:\n\n${body}`;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	let res;
	try {
		res = await fetch(`${BASE}/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}) },
			body: JSON.stringify({
				model: MODEL,
				messages: [
					{ role: 'system', content: SYSTEM },
					{ role: 'user', content: user },
				],
				stream: false,
				temperature: 0.2,
			}),
			signal: ctrl.signal,
		});
	} finally {
		clearTimeout(timer);
	}
	// A non-OK HTTP response is a per-item failure (endpoint is up but rejected THIS request).
	if (!res.ok) {
		const txt = await res.text().catch(() => '');
		throw Object.assign(new Error(`HTTP ${res.status} ${res.statusText} ${txt.slice(0, 200)}`), { perItem: true });
	}
	const data = await res.json();
	const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
	const s = (content == null ? '' : String(content)).trim();
	if (!s) throw Object.assign(new Error('empty completion'), { perItem: true });
	return s;
}

async function main() {
	if (!MODEL) {
		console.error('summarize: SUMMARY_MODEL is required (e.g. SUMMARY_MODEL=qwen2.5:7b). Set up a local endpoint first:');
		console.error('  Ollama: winget install Ollama.Ollama && ollama pull qwen2.5:7b   (serves http://localhost:11434)');
		process.exit(1);
	}
	let input = '';
	for await (const c of process.stdin) input += c;
	let items;
	try {
		items = JSON.parse(input.trim() || '[]');
	} catch (e) {
		console.error('summarize: invalid JSON on stdin: ' + e.message);
		process.exit(1);
	}
	if (!Array.isArray(items)) {
		console.error('summarize: stdin must be a JSON array of items');
		process.exit(1);
	}

	let done = 0;
	let warned = 0;
	for (const it of items) {
		const body = it && it.raw_text != null ? String(it.raw_text).trim() : '';
		if (!body) continue; // nothing to summarize for this item
		try {
			it.summary = await summarizeOne(it.title || '', body);
			done++;
			console.error(`summarize: ${it.doc_id || '?'} ✓ (${it.summary.length} chars)`);
		} catch (e) {
			if (e.perItem) {
				warned++;
				console.error(`summarize: ${it.doc_id || '?'} ⚠ skipped — ${e.message}`);
				continue;
			}
			// A network/abort error: the endpoint is unreachable/misconfigured — nothing will work.
			console.error(`summarize: FATAL — cannot reach SUMMARY_API_URL (${BASE}): ${e.message}`);
			console.error('  Is the local model server running? (Ollama: `ollama serve` + `ollama pull ' + MODEL + '`)');
			process.exit(1);
		}
	}
	console.error(`summarize: done — ${done} summarized, ${warned} skipped, model=${MODEL} @ ${BASE}`);
	process.stdout.write(JSON.stringify(items));
}

main();
