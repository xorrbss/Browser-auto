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
// duplicated lines when the browser EventSource auto-reconnects after a transport drop. Callers
// that write a pre-stream header can opt out of that clear.
let currentEs = null;

export function streamJob(jobId, logEl, onEnd, options = {}) {
	if (currentEs) {
		currentEs.close();
		currentEs = null;
	}
	const es = new EventSource(`/api/jobs/${encodeURIComponent(jobId)}/stream`);
	currentEs = es;
	// onEnd MUST fire exactly once — on the terminal 'end' frame, OR (if that frame never arrives because
	// the stream closed abnormally: server restart, evicted job) on a best-effort fetch of the final job
	// state. Without the fallback, a caller that clears UI state in onEnd (e.g. an in-flight approve flag)
	// would wedge until a full reload. `data` is the publicJob (same shape as the 'end' frame), or null
	// only when the fallback fetch also fails — every onEnd caller already null-guards its argument.
	let finished = false;
	const finish = (data) => {
		if (finished) return;
		finished = true;
		if (currentEs === es) currentEs = null;
		try { es.close(); } catch { /* idempotent */ }
		if (onEnd) onEnd(data);
	};
	es.addEventListener('open', () => {
		if (options.clearOnOpen !== false) logEl.textContent = '';
	});
	es.addEventListener('line', (ev) => {
		const { line } = JSON.parse(ev.data);
		const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
		logEl.append(document.createTextNode(line + '\n'));
		if (atBottom) logEl.scrollTop = logEl.scrollHeight;
	});
	es.addEventListener('end', (ev) => {
		let data = null;
		try { data = JSON.parse(ev.data); } catch { /* keep null */ }
		finish(data);
	});
	es.onerror = () => {
		// CLOSED = the browser gave up reconnecting (transient drops auto-reconnect with readyState
		// CONNECTING and are left alone). The 'end' frame won't come, so fetch the terminal state once
		// and finalize — otherwise the caller's onEnd never runs and its UI state stays stuck.
		if (es.readyState === EventSource.CLOSED && currentEs === es && !finished) {
			currentEs = null; // claim this stream so a repeat CLOSED dispatch can't schedule a 2nd fallback fetch
			logEl.append(document.createTextNode('\n[webui] 로그 스트림이 닫혔습니다 — 최종 상태를 확인합니다…\n'));
			getJson(`/api/jobs/${encodeURIComponent(jobId)}`).then(finish).catch(() => finish(null));
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
