// webui/agent.js — the natural-language COMMAND ROUTER (Phase 1: read intents).
//
// The user types Korean in the webui command box; the ON-PREM exaone model classifies it into ONE
// validated intent (sync / summarize / query / approve-candidates / clarify). The model has ZERO
// authority: it only CLASSIFIES — it never drives the browser, never decides or executes an
// approval, never touches pass/fail. The server validates the model's reply against a strict
// allowlist and degrades to "clarify" on any doubt (never to a default action, NEVER to approve).
// Injection containment: only the user's command text is sent to the model — never document bodies.
//
// ESM ↔ CJS: reach lib/llm.js + lib/db.js via createRequire (same pattern as webui/approvals.js).

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const llm = require('../lib/llm.js');
const { openDb, closeDb, queryApprovals } = require('../lib/db.js');

// The webui is `node` (can't `source` the bash data/approvals.config), so load the model endpoint
// config from it into process.env once at startup if not already set — then `node webui/server.js`
// "just works" with the same on-prem model the CLI uses. Parses simple [export] KEY=VALUE lines.
(function loadConfig() {
	try {
		const cfg = path.join(import.meta.dirname, '..', 'data', 'approvals.config');
		for (const line of fs.readFileSync(cfg, 'utf8').split('\n')) {
			const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
			if (!m) continue;
			let v = m[2].trim().replace(/^["']|["']$/g, '');
			if (process.env[m[1]] === undefined) process.env[m[1]] = v;
		}
	} catch { /* no config — env or defaults apply */ }
})();

const ACTIONS = new Set(['sync', 'summarize', 'query', 'approve', 'clarify']);
const FILTER_KEYS = new Set(['dept', 'drafter', 'dateFrom', 'dateTo', 'keyword', 'limit']);

const SYSTEM =
	'너는 기업 전자결재 자동화 시스템의 "명령 분류기"다. 사용자의 한국어 명령을 아래 의도 중 정확히 하나로 분류해 ' +
	'JSON 객체 하나만 출력한다(설명·코드펜스 금지).\n' +
	'의도:\n' +
	'- {"action":"sync"}                              // 결재 목록을 새로 가져온다(새로고침/동기화)\n' +
	'- {"action":"summarize","limit":<정수?>}          // 아직 요약 안 된 문서를 요약한다\n' +
	'- {"action":"query","filter":{...}}              // 조회/검색. filter 키만 사용: dept, drafter, dateFrom("YYYY-MM-DD"), dateTo, keyword\n' +
	'- {"action":"approve","filter":{...}}            // 승인 "후보"를 조회한다(절대 실행이 아니다)\n' +
	'- {"action":"clarify","question":"<한국어 질문>"}  // 위로 분류 불가하거나 모호할 때\n' +
	'규칙: 너는 분류만 한다. 승인 같은 효력 행위를 결정·실행하지 않는다(approve는 후보 조회일 뿐). ' +
	'금액 조건은 숫자 비교가 불가하니 filter.keyword 에 넣어라(예: "100만원"). ' +
	'조회 시 부서/기안자 외에 핵심 검색어가 있으면 filter.keyword 에도 함께 넣어라(예: "관리팀 출장" → {"dept":"관리팀","keyword":"출장"}). ' +
	'날짜는 "YYYY-MM-DD" 로만 쓰고, 연도가 없으면 반드시 아래에 주어진 현재 날짜의 연도를 사용하라(추측 금지). ' +
	'결재 업무와 무관한 요청은 action:"clarify" 로 하고 question 에 "결재 관련 명령을 입력해 주세요(예: 조회/요약/동기화)" 라고 답하라. 반드시 JSON 하나만.';

// classifyIntent(text): model reply is UNTRUSTED — extract JSON, validate to the allowlist, sanitize
// the filter to whitelisted keys, clamp limits. Any failure/ambiguity -> {action:"clarify"}.
export async function classifyIntent(text) {
	const cmd = String(text || '').slice(0, 2000);
	// Inject TODAY (the node process knows the real date; the model does not) so relative dates like
	// "6월 1일 이후" resolve to the current year instead of a hallucinated one.
	const today = new Date().toISOString().slice(0, 10);
	const sys = `${SYSTEM}\n현재 날짜: ${today} (연도 미지정 시 ${today.slice(0, 4)}년으로 해석).`;
	let raw;
	try {
		raw = await llm.chat([{ role: 'system', content: sys }, { role: 'user', content: cmd }], { temperature: 0 });
	} catch (e) {
		return { action: 'clarify', question: `모델을 호출하지 못했어요 (${e.message}). 온프렘 모델 상태를 확인하거나 잠시 후 다시 시도하세요.`, _error: true };
	}
	const obj = llm.extractJson(raw);
	if (!obj || typeof obj !== 'object' || !ACTIONS.has(obj.action)) {
		return { action: 'clarify', question: '명령을 이해하지 못했어요. 예: "미결 목록 새로고침", "관리팀 출장 관련 조회", "최근 문서 10건 요약".', _raw: String(raw || '').slice(0, 200) };
	}
	const out = { action: obj.action };
	if (obj.action === 'clarify') {
		out.question = typeof obj.question === 'string' && obj.question.trim() ? obj.question.trim() : '무엇을 도와드릴까요?';
		return out;
	}
	if (obj.action === 'summarize') {
		const n = parseInt(obj.limit, 10);
		if (Number.isFinite(n) && n > 0) out.limit = Math.min(n, 50);
	}
	if (obj.action === 'query' || obj.action === 'approve') {
		const f = {};
		const src = obj.filter && typeof obj.filter === 'object' ? obj.filter : {};
		for (const k of Object.keys(src)) {
			if (!FILTER_KEYS.has(k)) continue;
			const v = src[k];
			if (v == null || v === '') continue;
			if (k === 'limit') { const n = parseInt(v, 10); if (Number.isFinite(n) && n > 0) f.limit = Math.min(n, 500); }
			else f[k] = String(v).slice(0, 100);
		}
		out.filter = f;
	}
	return out;
}

// runQuery(filter): READ-ONLY rows for query/approve-candidate intents (DB-authoritative facts).
export function runQuery(filter = {}) {
	const db = openDb();
	try {
		return queryApprovals(db, { ...filter, limit: Number.isInteger(filter.limit) ? filter.limit : 200 });
	} finally {
		closeDb(db);
	}
}
