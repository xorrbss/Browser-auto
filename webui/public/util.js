// webui/public/util.js — tiny shared DOM/fetch helpers + the job SSE stream machinery,
// imported by app.js (Runs view) and flows.js (Flows view). No framework, no build.

export const $ = (sel) => document.querySelector(sel);

// el('div', {class:'x', onclick:fn}, 'text', childNode, ...)
export function el(tag, props = {}, ...children) {
	const node = document.createElement(tag);
	for (const [k, v] of Object.entries(props)) {
		if (v == null) continue;
		if (k === 'class') node.className = v;
		else if (k === 'dataset') Object.assign(node.dataset, v);
		else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
		else node.setAttribute(k, v);
	}
	for (const c of children) {
		if (c == null) continue;
		node.append(c.nodeType ? c : document.createTextNode(String(c)));
	}
	return node;
}

export async function getJson(url) {
	const r = await fetch(url);
	if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
	return r.json();
}

export const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
export const fmtTime = (iso) => {
	if (!iso) return '';
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

// status -> Korean badge label (job/test/run states); unknown values fall back to upper-case.
export const statusKo = (s) => {
	const k = String(s == null ? '' : s).toLowerCase();
	return { pass: '통과', fail: '실패', ok: '정상', done: '완료', failed: '실패', cancelled: '취소', running: '실행중', pending: '대기', queued: '대기', fetched: '미결', approved: '승인' }[k] || String(s == null ? '' : s).toUpperCase();
};

// Exactly one job stream is open at a time. Starting another closes the prior one, so a stale
// job's 'end' never reaches the client (no view hijack); clearing on '(re)open' avoids
// duplicated lines when the browser EventSource auto-reconnects after a transport drop.
let currentEs = null;

export function streamJob(jobId, logEl, onEnd) {
	if (currentEs) {
		currentEs.close();
		currentEs = null;
	}
	const es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/stream`);
	currentEs = es;
	es.addEventListener('open', () => {
		logEl.textContent = '';
	});
	es.addEventListener('line', (ev) => {
		const { line } = JSON.parse(ev.data);
		const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
		logEl.append(document.createTextNode(line + '\n'));
		if (atBottom) logEl.scrollTop = logEl.scrollHeight;
	});
	es.addEventListener('end', (ev) => {
		es.close();
		if (currentEs === es) currentEs = null;
		if (onEnd) onEnd(JSON.parse(ev.data));
	});
	es.onerror = () => {
		if (es.readyState === EventSource.CLOSED && currentEs === es) {
			currentEs = null;
			logEl.append(document.createTextNode('\n[webui] 로그 스트림이 닫혔습니다 — 새로고침하세요.\n'));
		}
	};
}

export async function cancelJob(id) {
	try {
		await fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
	} catch {
		/* the SSE end frame still reports the final state */
	}
}

// stopJob(id): request a GRACEFUL early finish of a running recording (a COMPLETE capture) — vs
// cancelJob's tree-kill (partial). Sends a "{}" body because /stop is parsed after the JSON reader.
export async function stopJob(id) {
	try {
		const r = await fetch(`/api/jobs/${encodeURIComponent(id)}/stop`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
		return r.ok; // false (409) when the job is still queued — not yet a running recording
	} catch {
		return false; /* the SSE end frame still reports the final state */
	}
}
