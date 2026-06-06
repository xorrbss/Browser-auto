// webui/public/app.js — entry module. Runs view (dashboard + run trigger) + view switching +
// global queue status. Flows view lives in flows.js. Shared helpers in util.js.

import { $, el, getJson, fmtMs, fmtTime, statusKo, streamJob, cancelJob } from './util.js';
import { initFlows, loadFlows, reconcileFlowJob } from './flows.js';

// ---------- Runs dashboard ----------

let selectedRunId = null;

async function loadRuns() {
	const list = $('#runs');
	try {
		const { runs } = await getJson('/api/runs');
		list.replaceChildren();
		if (!runs.length) {
			list.append(el('div', { class: 'hint' }, '아직 실행이 없습니다. 위에서 스위트를 실행하세요.'));
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
		list.replaceChildren(el('div', { class: 'error' }, `실행 목록을 불러오지 못했습니다: ${e.message}`));
	}
}

async function selectRun(runId) {
	selectedRunId = runId;
	for (const b of document.querySelectorAll('#runs .run-row')) b.classList.toggle('active', b.dataset.runId === runId);
	const detail = $('#detail');
	detail.replaceChildren(el('div', { class: 'placeholder' }, '로딩 중…'));
	try {
		renderDetail(await getJson(`/api/runs/${encodeURIComponent(runId)}`));
	} catch (e) {
		detail.replaceChildren(el('div', { class: 'error' }, `실행을 불러오지 못했습니다: ${e.message}`));
	}
}

function renderDetail(run) {
	const ok = run.failed === 0;
	const head = el(
		'div',
		{ class: 'detail-head' },
		el('span', { class: 'badge ' + (ok ? 'pass' : 'fail') }, ok ? 'PASS' : 'FAIL'),
		el('h2', {}, run.runId),
		el('span', { class: 'detail-sub' }, `통과 ${run.passed}/${run.total} • 실패 ${run.failed} • ${fmtMs(run.durationMs)} • ${fmtTime(run.startedAt)}`),
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
				el('span', { class: 'badge sm ' + (t.status === 'pass' ? 'pass' : 'fail') }, statusKo(t.status)),
				el('span', { class: 'test-name' }, t.name),
				el('span', { class: 'test-dur' }, fmtMs(t.durationMs)),
			),
		);
		if (t.hasVideo) {
			card.append(el('video', { class: 'video', controls: '', preload: 'metadata', src: `/artifacts/${run.runId}/${encodeURIComponent(t.name)}/video.webm` }));
		} else {
			card.append(el('div', { class: 'no-video' }, '비디오 없음 (브라우저 미사용 테스트)'));
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
				el('span', { class: 'badge run', id: 'job-badge' }, statusKo(job.status || 'running')),
				el('h2', {}, job.label || job.kind),
				el('span', { class: 'detail-sub', id: 'job-sub' }, job.id),
				el('button', { class: 'cancel-btn', id: 'job-cancel', type: 'button', onclick: () => cancelJob(job.id).then(refreshQueue) }, '✕ 취소'),
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
		$('#detail').replaceChildren(el('div', { class: 'error' }, `실행 요청 실패: ${e.message}`));
		return;
	}
	if (!resp.ok) {
		const e = await resp.json().catch(() => ({ error: resp.statusText }));
		$('#detail').replaceChildren(el('div', { class: 'error' }, `실행 거부됨: ${e.error || resp.status}`));
		return;
	}
	const { job } = await resp.json();
	const log = renderJobPanel(job);
	streamJob(job.id, log, (done) => {
		const badge = $('#job-badge');
		if (badge) {
			badge.textContent = statusKo(done.status);
			badge.className = 'badge ' + (done.status === 'done' ? 'pass' : 'fail');
		}
		const sub = $('#job-sub');
		if (sub) sub.textContent = `${done.id} • 종료 ${done.exitCode}`;
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
			node.textContent = `실행중 ${q.running.id}` + (q.pending.length ? ` • 대기 ${q.pending.length}` : '');
			node.className = 'qstatus busy';
		} else {
			node.textContent = q.pending.length ? `대기 ${q.pending.length}` : '대기';
			node.className = 'qstatus';
		}
		// Self-heal per-view job controls: the shared single SSE stream (util.js) can be
		// pre-empted when another view starts a job, so a view's own onEnd may never fire.
		// Reconcile against the queue here (runs every 2s) so stuck cancel buttons clear and
		// lists refresh once a job is no longer running/pending.
		const activeIds = new Set([q.running && q.running.id, ...q.pending.map((p) => p.id)].filter(Boolean));
		if (syncJob && !activeIds.has(syncJob)) {
			syncJob = null;
			$('#sync-cancel').hidden = true;
			loadApprovals(); // a finished sync may have written new rows
		}
		if (authJob && !activeIds.has(authJob)) {
			authJob = null;
			$('#auth-cancel').hidden = true;
			loadAuth(); // a finished auth may have saved a new state
		}
		if (sysJob && !activeIds.has(sysJob)) { sysJob = null; loadSystems(); }
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
			box.append(el('div', { class: 'hint' }, '아직 실행이 없습니다.'));
			return;
		}
		const table = el('table', { class: 'trend-table' });
		const head = el('tr', {}, el('th', { class: 'tname' }, '테스트'));
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
		box.append(el('div', { class: 'trend-sub' }, `실행 ${runs.length}개, 과거 → 최신. 최신 통과율: ${runs[runs.length - 1].passRate}%`), table);
	} catch (e) {
		box.replaceChildren(el('div', { class: 'error' }, `추세를 불러오지 못했습니다: ${e.message}`));
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
			node.append(document.createTextNode('(없음)'));
			return;
		}
		for (const a of apps) {
			node.append(el('span', { class: 'auth-chip' }, a, el('button', { class: 'chip-x', type: 'button', title: 'delete cached state', onclick: () => deleteAuth(a) }, '✕')));
		}
	} catch {
		node.textContent = '(오류)';
	}
}

async function deleteAuth(app) {
	if (!confirm(`"${app}" 앱의 캐시된 인증 상태를 삭제할까요? 이 앱을 쓰는 테스트는 재인증이 필요합니다.`)) return;
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
	log.textContent = '인증 시작 중…';
	let resp;
	try {
		resp = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app, loginUrl, successUrl }) });
	} catch (e) {
		log.textContent = `인증 실패: ${e.message}`;
		return;
	}
	if (!resp.ok) {
		const e = await resp.json().catch(() => ({ error: resp.statusText }));
		log.textContent = `인증 거부됨: ${e.error || resp.status}`;
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
			list.append(el('div', { class: 'hint' }, '아직 작업이 없습니다.'));
			return;
		}
		for (const j of ordered) {
			const cls = j.status === 'done' ? 'pass' : j.status === 'failed' || j.status === 'cancelled' ? 'fail' : 'run';
			list.append(
				el(
					'button',
					{ class: 'run-row', type: 'button', dataset: { job: j.id }, onclick: () => openJob(j.id) },
					el('span', { class: 'badge ' + cls }, statusKo(j.status)),
					el(
						'span',
						{ class: 'run-meta' },
						el('span', { class: 'run-id' }, j.label || j.kind || j.id),
						el('span', { class: 'run-sub' }, `${j.id} • ${j.kind}${j.exitCode != null ? ` • 종료 ${j.exitCode}` : ''}`),
					),
				),
			);
		}
	} catch (e) {
		list.replaceChildren(el('div', { class: 'error' }, `작업 목록을 불러오지 못했습니다: ${e.message}`));
	}
}

function openJob(id) {
	for (const b of document.querySelectorAll('#jobs-list .run-row')) b.classList.toggle('active', b.dataset.job === id);
	const log = $('#jobs-log');
	log.hidden = false;
	$('#jobs-detail').replaceChildren(el('div', { class: 'detail-head' }, el('h2', {}, `작업 ${id}`)));
	// replays the buffered log (and streams live if still running); refresh the list at end.
	streamJob(id, log, () => loadJobs());
}

// ---------- approvals (결재 미결함) — read/display only (P0; approve is P1) ----------

let syncJob = null;

// one approval card (shared by the list and the NL command results)
function renderApprovalCard(a) {
	const card = el(
		'div', { class: 'approval' },
		el(
			'div', { class: 'approval-head' },
			el('span', { class: 'badge sm ' + (a.status === 'approved' ? 'pass' : 'run') }, statusKo(a.status)),
			el('span', { class: 'approval-title' }, a.title || '(제목 없음)'),
			el('span', { class: 'approval-id' }, a.doc_id),
		),
		el('div', { class: 'approval-meta' }, [a.drafter, a.dept, a.submitted_at, a.amount ? a.amount + '원' : null].filter(Boolean).join(' • ')),
	);
	if (a.summary) card.append(el('div', { class: 'approval-summary' }, a.summary));
	else if (a.raw_text) card.append(el('div', { class: 'approval-raw' }, a.raw_text));
	return card;
}

// NL command box: POST /api/agent -> show the routed intent, then stream a job (sync/summarize)
// or render rows (query/approve-candidates) or the clarify question. The model only classified;
// the server did the routing. Approval EXECUTION is never triggered here (Phase 2, human-gated).
async function runAgent() {
	const text = $('#agent-cmd').value.trim();
	if (!text) return;
	const out = $('#agent-out');
	out.hidden = false;
	out.replaceChildren(el('div', { class: 'hint' }, '명령 분류 중…'));
	let resp;
	try {
		resp = await fetch('/api/agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
	} catch (e) {
		out.replaceChildren(el('div', { class: 'error' }, `요청 실패: ${e.message}`));
		return;
	}
	if (!resp.ok) {
		const e = await resp.json().catch(() => ({ error: resp.statusText }));
		out.replaceChildren(el('div', { class: 'error' }, `거부됨: ${e.error || resp.status}`));
		return;
	}
	const data = await resp.json();
	const intent = data.intent || {};
	out.replaceChildren(el('div', { class: 'agent-head' }, el('span', { class: 'badge run' }, '의도: ' + (intent.action || '?')), el('span', { class: 'agent-echo' }, text)));
	if (intent.action === 'clarify') { out.append(el('div', { class: 'note' }, intent.question || '무엇을 도와드릴까요?')); return; }
	if (intent.action === 'sync' || intent.action === 'summarize') {
		const log = el('pre', { class: 'joblog' });
		out.append(log);
		if (data.job) streamJob(data.job.id, log, () => loadApprovals());
		return;
	}
	if (intent.action === 'query' || intent.action === 'approve') {
		if (data.note) out.append(el('div', { class: 'note' }, data.note));
		const rows = data.approvals || [];
		out.append(el('div', { class: 'hint' }, `${rows.length}건`));
		for (const a of rows) out.append(renderApprovalCard(a));
	}
}

async function loadApprovals() {
	const box = $('#approvals-list');
	try {
		const { approvals } = await getJson('/api/approvals');
		box.replaceChildren();
		if (!approvals.length) {
			box.append(el('div', { class: 'hint' }, '저장된 결재가 없습니다. 위의 동기화를 실행하세요.'));
			return;
		}
		for (const a of approvals) box.append(renderApprovalCard(a));
	} catch (e) {
		box.replaceChildren(el('div', { class: 'error' }, `결재 목록을 불러오지 못했습니다: ${e.message}`));
	}
}

async function startSync() {
	if (syncJob) return; // one sync in flight (avoid orphaning the tracked browser job)
	const app = $('#sync-app').value.trim();
	const log = $('#sync-log');
	log.hidden = false;
	log.textContent = '동기화 시작 중…';
	let resp;
	try {
		resp = await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app }) });
	} catch (e) {
		log.textContent = `동기화 실패: ${e.message}`;
		return;
	}
	if (!resp.ok) {
		const e = await resp.json().catch(() => ({ error: resp.statusText }));
		log.textContent = `동기화 거부됨: ${e.error || resp.status}`;
		return;
	}
	const { job } = await resp.json();
	syncJob = job.id;
	$('#sync-cancel').hidden = false;
	streamJob(job.id, log, () => {
		syncJob = null;
		$('#sync-cancel').hidden = true;
		loadApprovals(); // refresh once the scrape wrote the DB
	});
	refreshQueue();
}

// ---------- systems (generic RPA registry) ----------
let selectedSystem = null;
let sysJob = null;
let sysCache = [];

async function loadSystems() {
	const box = $('#sys-list');
	try {
		const { systems } = await getJson('/api/systems');
		sysCache = systems;
		box.replaceChildren();
		if (!systems.length) { box.append(document.createTextNode('(없음)')); return; }
		for (const sy of systems) {
			box.append(el('button', { class: 'sys-chip' + (sy.name === selectedSystem ? ' active' : ''), type: 'button', onclick: () => selectSystem(sy.name) }, `${sy.label || sy.name} · ${sy.recordCount}`));
		}
	} catch (e) { box.replaceChildren(el('span', { class: 'error' }, e.message)); }
}

function selectSystem(name) {
	selectedSystem = name;
	const sy = sysCache.find((x) => x.name === name);
	if (sy) {
		$('#sys-name').value = sy.name; $('#sys-label').value = sy.label || '';
		$('#sys-login').value = sy.login_url || ''; $('#sys-success').value = sy.success_url || '';
		$('#sys-target').value = sy.target_url || '';
		$('#sys-recipe').value = sy.recipe ? JSON.stringify(sy.recipe, null, 2) : '';
	}
	loadSystems(); loadRecords();
}

function sysFormBody() {
	const t = $('#sys-recipe').value.trim();
	let recipe;
	if (t) { try { recipe = JSON.parse(t); } catch { alert('레시피 JSON 형식 오류'); throw new Error('bad recipe'); } }
	return { name: $('#sys-name').value.trim(), label: $('#sys-label').value.trim() || undefined, login_url: $('#sys-login').value.trim() || undefined, success_url: $('#sys-success').value.trim() || undefined, target_url: $('#sys-target').value.trim() || undefined, recipe };
}

async function saveSystemForm() {
	let body; try { body = sysFormBody(); } catch { return; }
	if (!body.name) { alert('이름을 입력하세요'); return; }
	const r = await fetch('/api/systems', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
	const j = await r.json().catch(() => ({}));
	if (!r.ok) { alert('저장 실패: ' + (j.error || r.status)); return; }
	selectedSystem = body.name; loadSystems();
}

// sysAction(action): POST /api/systems/<name>/<action> -> stream the job log; onEnd(name) after.
function sysAction(action, onEnd) {
	const name = $('#sys-name').value.trim();
	if (!name) { alert('이름을 입력하세요'); return; }
	if (sysJob) return;
	const log = $('#sys-log'); log.hidden = false; log.textContent = action + ' 시작…';
	fetch(`/api/systems/${encodeURIComponent(name)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
		.then((r) => r.json().then((j) => ({ ok: r.ok, status: r.status, j })))
		.then(({ ok, status, j }) => {
			if (!ok) { log.textContent = `${action} 거부됨: ${j.error || status}`; return; }
			if (j.job) { sysJob = j.job.id; streamJob(j.job.id, log, () => { sysJob = null; loadSystems(); if (onEnd) onEnd(name); }); }
			refreshQueue();
		})
		.catch((e) => { log.textContent = `${action} 실패: ${e.message}`; });
}

async function analyzeSystem() {
	let body; try { body = sysFormBody(); } catch { return; }
	if (!body.name || !body.target_url) { alert('이름과 대상 URL을 먼저 입력하세요'); return; }
	const r = await fetch('/api/systems', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
	if (!r.ok) { const j = await r.json().catch(() => ({})); alert('먼저 저장 실패: ' + (j.error || r.status)); return; }
	sysAction('analyze', async (name) => {
		try {
			const { proposed } = await getJson(`/api/systems/${encodeURIComponent(name)}/proposed`);
			if (proposed && proposed.recipe) { $('#sys-recipe').value = JSON.stringify(proposed.recipe, null, 2); $('#sys-log').textContent += `\n✓ 제안된 레시피를 채웠습니다 (${proposed.proposedBy}). 검토 후 [저장] → [동기화].`; }
			else $('#sys-log').textContent += '\n⚠ 레시피 제안 실패: ' + ((proposed && proposed.error) || '표를 찾지 못함');
		} catch (e) { $('#sys-log').textContent += '\n제안 로드 실패: ' + e.message; }
	});
}

async function loadRecords() {
	const box = $('#sys-records');
	if (!selectedSystem) { box.replaceChildren(el('div', { class: 'placeholder' }, '위에서 시스템을 선택하세요.')); return; }
	const q = $('#sys-q').value.trim();
	try {
		const { records } = await getJson(`/api/systems/${encodeURIComponent(selectedSystem)}/records` + (q ? `?q=${encodeURIComponent(q)}` : ''));
		box.replaceChildren(el('div', { class: 'hint' }, `${selectedSystem}: ${records.length}건`));
		for (const rec of records) {
			const fields = Object.entries(rec.data || {}).map(([k, v]) => `${k}: ${v}`).join('  ·  ');
			const card = el('div', { class: 'approval' }, el('div', { class: 'approval-head' }, el('span', { class: 'badge sm run' }, statusKo(rec.status)), el('span', { class: 'approval-title' }, rec.key)), el('div', { class: 'approval-meta' }, fields));
			if (rec.summary) card.append(el('div', { class: 'approval-summary' }, rec.summary));
			box.append(card);
		}
	} catch (e) { box.replaceChildren(el('div', { class: 'error' }, e.message)); }
}

async function deleteSelectedSystem() {
	const name = $('#sys-name').value.trim();
	if (!name) return;
	if (!confirm(`'${name}' 시스템과 그 레코드를 모두 삭제할까요?`)) return;
	await fetch(`/api/systems/${encodeURIComponent(name)}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
	selectedSystem = null; $('#sys-recipe').value = ''; loadSystems(); loadRecords();
}

// ---------- view switching ----------

const NAV = { runs: '#nav-runs', approvals: '#nav-approvals', systems: '#nav-systems', flows: '#nav-flows', trends: '#nav-trends', auth: '#nav-auth', jobs: '#nav-jobs' };

function loadView(view) {
	if (view === 'flows') loadFlows();
	else if (view === 'trends') loadTrends();
	else if (view === 'auth') loadAuth();
	else if (view === 'approvals') loadApprovals();
	else if (view === 'systems') loadSystems();
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
$('#sys-save').addEventListener('click', saveSystemForm);
$('#sys-auth').addEventListener('click', () => sysAction('auth'));
$('#sys-analyze').addEventListener('click', analyzeSystem);
$('#sys-sync').addEventListener('click', () => sysAction('sync', () => loadRecords()));
$('#sys-delete').addEventListener('click', deleteSelectedSystem);
$('#sys-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadRecords(); });
$('#sync-btn').addEventListener('click', startSync);
$('#agent-run').addEventListener('click', runAgent);
$('#agent-cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') runAgent(); });
$('#sync-cancel').addEventListener('click', () => syncJob && cancelJob(syncJob));
$('#auth-cancel').addEventListener('click', () => authJob && cancelJob(authJob));
$('#refresh').addEventListener('click', () => loadView(document.body.dataset.view));

// ---------- init ----------

loadRuns();
refreshQueue();
setInterval(refreshQueue, 2000);
initFlows();
