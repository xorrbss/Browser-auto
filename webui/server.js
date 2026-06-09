// webui/server.js — the agent-qa local web UI server (P0: results dashboard).
//
// Raw node:http, ZERO npm dependencies, bound to 127.0.0.1 ONLY. It is a thin layer over
// the verified bash CLI: P0 only READS artifacts/ (no browser, no spawn). Later phases add
// a single-slot serial job queue (webui/jobs.js) + spawn (webui/spawn.js) for run/record.
//
// Routes (P0):
//   GET /                      -> webui/public/index.html
//   GET /app.js, /app.css, ... -> webui/public/* (static)
//   GET /api/runs              -> { runs: [summary...] }   (index.js, fs-authoritative)
//   GET /api/runs/:id          -> run detail (per-test rows) | 404
//   GET /artifacts/<path>      -> static file under artifacts/ with HTTP Range (video scrub)
// Routes (P1 — run trigger via the single-slot serial queue, jobs.js + spawn.js):
//   POST /api/run              -> enqueue `run.sh [glob]`; { job } (202)
//   GET  /api/queue            -> { busy, running, pending[], recent[] }  (serialization proof)
//   GET  /api/jobs/:id         -> job status | 404
//   GET  /api/jobs/:id/stream  -> SSE live log (replay buffer + live lines + end)
// Routes (P2 — recorder + flow editor, flows.js):
//   POST /api/record           -> enqueue record.cmd capture (headed, serial); { job, flow }
//   GET  /api/flows            -> [{ name, steps, needsReview, inputTokens, compiled }]
//   GET  /api/flows/:name      -> flow detail (steps, needsReviewSteps, values, compilable)
//   POST /api/flows/:name/resolve { step, candidate } -> pick a candidate (human flow.json edit)
//   POST /api/flows/:name/values  { values }          -> write the {{input_N}} sidecar
//   POST /api/verify           -> enqueue verify-repair re-drive (browser, serial); { job }
//   POST /api/compile          -> compile flow -> tests/<name>.test.sh (sync, daemon-free)
// Routes (P3 — trends + auth):
//   GET  /api/trends           -> { runs:[{passRate...}], tests:{name:[{status}]} } (read-only)
//   GET  /api/auth             -> { apps:[<cached state names>] }
//   POST /api/auth             -> enqueue setup/auth.sh (headed OTP, serial); { job, app }
//   POST /api/auth/:app/delete -> remove fixtures/auth/<app>.state.json; { ok, apps }
//   GET  /api/trends           -> { runs, tests } (also: artifacts retention prunes on startup)
//
// Run: `node webui/server.js`  (WEBUI_PORT overrides the default port).

import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { pipeline } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { listRuns, getRun, getTrends, pruneArtifacts, ARTIFACTS_DIR } from './index.js';
import { enqueue, jobStatus, jobResult, subscribe, queueState, cancel, stop, killRunning } from './jobs.js';
import { gitBash, recordCmd, nodeLeaf } from './spawn.js';
import { listFlows, getFlow, resolveStep, saveValues, validName, flowExists } from './flows.js';
import { listAuthStates, validApp, deleteAuthState } from './auth.js';
import { listApprovalsView } from './approvals.js';
import { rpaPost, rpaGet } from './routes-rpa.js';
import { approvePost, approveGet } from './routes-approve.js';
import { commandPlanPost, commandPlanGet, recordCommandGateRefusal } from './routes-command-plan.js';
import { issueSessionIfNeeded, approveGate } from './session.js';

const PUBLIC_DIR = path.join(import.meta.dirname, 'public');
// Bind address. Default 127.0.0.1 (localhost-only — the safe default for native Windows/macOS use).
// A 127.0.0.1 listener inside a container is unreachable through Docker's published port, so the
// Docker image sets WEBUI_HOST=0.0.0.0; that stays safe because compose publishes the port only to
// the host's 127.0.0.1 (to be fronted by an auth proxy), never to 0.0.0.0 on the host.
const HOST = process.env.WEBUI_HOST || '127.0.0.1';
const PORT = Number(process.env.WEBUI_PORT) || 4310;
// Host-header allowlist (DNS-rebinding defense): a malicious page can point a hostname at this
// loopback/published port from the victim's browser, but cannot forge a Host header we accept.
// Default localhost/127.0.0.1 (with and without :PORT). For a fronted deployment bound to 0.0.0.0,
// set WEBUI_ALLOWED_HOSTS (comma-separated host[:port]) to the proxy/public host(s) to accept.
const ALLOWED_HOSTS = new Set(
	(process.env.WEBUI_ALLOWED_HOSTS || `127.0.0.1:${PORT},localhost:${PORT},127.0.0.1,localhost`)
		.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
);
// artifacts retention (disk hygiene). Explicit parse so 0 ("keep none") is honored and a
// negative/NaN value can't slip through (a negative would otherwise prune ALL runs).
const _keep = Number(process.env.WEBUI_KEEP_RUNS);
const KEEP_RUNS = Number.isFinite(_keep) && _keep >= 0 ? Math.floor(_keep) : 50;

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8',
	'.webm': 'video/webm',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, code, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(code, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(body),
	});
	res.end(body);
}

const notFound = (res, msg = 'not found') => sendJson(res, 404, { error: msg });

// Collect a (small) request body. Rejects if it exceeds `limit` bytes.
function readBody(req, limit = 1 << 20) {
	return new Promise((resolve, reject) => {
		let data = '';
		let size = 0;
		req.on('data', (c) => {
			size += c.length;
			if (size > limit) {
				reject(new Error('body too large'));
				req.destroy();
			} else {
				data += c;
			}
		});
		req.on('end', () => resolve(data));
		req.on('error', reject);
	});
}

// Parse a JSON request body ({} when empty). Throws on malformed JSON (caller -> 400).
async function readJson(req) {
	const body = await readBody(req);
	return body.trim() ? JSON.parse(body) : {};
}

// Run a child to completion, capturing merged stdout+stderr. For the deterministic, NON-browser
// compile step (it never touches the daemon, so it does NOT go through the serial queue).
function runCapture(child) {
	return new Promise((resolve) => {
		let out = '';
		child.stdout?.on('data', (d) => (out += d));
		child.stderr?.on('data', (d) => (out += d));
		child.on('error', (e) => resolve({ code: -1, output: out + `\n[spawn error] ${e.message}` }));
		child.on('close', (c) => resolve({ code: c == null ? -1 : c, output: out }));
	});
}

// Resolve reqPath under base, refusing any traversal / NUL / absolute escape. Returns an
// absolute path guaranteed to sit inside base, or null.
function safeResolve(base, reqPath) {
	let decoded;
	try {
		decoded = decodeURIComponent(reqPath);
	} catch {
		return null;
	}
	if (decoded.includes('\0')) return null;
	// Anchor at "/" then posix-normalize so ".." can never climb above the root.
	const norm = path.posix.normalize('/' + decoded.replace(/\\/g, '/'));
	const full = path.join(base, '.' + norm);
	const rel = path.relative(base, full);
	if (rel === '') return full;
	if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
	return full;
}

// Stream a file to the response with a proper lifecycle. pipeline() destroys both ends on
// any error: a read error AFTER headers (file deleted/renamed mid-serve, EACCES, or a
// Windows sharing-violation/EBUSY when video.webm is still held open) destroys the socket
// instead of emitting an unhandled 'error' that would crash the whole single-process
// server; a client abort (browsers abort+re-issue Range reqs while scrubbing) destroys the
// read stream so its fd is not leaked. Headers are always written before this is called.
function streamFile(res, filePath, opts) {
	const s = opts ? createReadStream(filePath, opts) : createReadStream(filePath);
	pipeline(s, res, (err) => {
		// Premature close == normal client abort (scrub/seek); don't log it as an error.
		if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
			console.error('[webui] stream error:', err.code || err.message);
		}
	});
}

// Static file serve with HTTP Range support (so video.webm scrubbing works).
function serveFile(req, res, filePath) {
	let st;
	try {
		st = statSync(filePath);
	} catch {
		return notFound(res);
	}
	if (!st.isFile()) return notFound(res);

	const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
	const range = req.headers.range;

	if (range) {
		const m = /^bytes=(\d*)-(\d*)$/.exec(range);
		if (m && (m[1] !== '' || m[2] !== '')) {
			let start, end;
			if (m[1] === '') {
				// suffix range: last N bytes
				const n = parseInt(m[2], 10);
				start = Math.max(0, st.size - n);
				end = st.size - 1;
			} else {
				start = parseInt(m[1], 10);
				end = m[2] === '' ? st.size - 1 : Math.min(parseInt(m[2], 10), st.size - 1);
			}
			if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= st.size) {
				res.writeHead(416, {
					'Content-Type': type,
					'Content-Range': `bytes */${st.size}`,
					'Accept-Ranges': 'bytes',
				});
				return res.end();
			}
			res.writeHead(206, {
				'Content-Type': type,
				'Content-Range': `bytes ${start}-${end}/${st.size}`,
				'Accept-Ranges': 'bytes',
				'Content-Length': end - start + 1,
			});
			if (req.method === 'HEAD') return res.end();
			return streamFile(res, filePath, { start, end });
		}
	}

	res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes' });
	if (req.method === 'HEAD') return res.end();
	streamFile(res, filePath);
}

const server = http.createServer(async (req, res) => {
	try {
		// Host-header allowlist — DNS-rebinding defense. Applies to GET and POST (GET routes serve
		// artifacts/PII and have no Origin check), so reject before any routing or side effect.
		if (!ALLOWED_HOSTS.has((req.headers.host || '').toLowerCase())) {
			return sendJson(res, 403, { error: 'host not allowed' });
		}
		const url = new URL(req.url, `http://${HOST}:${PORT}`);
		const p = url.pathname;

		if (req.method === 'POST') {
			// CSRF guard: browsers send Origin on cross-origin POST. Refuse anything not from us
			// (these endpoints spawn processes; a malicious page must not drive them).
			const origin = req.headers.origin;
			if (origin) {
				let oh;
				try {
					oh = new URL(origin).host;
				} catch {
					return sendJson(res, 403, { error: 'bad origin' });
				}
				// Match the SAME allowlist as the Host-header guard (above) and the approve gate, so a
				// fronted/Docker deploy (WEBUI_HOST=0.0.0.0 / WEBUI_ALLOWED_HOSTS) accepts its real Origin
				// instead of 403'ing legit browsers before approveGate can run (red-team gate-review low).
				if (!ALLOWED_HOSTS.has(oh.toLowerCase())) {
					return sendJson(res, 403, { error: 'cross-origin POST refused' });
				}
			}
			// The EFFECTFUL auto-approve route clicks a REAL 확인 with no human, so it is gated STRICTER
			// than the general guard above: a PRESENT host-matching Origin/Referer (no absent-fall-through —
			// red-team R1/T8) AND a valid server session cookie (DESIGN §5). See webui/session.js.
			// Match confirm followed by EOL or ANY trailing segment (…/confirm/x): the route below
			// dispatches confirm on op===\'confirm\' regardless of trailing segments, so the gate must be a
			// SUPERSET of that shape — else /confirm/x bypasses the session+Origin gate and runs a LIVE
			// approve. The route also refuses the trailing-segment shape; the two now agree.
			const commandConfirm = /^\/api\/agent\/plans?\/[^/]+\/confirm(?:\/|$)/.test(p);
			if ((p.startsWith('/api/approve/') || commandConfirm) && approveGate(req, res, ALLOWED_HOSTS, sendJson)) {
				if (commandConfirm) {
					recordCommandGateRefusal(p, res.statusCode === 401 ? 'session_missing' : 'origin_or_referer_required', { httpStatus: res.statusCode });
				}
				return;
			}
			if (p === '/api/run') {
				let body;
				try {
					body = await readBody(req);
				} catch {
					return sendJson(res, 413, { error: 'body too large' });
				}
				let glob = '';
				if (body.trim()) {
					try {
						glob = String(JSON.parse(body).glob || '').trim();
					} catch {
						return sendJson(res, 400, { error: 'invalid JSON body' });
					}
				}
				// Restrict to a test-name glob so nothing shell-special reaches the CLI arg.
				if (glob && !/^[A-Za-z0-9_*?-]+$/.test(glob)) {
					return sendJson(res, 400, { error: 'invalid test glob' });
				}
				const label = glob ? `run.sh ${glob}` : 'run.sh (all)';
				const job = enqueue({ kind: 'run', label, spawnFn: () => gitBash('run.sh', glob ? [glob] : []) });
				return sendJson(res, 202, { job });
			}
			const mCancel = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(p);
			if (mCancel) {
				return cancel(mCancel[1]) ? sendJson(res, 200, { ok: true }) : notFound(res, 'no such job');
			}

			// --- P2: recorder + flow editor ---
			let bodyJson;
			try {
				bodyJson = await readJson(req);
			} catch {
				return sendJson(res, 400, { error: 'invalid JSON body' });
			}

			if (p === '/api/record') {
				const name = String(bodyJson.name || '').trim();
				const startUrl = String(bodyJson.startUrl || '').trim();
				const app = bodyJson.app ? String(bodyJson.app).trim() : '';
				let seconds = parseInt(bodyJson.seconds, 10);
				if (!Number.isFinite(seconds)) seconds = 120;
				seconds = Math.min(Math.max(seconds, 5), 1800); // clamp 5s..30min
				if (!validName(name)) return sendJson(res, 400, { error: 'invalid flow name (use [A-Za-z0-9_-])' });
				let parsedUrl;
				try {
					parsedUrl = new URL(startUrl);
				} catch {
					return sendJson(res, 400, { error: 'invalid startUrl' });
				}
				if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
					return sendJson(res, 400, { error: 'startUrl must be http(s)' });
				}
				if (app && !validName(app)) return sendJson(res, 400, { error: 'invalid app name' });
				// Re-recording overwrites flows/<name>.flow.json (and may lose manual resolutions);
				// require an explicit overwrite flag so it is never silent.
				if (flowExists(name) && bodyJson.overwrite !== true) {
					return sendJson(res, 409, { error: `flow '${name}' already exists — re-record will overwrite it`, exists: true });
				}
				// Per-recording stop-file the UI can touch for a graceful early finish (in tmpdir, not
				// the repo). jobs.stop() writes it; capture() watches it; runJob's finally removes it.
				const stopFile = path.join(os.tmpdir(), `aqa-stop-${name}-${Date.now()}`);
				const job = enqueue({
					kind: 'record',
					label: `record ${name} (${seconds}s)`,
					spawnFn: () => recordCmd(name, startUrl, { app: app || undefined, seconds, stopFile }),
					stopFile,
				});
				return sendJson(res, 202, { job, flow: name });
			}

			// Graceful early finish of a running recording (a COMPLETE capture; vs cancel's kill).
				// Body-less POST; sits after readJson, so the UI sends a "{}" body (see util.stopJob).
				const mStop = /^\/api\/jobs\/([^/]+)\/stop$/.exec(p);
				if (mStop) {
					return stop(mStop[1]) ? sendJson(res, 200, { ok: true }) : sendJson(res, 409, { error: 'job not stoppable (not a running recording)' });
				}

				if (p === '/api/verify') {
				const name = String(bodyJson.name || '').trim();
				if (!flowExists(name)) return sendJson(res, 400, { error: 'no such flow' });
				const job = enqueue({
					kind: 'verify',
					label: `verify ${name}`,
					spawnFn: () => gitBash('bin/probe-record.sh', ['verify', `flows/${name}.flow.json`]),
				});
				return sendJson(res, 202, { job });
			}

			if (p === '/api/compile') {
				const name = String(bodyJson.name || '').trim();
				if (!flowExists(name)) return sendJson(res, 400, { error: 'no such flow' });
				// compile is deterministic + daemon-free -> run directly (not via the serial queue).
				const { code, output } = await runCapture(gitBash('bin/probe-record.sh', ['compile', `flows/${name}.flow.json`]));
				return sendJson(res, 200, { ok: code === 0, code, output, testFile: code === 0 ? `tests/${name}.test.sh` : null });
			}

				// 결재/RPA routes (sync, NL command router, system registry) — see webui/routes-rpa.js.
				if (await commandPlanPost(p, bodyJson, res, { sendJson, enqueue, gitBash, nodeLeaf })) return;
				if (approvePost(p, bodyJson, res, { sendJson, enqueue, nodeLeaf })) return;
				if (await rpaPost(p, bodyJson, res, { sendJson, enqueue, gitBash })) return;

			if (p === '/api/auth') {
				const app = String(bodyJson.app || '').trim();
				const loginUrl = String(bodyJson.loginUrl || '').trim();
				const successUrl = String(bodyJson.successUrl || '').trim();
				if (!validApp(app)) return sendJson(res, 400, { error: 'invalid app name (use [A-Za-z0-9_-])' });
				let lu;
				try {
					lu = new URL(loginUrl);
				} catch {
					return sendJson(res, 400, { error: 'invalid loginUrl' });
				}
				if (lu.protocol !== 'http:' && lu.protocol !== 'https:') {
					return sendJson(res, 400, { error: 'loginUrl must be http(s)' });
				}
				if (!successUrl || successUrl.length > 2048 || successUrl.includes('\0')) {
					return sendJson(res, 400, { error: 'invalid successUrl' });
				}
				// setup/auth.sh opens headed Chrome for human OTP, then saves fixtures/auth/<app>.state.json.
				// Browser job -> through the single-slot serial queue. (successUrl is an inert arg via Git-Bash.)
				const job = enqueue({ kind: 'auth', label: `auth ${app}`, spawnFn: () => gitBash('setup/auth.sh', [app, loginUrl, successUrl]) });
				return sendJson(res, 202, { job, app });
			}

			const mAuthDel = /^\/api\/auth\/([^/]+)\/delete$/.exec(p);
			if (mAuthDel) {
				let app;
				try {
					app = decodeURIComponent(mAuthDel[1]);
				} catch {
					return sendJson(res, 400, { error: 'invalid app name' });
				}
				const r = await deleteAuthState(app);
				return r.ok ? sendJson(res, 200, { ok: true, apps: await listAuthStates() }) : sendJson(res, 400, r);
			}

			const mResolve = /^\/api\/flows\/([^/]+)\/resolve$/.exec(p);
			if (mResolve) {
				let fname;
				try {
					fname = decodeURIComponent(mResolve[1]);
				} catch {
					return notFound(res, 'no such flow');
				}
				const r = await resolveStep(fname, parseInt(bodyJson.step, 10), parseInt(bodyJson.candidate, 10));
				return r.ok ? sendJson(res, 200, { ok: true, flow: await getFlow(fname) }) : sendJson(res, 400, r);
			}

			const mValues = /^\/api\/flows\/([^/]+)\/values$/.exec(p);
			if (mValues) {
				let fname;
				try {
					fname = decodeURIComponent(mValues[1]);
				} catch {
					return notFound(res, 'no such flow');
				}
				const r = await saveValues(fname, bodyJson.values);
				return r.ok ? sendJson(res, 200, { ok: true, flow: await getFlow(fname) }) : sendJson(res, 400, r);
			}

			return notFound(res);
		}

		if (req.method !== 'GET' && req.method !== 'HEAD') {
			return sendJson(res, 405, { error: 'method not allowed' });
		}

		if (p === '/' || p === '/index.html') {
			issueSessionIfNeeded(req, res); // mint the approve session cookie (HttpOnly; SameSite=Strict) — see session.js
			return serveFile(req, res, path.join(PUBLIC_DIR, 'index.html'));
		}

		if (p === '/api/runs') {
			return sendJson(res, 200, { runs: await listRuns() });
		}

		const mRun = /^\/api\/runs\/([^/]+)$/.exec(p);
		if (mRun) {
			let id;
			try {
				id = decodeURIComponent(mRun[1]);
			} catch {
				return notFound(res, 'no such run'); // malformed %-escape -> 404, not 500
			}
			const run = await getRun(id);
			return run ? sendJson(res, 200, run) : notFound(res, 'no such run');
		}

		if (p === '/api/queue') {
			return sendJson(res, 200, queueState());
		}

		if (p === '/api/trends') {
			return sendJson(res, 200, await getTrends());
		}

		if (p === '/api/auth') {
			return sendJson(res, 200, { apps: await listAuthStates() });
		}

		if (p === '/api/approvals') {
			return sendJson(res, 200, { approvals: await listApprovalsView() });
		}

		if (approveGet(p, url, res, { sendJson })) return;
		if (commandPlanGet(p, url, res, { sendJson })) return;
		if (rpaGet(p, url, res, { sendJson, notFound })) return;

		if (p === '/api/flows') {
			return sendJson(res, 200, { flows: await listFlows() });
		}

		const mFlow = /^\/api\/flows\/([^/]+)$/.exec(p);
		if (mFlow) {
			let name;
			try {
				name = decodeURIComponent(mFlow[1]);
			} catch {
				return notFound(res, 'no such flow');
			}
			const flow = await getFlow(name);
			return flow ? sendJson(res, 200, flow) : notFound(res, 'no such flow');
		}

		const mJobResult = /^\/api\/jobs\/([^/]+?)\/result$/.exec(p);
		if (mJobResult) {
			const jr = jobResult(mJobResult[1]);
			return jr ? sendJson(res, 200, jr) : notFound(res, 'no such job');
		}

		const mJob = /^\/api\/jobs\/([^/]+?)(\/stream)?$/.exec(p);
		if (mJob) {
			const id = mJob[1];
			if (mJob[2]) {
				// SSE: subscribe() owns the response lifecycle (replay + live + end/close).
				if (!subscribe(id, res)) return notFound(res, 'no such job');
				return;
			}
			const js = jobStatus(id);
			return js ? sendJson(res, 200, js) : notFound(res, 'no such job');
		}

		if (p.startsWith('/artifacts/')) {
			const full = safeResolve(ARTIFACTS_DIR, p.slice('/artifacts'.length));
			return full ? serveFile(req, res, full) : notFound(res, 'bad path');
		}

		// Fall through: static asset from webui/public (app.js, app.css, favicon, ...).
		// serveFile() statSyncs in its own try/catch and 404s on miss/non-file, so no
		// existsSync pre-check (which would TOCTOU-throw a 500 and double-stat the file).
		const pub = safeResolve(PUBLIC_DIR, p);
		if (pub) return serveFile(req, res, pub);

		return notFound(res);
	} catch (e) {
		sendJson(res, 500, { error: String((e && e.message) || e) });
	}
});

server.on('error', (e) => {
	if (e.code === 'EADDRINUSE') {
		console.error(`[webui] port ${PORT} is already in use (set WEBUI_PORT to override).`);
	} else {
		console.error('[webui] server error:', e.message);
	}
	process.exit(1);
});

// Graceful shutdown: tree-kill any in-flight browser job so the run.sh -> agent-browser ->
// Chrome tree is not orphaned (an orphaned daemon wedges the next run). Then exit.
let shuttingDown = false;
function shutdown(sig) {
	if (shuttingDown) return;
	shuttingDown = true;
	console.log(`[webui] ${sig} — killing any running job and exiting`);
	killRunning();
	server.close();
	process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
	console.log(`[webui] listening on http://${HOST}:${PORT}`);
	console.log(`[webui] artifacts: ${ARTIFACTS_DIR}`);
	pruneArtifacts(KEEP_RUNS).then((r) => {
		if (r.pruned.length) console.log(`[webui] pruned ${r.pruned.length} old run dir(s), kept newest ${r.kept} (WEBUI_KEEP_RUNS=${KEEP_RUNS})`);
	});
});
