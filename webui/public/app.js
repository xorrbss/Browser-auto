// webui/public/app.js -- NL RPA Control Plane shell.
// Zero-dependency browser app over the existing localhost APIs.

import { $, el, getJson, fmtTime, streamJob, cancelJob } from './util.js';

const VIEW_TITLES = {
	'command-center': 'Command Center',
	'nl-command': 'Natural Language Command',
	'command-plan': 'CommandPlan',
	'target-review': 'Target Review',
	systems: 'System Registry',
	actions: 'Action Registry',
	queue: 'Queue / Jobs',
	audit: 'Audit Log',
	'approval-state': 'Approval State',
	diagnostics: 'Diagnostics / Workspace Links',
};

const state = {
	view: 'command-center',
	approvals: [],
	systems: [],
	records: [],
	queue: null,
	audit: [],
	runs: [],
	flows: [],
	auth: [],
	actionStates: new Map(),
	actions: [],
	selectedTargets: new Set(),
	selectedSystem: '',
	plan: null,
	planEvents: [],
	dryRunPassed: false,
	dryRunSummary: null,
	activeApproveJob: null,
	activeSystemJob: null,
	activeRunJob: null,
};

const empty = (message) => el('div', { class: 'empty' }, message);
const errorBox = (message) => el('div', { class: 'notice danger' }, message);
const warnBox = (message) => el('div', { class: 'notice warning' }, message);

function badge(label, kind = 'neutral') {
	return el('span', { class: `badge ${kind}` }, label);
}

function safeText(value, fallback = '') {
	if (value == null || value === '') return fallback;
	return String(value);
}

function statusKind(value) {
	const s = String(value || '').toLowerCase();
	if (['done', 'pass', 'passed', 'ready', 'ok', 'success', 'succeeded', 'approved', 'confirmed', 'synced', 'verified', 'dry-ok', 'implemented', 'enabled'].includes(s)) return 'success';
	if (['running', 'queued', 'pending', 'planned', 'dry-running', 'dry'].includes(s)) return 'info';
	if (['needs implementation', 'needs-review', 'needs_review', 'skipped', 'stale-auth', 'awaiting-confirmation', 'disabled', 'not queued'].includes(s)) return 'warning';
	if (['failed', 'fail', 'refused', 'blocked', 'cancelled', 'guard-failed', 'unavailable'].includes(s)) return 'danger';
	return 'neutral';
}

function statusBadge(value, override) {
	const label = safeText(value, 'unknown');
	return badge(label, override || statusKind(label));
}

async function postJson(url, body) {
	const r = await fetch(url, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(body || {}),
	});
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
	return data;
}

async function refreshPlan(id = state.plan?.id) {
	if (!id) return null;
	const [{ plan }, ev] = await Promise.all([
		getJson(`/api/agent/plan/${encodeURIComponent(id)}`),
		getJson(`/api/agent/plan/${encodeURIComponent(id)}/events`).catch(() => ({ events: [] })),
	]);
	state.plan = plan;
	state.planEvents = ev.events || [];
	state.dryRunPassed = !!(plan?.dryRun && plan.dryRun.status === 'passed' && plan.dryRun.planHash === plan.hash && plan.dryRun.targetSetHash === plan.targetSetHash);
	state.dryRunSummary = plan?.dryRun?.result || null;
	updatePlanPill();
	return plan;
}

function setChildren(node, ...children) {
	node.replaceChildren(...children.filter(Boolean));
}

function selectedDocs() {
	return [...state.selectedTargets].filter(Boolean);
}

function pendingApprovals() {
	return state.approvals.filter((a) => String(a.status || '').toLowerCase() !== 'approved');
}

function setView(view) {
	state.view = view;
	document.body.dataset.view = view;
	$('.view.active')?.classList.remove('active');
	document.querySelector(`.view[data-view="${view}"]`)?.classList.add('active');
	document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.viewTarget === view));
	$('#page-title').textContent = VIEW_TITLES[view] || 'Control Plane';
	loadView(view);
}

function updatePlanPill() {
	const pill = $('#top-plan-pill');
	if (!state.plan) {
		pill.textContent = 'plan: none';
		pill.className = 'pill muted';
		return;
	}
	pill.textContent = `${state.plan.id} / ${state.plan.status}`;
	pill.className = 'pill';
}

function inferAction(text) {
	const s = String(text || '');
	if (/(approve|confirm|review|approval)/i.test(s)) return 'approve';
	if (/(sync|refresh|fetch)/i.test(s)) return 'sync';
	if (/(summarize|summary|digest|enrich)/i.test(s)) return 'enrich';
	return '';
}

async function makePlan(source) {
	const text = String(source || '').trim() || 'Review selected pending approvals';
	const body = { text, system: state.selectedSystem || 'hiworks', mode: 'reviewed' };
	const action = inferAction(text);
	if (action) body.action = action;
	try {
		const { plan, refusal } = await postJson('/api/agent/plan', body);
		state.plan = plan;
		state.planEvents = [];
		state.dryRunPassed = false;
		state.dryRunSummary = null;
		await refreshPlan(plan.id);
		if (plan?.action === 'approve') {
			state.plan.targets = selectedDocs();
			state.plan.targetCount = state.plan.targets.length;
		}
		if (refusal) addTimeline('Plan refused', `${refusal.reason}: ${refusal.detail || ''}`, 'danger');
		renderAll();
		return plan;
	} catch (e) {
		state.planError = e.message;
		renderAll();
		alert(`Plan creation refused: ${e.message}`);
		return null;
	}
}

function addTimeline(title, detail, kind = 'info') {
	if (!state.plan) return;
	state.plan.events = state.plan.events || [];
	state.plan.events.push({ at: new Date().toISOString(), title, detail, kind });
}

async function loadCoreData() {
	await Promise.allSettled([loadApprovals(), loadSystems(), loadQueue(), loadAudit()]);
	renderAll();
}

async function loadApprovals() {
	try {
		const { approvals } = await getJson('/api/approvals');
		state.approvals = Array.isArray(approvals) ? approvals : [];
		for (const doc of selectedDocs()) {
			if (!state.approvals.some((a) => a.doc_id === doc)) state.selectedTargets.delete(doc);
		}
		state.approvalsError = null;
	} catch (e) {
		state.approvalsError = e.message;
	}
}

async function loadSystems() {
	try {
		const { systems } = await getJson('/api/systems');
		state.systems = Array.isArray(systems) ? systems : [];
		if (!state.selectedSystem) {
			const preferred = state.systems.find((s) => s.name === 'hiworks') || state.systems[0];
			state.selectedSystem = preferred ? preferred.name : 'hiworks';
		}
		state.systemsError = null;
		await Promise.allSettled([loadActionStates(), loadActions()]);
	} catch (e) {
		state.systemsError = e.message;
	}
}

async function loadActions() {
	try {
		const { actions } = await getJson('/api/actions');
		state.actions = Array.isArray(actions) ? actions : [];
		state.actionsError = null;
	} catch (e) {
		state.actionsError = e.message;
	}
}

async function loadActionStates() {
	const names = new Set(['hiworks', ...state.systems.map((s) => s.name).filter(Boolean)]);
	const entries = await Promise.all([...names].map(async (name) => {
		try {
			const data = await getJson(`/api/approve/state?app=${encodeURIComponent(name)}`);
			return [name, data];
		} catch (e) {
			return [name, { app: name, error: e.message }];
		}
	}));
	state.actionStates = new Map(entries);
}

async function loadQueue() {
	try {
		state.queue = await getJson('/api/queue');
		state.queueError = null;
		renderQueueGlobal();
	} catch (e) {
		state.queueError = e.message;
	}
}

async function loadAudit() {
	try {
		const { audit, total } = await getJson('/api/approve/audit?limit=300');
		state.audit = Array.isArray(audit) ? audit : [];
		state.auditTotal = total || state.audit.length;
		state.auditError = null;
	} catch (e) {
		state.auditError = e.message;
	}
}

async function loadDiagnostics() {
	await Promise.allSettled([
		getJson('/api/runs').then((d) => { state.runs = d.runs || []; }),
		getJson('/api/flows').then((d) => { state.flows = d.flows || []; }),
		getJson('/api/auth').then((d) => { state.auth = d.apps || []; }),
	]);
	renderDiagnostics();
}

function loadView(view) {
	if (view === 'target-review') renderTargetsView();
	if (view === 'systems') renderSystems();
	if (view === 'actions') renderActions();
	if (view === 'queue') renderQueueView();
	if (view === 'audit') renderAudit();
	if (view === 'approval-state') renderApprovalState();
	if (view === 'diagnostics') loadDiagnostics();
}

function renderAll() {
	renderCommandCenter();
	renderPlan();
	renderTargetsView();
	renderSystems();
	renderActions();
	renderQueueGlobal();
	renderQueueView();
	renderAudit();
	renderApprovalState();
	renderDiagnosticsLinks();
}

function renderCommandCenter() {
	renderPlanSummary('#cc-summary', true);
	renderPlanBadges('#cc-badges');
	renderTargetsTable('#cc-targets', state.approvals, { compact: true });
	renderGates('#cc-gates');
	renderTimeline('#cc-timeline');
	renderQueueMini('#cc-queue');
	updateActionButtons();
}

function renderPlanBadges(selector) {
	const box = $(selector);
	if (!box) return;
	if (!state.plan) return setChildren(box, badge('no plan', 'neutral'));
	const risk = state.plan.riskClass === 'irreversible' ? 'risk' : 'info';
	setChildren(
		box,
		badge(state.plan.status, 'pending'),
		badge(state.plan.action, 'info'),
		badge(state.plan.riskClass, risk),
		state.dryRunPassed ? badge('dry-run passed', 'success') : badge('dry-run required', state.plan.requirements.dryRun ? 'warning' : 'neutral'),
	);
}

function renderPlanSummary(selector, includeMetrics = false) {
	const box = $(selector);
	if (!box) return;
	if (!state.plan) return setChildren(box, empty('No plan preview has been created.'));
	const metrics = includeMetrics ? el('div', { class: 'metric-grid' },
		metric('Targets', state.plan.targetCount, 'selected or resolved'),
		metric('Risk', state.plan.riskClass, state.plan.mode),
		metric('Dry-run', state.plan.requirements.dryRun ? (state.dryRunPassed ? 'passed' : 'required') : 'not required', 'gate state'),
		metric('Plan hash', state.plan.hash, 'server computed'),
	) : null;
	const kvs = el('div', { class: 'kv-grid' },
		kv('Plan ID', state.plan.id),
		kv('System', state.plan.system),
		kv('Action', state.plan.action),
		kv('Intent', state.plan.intent),
		kv('Actor', state.plan.actor),
		kv('Source text', state.plan.sourceText),
		kv('Contract', state.plan.refusal ? `refused: ${state.plan.refusal.reason}` : 'durable server CommandPlan'),
		kv('Created', fmtTime(state.plan.createdAt)),
		kv('Hash', state.plan.hash),
	);
	setChildren(box, metrics, kvs);
}

function metric(label, value, sub) {
	return el('div', { class: 'metric' }, el('span', {}, label), el('strong', {}, safeText(value, '-')), el('em', {}, sub || ''));
}

function kv(label, value) {
	const content = String(value || '').length > 34 ? el('code', {}, safeText(value, '-')) : el('strong', { title: safeText(value, '-') }, safeText(value, '-'));
	return el('div', { class: 'kv' }, el('span', {}, label), content);
}

function renderGates(selector) {
	const box = $(selector);
	if (!box) return;
	if (!state.plan) return setChildren(box, empty('Create a plan preview to inspect gates.'));
	const selected = selectedDocs().length;
	const gates = [
		['Plan preview', true, `id ${state.plan.id}`],
		['Target review', state.plan.riskClass === 'read' || selected > 0, selected ? `${selected} selected` : 'select target rows'],
		['Dry-run required', state.plan.riskClass === 'read' || state.dryRunPassed, state.plan.riskClass === 'read' ? 'read-only plan' : (state.dryRunPassed ? 'passed' : 'pending')],
		['Plan hash visible', !!state.plan.hash, state.plan.hash],
		['Human confirm', state.plan.riskClass === 'read' || state.dryRunPassed, state.plan.riskClass === 'read' ? 'not required' : 'enabled after dry-run'],
		['Audit trail', true, 'approve audit API connected'],
	];
	const list = el('ul', { class: 'gate-list' });
	for (const [name, ok, detail] of gates) {
		list.append(el('li', {}, el('span', { class: `gate-marker ${ok ? 'on' : 'warn'}` }), el('span', {}, `${name}: ${detail}`)));
	}
	setChildren(box, list);
}

function renderTimeline(selector) {
	const box = $(selector);
	if (!box) return;
	const events = (state.planEvents && state.planEvents.length)
		? state.planEvents.map((e) => ({ at: e.at, title: e.type, detail: [e.status, e.reason, e.jobId].filter(Boolean).join(' / '), kind: e.status }))
		: (state.plan && state.plan.events && state.plan.events.length)
			? state.plan.events
		: [{ at: new Date().toISOString(), title: 'Waiting for plan', detail: 'No command has been staged yet.', kind: 'neutral' }];
	setChildren(box, ...events.slice(-8).reverse().map((ev, i) =>
		el('div', { class: 'event' },
			el('div', { class: 'event-dot' }, String(events.length - i).slice(0, 2)),
			el('div', {}, el('strong', {}, ev.title), el('span', {}, `${fmtTime(ev.at)} / ${ev.detail || ''}`)),
		),
	));
}

function updateActionButtons() {
	const selected = selectedDocs().length;
	const editableStatuses = ['planned', 'dry_failed', 'dry_running', 'awaiting_confirmation'];
	const canDry = !!state.plan && state.plan.action === 'approve' && editableStatuses.includes(state.plan.status) && selected > 0 && !state.activeApproveJob;
	const canConfirm = canDry && state.dryRunPassed && state.plan.status === 'awaiting_confirmation' && !state.plan.confirmation;
	for (const id of ['#cc-dry-run', '#tr-dry-run']) {
		const btn = $(id);
		if (btn) btn.disabled = !canDry;
	}
	for (const id of ['#cc-confirm', '#tr-confirm']) {
		const btn = $(id);
		if (btn) {
			btn.disabled = !canConfirm;
			btn.textContent = `Confirm Live (${selected})`;
		}
	}
}

function approvalTitle(a) {
	return a.title || a.summary || '(no title)';
}

function renderTargetsTable(selector, rows, { compact = false } = {}) {
	const box = $(selector);
	if (!box) return;
	if (state.approvalsError) return setChildren(box, errorBox(`Approvals API error: ${state.approvalsError}`));
	if (!rows.length) return setChildren(box, empty('No approval records. Run sync before target review.'));
	const table = el('table', {},
		el('thead', {}, el('tr', {},
			el('th', { class: 'col-check' }, ''),
			el('th', { class: 'col-key' }, 'Doc key'),
			el('th', {}, 'Title / summary'),
			el('th', { class: 'col-short' }, 'Drafter'),
			el('th', { class: 'col-short' }, 'Submitted'),
			el('th', { class: 'col-status' }, 'Status'),
		)),
	);
	const body = el('tbody');
	for (const a of rows) {
		const doc = safeText(a.doc_id);
		const checked = state.selectedTargets.has(doc);
		const cb = el('input', { type: 'checkbox', class: 'check', title: 'Select target', dataset: { doc } });
		cb.checked = checked;
		cb.addEventListener('change', () => {
			if (cb.checked) state.selectedTargets.add(doc);
			else state.selectedTargets.delete(doc);
			if (state.plan && state.plan.action === 'approve') {
				state.plan.targets = selectedDocs();
				state.plan.targetCount = state.plan.targets.length;
				state.plan.targetSetHash = null;
				state.dryRunPassed = false;
			}
			renderAll();
		});
		body.append(el('tr', { class: checked ? 'row-selected' : '' },
			el('td', { class: 'col-check' }, cb),
			el('td', { class: 'col-key', title: doc }, doc || '-'),
			el('td', { class: 'cell-wrap', title: approvalTitle(a) }, approvalTitle(a)),
			el('td', { class: 'col-short', title: safeText(a.drafter) }, safeText(a.drafter, '-')),
			el('td', { class: 'col-short', title: safeText(a.submitted_at) }, safeText(a.submitted_at, '-')),
			el('td', { class: 'col-status' }, statusBadge(a.status || 'pending')),
		));
	}
	table.append(body);
	const selected = selectedDocs().length;
	const caption = compact ? el('div', { class: 'panel-body border-top' }, `${rows.length} visible / ${selected} selected`) : null;
	setChildren(box, table, caption);
}

function renderTargetsView() {
	renderTargetsTable('#target-review-table', state.approvals);
	updateActionButtons();
}

async function runDryRun() {
	const docs = selectedDocs();
	if (!docs.length) return;
	if (!state.plan) await makePlan($('#cc-command').value);
	if (!state.plan) return;
	state.activeApproveJob = true;
	state.dryRunPassed = false;
	addTimeline('Dry-run requested', `${docs.length} target(s)`);
	renderAll();
	const log = $('#job-log');
	if (log) {
		log.textContent = '';
		$('#job-log-badge').textContent = 'dry-run';
		$('#job-log-badge').className = 'badge info';
	}
	try {
		const data = await postJson(`/api/agent/plan/${encodeURIComponent(state.plan.id)}/dry-run`, { planHash: state.plan.hash, targetKeys: docs });
		if (data.job) {
			streamJob(data.job.id, log || document.createElement('pre'), async () => {
				state.activeApproveJob = null;
				await refreshPlan(state.plan.id);
				const jr = await getJson(`/api/jobs/${encodeURIComponent(data.job.id)}/result`).catch(() => null);
				state.dryRunSummary = state.plan?.dryRun?.result || jr?.result || null;
				addTimeline(state.dryRunPassed ? 'Dry-run passed' : 'Dry-run ended', state.dryRunPassed ? 'All selected targets returned dry-ok.' : 'Inspect the job log and guard results.', state.dryRunPassed ? 'success' : 'warning');
				loadQueue().finally(renderAll);
			});
			setView('queue');
		}
	} catch (e) {
		state.activeApproveJob = null;
		addTimeline('Dry-run refused', e.message, 'danger');
		renderAll();
		alert(`Dry-run refused: ${e.message}`);
	}
}

async function runLiveConfirm() {
	const docs = selectedDocs();
	if (!state.plan || !state.dryRunPassed || !docs.length) return;
	const msg = `This will request LIVE approval for ${docs.length} selected document(s).\n\nPlan: ${state.plan.id}\nHash: ${state.plan.hash}\n\nContinue?`;
	if (!window.confirm(msg)) return;
	state.activeApproveJob = true;
	addTimeline('Human confirmation accepted', `${docs.length} live target(s) / hash ${state.plan.hash}`);
	renderAll();
	const log = $('#job-log');
	if (log) {
		log.textContent = '';
		$('#job-log-badge').textContent = 'live approve';
		$('#job-log-badge').className = 'badge risk';
	}
	try {
		const data = await postJson(`/api/agent/plan/${encodeURIComponent(state.plan.id)}/confirm`, {
			planHash: state.plan.hash,
			targetSetHash: state.plan.targetSetHash,
			dryRunHash: state.plan.dryRun?.hash,
			confirm: true,
		});
		if (data.job) {
			streamJob(data.job.id, log || document.createElement('pre'), async () => {
				state.activeApproveJob = null;
				await refreshPlan(state.plan.id);
				addTimeline('Live job finished', 'Audit API will show requested/clicked/confirmed/skipped events.');
				Promise.allSettled([loadApprovals(), loadAudit(), loadQueue()]).then(renderAll);
			});
			setView('queue');
		}
	} catch (e) {
		state.activeApproveJob = null;
		addTimeline('Live confirmation refused', e.message, 'danger');
		renderAll();
		alert(`Live confirm refused: ${e.message}`);
	}
}

function selectVisibleTargets() {
	for (const a of pendingApprovals()) {
		if (a.doc_id) state.selectedTargets.add(a.doc_id);
	}
	if (state.plan && state.plan.action === 'approve') {
		state.plan.targets = selectedDocs();
		state.plan.targetCount = state.plan.targets.length;
		state.plan.targetSetHash = null;
		state.dryRunPassed = false;
	}
	renderAll();
}

function clearTargets() {
	state.selectedTargets.clear();
	if (state.plan && state.plan.action === 'approve') {
		state.plan.targets = [];
		state.plan.targetCount = 0;
		state.plan.targetSetHash = null;
		state.dryRunPassed = false;
	}
	renderAll();
}

async function runNlCommand() {
	const input = $('#nl-command-input');
	const text = input.value.trim();
	if (!text) return;
	const out = $('#nl-output');
	setChildren(out, empty('Calling /api/agent...'));
	try {
		const data = await postJson('/api/agent', { text });
		renderNlOutput(data, text);
		if (data.job) loadQueue();
	} catch (e) {
		setChildren(out, errorBox(e.message));
	}
}

function renderNlOutput(data, source) {
	const out = $('#nl-output');
	const intent = data.intent || {};
	const parts = [
		el('div', { class: 'badge-row' }, badge(`intent: ${intent.action || 'unknown'}`, statusKind(intent.action)), data.job ? badge(`job: ${data.job.id}`, 'info') : null),
		el('div', { class: 'kv-grid' },
			kv('Source', source),
			kv('Surface', data.surface || '-'),
			kv('Note', data.note || intent.question || '-'),
		),
	];
	if (data.job) {
		const log = el('pre', { class: 'joblog' });
		parts.push(log);
		streamJob(data.job.id, log, () => Promise.allSettled([loadApprovals(), loadQueue(), loadAudit()]).then(renderAll));
	}
	if (Array.isArray(data.approvals)) parts.push(renderGenericTable(data.approvals.slice(0, 50), ['doc_id', 'title', 'drafter', 'submitted_at', 'status'], 'Approval candidates'));
	if (Array.isArray(data.systems)) {
		for (const sys of data.systems) {
			parts.push(el('div', { class: 'notice neutral' }, `${sys.label || sys.system}: ${(sys.records || []).length} record(s)`));
			parts.push(renderGenericTable((sys.records || []).slice(0, 30).map((r) => ({ key: r.key, status: r.status, summary: r.summary, data: JSON.stringify(r.data || {}) })), ['key', 'status', 'summary', 'data'], 'System records'));
		}
	}
	setChildren(out, ...parts);
}

function renderPlan() {
	renderPlanBadges('#plan-badges');
	renderPlanSummary('#plan-detail');
	const contract = $('#plan-contract');
	if (contract) {
		const rows = [
			['POST /api/agent/plan', 'implemented', 'Creates a durable server-hashed CommandPlan.'],
			['GET /api/agent/plan/:id', 'implemented', 'Reloads plan state after refresh or job completion.'],
			['POST /api/agent/plan/:id/dry-run', 'implemented', 'Stores reviewed target set and queues deterministic dry-run.'],
			['POST /api/agent/plan/:id/confirm', 'implemented', 'Requires session/origin gate, dry-run pass, target hash, and human confirmation.'],
			['GET /api/agent/plan/:id/events', 'implemented', 'Durable command event timeline.'],
			['GET /api/jobs/:id/result', 'implemented', 'Structured job result; UI no longer parses approve logs.'],
		];
		setChildren(contract, renderRowsTable(rows, ['Contract', 'State', 'Operational impact']));
	}
}

function renderSystems() {
	renderSystemsTable();
	renderSystemForm();
	renderRecords();
}

function renderSystemsTable() {
	const box = $('#systems-table');
	if (!box) return;
	if (state.systemsError) return setChildren(box, errorBox(`Systems API error: ${state.systemsError}`));
	if (!state.systems.length) return setChildren(box, empty('No registered systems. Save a system to begin onboarding.'));
	const table = el('table', {},
		el('thead', {}, el('tr', {},
			el('th', { class: 'col-key' }, 'System'),
			el('th', {}, 'Target URL'),
			el('th', { class: 'col-short' }, 'Records'),
			el('th', { class: 'col-status' }, 'Recipe'),
			el('th', { class: 'col-actions' }, 'Action'),
		)),
	);
	const body = el('tbody');
	for (const s of state.systems) {
		const btn = el('button', { class: 'btn small', type: 'button' }, 'Open');
		btn.addEventListener('click', () => selectSystem(s.name));
		body.append(el('tr', { class: state.selectedSystem === s.name ? 'row-selected' : '' },
			el('td', { class: 'col-key', title: s.name }, s.label || s.name),
			el('td', { title: safeText(s.target_url) }, safeText(s.target_url, '-')),
			el('td', { class: 'col-short' }, safeText(s.recordCount, '0')),
			el('td', { class: 'col-status' }, statusBadge(s.recipe ? 'ready' : 'pending')),
			el('td', { class: 'col-actions' }, btn),
		));
	}
	table.append(body);
	setChildren(box, table);
}

function selectSystem(name) {
	state.selectedSystem = name;
	state.records = [];
	loadRecords().finally(renderSystems);
}

function selectedSystemObj() {
	return state.systems.find((s) => s.name === state.selectedSystem) || null;
}

function renderSystemForm() {
	const sys = selectedSystemObj();
	const badgeNode = $('#sys-selected-badge');
	if (!badgeNode) return;
	badgeNode.textContent = sys ? sys.name : 'new system';
	badgeNode.className = `badge ${sys ? 'info' : 'neutral'}`;
	if (!document.activeElement || !document.activeElement.closest('.systems-layout')) {
		$('#sys-name').value = sys?.name || state.selectedSystem || '';
		$('#sys-label').value = sys?.label || '';
		$('#sys-login').value = sys?.login_url || '';
		$('#sys-success').value = sys?.success_url || '';
		$('#sys-target').value = sys?.target_url || '';
		$('#sys-recipe').value = sys?.recipe ? JSON.stringify(sys.recipe, null, 2) : '';
	}
}

function systemFormBody() {
	let recipe;
	const text = $('#sys-recipe').value.trim();
	if (text) recipe = JSON.parse(text);
	return {
		name: $('#sys-name').value.trim(),
		label: $('#sys-label').value.trim() || undefined,
		login_url: $('#sys-login').value.trim() || undefined,
		success_url: $('#sys-success').value.trim() || undefined,
		target_url: $('#sys-target').value.trim() || undefined,
		recipe,
	};
}

async function saveSystem() {
	let body;
	try { body = systemFormBody(); } catch (e) { alert(`Recipe JSON is invalid: ${e.message}`); return; }
	if (!body.name) { alert('System name is required.'); return; }
	try {
		await postJson('/api/systems', body);
		state.selectedSystem = body.name;
		await loadSystems();
		renderSystems();
	} catch (e) {
		alert(`Save refused: ${e.message}`);
	}
}

async function runSystemAction(action) {
	const name = $('#sys-name').value.trim() || state.selectedSystem;
	if (!name) return alert('Select or enter a system first.');
	if (action === 'delete' && !window.confirm(`Delete system ${name} and its records?`)) return;
	const log = $('#sys-log');
	log.hidden = false;
	log.textContent = `${action} requested...\n`;
	try {
		const data = await postJson(`/api/systems/${encodeURIComponent(name)}/${action}`, {});
		if (data.job) {
			state.activeSystemJob = data.job.id;
			streamJob(data.job.id, log, () => {
				state.activeSystemJob = null;
				Promise.allSettled([loadSystems(), loadRecords(), loadQueue()]).then(renderAll);
			});
		} else {
			await loadSystems();
			renderSystems();
		}
	} catch (e) {
		log.textContent += `Refused: ${e.message}\n`;
	}
}

async function loadRecords() {
	if (!state.selectedSystem) return;
	try {
		const q = $('#records-query')?.value.trim();
		const url = `/api/systems/${encodeURIComponent(state.selectedSystem)}/records${q ? `?q=${encodeURIComponent(q)}` : ''}`;
		const { records } = await getJson(url);
		state.records = Array.isArray(records) ? records : [];
		state.recordsError = null;
	} catch (e) {
		state.recordsError = e.message;
	}
}

function renderRecords() {
	const box = $('#records-table');
	if (!box) return;
	if (!state.selectedSystem) return setChildren(box, empty('Select a system to view records.'));
	if (state.recordsError) return setChildren(box, errorBox(state.recordsError));
	if (!state.records.length) return setChildren(box, empty(`${state.selectedSystem}: no records for the current filter.`));
	const rows = state.records.map((r) => ({
		key: r.key,
		status: r.status,
		summary: r.summary,
		fetched_at: r.fetched_at,
		data: Object.entries(r.data || {}).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join(' / '),
	}));
	setChildren(box, renderGenericTable(rows, ['key', 'data', 'summary', 'status', 'fetched_at'], 'Records'));
}

function renderActions() {
	const box = $('#actions-table');
	if (!box) return;
	if (state.actionsError) return setChildren(box, errorBox(state.actionsError));
	const rows = (state.actions || []).map((a) => ({
		system: a.system,
		action: a.action,
		risk: a.riskClass,
		state: a.state || (a.enabled ? 'enabled' : 'disabled'),
		requirements: a.disabledReason || [a.permission, a.dryRunRequired ? 'dry-run' : '', a.humanConfirmRequired ? 'human confirm' : ''].filter(Boolean).join(' / '),
	}));
	setChildren(box, renderGenericTable(rows, ['system', 'action', 'risk', 'state', 'requirements'], 'Actions'));
}

function renderQueueGlobal() {
	const q = state.queue;
	if (!q) return;
	const dot = $('#side-queue-dot');
	const title = $('#side-queue-title');
	const sub = $('#side-queue-sub');
	if (dot) dot.className = `health-dot ${q.busy ? 'busy' : 'idle'}`;
	if (title) title.textContent = q.busy ? `Running ${q.running?.id || ''}` : 'Queue idle';
	if (sub) sub.textContent = q.busy ? (q.running?.label || 'browser job running') : `${q.pending?.length || 0} pending / ${q.recent?.length || 0} recent`;
	renderQueueMini('#cc-queue');
}

function renderQueueMini(selector) {
	const box = $(selector);
	if (!box) return;
	const q = state.queue;
	if (!q) return setChildren(box, empty('Queue API not loaded.'));
	const rows = [
		['Busy', q.busy ? 'yes' : 'no'],
		['Running', q.running ? `${q.running.id} / ${q.running.label}` : 'none'],
		['Pending', String(q.pending?.length || 0)],
		['Recent', String(q.recent?.length || 0)],
	];
	setChildren(box, renderRowsTable(rows, ['Field', 'Value']));
}

function jobResultLabel(job) {
	if (!job || !job.result) return job?.status === 'done' ? 'no result' : '-';
	if (Array.isArray(job.result.results)) {
		const counts = job.result.results.reduce((m, r) => {
			const k = r.status || 'unknown';
			m[k] = (m[k] || 0) + 1;
			return m;
		}, {});
		return Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ');
	}
	return job.result.status || 'result';
}

function renderQueueView() {
	const box = $('#queue-table');
	if (!box) return;
	const q = state.queue;
	if (state.queueError) return setChildren(box, errorBox(state.queueError));
	if (!q) return setChildren(box, empty('Queue API not loaded.'));
	const jobs = [];
	if (q.running) jobs.push(q.running);
	jobs.push(...(q.pending || []), ...(q.recent || []));
	const seen = new Set();
	const unique = jobs.filter((j) => j && !seen.has(j.id) && seen.add(j.id));
	if (!unique.length) return setChildren(box, empty('No jobs in memory.'));
	const table = el('table', {},
		el('thead', {}, el('tr', {},
			el('th', { class: 'col-key' }, 'Job'),
			el('th', {}, 'Label'),
			el('th', { class: 'col-short' }, 'Kind'),
			el('th', { class: 'col-status' }, 'Status'),
			el('th', { class: 'col-status' }, 'Result'),
			el('th', { class: 'col-actions' }, 'Actions'),
		)),
	);
	const body = el('tbody');
	for (const j of unique) {
		const open = el('button', { class: 'btn small', type: 'button' }, 'Log');
		open.addEventListener('click', () => openJobLog(j.id, j.label));
		const cancel = el('button', { class: 'btn small quiet', type: 'button' }, 'Cancel');
		cancel.disabled = ['done', 'failed', 'cancelled'].includes(j.status);
		cancel.addEventListener('click', async () => { await cancelJob(j.id); await loadQueue(); renderQueueView(); });
		body.append(el('tr', {},
			el('td', { class: 'col-key' }, j.id),
			el('td', { title: safeText(j.label) }, safeText(j.label, '-')),
			el('td', { class: 'col-short' }, safeText(j.kind, '-')),
			el('td', { class: 'col-status' }, statusBadge(j.status)),
			el('td', { class: 'col-status' }, statusBadge(jobResultLabel(j))),
			el('td', { class: 'col-actions' }, el('div', { class: 'button-row' }, open, cancel)),
		));
	}
	table.append(body);
	setChildren(box, table);
}

function openJobLog(id, label) {
	const log = $('#job-log');
	$('#job-log-badge').textContent = id;
	$('#job-log-badge').className = 'badge info';
	log.textContent = '';
	streamJob(id, log, () => loadQueue().then(renderQueueView));
	if (state.view !== 'queue') setView('queue');
}

function renderAudit() {
	const box = $('#audit-table');
	if (!box) return;
	if (state.auditError) return setChildren(box, errorBox(state.auditError));
	const q = ($('#audit-filter')?.value || '').toLowerCase().trim();
	const rows = state.audit.filter((a) => !q || JSON.stringify(a).toLowerCase().includes(q));
	if (!rows.length) return setChildren(box, empty('No audit rows for the current filter.'));
	const mapped = rows.map((a) => ({
		at: a.at,
		doc_id: a.doc_id || '-',
		stage: a.stage || '-',
		mode: a.live === true ? 'LIVE' : 'dry',
		actor: a.actor || a.by || '-',
		detail: a.detail || '',
	}));
	setChildren(box, renderGenericTable(mapped, ['at', 'doc_id', 'stage', 'mode', 'actor', 'detail'], `Audit rows (${rows.length}/${state.auditTotal || rows.length})`));
}

async function renderApprovalState() {
	const box = $('#approval-state-card');
	if (!box) return;
	const app = $('#approval-app')?.value.trim() || state.selectedSystem || 'hiworks';
	try {
		const data = await getJson(`/api/approve/state?app=${encodeURIComponent(app)}`);
		setChildren(box,
			el('div', { class: 'metric-grid' },
				metric('App', data.app || app, 'selected'),
				metric('Logged in', data.loggedIn ? 'yes' : 'no', 'approve/*.pw-state.json'),
				metric('Recipe', data.hasApproveRecipe ? 'ready' : 'missing', `recipes/${app}.json`),
				metric('List URL', data.listUrl ? 'configured' : 'missing', 'pending inbox'),
			),
			data.loggedIn && data.hasApproveRecipe && data.listUrl
				? warnBox('Reviewed approval can dry-run. Live still requires human confirmation and server-side session/origin gate.')
				: warnBox('Approval action is disabled until login state, recipe, and list URL are all present.'),
		);
	} catch (e) {
		setChildren(box, errorBox(e.message));
	}
}

async function requestKillSwitch() {
	if (!window.confirm('Request approve kill-switch? A running live batch should stop before the next document.')) return;
	try {
		await postJson('/api/approve/stop', {});
		alert('Kill-switch requested.');
		await loadAudit();
		renderAudit();
	} catch (e) {
		alert(`Kill-switch failed: ${e.message}`);
	}
}

async function runSuite() {
	const glob = $('#run-glob').value.trim();
	const log = $('#run-log');
	log.hidden = false;
	log.textContent = 'run requested...\n';
	try {
		const data = await postJson('/api/run', { glob });
		if (data.job) {
			state.activeRunJob = data.job.id;
			streamJob(data.job.id, log, () => {
				state.activeRunJob = null;
				Promise.allSettled([loadQueue(), loadDiagnostics()]).then(renderAll);
			});
			await loadQueue();
			renderAll();
		}
	} catch (e) {
		log.textContent += `Refused: ${e.message}\n`;
	}
}

function renderDiagnosticsLinks() {
	const box = $('#workspace-links');
	if (!box) return;
	const links = [
		['Queue API', '/api/queue', 'Current job serialization state'],
		['Systems API', '/api/systems', 'Registered systems and record counts'],
		['Approvals API', '/api/approvals', 'Pending approval records'],
		['Audit API', '/api/approve/audit?limit=300', 'Append-only approve leaf audit'],
		['Runs API', '/api/runs', 'Historical run reports'],
		['Flows API', '/api/flows', 'Recorded declarative flows'],
	];
	setChildren(box, el('div', { class: 'link-grid' }, ...links.map(([title, href, desc]) =>
		el('a', { class: 'link-card', href, target: '_blank', rel: 'noreferrer' }, el('strong', {}, title), el('span', {}, desc)),
	)));
}

function renderDiagnostics() {
	const box = $('#diagnostics-table');
	if (!box) return;
	const rows = [
		{ area: 'Runs', count: state.runs.length, state: state.runs.length ? `${state.runs[0].runId || 'loaded'}` : 'no records', endpoint: '/api/runs' },
		{ area: 'Flows', count: state.flows.length, state: state.flows.some((f) => f.needsReview) ? 'needs review' : 'loaded', endpoint: '/api/flows' },
		{ area: 'Auth states', count: state.auth.length, state: state.auth.length ? state.auth.join(', ') : 'none', endpoint: '/api/auth' },
		{ area: 'Preflight', count: '-', state: 'CLI only', endpoint: 'bash lib/preflight.sh' },
		{ area: 'Full suite', count: '-', state: 'available through POST /api/run', endpoint: 'bash run.sh' },
	];
	setChildren(box, renderGenericTable(rows, ['area', 'count', 'state', 'endpoint'], 'Diagnostics'));
}

function renderGenericTable(rows, columns, label) {
	if (!rows.length) return empty(`No rows for ${label || 'table'}.`);
	const table = el('table', { 'aria-label': label || 'data table' },
		el('thead', {}, el('tr', {}, ...columns.map((c) => el('th', { class: columnClass(c) }, c.replaceAll('_', ' '))))),
	);
	const body = el('tbody');
	for (const row of rows) {
		body.append(el('tr', {}, ...columns.map((c) => {
			const val = row[c];
			const node = c === 'state' || c === 'status' || c === 'stage' ? statusBadge(val) : safeText(val, '-');
			return el('td', { class: columnClass(c), title: typeof val === 'string' ? val : undefined }, node);
		})));
	}
	table.append(body);
	return table;
}

function renderRowsTable(rows, columns) {
	const mapped = rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, r[i]])));
	return renderGenericTable(mapped, columns, 'rows');
}

function columnClass(name) {
	const n = String(name).toLowerCase();
	if (['doc_id', 'key', 'system', 'job', 'plan id', 'contract'].includes(n)) return 'col-key';
	if (['status', 'state', 'stage', 'risk', 'mode'].includes(n)) return 'col-status';
	if (['count', 'kind', 'action'].includes(n)) return 'col-short';
	if (['at', 'created', 'fetched_at', 'submitted_at'].includes(n)) return 'col-time';
	return n === 'detail' || n === 'requirements' || n === 'data' || n === 'summary' || n === 'operational impact' ? 'cell-wrap' : '';
}

function bindEvents() {
	document.querySelectorAll('.nav-item').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.viewTarget)));
	$('#global-refresh').addEventListener('click', () => loadCoreData());
	$('#cc-create-plan').addEventListener('click', () => makePlan($('#cc-command').value));
	$('#cc-dry-run').addEventListener('click', runDryRun);
	$('#tr-dry-run').addEventListener('click', runDryRun);
	$('#cc-confirm').addEventListener('click', runLiveConfirm);
	$('#tr-confirm').addEventListener('click', runLiveConfirm);
	$('#cc-select-all').addEventListener('click', selectVisibleTargets);
	$('#tr-select-all').addEventListener('click', selectVisibleTargets);
	$('#cc-clear-selection').addEventListener('click', clearTargets);
	$('#tr-refresh').addEventListener('click', () => loadApprovals().then(renderAll));
	$('#nl-run').addEventListener('click', runNlCommand);
	$('#nl-command-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') runNlCommand(); });
	$('#nl-use-plan').addEventListener('click', () => { $('#cc-command').value = $('#nl-command-input').value; makePlan($('#nl-command-input').value); setView('command-center'); });
	$('#sys-refresh').addEventListener('click', () => loadSystems().then(renderSystems));
	$('#sys-save').addEventListener('click', saveSystem);
	$('#sys-auth').addEventListener('click', () => runSystemAction('auth'));
	$('#sys-analyze').addEventListener('click', async () => { await saveSystem(); runSystemAction('analyze'); });
	$('#sys-sync').addEventListener('click', () => runSystemAction('sync'));
	$('#sys-enrich').addEventListener('click', () => runSystemAction('enrich'));
	$('#sys-delete').addEventListener('click', () => runSystemAction('delete'));
	$('#records-refresh').addEventListener('click', () => loadRecords().then(renderRecords));
	$('#records-query').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadRecords().then(renderRecords); });
	$('#actions-refresh').addEventListener('click', () => loadActions().then(renderActions));
	$('#queue-refresh').addEventListener('click', () => loadQueue().then(renderQueueView));
	$('#audit-refresh').addEventListener('click', () => loadAudit().then(renderAudit));
	$('#audit-filter').addEventListener('input', renderAudit);
	$('#approval-state-refresh').addEventListener('click', renderApprovalState);
	$('#approval-stop').addEventListener('click', requestKillSwitch);
	$('#run-suite').addEventListener('click', runSuite);
	$('#diagnostics-refresh').addEventListener('click', loadDiagnostics);
}

bindEvents();
loadCoreData();
setInterval(() => loadQueue().then(() => {
	if (state.view === 'queue') renderQueueView();
	renderCommandCenter();
}), 2500);
