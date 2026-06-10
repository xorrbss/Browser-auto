import http from 'node:http';

const rows = [
	{ id: 'RPA-1001', subject: 'Laptop request', owner: 'Alice', status: 'New', amount: '1200' },
	{ id: 'RPA-1002', subject: 'VPN access', owner: 'Bob', status: 'Waiting', amount: '0' },
	{ id: 'RPA-2001', subject: 'Quarterly approval', owner: 'Carol', status: 'Review', amount: '4500' },
	{ id: 'RPA-2002', subject: 'Invoice dry run', owner: 'Drew', status: 'Ready', amount: '800' },
];

const esc = (value) => String(value == null ? '' : value)
	.replace(/&/g, '&amp;')
	.replace(/</g, '&lt;')
	.replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;');

function page(title, body) {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<title>${esc(title)}</title>
	<style>
		body { font-family: Arial, sans-serif; margin: 24px; color: #172026; }
		main { max-width: 900px; }
		table { border-collapse: collapse; width: 100%; margin: 12px 0; }
		th, td { border: 1px solid #cfd7df; padding: 8px 10px; text-align: left; }
		label { display: block; margin: 10px 0; }
		input, select, textarea, button { font: inherit; min-height: 32px; }
		button, a.button { padding: 7px 10px; border: 1px solid #7c8792; background: #fff; color: #172026; cursor: pointer; }
		.notice { margin-top: 12px; padding: 10px; border: 1px solid #a7d2a9; background: #eef9ef; }
		iframe { width: 100%; min-height: 180px; border: 1px solid #cfd7df; }
	</style>
</head>
<body>
<main>${body}</main>
</body>
</html>`;
}

function ticketRows(pageNumber) {
	const slice = pageNumber === 2 ? rows.slice(2) : rows.slice(0, 2);
	return slice.map((r) => `<tr>
	<td><a title="${esc(r.id)}" href="/tickets/${encodeURIComponent(r.id)}">${esc(r.id)}</a></td>
	<td>${esc(r.subject)}</td>
	<td>${esc(r.owner)}</td>
	<td>${esc(r.status)}</td>
</tr>`).join('');
}

function ticketsPage() {
	return page('RPA Tickets', `<h1>RPA Tickets</h1>
<label for="pagePicker">Page</label>
<select id="pagePicker" aria-label="Page">
	<option value="1">1</option>
	<option value="2">2</option>
</select>
<table aria-label="RPA Tickets">
	<thead><tr><th>ID</th><th>Subject</th><th>Owner</th><th>Status</th></tr></thead>
	<tbody id="ticketBody">${ticketRows(1)}</tbody>
</table>
<script>
const rows = { "1": ${JSON.stringify(ticketRows(1))}, "2": ${JSON.stringify(ticketRows(2))} };
document.getElementById('pagePicker').addEventListener('change', (event) => {
	const body = document.getElementById('ticketBody');
	body.innerHTML = rows[event.target.value] || rows["1"];
});
</script>`);
}

function detailPage(id) {
	const row = rows.find((r) => r.id === id) || rows[0];
	return page('Ticket Detail', `<h1>Ticket Detail ${esc(row.id)} ${esc(row.subject)}</h1>
<table aria-label="Ticket Detail">
	<tbody>
		<tr><th scope="row">Ticket ID</th><td>${esc(row.id)}</td></tr>
		<tr><th scope="row">Owner</th><td>${esc(row.owner)}</td></tr>
		<tr><th scope="row">Amount</th><td>${esc(row.amount)}</td></tr>
		<tr><th scope="row">Status</th><td>${esc(row.status)}</td></tr>
	</tbody>
</table>
<p>${esc(row.subject)} requires deterministic local processing for ${esc(row.owner)}.</p>
<label>Resolution note <textarea id="resolution"></textarea></label>
<button type="button" id="saveResolution">Save resolution</button>
<div id="detailStatus" class="notice">Detail ready</div>
<script>
document.getElementById('saveResolution').addEventListener('click', () => {
	document.getElementById('detailStatus').textContent = 'Resolution saved: ' + document.getElementById('resolution').value;
});
</script>`);
}

function basicFormPage() {
	return page('Basic Form', `<h1>Basic Form</h1>
<label>Requester <input id="requester" autocomplete="off"></label>
<label>Request type
	<select id="requestType">
		<option value="hardware">Hardware</option>
		<option value="access">Access</option>
	</select>
</label>
<button type="button" id="submitForm">Submit request</button>
<div id="formStatus" class="notice">Waiting</div>
<script>
document.getElementById('submitForm').addEventListener('click', () => {
	document.getElementById('formStatus').textContent =
		'Submitted ' + document.getElementById('requester').value + ' / ' + document.getElementById('requestType').value;
});
</script>`);
}

function headerlessPage() {
	return page('Headerless Work', `<h1>Headerless Work</h1>
<table aria-label="Headerless Work">
	<tbody>
		<tr><td>select</td><td>id</td><td>subject</td><td>owner</td></tr>
		<tr><td><button type="button">open</button></td><td>HL-1</td><td>Headerless one</td><td>Ada</td></tr>
		<tr><td><button type="button">open</button></td><td>HL-2</td><td>Headerless two</td><td>Grace</td></tr>
	</tbody>
</table>`);
}

function iframeFormPage() {
	return page('Iframe Form', `<h1>Iframe Form</h1>
<iframe id="rpaFrame" name="rpaFrame" title="RPA Same Origin Frame" src="/frame-form"></iframe>`);
}

function frameFormPage() {
	return page('Frame Inner Form', `<h1>Frame Inner Form</h1>
<label>Frame note <input id="frameNote" autocomplete="off"></label>
<button type="button" id="frameSave">Save frame note</button>
<div id="frameStatus" class="notice">Frame waiting</div>
<script>
document.getElementById('frameSave').addEventListener('click', () => {
	document.getElementById('frameStatus').textContent = 'Frame saved: ' + document.getElementById('frameNote').value;
});
</script>`);
}

function needsReviewPage(otherOrigin) {
	return page('Needs Review', `<h1>Needs Review</h1>
<button type="button">Escalate</button>
<button type="button">Escalate</button>
<iframe id="xoFrame" name="xoFrame" title="Cross Origin Review" src="${esc(otherOrigin)}/xo-frame"></iframe>`);
}

function crossOriginFramePage() {
	return page('Cross Origin Frame', `<h1>Cross Origin Frame</h1>
<button data-testid="xo-approve" type="button">Cross approve</button>`);
}

export async function createRpaFixture() {
	let otherOrigin = '';
	const other = http.createServer((req, res) => {
		res.setHeader('content-type', 'text/html; charset=utf-8');
		if ((req.url || '').split('?')[0] === '/xo-frame') res.end(crossOriginFramePage());
		else res.end(page('Other Origin', '<p>Other origin</p>'));
	});
	await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
	otherOrigin = `http://127.0.0.1:${other.address().port}`;

	const main = http.createServer((req, res) => {
		const route = (req.url || '/').split('?')[0];
		res.setHeader('content-type', 'text/html; charset=utf-8');
		if (route === '/' || route === '/tickets') res.end(ticketsPage());
		else if (route.startsWith('/tickets/')) res.end(detailPage(decodeURIComponent(route.slice('/tickets/'.length))));
		else if (route === '/basic-form') res.end(basicFormPage());
		else if (route === '/headerless') res.end(headerlessPage());
		else if (route === '/iframe-form') res.end(iframeFormPage());
		else if (route === '/frame-form') res.end(frameFormPage());
		else if (route === '/needs-review') res.end(needsReviewPage(otherOrigin));
		else { res.statusCode = 404; res.end(page('Not Found', '<p>Not found</p>')); }
	});
	await new Promise((resolve) => main.listen(0, '127.0.0.1', resolve));
	const origin = `http://127.0.0.1:${main.address().port}`;
	return {
		origin,
		otherOrigin,
		rows,
		close: async () => {
			await Promise.all([
				new Promise((resolve) => main.close(resolve)),
				new Promise((resolve) => other.close(resolve)),
			]);
		},
	};
}

export function rpaFixtureRecipe() {
	return {
		collection: { name: 'RPA Tickets' },
		key: 'id',
		columns: { id: 'ID', subject: 'Subject', owner: 'Owner', status: 'Status' },
		columnIndexes: { id: 0, subject: 1, owner: 2, status: 3 },
		pagination: { mode: 'combobox' },
		ready: { text: 'RPA Tickets', timeout: 2 },
		detail: {
			idLabel: 'Ticket ID',
			fields: { owner: 'Owner', amount: 'Amount', status: 'Status' },
			bodyFromHeadingLevel: 1,
			ready: { text: 'Ticket Detail', timeout: 2 },
			urlGlob: '**/tickets/**',
		},
	};
}
