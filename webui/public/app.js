// webui/public/app.js — vanilla dashboard client (no framework, no build).
// Fetches the read-only JSON API and renders runs + run detail (video + per-test status).
// All filesystem-derived strings go through textContent / createElement — never raw innerHTML
// of untrusted values — so a stray test name can't inject markup.

const $ = (sel) => document.querySelector(sel);

// Tiny DOM builder: el('div', {class:'x'}, 'text', childNode, ...)
function el(tag, props = {}, ...children) {
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

const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`);
const fmtTime = (iso) => {
	if (!iso) return '';
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
};

async function getJson(url) {
	const r = await fetch(url);
	if (!r.ok) throw new Error(`${r.status} ${r.statusText} for ${url}`);
	return r.json();
}

let selectedRunId = null;

async function loadRuns() {
	const list = $('#runs');
	try {
		const { runs } = await getJson('/api/runs');
		list.replaceChildren();
		if (!runs.length) {
			list.append(el('div', { class: 'hint' }, 'No runs yet. Run the suite (bash run.sh) to populate.'));
			return;
		}
		for (const r of runs) {
			const ok = r.failed === 0;
			const row = el(
				'button',
				{
					class: 'run-row' + (r.runId === selectedRunId ? ' active' : ''),
					type: 'button',
					dataset: { runId: r.runId },
					onclick: () => selectRun(r.runId),
				},
				el('span', { class: 'badge ' + (ok ? 'pass' : 'fail') }, ok ? 'PASS' : 'FAIL'),
				el(
					'span',
					{ class: 'run-meta' },
					el('span', { class: 'run-id' }, r.runId),
					el('span', { class: 'run-sub' }, `${r.passed}/${r.total} • ${fmtMs(r.durationMs)} • ${fmtTime(r.startedAt)}`),
				),
			);
			list.append(row);
		}
	} catch (e) {
		list.replaceChildren(el('div', { class: 'error' }, `Failed to load runs: ${e.message}`));
	}
}

async function selectRun(runId) {
	selectedRunId = runId;
	for (const b of document.querySelectorAll('.run-row')) {
		b.classList.toggle('active', b.dataset.runId === runId);
	}
	const detail = $('#detail');
	detail.replaceChildren(el('div', { class: 'placeholder' }, 'Loading…'));
	try {
		const run = await getJson(`/api/runs/${encodeURIComponent(runId)}`);
		renderDetail(run);
	} catch (e) {
		detail.replaceChildren(el('div', { class: 'error' }, `Failed to load run: ${e.message}`));
	}
}

function renderDetail(run) {
	const detail = $('#detail');
	const ok = run.failed === 0;
	const head = el(
		'div',
		{ class: 'detail-head' },
		el('span', { class: 'badge ' + (ok ? 'pass' : 'fail') }, ok ? 'PASS' : 'FAIL'),
		el('h2', {}, run.runId),
		el('span', { class: 'detail-sub' }, `${run.passed}/${run.total} passed • ${run.failed} failed • ${fmtMs(run.durationMs)} • ${fmtTime(run.startedAt)}`),
	);

	const links = el('div', { class: 'links' });
	if (run.hasReport) links.append(el('a', { href: `/artifacts/${run.runId}/report.json`, target: '_blank' }, 'report.json'));
	if (run.hasJunit) links.append(el('a', { href: `/artifacts/${run.runId}/report.junit.xml`, target: '_blank' }, 'report.junit.xml'));

	const tests = el('div', { class: 'tests' });
	for (const t of run.tests) {
		const card = el(
			'div',
			{ class: 'test' },
			el(
				'div',
				{ class: 'test-head' },
				el('span', { class: 'badge sm ' + (t.status === 'pass' ? 'pass' : 'fail') }, t.status.toUpperCase()),
				el('span', { class: 'test-name' }, t.name),
				el('span', { class: 'test-dur' }, fmtMs(t.durationMs)),
			),
		);
		if (t.hasVideo) {
			card.append(
				el('video', {
					class: 'video',
					controls: '',
					preload: 'metadata',
					src: `/artifacts/${run.runId}/${encodeURIComponent(t.name)}/video.webm`,
				}),
			);
		} else {
			card.append(el('div', { class: 'no-video' }, 'no video (browser-free test)'));
		}
		tests.append(card);
	}

	detail.replaceChildren(head, links, tests);
}

$('#refresh').addEventListener('click', () => {
	loadRuns();
	if (selectedRunId) selectRun(selectedRunId);
});

loadRuns();
