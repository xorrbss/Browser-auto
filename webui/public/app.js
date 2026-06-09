// webui/public/app.js -- NL RPA Control Plane shell.
// Zero-dependency browser app over the existing localhost APIs.

import { $, el, getJson, fmtTime, streamJob, cancelJob, stopJob } from './util.js';

const DEFAULT_ENGINE = 'agent-browser';
const ENGINES = ['agent-browser', 'playwright'];
const FLOW_NAME_RE = /^[A-Za-z0-9_-]+$/;

const VIEW_TITLES = {
	automation: '자동화 만들기',
	'command-center': '커맨드 센터',
	'nl-command': '자연어 명령',
	'command-plan': '커맨드 플랜',
	'target-review': '대상 검토',
	systems: '연결 시스템',
	actions: '액션 레지스트리',
	queue: '작업 큐',
	audit: '감사 로그',
	'approval-state': '결재 상태',
	diagnostics: '실행 결과',
};

const state = {
	view: 'automation',
	approvals: [],
	systems: [],
	records: [],
	queue: null,
	audit: [],
	runs: [],
	flows: [],
	auth: [],
	authStates: [],
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
	automation: {
		flowName: '',
		flow: null,
		plan: null,
		planError: null,
		recordJob: null,
		verifyJob: null,
		runJob: null,
		compileOutput: '',
		flowError: '',
		lastRunId: '',
	},
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
	$('#page-title').textContent = VIEW_TITLES[view] || '컨트롤 플레인';
	loadView(view);
}

function updatePlanPill() {
	const pill = $('#top-plan-pill');
	if (!state.plan) {
		pill.textContent = '플랜: 없음';
		pill.className = 'pill muted';
		return;
	}
	pill.textContent = `${state.plan.id} / ${state.plan.status}`;
	pill.className = 'pill';
}

function inferAction(text) {
	const s = String(text || '');
	if (/(sync|refresh|fetch|동기화|새로고침|가져오기)/i.test(s)) return 'sync';
	if (/(summarize|summary|digest|enrich|query|show|display|read|요약|상세|조회|검색|확인|보여|읽어)/i.test(s)) return 'enrich';
	if (/(approve|confirm|approval|승인|확정|실제\s*결재|결재\s*(승인|확정|처리|실행))/i.test(s)) return 'approve';
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
		if (refusal) addTimeline('플랜 거부됨', `${refusal.reason}: ${refusal.detail || ''}`, 'danger');
		renderAll();
		return plan;
	} catch (e) {
		state.planError = e.message;
		renderAll();
		alert(`플랜 생성 거부됨: ${e.message}`);
		return null;
	}
}

// 동기화: hiworks 결재 대기함을 스크랩해 DB(/api/approvals)를 채운다. fetch-approvals.sh 브라우저 작업을
// 직렬 큐에 올리고, 끝나면 대상 검토 표를 새로고침한다. 동기화 전에는 검토할 대기 문서가 없다.
async function runApprovalsSync() {
	const app = state.selectedSystem || 'hiworks';
	const log = $('#job-log');
	if (log) {
		log.textContent = '';
		$('#job-log-badge').textContent = '동기화';
		$('#job-log-badge').className = 'badge info';
	}
	try {
		const data = await postJson('/api/sync', { app });
		if (data.job) {
			setView('queue');
			streamJob(data.job.id, log || document.createElement('pre'), async () => {
				await loadApprovals();
				renderAll();
			});
		}
	} catch (e) {
		alert(`동기화 거부됨: ${e.message}`);
	}
}

function addTimeline(title, detail, kind = 'info') {
	if (!state.plan) return;
	state.plan.events = state.plan.events || [];
	state.plan.events.push({ at: new Date().toISOString(), title, detail, kind });
}

async function loadCoreData() {
	await Promise.allSettled([loadApprovals(), loadSystems(), loadQueue(), loadAudit(), loadFlowsList(), loadAuthStates()]);
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
		loadAuthStates(),
	]);
	renderDiagnostics();
}

async function loadAuthStates() {
	try {
		const { apps, states } = await getJson('/api/auth');
		state.auth = Array.isArray(apps) ? apps : [];
		state.authStates = Array.isArray(states) ? states : [];
	} catch {
		state.auth = [];
		state.authStates = [];
	}
}

async function loadFlowsList() {
	try {
		const { flows } = await getJson('/api/flows');
		state.flows = Array.isArray(flows) ? flows : [];
	} catch {
		state.flows = [];
	}
}

function loadView(view) {
	if (view === 'automation') renderAutomation();
	if (view === 'target-review') renderTargetsView();
	if (view === 'systems') renderSystems();
	if (view === 'actions') renderActions();
	if (view === 'queue') renderQueueView();
	if (view === 'audit') renderAudit();
	if (view === 'approval-state') renderApprovalState();
	if (view === 'diagnostics') loadDiagnostics();
}

function renderAll() {
	renderAutomation();
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

function automationForm() {
	const recordUrl = $('#auto-record-url')?.value.trim() || '';
	const loginUrl = $('#auto-login-url')?.value.trim() || '';
	const manualName = $('#auto-name')?.value.trim() || '';
	const manualApp = $('#auto-app')?.value.trim() || '';
	const manualSuccessUrl = $('#auto-success-url')?.value.trim() || '';
	const autoApp = appSuggestion({ recordUrl, loginUrl });
	const matchedApp = matchedAuthApp({ recordUrl, loginUrl });
	const app = manualApp || matchedApp || autoApp;
	const autoName = flowNameSuggestion({ name: '', recordUrl, loginUrl, app });
	const autoSuccessUrl = successNeedleSuggestion({ recordUrl });
	return {
		name: manualName || autoName,
		recordUrl,
		loginUrl,
		app,
		successUrl: manualSuccessUrl || autoSuccessUrl,
		manualName,
		manualApp,
		manualSuccessUrl,
		autoName,
		autoApp,
		matchedApp,
		autoSuccessUrl,
		engine: $('#auto-engine')?.value || DEFAULT_ENGINE,
		seconds: Math.min(Math.max(parseInt($('#auto-seconds')?.value, 10) || 180, 5), 1800),
		goal: $('#auto-goal')?.value.trim() || '',
	};
}

function slugPart(value) {
	return String(value || '')
		.normalize('NFKD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^A-Za-z0-9_-]+/g, '_')
		.replace(/_+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 64);
}

function flowNameSuggestion(form) {
	const fromName = slugPart(form.name);
	if (fromName) return fromName;
	try {
		const u = new URL(form.recordUrl || form.loginUrl);
		const host = slugPart(u.hostname.replace(/^www\./, ''));
		const path = slugPart(u.pathname.split('/').filter(Boolean).slice(0, 2).join('_'));
		const candidate = [host, path].filter(Boolean).join('_').slice(0, 64);
		if (candidate) return candidate;
	} catch {
		/* handled by the caller's URL validation */
	}
	const fromApp = slugPart(form.app);
	if (fromApp) return fromApp;
	const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 12);
	return `flow_${stamp}`;
}

function appSuggestion(form) {
	try {
		const u = new URL(form.recordUrl || form.loginUrl);
		const firstPath = u.pathname.split('/').filter(Boolean)[0] || '';
		const org = /\./.test(firstPath) ? firstPath : '';
		const host = u.hostname
			.replace(/^www\./, '')
			.replace(/^(login|signin|auth|sso|oauth|approval)\./i, '');
		return slugPart(org || host).slice(0, 48);
	} catch {
		return '';
	}
}

function successNeedleSuggestion(form) {
	try {
		const u = new URL(form.recordUrl);
		const firstPath = u.pathname.split('/').filter(Boolean)[0] || '';
		const pathPart = firstPath ? `/${firstPath}` : '';
		return `${u.hostname}${pathPart}`;
	} catch {
		return '';
	}
}

function urlPartsForAuth(urls) {
	const hosts = [];
	const hints = [];
	for (const raw of urls) {
		try {
			const u = new URL(raw);
			hosts.push(u.hostname.toLowerCase());
			const firstPath = u.pathname.split('/').filter(Boolean)[0] || '';
			if (/^[A-Za-z0-9._-]{2,128}$/.test(firstPath)) hints.push(firstPath);
		} catch {
			/* ignore incomplete URLs while typing */
		}
	}
	return { hosts, hints };
}

function hostMatchesDomain(host, domain) {
	const d = String(domain || '').replace(/^\./, '').toLowerCase();
	return !!(host && d && (host === d || host.endsWith(`.${d}`)));
}

function matchedAuthApp(form) {
	const { hosts, hints } = urlPartsForAuth([form.recordUrl, form.loginUrl]);
	if (!hosts.length && !hints.length) return '';
	let best = null;
	for (const auth of state.authStates || []) {
		let score = 0;
		const domains = Array.isArray(auth.domains) ? auth.domains : [];
		const authHints = Array.isArray(auth.hints) ? auth.hints : [];
		if (hints.some((h) => authHints.includes(h))) score += 10;
		if (hosts.some((h) => domains.some((d) => hostMatchesDomain(h, d)))) score += 3;
		if (!score) continue;
		const updatedAt = Number(auth.updatedAt) || 0;
		if (!best || score > best.score || (score === best.score && updatedAt > best.updatedAt)) {
			best = { app: auth.app, score, updatedAt };
		}
	}
	return best?.app || '';
}

function ensureFlowName(form, { update = true } = {}) {
	if (FLOW_NAME_RE.test(form.name)) return form.name;
	const suggested = flowNameSuggestion(form);
	if (update) {
		const input = $('#auto-name');
		if (input) input.value = suggested;
		const log = $('#auto-record-log');
		if (log) {
			log.hidden = false;
			log.append(document.createTextNode(`이름은 영문/숫자/_/-만 사용할 수 있어 '${suggested}' ID로 바꿨습니다.\n`));
		}
	}
	return suggested;
}

function safeAutomationSystem(form) {
	if (FLOW_NAME_RE.test(form.app)) return form.app;
	if (FLOW_NAME_RE.test(form.name)) return form.name;
	return state.selectedSystem || 'hiworks';
}

function looksLikeLoginUrl(url) {
	return /login|signin|auth|sso|oauth/i.test(String(url || ''));
}

function automationLoggedIn(form = automationForm()) {
	return !!(form.app && state.auth.includes(form.app));
}

function queueWork() {
	const q = state.queue || {};
	return {
		running: q.running || null,
		pending: Array.isArray(q.pending) ? q.pending : [],
	};
}

function queueBusy() {
	const q = queueWork();
	return !!(q.running || q.pending.length);
}

function queueBusyText() {
	const q = queueWork();
	if (q.running) return `현재 ${q.running.id} ${q.running.label || q.running.kind} 실행 중`;
	if (q.pending.length) return `대기 중인 작업 ${q.pending.length}개`;
	return '';
}

function queueJob(id) {
	if (!id) return null;
	const q = queueWork();
	return [q.running, ...q.pending].filter(Boolean).find((j) => j.id === id) || null;
}

function flowStepSummary(s) {
	if (!s || typeof s !== 'object') return '-';
	if (s.kind === 'wait') return `대기: ${s.until || ''} ${s.value || ''}`.trim();
	if (s.kind === 'press') return `키 입력: ${s.value || ''}`;
	if (s.kind === 'scroll') return `스크롤: ${s.dir || 'down'} ${s.px || ''}`;
	if (s.kind === 'find') {
		const locator = s.needs_review ? '검토 필요' : `${s.by || '?'}=${s.value || ''}${s.name ? ` / ${s.name}` : ''}`;
		const value = s.text != null ? ` / ${s.text}` : s.val != null ? ` / ${s.val}` : '';
		return `${s.action || '동작'}: ${locator}${value}`;
	}
	return `${s.kind || '단계'}`;
}

function flowReadyReason(flow) {
	if (!flow) return '녹화된 플로우가 없습니다.';
	if (flow.needsReviewSteps?.length) return `검토 필요 단계 ${flow.needsReviewSteps.length}개`;
	if (flow.missingValues?.length) return `입력값 누락: ${flow.missingValues.join(', ')}`;
	if (!flow.compiled) return '컴파일 전';
	return '실행 가능';
}

function setAutomationJobBadge(label, kind = 'neutral') {
	const b = $('#auto-job-badge');
	if (!b) return;
	b.textContent = label;
	b.className = `badge ${kind}`;
}

function renderAutomation() {
	const box = $('#auto-flow-box');
	if (!box) return;
	const flow = state.automation.flow;
	const form = automationForm();
	const recordJob = queueJob(state.automation.recordJob);
	const activeRecord = !!state.automation.recordJob;
	const recordQueued = recordJob?.status === 'queued';
	const recordRunning = recordJob?.status === 'running';
	const activeVerify = !!state.automation.verifyJob;
	const activeRun = !!state.automation.runJob;
	const loggedIn = automationLoggedIn(form);
	const busy = queueBusy();
	const busyText = queueBusyText();
	const badges = $('#auto-status-badges');
	if (badges) {
		setChildren(
			badges,
			badge(flow ? flow.name : '새 시나리오', flow ? 'info' : 'neutral'),
			flow ? badge(`${flow.steps.length}단계`, 'neutral') : badge('URL 대기', 'warning'),
			flow && flow.needsReviewSteps.length ? badge(`${flow.needsReviewSteps.length} 검토`, 'warning') : null,
			flow && flow.compiled ? badge('컴파일됨', 'success') : null,
			activeRecord ? badge(recordQueued ? '녹화 대기 중' : '녹화 중', 'info') : null,
			!activeRecord && busy ? badge('작업 대기 중', 'info') : null,
		);
	}
	const pill = $('#top-plan-pill');
	if (pill && state.view === 'automation') {
		pill.textContent = flow ? `시나리오: ${flow.name} / ${flowReadyReason(flow)}` : '시나리오: 준비 전';
		pill.className = `pill ${flow && flow.compilable ? '' : 'muted'}`;
	}
	const stopBtn = $('#auto-stop-record');
	if (stopBtn) {
		stopBtn.disabled = !recordRunning;
		stopBtn.title = recordQueued ? '앞선 작업이 끝나고 녹화가 시작되면 종료할 수 있습니다.' : '';
	}
	const startBtn = $('#auto-start-record');
	if (startBtn) {
		startBtn.disabled = activeRecord || activeVerify || activeRun || busy || !form.recordUrl;
		startBtn.textContent = activeRecord ? (recordQueued ? '녹화 대기 중' : '녹화 중') : busy ? '작업 대기 중' : '녹화 시작';
		startBtn.title = !form.recordUrl ? '로그인 이후 실제 업무 화면 URL을 입력하세요.' : !activeRecord && busy ? busyText : '';
	}
	const authBadge = $('#auto-auth-badge');
	if (authBadge) {
		setChildren(
			authBadge,
			loggedIn ? badge('로그인 등록됨', 'success') : badge('로그인 필요', 'warning'),
			form.app ? badge('자동 연결', 'neutral') : null,
			!loggedIn && busy ? badge('작업 대기 중', 'info') : null,
		);
	}
	const authBtn = $('#auto-auth');
	if (authBtn) {
		authBtn.disabled = loggedIn || busy || !form.app || !form.loginUrl;
		authBtn.textContent = loggedIn ? '로그인 등록됨' : busy ? '작업 대기 중' : '로그인 등록';
		authBtn.title = !form.loginUrl ? '로그인 URL을 입력하세요.' : !loggedIn && busy ? busyText : '';
	}
	const authHint = $('#auto-auth-hint');
	if (authHint) {
		authHint.textContent = loggedIn
			? '이 사이트의 로그인 상태가 저장되어 있습니다.'
			: form.loginUrl && form.successUrl
				? '녹화 URL을 기준으로 로그인 완료를 자동 확인합니다.'
				: form.loginUrl
					? '로그인 완료 확인을 위해 녹화 URL도 필요합니다.'
					: '녹화 URL과 로그인 URL을 입력하면 로그인 완료 기준은 자동으로 잡습니다.';
	}
	const recordHint = $('#auto-record-hint');
	if (recordHint) {
		recordHint.textContent = form.recordUrl
			? '시나리오 이름과 로그인 연결은 자동으로 처리됩니다.'
			: '로그인 이후 실제 업무 화면 URL만 입력하면 나머지는 자동으로 준비됩니다.';
	}
	['#auto-login-url', '#auto-success-url'].forEach((sel) => {
		const node = $(sel);
		if (node) node.disabled = loggedIn;
	});
	const verifyBtn = $('#auto-verify');
	if (verifyBtn) verifyBtn.disabled = !flow || activeRecord || activeVerify || activeRun || busy;
	const compileBtn = $('#auto-compile');
	if (compileBtn) {
		compileBtn.disabled = !flow || !flow.compilable || activeRecord || activeVerify || activeRun;
		compileBtn.title = flow && !flow.compilable ? flowReadyReason(flow) : '';
	}
	const runBtn = $('#auto-run');
	if (runBtn) {
		runBtn.disabled = !flow || !flow.compilable || activeRecord || activeVerify || activeRun || busy;
		runBtn.textContent = flow && !flow.compiled ? '컴파일 후 실행' : '실행';
	}
	renderAutomationPreview(form.goal);
	renderAutomationFlow(flow);
}

function renderAutomationPreview(goal) {
	const box = $('#auto-preview-box');
	if (!box) return;
	const flow = state.automation.flow;
	const plan = state.automation.plan;
	const form = automationForm();
	if (!goal && !plan) {
		const loginNotice = looksLikeLoginUrl(form.recordUrl)
			? warnBox('녹화 URL은 로그인 이후 실제 업무 화면이어야 합니다. 로그인은 왼쪽의 로그인 등록에서 먼저 저장하세요.')
			: null;
		return setChildren(box, empty('목표가 아직 없습니다.'), loginNotice);
	}
	const risk = plan?.riskClass || (/(승인|삭제|확정|approve|delete|confirm|실제\s*결재|결재\s*(승인|확정|처리|실행))/i.test(goal) ? 'irreversible' : 'read');
	const rows = [
		['목표', goal || plan?.sourceText || '-'],
		['기반', flow ? `${flow.name} / ${flow.steps.length}단계 녹화` : '녹화 전'],
		['실행 방식', '컴파일된 bash 테스트'],
		['위험도', risk === 'irreversible' ? '변경 작업' : '조회 작업'],
		['게이트', flowReadyReason(flow)],
	];
	if (plan) {
		rows.push(['계획 ID', plan.id], ['액션', plan.action], ['시스템', plan.system]);
	}
	const notice = state.automation.planError
		? warnBox(`계획 생성 참고: ${state.automation.planError}`)
		: risk === 'irreversible'
			? warnBox('변경 작업은 모의실행과 사람 확인을 거친 뒤 실행됩니다.')
			: null;
	setChildren(box, renderRowsTable(rows, ['항목', '값']), notice);
}

function renderAutomationFlow(flow) {
	const box = $('#auto-flow-box');
	if (!box) return;
	if (state.automation.flowError) return setChildren(box, errorBox(state.automation.flowError));
	if (!flow) return setChildren(box, empty('녹화가 끝나면 단계와 검토 항목이 여기에 표시됩니다.'));
	const summary = el('div', { class: 'metric-grid' },
		metric('단계', flow.steps.length, flow.startUrl || ''),
		metric('검토', flow.needsReviewSteps.length, 'locator 후보 선택'),
		metric('입력값', flow.inputTokens.length, flow.missingValues.length ? '누락 있음' : '준비됨'),
		metric('상태', flow.compiled ? 'compiled' : flowReadyReason(flow), flow.engine),
	);
	const steps = el('div', { class: 'step-list' });
	flow.steps.forEach((s, i) => {
		steps.append(el('div', { class: `flow-step ${s.needs_review ? 'needs-review' : ''}` },
			el('span', { class: 'step-num' }, String(i + 1)),
			el('span', { class: 'step-text' }, flowStepSummary(s)),
		));
	});
	const reviewBlocks = flow.needsReviewSteps.map((item) => {
		const actions = el('div', { class: 'candidate-list' });
		for (const [ci, c] of (item.candidates || []).entries()) {
			actions.append(el('button', {
				class: 'candidate-button',
				type: 'button',
				onclick: () => resolveAutomationStep(flow.name, item.index, ci),
			}, `${c.by}: ${c.value}${c.name ? ` / ${c.name}` : ''}`));
		}
		return el('div', { class: 'review-block' },
			el('strong', {}, `${item.index + 1}단계 locator 선택`),
			actions,
		);
	});
	let valuesBlock = null;
	if (flow.inputTokens.length) {
		const inputs = el('div', { class: 'values-grid' });
		for (const t of flow.inputTokens) {
			inputs.append(el('label', { class: 'input-wrap' }, el('span', {}, t), el('input', { class: 'auto-value-input', dataset: { token: t }, value: flow.values[t] || '', autocomplete: 'off' })));
		}
		valuesBlock = el('div', { class: 'review-block' },
			el('strong', {}, '입력값'),
			inputs,
			el('div', { class: 'button-row' }, el('button', { class: 'btn small', type: 'button', onclick: () => saveAutomationValues(flow.name) }, '값 저장')),
		);
	}
	const compileOut = state.automation.compileOutput ? el('pre', { class: 'joblog compact-log' }, state.automation.compileOutput) : null;
	setChildren(box,
		summary,
		el('div', { class: 'flow-body' }, steps),
		...reviewBlocks,
		valuesBlock,
		compileOut,
	);
}

async function loadAutomationFlow(name) {
	const form = automationForm();
	const raw = String(name || form.name || state.automation.flowName || '').trim();
	const flowName = FLOW_NAME_RE.test(raw) ? raw : ensureFlowName({ ...form, name: raw });
	if (!flowName) return;
	try {
		if (state.automation.flowName && state.automation.flowName !== flowName) state.automation.compileOutput = '';
		state.automation.flow = await getJson(`/api/flows/${encodeURIComponent(flowName)}`);
		state.automation.flowName = flowName;
		state.automation.flowError = '';
		const nameInput = $('#auto-name');
		if (nameInput && !nameInput.value.trim()) nameInput.value = flowName;
		renderAutomation();
	} catch (e) {
		state.automation.flow = null;
		state.automation.flowError = `플로우를 불러오지 못했습니다: ${e.message}`;
		renderAutomation();
	}
}

async function startAutomationRecord(overwrite = false) {
	const form = automationForm();
	if (!form.recordUrl) return alert('녹화 URL을 입력하세요.');
	const log = $('#auto-record-log');
	log.hidden = false;
	log.textContent = '녹화 준비 중...\n';
	await loadQueue();
	if (queueBusy()) {
		setAutomationJobBadge('작업 대기 중', 'warning');
		log.textContent += `${queueBusyText()}\n이 작업이 끝난 뒤 [녹화 시작]을 다시 눌러주세요.\n`;
		renderAutomation();
		return;
	}
	if (looksLikeLoginUrl(form.recordUrl)) {
		setAutomationJobBadge('로그인 먼저', 'warning');
		log.textContent += '로그인 URL에서는 녹화를 시작하지 않습니다.\n먼저 [로그인 등록]을 완료한 뒤, 녹화 URL에는 로그인 이후 실제 업무 화면을 넣어주세요.\n';
		return;
	}
	const flowName = ensureFlowName(form);
	if (!flowName) return alert('이름을 영문/숫자/_/- 형태로 입력하세요.');
	setAutomationJobBadge('녹화', 'info');
	try {
		const data = await postJson('/api/record', {
			name: flowName,
			startUrl: form.recordUrl,
			app: form.app || undefined,
			engine: form.engine,
			seconds: form.seconds,
			overwrite,
		});
		state.automation.flowName = flowName;
		state.automation.recordJob = data.job?.id || null;
		renderAutomation();
		if (data.job) {
			streamJob(data.job.id, log, async (done) => {
				state.automation.recordJob = null;
				setAutomationJobBadge(done?.status === 'done' ? '녹화 완료' : '녹화 종료', done?.status === 'done' ? 'success' : 'warning');
				await Promise.allSettled([loadFlowsList(), loadAutomationFlow(flowName), loadQueue()]);
				renderAutomation();
			});
		}
	} catch (e) {
		if (String(e.message || '').includes('already exists') && !overwrite && window.confirm('같은 이름의 플로우가 있습니다. 다시 녹화해서 덮어쓸까요?')) {
			return startAutomationRecord(true);
		}
		state.automation.recordJob = null;
		setAutomationJobBadge('녹화 실패', 'danger');
		log.textContent += `거부됨: ${e.message}\n`;
		renderAutomation();
	}
}

async function stopAutomationRecord() {
	const id = state.automation.recordJob;
	if (!id) return;
	const log = $('#auto-record-log');
	const ok = await stopJob(id);
	log.hidden = false;
	log.append(document.createTextNode(ok ? '\n[webui] 녹화 종료를 요청했습니다.\n' : '\n[webui] 아직 종료할 수 없습니다. 잠시 후 다시 누르세요.\n'));
}

async function runAutomationAuth() {
	const form = automationForm();
	if (!form.app) return alert('녹화 URL 또는 로그인 URL을 입력하면 앱 ID는 자동으로 생성됩니다.');
	if (automationLoggedIn(form)) return alert(`${form.app} 로그인 상태가 이미 저장되어 있습니다.`);
	if (!form.loginUrl) return alert('로그인 URL을 입력하세요.');
	if (!form.successUrl) {
		const log = $('#auto-record-log');
		if (log) {
			log.hidden = false;
			log.textContent = '로그인 완료를 확인하려면 로그인 후 실제로 열 업무 화면 URL이 필요합니다.\n오른쪽 [녹화 URL]에 로그인 이후 화면 주소를 입력한 뒤 다시 [로그인 등록]을 누르세요.\n';
		}
		$('#auto-record-url')?.focus();
		return;
	}
	const log = $('#auto-record-log');
	log.hidden = false;
	log.textContent = '로그인 등록 준비 중...\n';
	await loadQueue();
	if (queueBusy()) {
		setAutomationJobBadge('작업 대기 중', 'warning');
		log.textContent += `${queueBusyText()}\n이 작업이 끝난 뒤 [로그인 등록]을 다시 눌러주세요.\n`;
		renderAutomation();
		return;
	}
	log.textContent = '로그인 창을 여는 중...\n로그인과 OTP를 완료하면 완료 확인값을 보고 창이 자동으로 닫히고 상태가 저장됩니다.\n';
	setAutomationJobBadge('로그인 등록', 'info');
	try {
		const data = await postJson('/api/auth', {
			app: form.app,
			loginUrl: form.loginUrl,
			successUrl: form.successUrl,
			engine: form.engine,
		});
		if (data.job) {
			streamJob(data.job.id, log, async (done) => {
				setAutomationJobBadge(done?.status === 'done' ? '로그인 등록 완료' : '로그인 확인', done?.status === 'done' ? 'success' : 'warning');
				await Promise.allSettled([loadAuthStates(), loadDiagnostics(), loadQueue()]);
				log.append(document.createTextNode('\n다음 단계: 녹화 URL에 로그인 이후 실제 업무 화면을 넣고 [녹화 시작]을 누르세요.\n'));
				renderAutomation();
			});
		}
	} catch (e) {
		setAutomationJobBadge('로그인 실패', 'danger');
		log.append(document.createTextNode(`로그인 등록 거부됨: ${e.message}\n`));
	}
}

async function createAutomationPreview() {
	const form = automationForm();
	if (!form.goal) return alert('하고 싶은 일을 입력하세요.');
	state.automation.plan = null;
	state.automation.planError = null;
	renderAutomation();
	const action = inferAction(form.goal);
	try {
		const body = { text: form.goal, system: safeAutomationSystem(form), mode: 'reviewed' };
		if (action) body.action = action;
		const { plan, refusal } = await postJson('/api/agent/plan', body);
		state.automation.plan = plan || null;
		state.automation.planError = refusal ? `${refusal.reason}${refusal.detail ? ` / ${refusal.detail}` : ''}` : null;
	} catch (e) {
		state.automation.planError = e.message;
	}
	renderAutomation();
}

async function resolveAutomationStep(name, step, candidate) {
	try {
		await postJson(`/api/flows/${encodeURIComponent(name)}/resolve`, { step, candidate });
		await loadAutomationFlow(name);
	} catch (e) {
		alert(`locator 선택 실패: ${e.message}`);
	}
}

async function saveAutomationValues(name) {
	const values = {};
	document.querySelectorAll('.auto-value-input').forEach((input) => {
		values[input.dataset.token] = input.value;
	});
	try {
		await postJson(`/api/flows/${encodeURIComponent(name)}/values`, { values });
		await loadAutomationFlow(name);
	} catch (e) {
		alert(`값 저장 실패: ${e.message}`);
	}
}

async function verifyAutomationFlow() {
	const flow = state.automation.flow;
	if (!flow) return;
	const log = $('#auto-run-log');
	log.textContent = '검증 요청 중...\n';
	setAutomationJobBadge('검증', 'info');
	try {
		const data = await postJson('/api/verify', { name: flow.name });
		state.automation.verifyJob = data.job?.id || null;
		renderAutomation();
		if (data.job) {
			streamJob(data.job.id, log, async (done) => {
				state.automation.verifyJob = null;
				setAutomationJobBadge(done?.status === 'done' ? '검증 완료' : '검증 확인', done?.status === 'done' ? 'success' : 'warning');
				await loadAutomationFlow(flow.name);
			});
		}
	} catch (e) {
		state.automation.verifyJob = null;
		setAutomationJobBadge('검증 실패', 'danger');
		log.textContent += `거부됨: ${e.message}\n`;
		renderAutomation();
	}
}

async function compileAutomationFlow() {
	const flow = state.automation.flow;
	if (!flow) return false;
	state.automation.compileOutput = '컴파일 중...';
	renderAutomation();
	try {
		const data = await postJson('/api/compile', { name: flow.name });
		state.automation.compileOutput = (data.ok ? `컴파일됨: ${data.testFile}` : `컴파일 실패 (${data.code})`) + (data.output ? `\n\n${data.output}` : '');
		await loadAutomationFlow(flow.name);
		return !!data.ok;
	} catch (e) {
		state.automation.compileOutput = `컴파일 실패: ${e.message}`;
		renderAutomation();
		return false;
	}
}

async function runAutomationFlow() {
	let flow = state.automation.flow;
	if (!flow) return;
	if (!flow.compiled) {
		const ok = await compileAutomationFlow();
		if (!ok) return;
		flow = state.automation.flow;
	}
	const log = $('#auto-run-log');
	log.textContent = '실행 요청 중...\n';
	setAutomationJobBadge('실행', 'info');
	try {
		const data = await postJson('/api/run', { glob: flow.name });
		state.automation.runJob = data.job?.id || null;
		renderAutomation();
		if (data.job) {
			streamJob(data.job.id, log, async (done) => {
				state.automation.runJob = null;
				state.automation.lastRunId = done?.result?.runId || '';
				setAutomationJobBadge(done?.status === 'done' ? '실행 완료' : '실행 확인', done?.status === 'done' ? 'success' : 'warning');
				await Promise.allSettled([loadQueue(), loadDiagnostics(), loadAutomationFlow(flow.name)]);
				renderAutomation();
			});
		}
	} catch (e) {
		state.automation.runJob = null;
		setAutomationJobBadge('실행 실패', 'danger');
		log.textContent += `거부됨: ${e.message}\n`;
		renderAutomation();
	}
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
	if (!state.plan) return setChildren(box, badge('플랜 없음', 'neutral'));
	const risk = state.plan.riskClass === 'irreversible' ? 'risk' : 'info';
	setChildren(
		box,
		badge(state.plan.status, 'pending'),
		badge(state.plan.action, 'info'),
		badge(state.plan.riskClass, risk),
		state.dryRunPassed ? badge('모의실행 통과', 'success') : badge('모의실행 필요', state.plan.requirements.dryRun ? 'warning' : 'neutral'),
	);
}

function renderPlanSummary(selector, includeMetrics = false) {
	const box = $(selector);
	if (!box) return;
	if (!state.plan) return setChildren(box, empty('생성된 플랜 미리보기가 없습니다.'));
	const metrics = includeMetrics ? el('div', { class: 'metric-grid' },
		metric('대상', state.plan.targetCount, '선택 또는 확정됨'),
		metric('위험도', state.plan.riskClass, state.plan.mode),
		metric('모의실행', state.plan.requirements.dryRun ? (state.dryRunPassed ? 'passed' : 'required') : 'not required', '게이트 상태'),
		metric('플랜 해시', state.plan.hash, '서버 계산'),
	) : null;
	const kvs = el('div', { class: 'kv-grid' },
		kv('플랜 ID', state.plan.id),
		kv('시스템', state.plan.system),
		kv('액션', state.plan.action),
		kv('인텐트', state.plan.intent),
		kv('수행자', state.plan.actor),
		kv('원본 텍스트', state.plan.sourceText),
		kv('계약', state.plan.refusal ? `refused: ${state.plan.refusal.reason}` : 'durable server CommandPlan'),
		kv('생성 시각', fmtTime(state.plan.createdAt)),
		kv('해시', state.plan.hash),
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
	if (!state.plan) return setChildren(box, empty('게이트를 확인하려면 플랜 미리보기를 생성하세요.'));
	const selected = selectedDocs().length;
	const gates = [
		['플랜 미리보기', true, `id ${state.plan.id}`],
		['대상 검토', state.plan.riskClass === 'read' || selected > 0, selected ? `${selected}개 선택됨` : '대상 행을 선택하세요'],
		['모의실행 필요', state.plan.riskClass === 'read' || state.dryRunPassed, state.plan.riskClass === 'read' ? '읽기 전용 플랜' : (state.dryRunPassed ? '통과' : '대기 중')],
		['플랜 해시 표시', !!state.plan.hash, state.plan.hash],
		['사람 확인', state.plan.riskClass === 'read' || state.dryRunPassed, state.plan.riskClass === 'read' ? '불필요' : '모의실행 후 활성화'],
		['감사 추적', true, '결재 감사 API 연결됨'],
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
		: [{ at: new Date().toISOString(), title: '플랜 대기 중', detail: '아직 준비된 명령이 없습니다.', kind: 'neutral' }];
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
			btn.textContent = `확정 실행 (${selected})`;
		}
	}
}

function approvalTitle(a) {
	return a.title || a.summary || '(제목 없음)';
}

function renderTargetsTable(selector, rows, { compact = false } = {}) {
	const box = $(selector);
	if (!box) return;
	if (state.approvalsError) return setChildren(box, errorBox(`결재 API 오류: ${state.approvalsError}`));
	if (!rows.length) return setChildren(box, empty('결재 레코드가 없습니다. 대상 검토 전에 동기화를 실행하세요.'));
	const table = el('table', {},
		el('thead', {}, el('tr', {},
			el('th', { class: 'col-check' }, ''),
			el('th', { class: 'col-key' }, '문서 키'),
			el('th', {}, '제목 / 요약'),
			el('th', { class: 'col-short' }, '기안자'),
			el('th', { class: 'col-short' }, '제출'),
			el('th', { class: 'col-status' }, '상태'),
		)),
	);
	const body = el('tbody');
	for (const a of rows) {
		const doc = safeText(a.doc_id);
		const checked = state.selectedTargets.has(doc);
		const cb = el('input', { type: 'checkbox', class: 'check', title: '대상 선택', dataset: { doc } });
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
	const caption = compact ? el('div', { class: 'panel-body border-top' }, `${rows.length}개 표시 / ${selected}개 선택됨`) : null;
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
	addTimeline('모의실행 요청됨', `대상 ${docs.length}개`);
	renderAll();
	const log = $('#job-log');
	if (log) {
		log.textContent = '';
		$('#job-log-badge').textContent = '모의실행';
		$('#job-log-badge').className = 'badge info';
	}
	try {
		const planId = state.plan.id; // capture now — the operator may switch plans while the job streams
		const data = await postJson(`/api/agent/plan/${encodeURIComponent(planId)}/dry-run`, { planHash: state.plan.hash, targetKeys: docs });
		state.activeApproveJob = data.job ? data.job.id : null; // track the id so the poll self-heals a pre-empted stream
		if (data.job) {
			streamJob(data.job.id, log || document.createElement('pre'), async () => {
				state.activeApproveJob = null;
				try {
					// Only fold the result into the view if we're STILL on this plan; otherwise refreshPlan(planId)
					// would clobber the newer plan the operator navigated to (cross-plan contamination).
					if (state.plan && state.plan.id === planId) {
						await refreshPlan(planId);
						const jr = await getJson(`/api/jobs/${encodeURIComponent(data.job.id)}/result`).catch(() => null);
						state.dryRunSummary = state.plan?.dryRun?.result || jr?.result || null;
						addTimeline(state.dryRunPassed ? '모의실행 통과' : '모의실행 종료', state.dryRunPassed ? '선택한 모든 대상이 dry-ok를 반환했습니다.' : '작업 로그와 가드 결과를 확인하세요.', state.dryRunPassed ? 'success' : 'warning');
					}
				} catch (e) {
					addTimeline('모의실행 상태 갱신 실패', e.message, 'warning');
				}
				loadQueue().finally(renderAll);
			});
			setView('queue');
		}
	} catch (e) {
		state.activeApproveJob = null;
		addTimeline('모의실행 거부됨', e.message, 'danger');
		renderAll();
		alert(`모의실행 거부됨: ${e.message}`);
	}
}

async function runLiveConfirm() {
	const docs = selectedDocs();
	if (!state.plan || !state.dryRunPassed || !docs.length) return;
	const msg = `선택한 문서 ${docs.length}건에 대해 실제 결재를 요청합니다.\n\n플랜: ${state.plan.id}\n해시: ${state.plan.hash}\n\n계속할까요?`;
	if (!window.confirm(msg)) return;
	state.activeApproveJob = true;
	addTimeline('사람 확인 완료', `실제 대상 ${docs.length}개 / 해시 ${state.plan.hash}`);
	renderAll();
	const log = $('#job-log');
	if (log) {
		log.textContent = '';
		$('#job-log-badge').textContent = '실제 결재';
		$('#job-log-badge').className = 'badge risk';
	}
	try {
		const planId = state.plan.id; // capture now — guard the onEnd refresh against a plan switch mid-job
		const data = await postJson(`/api/agent/plan/${encodeURIComponent(planId)}/confirm`, {
			planHash: state.plan.hash,
			targetSetHash: state.plan.targetSetHash,
			dryRunHash: state.plan.dryRun?.hash,
			confirm: true,
		});
		state.activeApproveJob = data.job ? data.job.id : null; // track the id so the poll self-heals a pre-empted stream
		if (data.job) {
			streamJob(data.job.id, log || document.createElement('pre'), async () => {
				state.activeApproveJob = null;
				try {
					if (state.plan && state.plan.id === planId) {
						await refreshPlan(planId);
						addTimeline('실제 작업 완료', '감사 API에서 requested/clicked/confirmed/skipped 이벤트를 확인할 수 있습니다.');
					}
				} catch (e) {
					addTimeline('상태 갱신 실패', e.message, 'warning');
				}
				Promise.allSettled([loadApprovals(), loadAudit(), loadQueue()]).then(renderAll);
			});
			setView('queue');
		}
	} catch (e) {
		state.activeApproveJob = null;
		addTimeline('실제 확정 거부됨', e.message, 'danger');
		renderAll();
		alert(`실제 확정 거부됨: ${e.message}`);
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
	setChildren(out, empty('/api/agent 호출 중...'));
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
		el('div', { class: 'badge-row' }, badge(`인텐트: ${intent.action || 'unknown'}`, statusKind(intent.action)), data.job ? badge(`작업: ${data.job.id}`, 'info') : null),
		el('div', { class: 'kv-grid' },
			kv('소스', source),
			kv('표면', data.surface || '-'),
			kv('비고', data.note || intent.question || '-'),
		),
	];
	if (data.job) {
		const log = el('pre', { class: 'joblog' });
		parts.push(log);
		streamJob(data.job.id, log, () => Promise.allSettled([loadApprovals(), loadQueue(), loadAudit()]).then(renderAll));
	}
	if (Array.isArray(data.approvals)) parts.push(renderGenericTable(data.approvals.slice(0, 50), ['doc_id', 'title', 'drafter', 'submitted_at', 'status'], '결재 후보'));
	if (Array.isArray(data.systems)) {
		for (const sys of data.systems) {
			parts.push(el('div', { class: 'notice neutral' }, `${sys.label || sys.system}: 레코드 ${(sys.records || []).length}건`));
			parts.push(renderGenericTable((sys.records || []).slice(0, 30).map((r) => ({ key: r.key, status: r.status, summary: r.summary, data: JSON.stringify(r.data || {}) })), ['key', 'status', 'summary', 'data'], '시스템 레코드'));
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
			['POST /api/agent/plan', '구현됨', '서버 해시 기반의 영속 커맨드 플랜을 생성합니다.'],
			['GET /api/agent/plan/:id', '구현됨', '새로고침 또는 작업 완료 후 플랜 상태를 다시 불러옵니다.'],
			['POST /api/agent/plan/:id/dry-run', '구현됨', '검토된 대상 집합을 저장하고 결정론적 모의실행을 큐에 넣습니다.'],
			['POST /api/agent/plan/:id/confirm', '구현됨', '세션/오리진 게이트, 모의실행 통과, 대상 해시, 사람 확인을 요구합니다.'],
			['GET /api/agent/plan/:id/events', '구현됨', '영속 커맨드 이벤트 타임라인.'],
			['GET /api/jobs/:id/result', '구현됨', '구조화된 작업 결과. UI는 더 이상 결재 로그를 파싱하지 않습니다.'],
		];
		setChildren(contract, renderRowsTable(rows, ['계약', '상태', '운영 영향']));
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
	if (state.systemsError) return setChildren(box, errorBox(`시스템 API 오류: ${state.systemsError}`));
	if (!state.systems.length) return setChildren(box, empty('등록된 시스템이 없습니다. 온보딩을 시작하려면 시스템을 저장하세요.'));
	const table = el('table', {},
		el('thead', {}, el('tr', {},
			el('th', { class: 'col-key' }, '시스템'),
			el('th', {}, '대상 URL'),
			el('th', { class: 'col-short' }, '레코드'),
			el('th', { class: 'col-status' }, '레시피'),
			el('th', { class: 'col-actions' }, '액션'),
		)),
	);
	const body = el('tbody');
	for (const s of state.systems) {
		const btn = el('button', { class: 'btn small', type: 'button' }, '열기');
		btn.addEventListener('click', () => selectSystem(s.name));
		body.append(el('tr', { class: state.selectedSystem === s.name ? 'row-selected' : '' },
			el('td', { class: 'col-key', title: `${s.name} / ${s.engine || DEFAULT_ENGINE}` }, `${s.label || s.name} (${s.engine || DEFAULT_ENGINE})`),
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

function ensureSystemEngineField() {
	if ($('#sys-engine')) return;
	const login = $('#sys-login');
	if (!login) return;
	const select = el('select', { id: 'sys-engine' }, ...ENGINES.map((engine) => el('option', { value: engine }, engine === 'playwright' ? 'Playwright' : engine)));
	const wrap = el('label', { class: 'input-wrap' }, el('span', {}, 'Engine'), select);
	login.closest('.input-wrap')?.before(wrap);
}

function renderSystemForm() {
	ensureSystemEngineField();
	const sys = selectedSystemObj();
	const badgeNode = $('#sys-selected-badge');
	if (!badgeNode) return;
	badgeNode.textContent = sys ? sys.name : '새 시스템';
	badgeNode.className = `badge ${sys ? 'info' : 'neutral'}`;
	if (!document.activeElement || !document.activeElement.closest('.systems-layout')) {
		$('#sys-name').value = sys?.name || state.selectedSystem || '';
		$('#sys-label').value = sys?.label || '';
		$('#sys-engine').value = sys?.engine || DEFAULT_ENGINE;
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
		engine: $('#sys-engine')?.value || DEFAULT_ENGINE,
		login_url: $('#sys-login').value.trim() || undefined,
		success_url: $('#sys-success').value.trim() || undefined,
		target_url: $('#sys-target').value.trim() || undefined,
		recipe,
	};
}

async function saveSystem() {
	let body;
	try { body = systemFormBody(); } catch (e) { alert(`레시피 JSON 형식이 올바르지 않습니다: ${e.message}`); return; }
	if (!body.name) { alert('시스템 이름은 필수입니다.'); return; }
	try {
		await postJson('/api/systems', body);
		state.selectedSystem = body.name;
		await loadSystems();
		renderSystems();
	} catch (e) {
		alert(`저장 거부됨: ${e.message}`);
	}
}

async function runSystemAction(action) {
	const name = $('#sys-name').value.trim() || state.selectedSystem;
	if (!name) return alert('먼저 시스템을 선택하거나 입력하세요.');
	if (action === 'delete' && !window.confirm(`${name} 시스템과 그 레코드를 삭제할까요?`)) return;
	const log = $('#sys-log');
	log.hidden = false;
	log.textContent = `${action} 요청됨...\n`;
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
		log.textContent += `거부됨: ${e.message}\n`;
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
	if (!state.selectedSystem) return setChildren(box, empty('레코드를 보려면 시스템을 선택하세요.'));
	if (state.recordsError) return setChildren(box, errorBox(state.recordsError));
	if (!state.records.length) return setChildren(box, empty(`${state.selectedSystem}: 현재 필터에 해당하는 레코드가 없습니다.`));
	const rows = state.records.map((r) => ({
		key: r.key,
		status: r.status,
		summary: r.summary,
		fetched_at: r.fetched_at,
		data: Object.entries(r.data || {}).slice(0, 6).map(([k, v]) => `${k}: ${v}`).join(' / '),
	}));
	setChildren(box, renderGenericTable(rows, ['key', 'data', 'summary', 'status', 'fetched_at'], '레코드'));
}

function renderActions() {
	const box = $('#actions-table');
	if (!box) return;
	if (state.actionsError) return setChildren(box, errorBox(state.actionsError));
	const rows = (state.actions || []).map((a) => ({
		system: a.system,
		action: a.action,
		engine: a.engine || '',
		risk: a.riskClass,
		state: a.state || (a.enabled ? 'enabled' : 'disabled'),
		requirements: a.disabledReason || [a.permission, a.dryRunRequired ? '모의실행' : '', a.humanConfirmRequired ? '사람 확인' : ''].filter(Boolean).join(' / '),
	}));
	setChildren(box, renderGenericTable(rows, ['system', 'action', 'risk', 'state', 'requirements'], '액션'));
}

function renderQueueGlobal() {
	const q = state.queue;
	if (!q) return;
	const dot = $('#side-queue-dot');
	const title = $('#side-queue-title');
	const sub = $('#side-queue-sub');
	if (dot) dot.className = `health-dot ${q.busy ? 'busy' : 'idle'}`;
	if (title) title.textContent = q.busy ? `실행 중 ${q.running?.id || ''}` : '큐 유휴';
	if (sub) sub.textContent = q.busy ? (q.running?.label || '브라우저 작업 실행 중') : `대기 ${q.pending?.length || 0}개 / 최근 ${q.recent?.length || 0}개`;
	renderQueueMini('#cc-queue');
}

function renderQueueMini(selector) {
	const box = $(selector);
	if (!box) return;
	const q = state.queue;
	if (!q) return setChildren(box, empty('큐 API를 불러오지 못했습니다.'));
	const rows = [
		['실행 여부', q.busy ? 'yes' : 'no'],
		['실행 중', q.running ? `${q.running.id} / ${q.running.label}` : 'none'],
		['대기', String(q.pending?.length || 0)],
		['최근', String(q.recent?.length || 0)],
	];
	setChildren(box, renderRowsTable(rows, ['항목', '값']));
}

function jobResultLabel(job) {
	if (!job || !job.result) return job?.status === 'done' ? '결과 없음' : '-';
	if (Array.isArray(job.result.results)) {
		const counts = job.result.results.reduce((m, r) => {
			const k = r.status || 'unknown';
			m[k] = (m[k] || 0) + 1;
			return m;
		}, {});
		return Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' ');
	}
	return job.result.status || '결과';
}

function renderQueueView() {
	const box = $('#queue-table');
	if (!box) return;
	const q = state.queue;
	if (state.queueError) return setChildren(box, errorBox(state.queueError));
	if (!q) return setChildren(box, empty('큐 API를 불러오지 못했습니다.'));
	const jobs = [];
	if (q.running) jobs.push(q.running);
	jobs.push(...(q.pending || []), ...(q.recent || []));
	const seen = new Set();
	const unique = jobs.filter((j) => j && !seen.has(j.id) && seen.add(j.id));
	if (!unique.length) return setChildren(box, empty('메모리에 작업이 없습니다.'));
	const table = el('table', {},
		el('thead', {}, el('tr', {},
			el('th', { class: 'col-key' }, '작업'),
			el('th', {}, '레이블'),
			el('th', { class: 'col-short' }, '종류'),
			el('th', { class: 'col-status' }, '상태'),
			el('th', { class: 'col-status' }, '결과'),
			el('th', { class: 'col-actions' }, '액션'),
		)),
	);
	const body = el('tbody');
	for (const j of unique) {
		const open = el('button', { class: 'btn small', type: 'button' }, '로그');
		open.addEventListener('click', () => openJobLog(j.id, j.label));
		const cancel = el('button', { class: 'btn small quiet', type: 'button' }, '취소');
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
	if (!rows.length) return setChildren(box, empty('현재 필터에 해당하는 감사 레코드가 없습니다.'));
	const mapped = rows.map((a) => ({
		at: a.at,
		doc_id: a.doc_id || '-',
		stage: a.stage || '-',
		mode: a.live === true ? '실제' : '모의',
		actor: a.actor || a.by || '-',
		detail: a.detail || '',
	}));
	setChildren(box, renderGenericTable(mapped, ['at', 'doc_id', 'stage', 'mode', 'actor', 'detail'], `감사 레코드 (${rows.length}/${state.auditTotal || rows.length})`));
}

async function renderApprovalState() {
	const box = $('#approval-state-card');
	if (!box) return;
	const app = $('#approval-app')?.value.trim() || state.selectedSystem || 'hiworks';
	try {
		const data = await getJson(`/api/approve/state?app=${encodeURIComponent(app)}`);
		const loginLog = el('pre', { class: 'job-log', hidden: true });
		const loginBtn = el('button', { class: 'btn small', type: 'button', onclick: () => runApproveLogin(app, loginBtn, loginLog) },
			data.loggedIn ? '🔐 결재 재로그인' : '🔐 결재 로그인');
		setChildren(box,
			el('div', { class: 'metric-grid' },
				metric('앱', data.app || app, '선택됨'),
				metric('로그인 여부', data.loggedIn ? 'yes' : 'no', 'approve/*.pw-state.json'),
				metric('레시피', data.hasApproveRecipe ? 'ready' : 'missing', `recipes/${app}.json`),
				metric('목록 URL', data.listUrl ? 'configured' : 'missing', '결재 대기함'),
			),
			el('div', { class: 'row' }, loginBtn),
			loginLog,
			data.loggedIn && data.hasApproveRecipe && data.listUrl
				? warnBox('검토된 결재는 모의실행할 수 있습니다. 실제 결재는 여전히 사람 확인과 서버 측 세션/오리진 게이트를 요구합니다.')
				: warnBox('로그인 상태, 레시피, 목록 URL이 모두 갖춰질 때까지 결재 액션은 비활성화됩니다.'),
		);
	} catch (e) {
		setChildren(box, errorBox(e.message));
	}
}

// 결재 로그인: trigger the headed Playwright login (approve/auth-pw.mjs) from the UI. A real Chrome window
// opens on the operator's desktop for ID/비번/OTP — credentials are NOT typed into the webui (irreducible
// human gesture). On success the leaf saves approve/<app>.pw-state.json and the job ends; we re-render state.
async function runApproveLogin(app, btn, log) {
	if (btn) { btn.disabled = true; btn.textContent = '로그인 창 대기 중…'; }
	if (log) { log.hidden = false; log.textContent = '데스크톱에 뜬 Chrome 창에서 로그인(OTP 포함)을 완료하세요…\n'; }
	try {
		const data = await postJson('/api/approve/login', { app });
		if (data.job) {
			streamJob(data.job.id, log || document.createElement('pre'), async () => {
				if (btn) { btn.disabled = false; }
				await renderApprovalState();
			});
		}
	} catch (e) {
		if (btn) { btn.disabled = false; btn.textContent = '🔐 결재 로그인'; }
		if (log) { log.textContent += `로그인 실행 거부: ${e.message}\n`; }
		alert(`결재 로그인 실패: ${e.message}`);
	}
}

async function requestKillSwitch() {
	if (!window.confirm('결재 긴급 중단을 요청할까요? 실행 중인 실제 배치는 다음 문서 전에 멈춥니다.')) return;
	try {
		await postJson('/api/approve/stop', {});
		alert('긴급 중단을 요청했습니다.');
		await loadAudit();
		renderAudit();
	} catch (e) {
		alert(`긴급 중단 실패: ${e.message}`);
	}
}

async function runSuite() {
	const glob = $('#run-glob').value.trim();
	const log = $('#run-log');
	log.hidden = false;
	log.textContent = '실행 요청됨...\n';
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
		log.textContent += `거부됨: ${e.message}\n`;
	}
}

function renderDiagnosticsLinks() {
	const box = $('#workspace-links');
	if (!box) return;
	const links = [
		['큐 API', '/api/queue', '현재 작업 직렬화 상태'],
		['시스템 API', '/api/systems', '등록된 시스템과 레코드 수'],
		['결재 API', '/api/approvals', '결재 대기 레코드'],
		['감사 API', '/api/approve/audit?limit=300', '추가 전용 결재 리프 감사'],
		['실행 API', '/api/runs', '과거 실행 리포트'],
		['플로우 API', '/api/flows', '녹화된 선언적 플로우'],
	];
	setChildren(box, el('div', { class: 'link-grid' }, ...links.map(([title, href, desc]) =>
		el('a', { class: 'link-card', href, target: '_blank', rel: 'noreferrer' }, el('strong', {}, title), el('span', {}, desc)),
	)));
}

function renderDiagnostics() {
	const box = $('#diagnostics-table');
	if (!box) return;
	const rows = [
		{ area: '실행', count: state.runs.length, state: state.runs.length ? `${state.runs[0].runId || 'loaded'}` : '레코드 없음', endpoint: '/api/runs' },
		{ area: '플로우', count: state.flows.length, state: state.flows.some((f) => f.needsReview) ? '검토 필요' : '로드됨', endpoint: '/api/flows' },
		{ area: '인증 상태', count: state.auth.length, state: state.auth.length ? state.auth.join(', ') : '없음', endpoint: '/api/auth' },
		{ area: '프리플라이트', count: '-', state: 'CLI 전용', endpoint: 'bash lib/preflight.sh' },
		{ area: '전체 스위트', count: '-', state: 'POST /api/run 로 실행 가능', endpoint: 'bash run.sh' },
	];
	setChildren(box, renderGenericTable(rows, ['area', 'count', 'state', 'endpoint'], '진단'));
}

function renderGenericTable(rows, columns, label) {
	if (!rows.length) return empty(`${label || '테이블'}에 표시할 행이 없습니다.`);
	const table = el('table', { 'aria-label': label || '데이터 테이블' },
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
	return renderGenericTable(mapped, columns, '행');
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
	$('#auto-auth').addEventListener('click', runAutomationAuth);
	$('#auto-start-record').addEventListener('click', () => startAutomationRecord(false));
	$('#auto-stop-record').addEventListener('click', stopAutomationRecord);
	$('#auto-refresh-flow').addEventListener('click', () => loadAutomationFlow());
	$('#auto-preview').addEventListener('click', createAutomationPreview);
	$('#auto-verify').addEventListener('click', verifyAutomationFlow);
	$('#auto-compile').addEventListener('click', compileAutomationFlow);
	$('#auto-run').addEventListener('click', runAutomationFlow);
	['#auto-record-url', '#auto-login-url', '#auto-success-url', '#auto-app', '#auto-goal'].forEach((sel) => $(sel)?.addEventListener('input', renderAutomation));
	$('#cc-sync').addEventListener('click', runApprovalsSync);
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

// Self-heal the approve gate. The single shared SSE stream (util.js) is pre-empted whenever another
// view opens a job log, so the dry-run/confirm onEnd that clears activeApproveJob may never fire. If
// the tracked approve job is no longer running/pending (it finished while pre-empted), clear the flag
// so the gate doesn't stay wedged until reload. Same self-heal role as flows.js reconcileFlowJob.
function reconcileApproveJob() {
	if (typeof state.activeApproveJob !== 'string') return; // null, or the brief pre-enqueue `true`
	const q = state.queue || {};
	const active = new Set([q.running && q.running.id, ...(q.pending || []).map((j) => j.id)].filter(Boolean));
	if (!active.has(state.activeApproveJob)) state.activeApproveJob = null;
}

function reconcileAutomationJobs() {
	const q = state.queue || {};
	const active = new Set([q.running && q.running.id, ...(q.pending || []).map((j) => j.id)].filter(Boolean));
	for (const key of ['recordJob', 'verifyJob', 'runJob']) {
		const id = state.automation[key];
		if (id && !active.has(id)) state.automation[key] = null;
	}
}

bindEvents();
loadCoreData();
setInterval(() => loadQueue().then(() => {
	reconcileApproveJob();
	reconcileAutomationJobs();
	if (state.view === 'queue') renderQueueView();
	if (state.view === 'automation') renderAutomation();
	renderCommandCenter();
}), 2500);
