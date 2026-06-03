// webui/public/app.js — entry module. Runs view (dashboard + run trigger) + view switching +
// global queue status. Flows view lives in flows.js. Shared helpers in util.js.

import { $, el, getJson, fmtMs, fmtTime, streamJob, cancelJob } from './util.js';
import { initFlows, loadFlows } from './flows.js';

// ---------- Runs dashboard ----------

let selectedRunId = null;

async function loadRuns() {
	const list = $('#runs');
	try {
		const { runs } = await getJson('/api/runs');
		list.replaceChildren();
		if (!runs.length) {
			list.append(el('div', { class: 'hint' }, 'No runs yet. Run the suite above.'));
			return;
		}
		for (const r of runs) {
			const ok = r.failed === 0;
			list.append(
				el(
					'button',
					{ class: 'run-row' + (r.runId === selectedRunId ? ' active' : ''), type: 'button', dataset: { runId: r.runId }, onclick: () => selectRun(r.runId) },
					el('span', { class: 'badge ' + (ok ? 'pass' : 'fail') }, ok ? 'PASS' : 'FAIL'),
					el(
						'span',
						{ class: 'run-meta' },
						el('span', { class: 'run-id' }, r.runId),
						el('span', { class: 'run-sub' }, `${r.passed}/${r.total} • ${fmtMs(r.durationMs)} • ${fmtTime(r.startedAt)}`),
					),
				),
			);
		}
	} catch (e) {
		list.replaceChildren(el('div', { class: 'error' }, `Failed to load runs: ${e.message}`));
	}
}

async function selectRun(runId) {
	selectedRunId = runId;
	for (const b of document.querySelectorAll('#runs .run-row')) b.classList.toggle('active', b.dataset.runId === runId);
	const detail = $('#detail');
	detail.replaceChildren(el('div', { class: 'placeholder' }, 'Loading…'));
	try {
		renderDetail(await getJson(`/api/runs/${encodeURIComponent(runId)}`));
	} catch (e) {
		detail.replaceChildren(el('div', { class: 'error' }, `Failed to load run: ${e.message}`));
	}
}

function renderDetail(run) {
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
			card.append(el('video', { class: 'video', controls: '', preload: 'metadata', src: `/artifacts/${run.runId}/${encodeURIComponent(t.name)}/video.webm` }));
		} else {
			card.append(el('div', { class: 'no-video' }, 'no video (browser-free test)'));
		}
		tests.append(card);
	}
	$('#detail').replaceChildren(head, links, tests);
}

// ---------- Run trigger (job + SSE log) ----------

function renderJobPanel(job) {
	const log = el('pre', { class: 'joblog', id: 'joblog' });
	$('#detail').replaceChildren(
		el(
			'div',
			{ class: 'job' },
			el(
				'div',
				{ class: 'detail-head' },
				el('span', { class: 'badge run', id: 'job-badge' }, (job.status || 'running').toUpperCase()),
				el('h2', {}, job.label || job.kind),
				el('span', { class: 'detail-sub', id: 'job-sub' }, job.id),
				el('button', { class: 'cancel-btn', id: 'job-cancel', type: 'button', onclick: () => cancelJob(job.id).then(refreshQueue) }, '✕ cancel'),
			),
			log,
		),
	);
	return log;
}

async function runSuite() {
	const glob = $('#glob').value.trim();
	let resp;
	try {
		resp = await fetch('/api/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ glob }) });
	} catch (e) {
		$('#detail').replaceChildren(el('div', { class: 'error' }, `Run request failed: ${e.message}`));
		return;
	}
	if (!resp.ok) {
		const e = await resp.json().catch(() => ({ error: resp.statusText }));
		$('#detail').replaceChildren(el('div', { class: 'error' }, `Run rejected: ${e.error || resp.status}`));
		return;
	}
	const { job } = await resp.json();
	const log = renderJobPanel(job);
	streamJob(job.id, log, (done) => {
		const badge = $('#job-badge');
		if (badge) {
			badge.textContent = done.status.toUpperCase();
			badge.className = 'badge ' + (done.status === 'done' ? 'pass' : 'fail');
		}
		const sub = $('#job-sub');
		if (sub) sub.textContent = `${done.id} • exit ${done.exitCode}`;
		const cb = $('#job-cancel');
		if (cb) cb.remove();
		loadRuns();
		if (done.runId) selectRun(done.runId);
		refreshQueue();
	});
	refreshQueue();
}

async function refreshQueue() {
	try {
		const q = await getJson('/api/queue');
		const node = $('#qstatus');
		if (q.busy) {
			node.textContent = `running ${q.running.id}` + (q.pending.length ? ` • ${q.pending.length} queued` : '');
			node.className = 'qstatus busy';
		} else {
			node.textContent = q.pending.length ? `${q.pending.length} queued` : 'idle';
			node.className = 'qstatus';
		}
	} catch {
		/* leave last status */
	}
}

// ---------- view switching ----------

function setView(view) {
	document.body.dataset.view = view;
	$('#nav-runs').classList.toggle('active', view === 'runs');
	$('#nav-flows').classList.toggle('active', view === 'flows');
	if (view === 'flows') loadFlows();
}

$('#nav-runs').addEventListener('click', () => setView('runs'));
$('#nav-flows').addEventListener('click', () => setView('flows'));
$('#run').addEventListener('click', runSuite);
$('#refresh').addEventListener('click', () => {
	if (document.body.dataset.view === 'flows') loadFlows();
	else {
		loadRuns();
		if (selectedRunId) selectRun(selectedRunId);
	}
});

// ---------- init ----------

loadRuns();
refreshQueue();
setInterval(refreshQueue, 2000);
initFlows();
