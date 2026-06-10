import http from 'node:http';

export const RPA_FIXTURE_NOTE = 'Reviewed by fixture bot';
export const RPA_REVIEW_LONG_TEXT =
	'Escalate duplicate quarterly settlement adjustment for manual review because this button label is intentionally far too long';

function esc(s) {
	return String(s == null ? '' : s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function page(title, body, script = '') {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<title>${esc(title)}</title>
	<style>
		body { font-family: Arial, sans-serif; margin: 24px; color: #172033; }
		header { margin-bottom: 18px; }
		table { border-collapse: collapse; min-width: 720px; }
		th, td { border: 1px solid #c9d2e3; padding: 8px 10px; text-align: left; }
		th { background: #eef3f8; }
		label { display: inline-flex; gap: 8px; align-items: center; margin: 12px 0; }
		input, select, textarea, button { font: inherit; }
		textarea { display: block; width: 420px; min-height: 76px; }
		iframe { display: block; width: 460px; height: 120px; border: 1px solid #aab4c4; margin-top: 14px; }
		.status { margin-top: 12px; font-weight: 700; }
	</style>
</head>
<body>
${body}
${script ? `<script>${script}</script>` : ''}
</body>
</html>`;
}

function captureReadyScript() {
	return `
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitForInitialRecorderReset() {
	for (let i = 0; i < 80; i++) {
		if (sessionStorage.getItem('__aqa_buf') === '[]' && sessionStorage.getItem('__aqa_seq') === '0') return;
		await sleep(50);
	}
}
async function waitForRecorderInstalled(win) {
	for (let i = 0; i < 80; i++) {
		if (win && win.__aqaInstalled) return;
		await sleep(50);
	}
}
function setField(el, value) {
	el.focus();
	el.value = value;
	el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
}
`;
}

function renderJourneyStart(run, auto) {
	const script = auto ? `<script>${captureReadyScript()}
(async () => {
	await waitForInitialRecorderReset();
	await sleep(150);
	const select = document.getElementById('pageSelect');
	select.value = '2';
	select.dispatchEvent(new Event('change', { bubbles: true }));
})();</script>` : '';
	return page('RPA Fixture Work Orders', `
<header>
	<h1>Work Orders</h1>
	<p>Operations queue for deterministic local RPA coverage.</p>
</header>
<label for="pageSelect">Page</label>
<select id="pageSelect" onchange="if (this.value === '2') location.href = '/journey/page/2/${esc(run)}';">
	<option value="1" selected>1</option>
	<option value="2">2</option>
</select>
<table aria-label="Work Orders">
	<thead>
		<tr><th>Ticket</th><th>Subject</th><th>Status</th></tr>
	</thead>
	<tbody>
		<tr><td>WO-1001</td><td>Printer onboarding</td><td>Queued</td></tr>
		<tr><td>WO-1002</td><td>Access renewal</td><td>Queued</td></tr>
	</tbody>
</table>
${script}`);
}

function renderJourneyPage2(run, auto) {
	const script = auto ? `<script>${captureReadyScript()}
(async () => {
	await waitForRecorderInstalled(window);
	await sleep(220);
	document.querySelector('[data-testid="open-WO-2002"]').click();
})();</script>` : '';
	return page('RPA Fixture Work Orders Page 2', `
<header>
	<h1>Work Orders</h1>
	<p>Page 2</p>
</header>
<label for="pageSelect">Page</label>
<select id="pageSelect">
	<option value="1">1</option>
	<option value="2" selected>2</option>
</select>
<table aria-label="Work Orders">
	<thead>
		<tr><th>Ticket</th><th>Subject</th><th>Status</th></tr>
	</thead>
	<tbody>
		<tr>
			<td>WO-2001</td>
			<td><a data-testid="open-WO-2001" href="/journey/detail/WO-2001/${esc(run)}" title="Open WO-2001">Laptop refresh</a></td>
			<td>Queued</td>
		</tr>
		<tr>
			<td>WO-2002</td>
			<td><a data-testid="open-WO-2002" href="/journey/detail/WO-2002/${esc(run)}" title="Open WO-2002">Vendor review</a></td>
			<td>Needs review</td>
		</tr>
	</tbody>
</table>
${script}`);
}

function renderJourneyDetail(run, id, auto) {
	const script = auto ? `<script>${captureReadyScript()}
(async () => {
	await waitForRecorderInstalled(window);
	await sleep(250);
	setField(document.getElementById('reviewerNote'), ${JSON.stringify(RPA_FIXTURE_NOTE)});
	await sleep(100);
	document.getElementById('saveDraft').click();
	await sleep(250);
	const frame = document.getElementById('approvalFrame');
	await waitForRecorderInstalled(frame.contentWindow);
	for (let i = 0; i < 80; i++) {
		const btn = frame.contentDocument && frame.contentDocument.querySelector('[data-testid="frame-confirm"]');
		if (btn) { btn.click(); return; }
		await sleep(50);
	}
})();</script>` : '';
	return page(`RPA Fixture Detail ${id}`, `
<header>
	<h1>Work Order ${esc(id)}</h1>
	<p>Vendor review detail</p>
</header>
<section aria-label="Detail Summary">
	<p><strong>Status:</strong> Needs review</p>
	<p><strong>Owner:</strong> Ada Operations</p>
</section>
<form onsubmit="return false;">
	<label for="reviewerNote">Reviewer note</label>
	<textarea id="reviewerNote"></textarea>
	<button id="saveDraft" type="button" onclick="document.getElementById('draftStatus').textContent='Draft saved';">Save Draft</button>
</form>
<div id="draftStatus" class="status">Draft idle</div>
<iframe id="approvalFrame" name="approvalFrame" title="Approval Frame" src="/journey/frame/${esc(run)}"></iframe>
<div id="frame-status" class="status">Frame idle</div>
${script}`);
}

function renderJourneyFrame(run) {
	return page('RPA Fixture Frame', `
<h2>Embedded Approval</h2>
<button data-testid="frame-confirm" type="button" onclick="
	parent.document.getElementById('frame-status').textContent='Frame confirmed';
	fetch('/autorun-complete/${esc(run)}').catch(() => {});
">Confirm in frame</button>`);
}

function renderNeedsReview(run, auto) {
	const script = auto ? `<script>${captureReadyScript()}
(async () => {
	await waitForInitialRecorderReset();
	await sleep(180);
	document.getElementById('longReview').click();
})();</script>` : '';
	return page('RPA Fixture Needs Review', `
<h1>Needs Review Fixture</h1>
<button id="longReview" type="button">${esc(RPA_REVIEW_LONG_TEXT)}</button>
${script}`);
}

function renderHeaderlessList() {
	return page('RPA Fixture Headerless Queue', `
<h1>Headerless Work Queue</h1>
<table aria-label="Headerless Work Queue">
	<tbody>
		<tr>
			<td>HL-1</td>
			<td><a href="/headerless/detail/HL-1" title="Server Intake">Server Intake</a></td>
			<td>Min Park</td>
		</tr>
		<tr>
			<td>HL-2</td>
			<td><a href="/headerless/detail/HL-2" title="Warehouse Batch">Warehouse Batch</a></td>
			<td>Lee Ops</td>
		</tr>
	</tbody>
</table>`);
}

function renderHeaderlessDetail(id) {
	return page(`Headerless Detail ${id}`, `
<h1>Headerless Detail ${esc(id)}</h1>
<p>Opened from a table without column headers.</p>`);
}

function renderFailurePage() {
	return page('RPA Fixture Failure', `
<h1>Failure Fixture</h1>
<button type="button">Existing Action</button>`);
}

export async function startRpaFixtureServer() {
	const journeyRuns = new Map();
	const reviewRuns = new Set();

	const server = http.createServer((req, res) => {
		const url = new URL(req.url || '/', 'http://127.0.0.1');
		const parts = url.pathname.split('/').filter(Boolean);
		let status = 200;
		let html = '';

		try {
			if (parts[0] === 'journey' && parts[1] === 'start' && parts[2]) {
				const run = parts[2];
				let auto = false;
				if (!journeyRuns.has(run)) {
					journeyRuns.set(run, 'list1');
					auto = true;
				} else {
					auto = journeyRuns.get(run) === 'list1';
				}
				html = renderJourneyStart(run, auto);
			} else if (parts[0] === 'journey' && parts[1] === 'page' && parts[2] === '2' && parts[3]) {
				const run = parts[3];
				const auto = journeyRuns.get(run) === 'list1';
				if (auto) journeyRuns.set(run, 'page2');
				html = renderJourneyPage2(run, auto);
			} else if (parts[0] === 'journey' && parts[1] === 'detail' && parts[2] && parts[3]) {
				const id = parts[2];
				const run = parts[3];
				const auto = journeyRuns.get(run) === 'page2';
				if (auto) journeyRuns.set(run, 'detail');
				html = renderJourneyDetail(run, id, auto);
			} else if (parts[0] === 'journey' && parts[1] === 'frame' && parts[2]) {
				html = renderJourneyFrame(parts[2]);
			} else if (parts[0] === 'autorun-complete' && parts[1]) {
				journeyRuns.set(parts[1], 'complete');
				res.writeHead(204);
				res.end();
				return;
			} else if (parts[0] === 'needs-review' && parts[1]) {
				const run = parts[1];
				const auto = !reviewRuns.has(run);
				reviewRuns.add(run);
				html = renderNeedsReview(run, auto);
			} else if (parts[0] === 'headerless' && !parts[1]) {
				html = renderHeaderlessList();
			} else if (parts[0] === 'headerless' && parts[1] === 'detail' && parts[2]) {
				html = renderHeaderlessDetail(parts[2]);
			} else if (parts[0] === 'failure') {
				html = renderFailurePage();
			} else {
				status = 404;
				html = page('Not Found', '<h1>Not Found</h1>');
			}
		} catch (e) {
			status = 500;
			html = page('Fixture Error', `<pre>${esc(e && e.stack || e)}</pre>`);
		}

		res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
		res.end(html);
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		origin: `http://127.0.0.1:${server.address().port}`,
		runState: (run) => journeyRuns.get(run) || null,
		markComplete: (run) => journeyRuns.set(run, 'complete'),
		close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())),
	};
}
