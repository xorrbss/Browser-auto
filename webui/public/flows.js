// webui/public/flows.js — Flows view: recorder control + flow editor (candidate picker,
// {{input_N}} values, gated compile, verify). Imports shared helpers from util.js.

import { $, el, getJson, streamJob, cancelJob } from './util.js';

let selectedFlow = null;
let activeFlowJob = null; // id of the in-flight record/verify job (single-slot queue)

function stepSummary(s) {
	if (s.kind === 'wait') return `wait ${s.until || ''}="${s.value || ''}"`;
	if (s.kind === 'press') return `press ${s.value || ''}`;
	if (s.kind === 'find') {
		const loc = s.needs_review ? '⟨needs review⟩' : `${s.by || '?'}="${s.value || ''}"${s.name ? ` name="${s.name}"` : ''}`;
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
			list.append(el('div', { class: 'hint' }, 'No flows yet. Record one above.'));
			return;
		}
		for (const f of flows) {
			const ok = f.needsReview === 0;
			list.append(
				el(
					'button',
					{ class: 'run-row' + (f.name === selectedFlow ? ' active' : ''), type: 'button', dataset: { flow: f.name }, onclick: () => openFlow(f.name) },
					el('span', { class: 'badge ' + (ok ? 'pass' : 'run') }, ok ? 'OK' : `${f.needsReview}⚠`),
					el(
						'span',
						{ class: 'run-meta' },
						el('span', { class: 'run-id' }, f.name),
						el('span', { class: 'run-sub' }, `${f.steps} steps${f.inputTokens.length ? ` • ${f.inputTokens.length} input` : ''}${f.compiled ? ' • compiled' : ''}`),
					),
				),
			);
		}
	} catch (e) {
		list.replaceChildren(el('div', { class: 'error' }, `Failed to load flows: ${e.message}`));
	}
}

// ---- flow editor ----

async function openFlow(name) {
	const switching = name !== selectedFlow;
	selectedFlow = name;
	for (const b of document.querySelectorAll('#flows-list .run-row')) b.classList.toggle('active', b.dataset.flow === name);
	if (switching) resetFlowOutputs(); // clear another flow's stale log/output (but keep a just-finished verify log on same-flow reload)
	const ed = $('#flow-editor');
	ed.replaceChildren(el('div', { class: 'placeholder' }, 'Loading…'));
	try {
		renderEditor(await getJson(`/api/flows/${encodeURIComponent(name)}`));
	} catch (e) {
		ed.replaceChildren(el('div', { class: 'error' }, `Failed to load flow: ${e.message}`));
	}
}

function renderEditor(flow) {
	const ed = $('#flow-editor');
	const ok = flow.needsReviewSteps.length === 0;

	const head = el(
		'div',
		{ class: 'detail-head' },
		el('span', { class: 'badge ' + (ok ? 'pass' : 'run') }, ok ? 'RESOLVED' : `${flow.needsReviewSteps.length}⚠`),
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
			form.append(el('label', { class: 'val-row' }, el('span', {}, t), el('input', { id: `val-${t}`, value: flow.values[t] || '', placeholder: 'value', autocomplete: 'off' })));
		});
		const saveBtn = el('button', { type: 'button', class: 'btn', onclick: () => saveValues(flow.name, flow.inputTokens) }, 'Save values');
		valuesBox = el('div', { class: 'values-box' }, el('h3', {}, 'Input values'), form, saveBtn);
	}

	// Actions: verify (browser job) + gated compile
	const compileBtn = el('button', { type: 'button', class: 'btn primary', onclick: () => compile(flow.name) }, '⚙ Compile → test');
	if (!flow.compilable) {
		compileBtn.disabled = true;
		compileBtn.title = flow.needsReviewSteps.length ? 'resolve all needs_review steps first' : `fill all input values first (missing: ${flow.missingValues.join(', ')})`;
	}
	const actions = el(
		'div',
		{ class: 'actions' },
		el('button', { type: 'button', class: 'btn', onclick: () => verify(flow.name) }, '↻ Verify (re-drive)'),
		compileBtn,
		flow.compiled ? el('span', { class: 'detail-sub' }, `tests/${flow.name}.test.sh exists`) : null,
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
			alert(`Resolve failed: ${data.error || r.status}`);
		}
	} catch (e) {
		alert(`Resolve failed: ${e.message}`);
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
		else alert(`Save failed: ${data.error || r.status}`);
	} catch (e) {
		alert(`Save failed: ${e.message}`);
	}
}

async function verify(name) {
	const log = $('#flow-log');
	log.hidden = false;
	try {
		const r = await fetch('/api/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
		if (!r.ok) {
			const e = await r.json().catch(() => ({}));
			log.textContent = `verify rejected: ${e.error || r.status}`;
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
		log.textContent = `verify failed: ${e.message}`;
	}
}

async function compile(name) {
	const out = $('#compile-out');
	out.hidden = false;
	out.textContent = 'compiling…';
	try {
		const r = await fetch('/api/compile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
		const data = await r.json();
		out.textContent = (data.ok ? `✓ compiled → ${data.testFile}\n\n` : `✗ compile failed (exit ${data.code})\n\n`) + (data.output || data.error || '');
		if (data.ok) loadFlows();
	} catch (e) {
		out.textContent = `compile failed: ${e.message}`;
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
	log.textContent = 'starting recorder…';
	fetch('/api/record', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ name, startUrl, app: app || undefined, seconds }),
	})
		.then((r) => r.json().then((d) => ({ ok: r.ok, d })))
		.then(({ ok, d }) => {
			if (!ok) {
				log.textContent = `record rejected: ${d.error || 'error'}` + (d.exists ? ' (a flow with this name exists — re-recording overwrites it)' : '');
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
			log.textContent = `record failed: ${e.message}`;
		});
}

export function initFlows() {
	$('#rec-btn').addEventListener('click', startRecord);
	$('#rec-cancel').addEventListener('click', () => activeFlowJob && cancelJob(activeFlowJob));
	$('#flow-cancel').addEventListener('click', () => activeFlowJob && cancelJob(activeFlowJob));
	loadFlows();
}
