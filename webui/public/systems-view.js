// webui/public/systems-view.js — the 시스템 (generic RPA registry) view: register any data-collection
// system, authenticate, analyze its structure into a recipe, sync it, and search its records. Mirrors
// flows.js (own module state + shared helpers from util.js; exports loadSystems / reconcileSysJob /
// initSystems / renderRecordCard). The queue panel self-refreshes on app.js's 2s poll.

import { $, el, getJson, streamJob, statusKo } from './util.js';

let selectedSystem = null;
let sysJob = null; // id of the in-flight auth/analyze/sync job (single-slot queue)
let sysCache = [];

// renderRecordCard(rec): a generic RPA record ({key, data:{...}, summary?}) — shared by the NL output
// (app.js) and this view's 조회 list.
export function renderRecordCard(rec) {
	const fields = Object.entries(rec.data || {}).map(([k, v]) => `${k}: ${v}`).join('  ·  ');
	const card = el('div', { class: 'approval' },
		el('div', { class: 'approval-head' }, el('span', { class: 'badge sm run' }, statusKo(rec.status)), el('span', { class: 'approval-title' }, rec.key)),
		el('div', { class: 'approval-meta' }, fields));
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
			if (j.job) { sysJob = j.job.id; streamJob(j.job.id, log, () => { sysJob = null; loadSystems(); if (onEnd) onEnd(name); }); }
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
		for (const rec of records) box.append(renderRecordCard(rec));
	} catch (e) { box.replaceChildren(el('div', { class: 'error' }, e.message)); }
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
}

export function initSystems() {
	$('#sys-save').addEventListener('click', saveSystemForm);
	$('#sys-auth').addEventListener('click', () => sysAction('auth'));
	$('#sys-analyze').addEventListener('click', analyzeSystem);
	$('#sys-sync').addEventListener('click', () => sysAction('sync', () => loadRecords()));
	$('#sys-delete').addEventListener('click', deleteSelectedSystem);
	$('#sys-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadRecords(); });
}
