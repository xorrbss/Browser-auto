// webui/public/app.js — entry module. Runs view (dashboard + run trigger) + view switching +
// global queue status. Flows view lives in flows.js. Shared helpers in util.js.

import { $, el, getJson, fmtMs, fmtTime, statusKo, streamJob, cancelJob } from './util.js';
import { initFlows, loadFlows, reconcileFlowJob } from './flows.js';
import { initSystems, loadSystems, reconcileSysJob, renderRecordCard } from './systems-view.js';

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
		reconcileSysJob(activeIds);
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

// one approval card. `selectable` adds a결재-선택 checkbox (the 결재 list passes true; NL results don't).
function renderApprovalCard(a, selectable = false) {
	const head = el('div', { class: 'approval-head' });
	if (selectable && a.status !== 'approved') head.append(el('input', { type: 'checkbox', class: 'rev-chk', title: '결재 선택', dataset: { doc: a.doc_id }, onchange: updateRevCount }));
	head.append(
		el('span', { class: 'badge sm ' + (a.status === 'approved' ? 'pass' : 'run') }, statusKo(a.status)),
		el('span', { class: 'approval-title' }, a.title || '(제목 없음)'),
		el('span', { class: 'approval-id' }, a.doc_id),
	);
	const card = el('div', { class: 'approval' }, head,
		el('div', { class: 'approval-meta' }, [a.drafter, a.dept, a.submitted_at, a.amount ? a.amount + '원' : null].filter(Boolean).join(' • ')),
	);
	if (a.summary) card.append(el('div', { class: 'approval-summary' }, a.summary));
	else if (a.raw_text) card.append(el('div', { class: 'approval-raw' }, a.raw_text));
	else if (selectable) card.append(el('div', { class: 'approval-raw hint' }, '요약 없음 — 제목·메타만 확인 후 체크하세요(요약하려면 동기화 후 NL "요약").'));
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
	// review = the composite "prepare to approve" intent: (optionally) summarize, THEN surface the 결재
	// checkbox review so the user checks + clicks 선택 항목 결재. The model only classified — it never approves.
	if (intent.action === 'review') {
		out.append(el('div', { class: 'note' }, '검토-결재 준비 — 아래 목록에서 결재할 항목을 체크하고 [✅ 선택 항목 결재]를 누르세요(사람이 직접 선택).'));
		const after = () => { loadApprovals(); const rb = document.querySelector('.review-bar'); if (rb) rb.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
		if (data.job) { const log = el('pre', { class: 'joblog' }); out.append(log); streamJob(data.job.id, log, after); }
		else after();
		return;
	}
	if (intent.action === 'query' || intent.action === 'approve') {
		if (data.note) out.append(el('div', { class: 'note' }, data.note));
		const rows = data.approvals || [];
		out.append(el('div', { class: 'hint' }, `결재: ${rows.length}건`));
		for (const a of rows) out.append(renderApprovalCard(a));
		// generic registered-system matches (the RPA registry — reaches "any system", not just 결재)
		for (const sys of (data.systems || [])) {
			out.append(el('div', { class: 'hint' }, `${sys.label}: ${sys.records.length}건`));
			for (const rec of sys.records) out.append(renderRecordCard(rec));
		}
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
		for (const a of approvals) box.append(renderApprovalCard(a, true));
		updateRevCount(); // fresh cards → reset the selected-count + 전체선택 state
	} catch (e) {
		box.replaceChildren(el('div', { class: 'error' }, `결재 목록을 불러오지 못했습니다: ${e.message}`));
	}
}

// ---------- ✅ 검토 후 일괄 결재 (human-reviewed batch: check cards → approve all checked at once) ----------
// The operator reads each summary and CHECKS the items to approve → the human is the content/amount control
// (총 금액/총 합 계 labels are drafter-typed → unreliable). reviewed:true tells the leaf to relax the
// full-auto-only form-homogeneity guard; identity/title/승인-radio/완료검증/audit still apply per item.
let reviewJob = null;
const revChecks = () => [...document.querySelectorAll('#approvals-list .rev-chk')];
function updateRevCount() {
	const boxes = revChecks();
	const n = boxes.filter((c) => c.checked).length;
	const btn = $('#rev-approve'); if (btn) btn.textContent = `✅ 선택 항목 결재 (${n})`;
	const all = $('#rev-all'); if (all) all.checked = boxes.length > 0 && boxes.every((c) => c.checked);
}
async function runReviewApprove() {
	const checked = revChecks().filter((c) => c.checked).map((c) => c.dataset.doc).filter(Boolean);
	const dryRun = $('#rev-dry').checked;
	const status = $('#rev-status'), results = $('#rev-results'), log = $('#rev-log');
	results.replaceChildren();
	if (!checked.length) { status.replaceChildren(el('div', { class: 'error' }, '결재할 항목을 먼저 체크하세요.')); return; }
	if (!dryRun && !window.confirm(`⚠ 체크한 ${checked.length}건을 실제로 자동 결재합니다(되돌릴 수 없음). 요약·내용을 확인하셨나요? 진행할까요?`)) return;
	status.replaceChildren(el('div', { class: 'hint' }, (dryRun ? '미리보기(dry-run)' : '결재') + ` 실행 중… (${checked.length}건)`));
	log.hidden = false;
	let resp;
	try {
		const r = await fetch('/api/approve/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app: 'hiworks', docs: checked, dryRun, reviewed: true }) });
		resp = await r.json();
	} catch (e) { status.replaceChildren(el('div', { class: 'error' }, '요청 실패: ' + e.message)); return; }
	if (!resp.job) { status.replaceChildren(el('div', { class: 'error' }, resp.error || '실행이 거부되었습니다.')); return; }
	reviewJob = resp.job.id;
	$('#rev-stop').hidden = dryRun; $('#rev-cancel').hidden = false;
	streamJob(resp.job.id, log, () => {
		$('#rev-stop').hidden = true; $('#rev-cancel').hidden = true; reviewJob = null;
		renderApproveResults(log.textContent, status, results);
		loadApprovals(); loadAudit(); // approved docs leave 대기; new audit rows
	});
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

// ---------- ⚡ auto-approve scenario (EFFECTFUL; the leaf approves real docs, no human click) ----------
let approveJob = null;
const APPROVE_ST = { approved: '✅ 승인', 'dry-ok': '👁 미리보기', failed: '✗ 실패', skipped: '⤼ 건너뜀' };

async function runApprove() {
	const app = ($('#approve-app').value || 'hiworks').trim();
	const docs = $('#approve-docs').value.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean);
	const dryRun = $('#approve-dry').checked;
	const max = parseInt($('#approve-max').value, 10) || 0;
	const maxAmount = parseInt($('#approve-maxamt').value, 10) || 0;
	const status = $('#approve-status'), results = $('#approve-results'), log = $('#approve-log');
	results.replaceChildren();
	if (!docs.length) { status.replaceChildren(el('div', { class: 'error' }, '문서번호를 한 줄에 하나씩 입력하세요.')); return; }
	// Live (non-dry) approve is irreversible AND human-gate-free — require an explicit count cap, a value
	// ceiling (or an explicit no-ceiling opt-out), and a confirm.
	let allowNoValueCeiling = false;
	if (!dryRun) {
		if (max < 1) { status.replaceChildren(el('div', { class: 'error' }, '실제 승인에는 최대 건수(≥1)가 필요합니다.')); return; }
		if (maxAmount < 1) {
			if (!window.confirm(`⚠⚠ 금액 상한 없이 자동 승인합니다 — 금액에 관계없이(고액 포함) 승인됩니다. 정말 진행하시겠습니까? (권장: 건당 최대 금액을 설정하세요)`)) return;
			allowNoValueCeiling = true;
		}
		if (!window.confirm(`⚠ 실제 ${docs.length}건을 사람 확인 없이 자동 승인합니다(최대 ${max}건${maxAmount ? `, 건당 ≤${maxAmount}원` : ', 금액 상한 없음'}). 되돌릴 수 없습니다. 진행할까요?`)) return;
	}
	status.replaceChildren(el('div', { class: 'hint' }, (dryRun ? '미리보기(dry-run)' : '자동 승인') + ' 실행 중…'));
	log.hidden = false;
	let resp;
	try {
		const r = await fetch('/api/approve/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app, docs, dryRun, max, maxAmount, allowNoValueCeiling }) });
		resp = await r.json();
	} catch (e) { status.replaceChildren(el('div', { class: 'error' }, '요청 실패: ' + e.message)); return; }
	if (!resp.job) { status.replaceChildren(el('div', { class: 'error' }, resp.error || '실행이 거부되었습니다.')); return; }
	approveJob = resp.job.id;
	$('#approve-cancel').hidden = false;
	$('#approve-stop').hidden = dryRun; // graceful kill-switch is meaningful only for a live batch
	streamJob(resp.job.id, log, () => {
		$('#approve-cancel').hidden = true;
		$('#approve-stop').hidden = true;
		approveJob = null;
		renderApproveResults(log.textContent, status, results);
		loadApprovals(); // approved docs left the 대기 inbox
		loadAudit();     // surface the new audit rows the run just appended
	});
}

function renderApproveResults(logText, status, results) {
	let summary = null;
	for (const line of logText.split('\n')) {
		const t = line.trim();
		if (t.startsWith('{') && t.includes('"results"')) { try { summary = JSON.parse(t); } catch { /* keep scanning */ } }
	}
	if (!summary || !Array.isArray(summary.results)) { status.replaceChildren(el('div', { class: 'error' }, '결과 요약을 파싱하지 못했습니다 — 아래 로그를 확인하세요.')); return; }
	const c = (s) => summary.results.filter((r) => r.status === s).length;
	status.replaceChildren(el('div', { class: 'hint' }, `${summary.dry ? '미리보기' : '자동 승인'} 완료 — ✅승인 ${c('approved')} · 👁미리보기 ${c('dry-ok')} · ✗실패 ${c('failed')} · ⤼건너뜀 ${c('skipped')} / 총 ${summary.total}`));
	const tbl = el('table', { class: 'approve-tbl' }, el('tr', {}, el('th', {}, '문서번호'), el('th', {}, '상태'), el('th', {}, '사유')));
	for (const r of summary.results) tbl.append(el('tr', { class: 'st-' + r.status }, el('td', {}, r.doc_id), el('td', {}, APPROVE_ST[r.status] || r.status), el('td', {}, r.reason || '')));
	results.replaceChildren(tbl);
}

// ---------- 🧾 approve audit viewer (read-only; data/approve-audit.jsonl is the source of truth) ----------
const AUDIT_ST = { requested: '요청', identity_ok: '신원확인', amount_ok: '금액확인', dry_ok: '👁 미리보기OK', clicked: '⚠ 클릭', confirmed: '✅ 승인', failed: '✗ 실패', skipped: '⤼ 건너뜀', 'reconciled-approved': '🔁 재조정:승인', 'reconciled-failed': '🔁 재조정:실패', 'reconcile-uncertain': '🔁 재조정:불확실', 'reconcile-error': '🔁 재조정:오류' };

async function loadAudit() {
	const box = $('#audit-list');
	box.replaceChildren(el('div', { class: 'hint' }, '감사 로그 로딩 중…'));
	try {
		const { audit, total } = await getJson('/api/approve/audit?limit=300');
		if (!audit.length) { box.replaceChildren(el('div', { class: 'hint' }, '감사 로그가 비어 있습니다 (아직 자동 승인 실행 없음).')); return; }
		const tbl = el('table', { class: 'approve-tbl' }, el('tr', {}, el('th', {}, '시각'), el('th', {}, '문서번호'), el('th', {}, '단계'), el('th', {}, '모드'), el('th', {}, '상세')));
		for (const a of audit) tbl.append(el('tr', { class: 'st-' + (a.stage || '') }, el('td', {}, fmtTime(a.at)), el('td', {}, a.doc_id || ''), el('td', {}, AUDIT_ST[a.stage] || a.stage || ''), el('td', {}, a.live === true ? 'LIVE' : 'dry'), el('td', {}, a.detail || '')));
		box.replaceChildren(el('div', { class: 'hint' }, `총 ${total}건 (최근 ${audit.length} 표시)`), tbl);
	} catch (e) { box.replaceChildren(el('div', { class: 'error' }, '감사 로그 로드 실패: ' + e.message)); }
}

// ---------- view switching ----------

const NAV = { runs: '#nav-runs', approvals: '#nav-approvals', systems: '#nav-systems', flows: '#nav-flows', trends: '#nav-trends', auth: '#nav-auth', jobs: '#nav-jobs' };

function loadView(view) {
	if (view === 'flows') loadFlows();
	else if (view === 'trends') loadTrends();
	else if (view === 'auth') loadAuth();
	else if (view === 'approvals') { loadApprovals(); loadAudit(); }
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
$('#sync-btn').addEventListener('click', startSync);
$('#agent-run').addEventListener('click', runAgent);
$('#agent-cmd').addEventListener('keydown', (e) => { if (e.key === 'Enter') runAgent(); });
$('#approve-run').addEventListener('click', runApprove);
$('#audit-refresh').addEventListener('click', loadAudit);
// ✅ 검토 후 일괄 결재 controls
$('#rev-approve').addEventListener('click', runReviewApprove);
$('#rev-all').addEventListener('change', () => { const c = $('#rev-all').checked; revChecks().forEach((b) => (b.checked = c)); updateRevCount(); });
$('#rev-stop').addEventListener('click', async () => { try { await fetch('/api/approve/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); $('#rev-status').replaceChildren(el('div', { class: 'hint' }, '🛑 중지 요청됨 — 현재 문서까지 끝내고 멈춥니다…')); } catch (e) { $('#rev-status').replaceChildren(el('div', { class: 'error' }, '중지 요청 실패: ' + e.message)); } });
$('#rev-cancel').addEventListener('click', () => reviewJob && cancelJob(reviewJob));
// graceful kill-switch: stops the batch BEFORE the next doc (vs the hard tree-kill of 강제중지, which can
// interrupt mid-approve). For an irreversible-money batch, prefer this.
$('#approve-stop').addEventListener('click', async () => {
	try { await fetch('/api/approve/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); $('#approve-status').replaceChildren(el('div', { class: 'hint' }, '🛑 중지 요청됨 — 현재 문서까지 끝내고 멈춥니다…')); }
	catch (e) { $('#approve-status').replaceChildren(el('div', { class: 'error' }, '중지 요청 실패: ' + e.message)); }
});
$('#approve-cancel').addEventListener('click', () => approveJob && cancelJob(approveJob));
$('#sync-cancel').addEventListener('click', () => syncJob && cancelJob(syncJob));
$('#auth-cancel').addEventListener('click', () => authJob && cancelJob(authJob));
$('#refresh').addEventListener('click', () => loadView(document.body.dataset.view));

// ---------- init ----------

loadRuns();
refreshQueue();
setInterval(refreshQueue, 2000);
initFlows();
initSystems();
