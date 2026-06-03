// webui/public/app.js — entry module. Runs view (dashboard + run trigger) + view switching +
// global queue status. Flows view lives in flows.js. Shared helpers in util.js.

import { $, el, getJson, fmtMs, fmtTime, streamJob, cancelJob } from './util.js';
import { initFlows, loadFlows, reconcileFlowJob } from './flows.js';

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
		// Self-heal per-view job controls: the shared single SSE stream (util.js) can be
		// pre-empted when another view starts a job, so a view's own onEnd may never fire.
		// Reconcile against the queue here (runs every 2s) so stuck cancel buttons clear and
		// lists refresh once a job is no longer running/pending.
		const activeIds = new Set([q.running && q.running.id, ...q.pending.map((p) => p.id)].filter(Boolean));
		if (authJob && !activeIds.has(authJob)) {
			authJob = null;
			$('#auth-cancel').hidden = true;
			loadAuth(); // a finished auth may have saved a new state
		}
		reconcileFlowJob(activeIds);
	} catch {
		/* leave last status */
	}
}

// ---------- P3: trends (read-only) ----------

async function loadTrends() {
	const box = $('#trends');
	try {
		const { runs, tests } = await getJson('/api/trends');
		box.replaceChildren();
		if (!runs.length) {
			box.append(el('div', { class: 'hint' }, 'No runs yet.'));
			return;
		}
		const table = el('table', { class: 'trend-table' });
		const head = el('tr', {}, el('th', { class: 'tname' }, 'test'));
		runs.forEach((r) => head.append(el('th', { class: r.total === 0 ? 'none' : r.failed === 0 ? 'pass' : 'fail', title: `${r.runId} — ${r.passed}/${r.total}` }, `${r.passRate}%`)));
		table.append(head);
		for (const name of Object.keys(tests).sort()) {
			const byRun = Object.fromEntries(tests[name].map((h) => [h.runId, h.status]));
			const row = el('tr', {}, el('td', { class: 'tname' }, name));
			runs.forEach((r) => {
				const st = byRun[r.runId] || 'none';
				row.append(el('td', {}, el('span', { class: 'dot ' + st, title: `${name} @ ${r.runId}: ${st}` })));
			});
			table.append(row);
		}
		box.append(el('div', { class: 'trend-sub' }, `${runs.length} run(s), oldest → newest. Newest pass-rate: ${runs[runs.length - 1].passRate}%`), table);
	} catch (e) {
		box.replaceChildren(el('div', { class: 'error' }, `Failed to load trends: ${e.message}`));
	}
}

// ---------- P3: auth (control-plane wrapper over setup/auth.sh) ----------

let authJob = null;

async function loadAuth() {
	const node = $('#auth-list');
	try {
		const { apps } = await getJson('/api/auth');
		node.replaceChildren();
		if (!apps.length) {
			node.append(document.createTextNode('(none)'));
			return;
		}
		for (const a of apps) {
			node.append(el('span', { class: 'auth-chip' }, a, el('button', { class: 'chip-x', type: 'button', title: 'delete cached state', onclick: () => deleteAuth(a) }, '✕')));
		}
	} catch {
		node.textContent = '(error)';
	}
}

async function deleteAuth(app) {
	if (!confirm(`Delete cached auth state for "${app}"? Tests using it will need re-auth.`)) return;
	try {
		await fetch(`/api/auth/${encodeURIComponent(app)}/delete`, { method: 'POST' });
	} catch {
		/* ignore; loadAuth re-syncs */
	}
	loadAuth();
}

async function startAuth() {
	if (authJob) return; // one auth in flight at a time (avoid orphaning the tracked job)
	const app = $('#auth-app').value.trim();
	const loginUrl = $('#auth-login').value.trim();
	const successUrl = $('#auth-success').value.trim();
	const log = $('#auth-log');
	log.hidden = false;
	log.textContent = 'starting auth…';
	let resp;
	try {
		resp = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app, loginUrl, successUrl }) });
	} catch (e) {
		log.textContent = `auth failed: ${e.message}`;
		return;
	}
	if (!resp.ok) {
		const e = await resp.json().catch(() => ({ error: resp.statusText }));
		log.textContent = `auth rejected: ${e.error || resp.status}`;
		return;
	}
	const { job } = await resp.json();
	authJob = job.id;
	$('#auth-cancel').hidden = false;
	streamJob(job.id, log, () => {
		authJob = null;
		$('#auth-cancel').hidden = true;
		loadAuth(); // a new state file may now exist
	});
	refreshQueue();
}

// ---------- jobs history (uses existing /api/queue + /api/jobs/:id/stream) ----------

async function loadJobs() {
	const list = $('#jobs-list');
	try {
		const q = await getJson('/api/queue');
		const ordered = [];
		const seen = new Set();
		for (const j of [q.running, ...q.pending, ...q.recent]) {
			if (j && !seen.has(j.id)) {
				seen.add(j.id);
				ordered.push(j);
			}
		}
		list.replaceChildren();
		if (!ordered.length) {
			list.append(el('div', { class: 'hint' }, 'No jobs yet.'));
			return;
		}
		for (const j of ordered) {
			const cls = j.status === 'done' ? 'pass' : j.status === 'failed' || j.status === 'cancelled' ? 'fail' : 'run';
			list.append(
				el(
					'button',
					{ class: 'run-row', type: 'button', dataset: { job: j.id }, onclick: () => openJob(j.id) },
					el('span', { class: 'badge ' + cls }, (j.status || '').toUpperCase()),
					el(
						'span',
						{ class: 'run-meta' },
						el('span', { class: 'run-id' }, j.label || j.kind || j.id),
						el('span', { class: 'run-sub' }, `${j.id} • ${j.kind}${j.exitCode != null ? ` • exit ${j.exitCode}` : ''}`),
					),
				),
			);
		}
	} catch (e) {
		list.replaceChildren(el('div', { class: 'error' }, `Failed to load jobs: ${e.message}`));
	}
}

function openJob(id) {
	for (const b of document.querySelectorAll('#jobs-list .run-row')) b.classList.toggle('active', b.dataset.job === id);
	const log = $('#jobs-log');
	log.hidden = false;
	$('#jobs-detail').replaceChildren(el('div', { class: 'detail-head' }, el('h2', {}, `job ${id}`)));
	// replays the buffered log (and streams live if still running); refresh the list at end.
	streamJob(id, log, () => loadJobs());
}

// ---------- view switching ----------

const NAV = { runs: '#nav-runs', flows: '#nav-flows', trends: '#nav-trends', auth: '#nav-auth', jobs: '#nav-jobs' };

function loadView(view) {
	if (view === 'flows') loadFlows();
	else if (view === 'trends') loadTrends();
	else if (view === 'auth') loadAuth();
	else if (view === 'jobs') loadJobs();
	else {
		loadRuns();
		if (selectedRunId) selectRun(selectedRunId);
	}
}

function setView(view) {
	document.body.dataset.view = view;
	for (const [v, sel] of Object.entries(NAV)) $(sel).classList.toggle('active', v === view);
	loadView(view);
}

for (const [v, sel] of Object.entries(NAV)) $(sel).addEventListener('click', () => setView(v));
$('#run').addEventListener('click', runSuite);
$('#auth-btn').addEventListener('click', startAuth);
$('#auth-cancel').addEventListener('click', () => authJob && cancelJob(authJob));
$('#refresh').addEventListener('click', () => loadView(document.body.dataset.view));

// ---------- init ----------

loadRuns();
refreshQueue();
setInterval(refreshQueue, 2000);
initFlows();
