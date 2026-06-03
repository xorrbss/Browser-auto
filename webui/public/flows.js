// webui/public/flows.js — Flows view: recorder control + flow editor (candidate picker,
// {{input_N}} values, gated compile, verify). Imports shared helpers from util.js.

import { $, el, getJson, streamJob, cancelJob } from './util.js';

let selectedFlow = null;
let activeFlowJob = null; // id of the in-flight record/verify job (single-slot queue)

function stepSummary(s) {
	if (s.kind === 'wait') return `wait ${s.until || ''}="${s.value || ''}"`;
	if (s.kind === 'press') return `press ${s.value || ''}`;
	if (s.kind === 'find') {
		const loc = s.needs_review ? '⟨검토 필요⟩' : `${s.by || '?'}="${s.value || ''}"${s.name ? ` name="${s.name}"` : ''}`;
		const arg = s.text != null ? ` "${s.text}"` : s.val != null ? ` =${s.val}` : '';
		return `find ${loc} → ${s.action || ''}${arg}`;
	}
	return s.kind || JSON.stringify(s);
}

// #flow-log / #compile-out / #flow-jobbar live OUTSIDE #flow-editor so a renderEditor() during
// a streaming verify never detaches the live log. Reset them only when switching flows.
function resetFlowOutputs() {
	const log = $('#flow-log');
	log.hidden = true;
	log.textContent = '';
	const out = $('#compile-out');
	out.hidden = true;
	out.textContent = '';
	$('#flow-jobbar').hidden = true;
}

// ---- flows list ----

export async function loadFlows() {
	const list = $('#flows-list');
	try {
		const { flows } = await getJson('/api/flows');
		list.replaceChildren();
		if (!flows.length) {
			list.append(el('div', { class: 'hint' }, '아직 플로우가 없습니다. 위에서 녹화하세요.'));
			return;
		}
		for (const f of flows) {
			const ok = f.needsReview === 0;
			list.append(
				el(
					'button',
					{ class: 'run-row' + (f.name === selectedFlow ? ' active' : ''), type: 'button', dataset: { flow: f.name }, onclick: () => openFlow(f.name) },
					el('span', { class: 'badge ' + (ok ? 'pass' : 'run') }, ok ? '정상' : `${f.needsReview}⚠`),
					el(
						'span',
						{ class: 'run-meta' },
						el('span', { class: 'run-id' }, f.name),
						el('span', { class: 'run-sub' }, `${f.steps}단계${f.inputTokens.length ? ` • 입력 ${f.inputTokens.length}` : ''}${f.compiled ? ' • 컴파일됨' : ''}`),
					),
				),
			);
		}
	} catch (e) {
		list.replaceChildren(el('div', { class: 'error' }, `플로우 목록을 불러오지 못했습니다: ${e.message}`));
	}
}

// ---- flow editor ----

async function openFlow(name) {
	const switching = name !== selectedFlow;
	selectedFlow = name;
	for (const b of document.querySelectorAll('#flows-list .run-row')) b.classList.toggle('active', b.dataset.flow === name);
	if (switching) resetFlowOutputs(); // clear another flow's stale log/output (but keep a just-finished verify log on same-flow reload)
	const ed = $('#flow-editor');
	ed.replaceChildren(el('div', { class: 'placeholder' }, '로딩 중…'));
	try {
		renderEditor(await getJson(`/api/flows/${encodeURIComponent(name)}`));
	} catch (e) {
		ed.replaceChildren(el('div', { class: 'error' }, `플로우를 불러오지 못했습니다: ${e.message}`));
	}
}

function renderEditor(flow) {
	const ed = $('#flow-editor');
	const ok = flow.needsReviewSteps.length === 0;

	const head = el(
		'div',
		{ class: 'detail-head' },
		el('span', { class: 'badge ' + (ok ? 'pass' : 'run') }, ok ? '해결됨' : `${flow.needsReviewSteps.length}⚠`),
		el('h2', {}, flow.name),
		el('span', { class: 'detail-sub' }, flow.startUrl + (flow.app ? ` • app:${flow.app}` : '')),
	);

	// Steps
	const steps = el('div', { class: 'steps' });
	flow.steps.forEach((s, i) => {
		const row = el('div', { class: 'step' + (s.needs_review ? ' needs-review' : '') }, el('span', { class: 'step-i' }, `#${i}`), el('span', { class: 'step-txt' }, stepSummary(s)));
		if (s.needs_review && Array.isArray(s.candidates)) {
			const picker = el('div', { class: 'candidates' });
			s.candidates.forEach((c, ci) => {
				const id = `cand-${i}-${ci}`;
				picker.append(
					el(
						'label',
						{ class: 'cand', for: id },
						el('input', { type: 'radio', id, name: `step-${i}`, onchange: () => resolve(flow.name, i, ci) }),
						el('span', {}, `${c.by}="${c.value}"${c.name ? ` name="${c.name}"` : ''}  (count ${c.count})`),
					),
				);
			});
			row.append(picker);
		}
		steps.append(row);
	});

	// {{input_N}} values
	let valuesBox = null;
	if (flow.inputTokens.length) {
		const form = el('div', { class: 'values' });
		flow.inputTokens.forEach((t) => {
			form.append(el('label', { class: 'val-row' }, el('span', {}, t), el('input', { id: `val-${t}`, value: flow.values[t] || '', placeholder: '값', autocomplete: 'off' })));
		});
		const saveBtn = el('button', { type: 'button', class: 'btn', onclick: () => saveValues(flow.name, flow.inputTokens) }, '값 저장');
		valuesBox = el('div', { class: 'values-box' }, el('h3', {}, '입력 값'), form, saveBtn);
	}

	// Actions: verify (browser job) + gated compile
	const compileBtn = el('button', { type: 'button', class: 'btn primary', onclick: () => compile(flow.name) }, '⚙ 컴파일 → 테스트');
	if (!flow.compilable) {
		compileBtn.disabled = true;
		compileBtn.title = flow.needsReviewSteps.length ? '먼저 모든 검토 필요 단계를 해결하세요' : `먼저 모든 입력 값을 채우세요 (누락: ${flow.missingValues.join(', ')})`;
	}
	const actions = el(
		'div',
		{ class: 'actions' },
		el('button', { type: 'button', class: 'btn', onclick: () => verify(flow.name) }, '↻ 검증 (재실행)'),
		compileBtn,
		flow.compiled ? el('span', { class: 'detail-sub' }, `tests/${flow.name}.test.sh 존재`) : null,
	);

	ed.replaceChildren(head, steps, valuesBox, actions);
}

async function resolve(name, step, candidate) {
	try {
		const r = await fetch(`/api/flows/${encodeURIComponent(name)}/resolve`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ step, candidate }),
		});
		const data = await r.json();
		if (data.flow) {
			renderEditor(data.flow);
			loadFlows();
		} else {
			alert(`해결 실패: ${data.error || r.status}`);
		}
	} catch (e) {
		alert(`해결 실패: ${e.message}`);
	}
}

async function saveValues(name, tokens) {
	const values = {};
	for (const t of tokens) values[t] = $(`#val-${t}`).value;
	try {
		const r = await fetch(`/api/flows/${encodeURIComponent(name)}/values`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ values }),
		});
		const data = await r.json();
		if (data.flow) renderEditor(data.flow);
		else alert(`저장 실패: ${data.error || r.status}`);
	} catch (e) {
		alert(`저장 실패: ${e.message}`);
	}
}

async function verify(name) {
	const log = $('#flow-log');
	log.hidden = false;
	try {
		const r = await fetch('/api/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
		if (!r.ok) {
			const e = await r.json().catch(() => ({}));
			log.textContent = `검증 거부됨: ${e.error || r.status}`;
			return;
		}
		const { job } = await r.json();
		activeFlowJob = job.id;
		$('#flow-jobbar').hidden = false;
		streamJob(job.id, log, () => {
			activeFlowJob = null;
			$('#flow-jobbar').hidden = true;
			openFlow(name); // re-drive may repair/promote steps -> reload (same-flow: keeps the log)
		});
	} catch (e) {
		log.textContent = `검증 실패: ${e.message}`;
	}
}

async function compile(name) {
	const out = $('#compile-out');
	out.hidden = false;
	out.textContent = '컴파일 중…';
	try {
		const r = await fetch('/api/compile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
		const data = await r.json();
		out.textContent = (data.ok ? `✓ 컴파일됨 → ${data.testFile}\n\n` : `✗ 컴파일 실패 (종료 ${data.code})\n\n`) + (data.output || data.error || '');
		if (data.ok) loadFlows();
	} catch (e) {
		out.textContent = `컴파일 실패: ${e.message}`;
	}
}

// ---- recorder ----

function startRecord() {
	const name = $('#rec-name').value.trim();
	const startUrl = $('#rec-url').value.trim();
	const app = $('#rec-app').value.trim();
	const seconds = parseInt($('#rec-seconds').value, 10) || 120;
	const log = $('#rec-log');
	log.hidden = false;
	log.textContent = '녹화 시작 중…';
	fetch('/api/record', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name, startUrl, app: app || undefined, seconds }),
	})
		.then((r) => r.json().then((d) => ({ ok: r.ok, d })))
		.then(({ ok, d }) => {
			if (!ok) {
				log.textContent = `녹화 거부됨: ${d.error || 'error'}` + (d.exists ? ' (같은 이름의 플로우가 있습니다 — 다시 녹화하면 덮어씁니다)' : '');
				return;
			}
			activeFlowJob = d.job.id;
			$('#rec-cancel').hidden = false;
			streamJob(d.job.id, log, (done) => {
				activeFlowJob = null;
				$('#rec-cancel').hidden = true;
				loadFlows();
				// only open the editor if the capture actually produced a flow (capture exits
				// non-zero + writes nothing on 0 events / cross-origin / new-tab).
				if (done && done.status === 'done' && done.exitCode === 0) openFlow(d.flow);
			});
		})
		.catch((e) => {
			log.textContent = `녹화 실패: ${e.message}`;
		});
}

// reconcileFlowJob(activeIds): self-heal stuck flow-job controls. The shared single SSE stream
// (util.js) may be pre-empted when another view starts a job, so this view's onEnd never fires;
// the global 2s queue poll calls this — if our tracked job is no longer running/pending, clear
// it and hide its cancel controls.
export function reconcileFlowJob(activeIds) {
	if (activeFlowJob && !activeIds.has(activeFlowJob)) {
		activeFlowJob = null;
		$('#rec-cancel').hidden = true;
		$('#flow-jobbar').hidden = true;
	}
}

export function initFlows() {
	$('#rec-btn').addEventListener('click', startRecord);
	$('#rec-cancel').addEventListener('click', () => activeFlowJob && cancelJob(activeFlowJob));
	$('#flow-cancel').addEventListener('click', () => activeFlowJob && cancelJob(activeFlowJob));
	loadFlows();
}
