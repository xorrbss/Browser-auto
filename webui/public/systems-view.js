// webui/public/systems-view.js — the 시스템 (generic RPA registry) view: register any data-collection
// system, authenticate, analyze its structure into a recipe, sync it, and search its records. Mirrors
// flows.js (own module state + shared helpers from util.js; exports loadSystems / reconcileSysJob /
// initSystems / renderRecordCard). The queue panel self-refreshes on app.js's 2s poll.

import { $, el, getJson, streamJob, statusKo, cancelJob } from './util.js';

let selectedSystem = null;
let sysJob = null; // id of the in-flight auth/analyze/sync job (single-slot queue)
let sysCache = [];

// renderRecordCard(rec): a generic RPA record ({key, data:{...}, summary?}) — shared by the NL output
// (app.js) and this view's 조회 list.
export function renderRecordCard(rec, selectable = false) {
	const fields = Object.entries(rec.data || {}).map(([k, v]) => `${k}: ${v}`).join('  ·  ');
	const head = el('div', { class: 'approval-head' });
	if (selectable && rec.status !== 'approved') head.append(el('input', { type: 'checkbox', class: 'sys-rev-chk', title: '결재 선택', dataset: { key: rec.key }, onchange: updateSysRevCount }));
	head.append(el('span', { class: 'badge sm run' }, statusKo(rec.status)), el('span', { class: 'approval-title' }, rec.key));
	const card = el('div', { class: 'approval' }, head, el('div', { class: 'approval-meta' }, fields));
	if (rec.summary) card.append(el('div', { class: 'approval-summary' }, rec.summary));
	return card;
}

export async function loadSystems() {
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
			if (j.job) {
				sysJob = j.job.id;
				streamJob(j.job.id, log, (done) => {
					sysJob = null; loadSystems();
					// Clear failure banner on a non-zero job (was: silently leave the raw log) so the operator
					// sees WHY the analyze/sync failed (auth expired, no table found, ...).
					if (done && done.status !== 'done') { log.textContent += `\n\n✗ ${action} 실패 (${statusKo(done.status)}${done.exitCode != null ? `, 종료 ${done.exitCode}` : ''}) — 위 로그에서 원인을 확인하세요. 인증 만료면 다시 인증하고 재시도하세요.`; return; }
					if (onEnd) onEnd(name);
				});
			}
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
	if (!selectedSystem) { box.replaceChildren(el('div', { class: 'placeholder' }, '위에서 시스템을 선택하세요.')); $('#sys-review-bar').hidden = true; return; }
	const q = $('#sys-q').value.trim();
	try {
		const { records } = await getJson(`/api/systems/${encodeURIComponent(selectedSystem)}/records` + (q ? `?q=${encodeURIComponent(q)}` : ''));
		box.replaceChildren(el('div', { class: 'hint' }, `${selectedSystem}: ${records.length}건`));
		for (const rec of records) box.append(renderRecordCard(rec, true));
		updateSysRevCount();
		loadSysApproveState(selectedSystem); // is this system approvable? (fail-closed surface)
	} catch (e) { box.replaceChildren(el('div', { class: 'error' }, e.message)); }
}

// ---------- ✅ 검토 후 결재 (generic system records → the reviewed-batch approve route; fail-closed per system) ----------
let sysRevJob = null;
const SYS_APV_ST = { approved: '✅ 승인', 'dry-ok': '👁 미리보기', failed: '✗ 실패', skipped: '⤼ 건너뜀' };
const sysRevChecks = () => [...document.querySelectorAll('#sys-records .sys-rev-chk')];
function updateSysRevCount() {
	const boxes = sysRevChecks(); const n = boxes.filter((c) => c.checked).length;
	const btn = $('#sys-rev-approve'); if (btn) btn.textContent = `✅ 선택 항목 결재 (${n})`;
	const all = $('#sys-rev-all'); if (all) all.checked = boxes.length > 0 && boxes.every((c) => c.checked);
}
// is this system approvable? needs recipe.actions.approve (or legacy approve) + a Playwright login + a list URL. Fail-closed: the button
// is disabled with a clear "what's missing" note until all three exist (a NEW system needs its approve UI
// captured into recipes/<name>.json + a login — the operator-accompanied per-system gate).
async function loadSysApproveState(name) {
	const bar = $('#sys-review-bar'), note = $('#sys-rev-note'), btn = $('#sys-rev-approve');
	bar.hidden = false;
	try {
		const s = await getJson(`/api/approve/state?app=${encodeURIComponent(name)}`);
		const ready = !!(s.hasApproveRecipe && s.loggedIn && s.listUrl);
		btn.disabled = !ready;
		if (ready) note.replaceChildren(el('span', {}, '결재할 항목을 체크하고 [선택 항목 결재]를 누르세요(사람이 직접 선택). 신원·제목·완료검증 가드 적용. 먼저 미리보기로 확인하세요.'));
		else {
			const miss = [!s.hasApproveRecipe && `recipes/${name}.json 의 approve 블록(결재 UI 캡처)`, !s.loggedIn && `Playwright 로그인(approve/${name}.pw-state.json)`, !s.listUrl && '대상(목록) URL'].filter(Boolean);
			note.replaceChildren(el('span', { class: 'warn' }, '⚠ 이 시스템은 아직 결재 불가 — 필요: ' + miss.join(', ') + '.'));
		}
	} catch (e) { btn.disabled = true; note.replaceChildren(el('span', { class: 'error' }, '결재 가능 여부 확인 실패: ' + e.message)); }
}
async function runSysReviewApprove() {
	if (!selectedSystem || $('#sys-rev-approve').disabled) return;
	const checked = sysRevChecks().filter((c) => c.checked).map((c) => c.dataset.key).filter(Boolean);
	const dryRun = $('#sys-rev-dry').checked;
	const status = $('#sys-rev-status'), results = $('#sys-rev-results'), log = $('#sys-rev-log');
	results.replaceChildren();
	if (!checked.length) { status.replaceChildren(el('div', { class: 'error' }, '결재할 항목을 먼저 체크하세요.')); return; }
	if (!dryRun && !window.confirm(`⚠ '${selectedSystem}' 시스템에서 체크한 ${checked.length}건을 실제로 자동 결재합니다(되돌릴 수 없음). 내용을 확인하셨나요?`)) return;
	status.replaceChildren(el('div', { class: 'hint' }, (dryRun ? '미리보기(dry-run)' : '결재') + ` 실행 중… (${checked.length}건)`));
	log.hidden = false;
	let resp;
	try { const r = await fetch('/api/approve/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ app: selectedSystem, docs: checked, dryRun, reviewed: true }) }); resp = await r.json(); }
	catch (e) { status.replaceChildren(el('div', { class: 'error' }, '요청 실패: ' + e.message)); return; }
	if (!resp.job) { status.replaceChildren(el('div', { class: 'error' }, resp.error || '실행이 거부되었습니다.')); return; }
	sysRevJob = resp.job.id; $('#sys-rev-cancel').hidden = false;
	streamJob(resp.job.id, log, () => { $('#sys-rev-cancel').hidden = true; sysRevJob = null; renderSysApproveResults(log.textContent, status, results); loadRecords(); });
}
function renderSysApproveResults(logText, status, results) {
	let summary = null;
	for (const line of logText.split('\n')) { let t = line.trim(); if (t.startsWith('AQA_JOB_RESULT=')) t = t.slice('AQA_JOB_RESULT='.length); if (t.startsWith('{') && t.includes('"results"')) { try { summary = JSON.parse(t); } catch {} } }
	if (!summary || !Array.isArray(summary.results)) { status.replaceChildren(el('div', { class: 'error' }, '결과 요약 파싱 실패 — 로그를 확인하세요.')); return; }
	const c = (s) => summary.results.filter((r) => r.status === s).length;
	status.replaceChildren(el('div', { class: 'hint' }, `${summary.dry ? '미리보기' : '결재'} 완료 — ✅${c('approved')} · 👁${c('dry-ok')} · ✗${c('failed')} · ⤼${c('skipped')} / 총 ${summary.total}`));
	const tbl = el('table', { class: 'approve-tbl' }, el('tr', {}, el('th', {}, '키'), el('th', {}, '상태'), el('th', {}, '사유')));
	for (const r of summary.results) tbl.append(el('tr', { class: 'st-' + r.status }, el('td', {}, r.doc_id), el('td', {}, SYS_APV_ST[r.status] || r.status), el('td', {}, r.reason || '')));
	results.replaceChildren(tbl);
}

async function deleteSelectedSystem() {
	const name = $('#sys-name').value.trim();
	if (!name) return;
	if (!confirm(`'${name}' 시스템과 그 레코드를 모두 삭제할까요?`)) return;
	await fetch(`/api/systems/${encodeURIComponent(name)}/delete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
	selectedSystem = null; $('#sys-recipe').value = ''; loadSystems(); loadRecords();
}

// reconcileSysJob(activeIds): self-heal a stuck sys-job control if its SSE stream missed the terminal
// event (same role as flows.js reconcileFlowJob). Called from app.js's 2s queue poll.
export function reconcileSysJob(activeIds) {
	if (sysJob && !activeIds.has(sysJob)) { sysJob = null; loadSystems(); }
	if (sysRevJob && !activeIds.has(sysRevJob)) { sysRevJob = null; $('#sys-rev-cancel').hidden = true; loadRecords(); }
}

export function initSystems() {
	$('#sys-save').addEventListener('click', saveSystemForm);
	$('#sys-auth').addEventListener('click', () => sysAction('auth'));
	$('#sys-analyze').addEventListener('click', analyzeSystem);
	$('#sys-sync').addEventListener('click', () => sysAction('sync', () => loadRecords()));
	$('#sys-enrich').addEventListener('click', () => sysAction('enrich', () => loadRecords()));
	$('#sys-delete').addEventListener('click', deleteSelectedSystem);
	$('#sys-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadRecords(); });
	$('#sys-rev-approve').addEventListener('click', runSysReviewApprove);
	$('#sys-rev-all').addEventListener('change', () => { const c = $('#sys-rev-all').checked; sysRevChecks().forEach((b) => (b.checked = c)); updateSysRevCount(); });
	$('#sys-rev-cancel').addEventListener('click', () => sysRevJob && cancelJob(sysRevJob));
}
