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
//   GET /artifacts/<path>      -> static file under artifacts/ (HTTP Range supported)
// Routes (P1 — run trigger via the single-slot serial queue, jobs.js + spawn.js):
//   POST /api/run              -> enqueue `run.sh [glob]`; { job } (202)
//   POST /api/dev-integration-readonly -> enqueue exact-allowlist read-only non-local replay
//   GET  /api/queue            -> { busy, running, pending[], recent[] }  (serialization proof)
//   GET  /api/jobs/:id         -> job status | 404
//   GET  /api/jobs/:id/stream  -> SSE live log (replay buffer + live lines + end)
// Routes (P2 — recorder + flow editor, flows.js):
//   POST /api/record           -> enqueue headed Playwright capture (serial); { job, flow }
//   GET  /api/flows            -> [{ name, steps, needsReview, inputTokens, compiled }]
//   GET  /api/flows/:name      -> flow detail (steps, needsReviewSteps, values, compilable)
//   POST /api/flows/:name/resolve { step, candidate } -> pick a candidate (human flow.json edit)
//   POST /api/flows/:name/resolve-clicked-record { step, recipe, field? } -> dynamic clicked-row-position open
//   POST /api/flows/:name/values  { values }          -> write the {{input_N}} sidecar
//   GET  /api/flows/blocked-report -> static blocked-flow metadata; no replay, auth, values, or artifacts
//   POST /api/verify           -> enqueue verify-repair re-drive (browser, serial); { job }
//   POST /api/compile          -> compile flow -> tests/<name>.test.sh (sync)
// Routes (P3 — trends + auth):
//   GET  /api/trends           -> { runs:[{passRate...}], tests:{name:[{status}]} } (read-only)
//   GET  /api/auth             -> { apps:[<cached state names>] }
//   POST /api/auth             -> enqueue setup/auth.sh (headed OTP, serial); { job, app }
//   POST /api/auth/:app/delete -> remove the cached auth state; { ok, apps }
//   GET  /api/trends           -> { runs, tests } (also: artifacts retention prunes on startup)
//   GET  /api/readiness        -> P0 checklist summary (read-only; not a security attestation)
//
// Run: `node webui/server.js`  (WEBUI_PORT overrides the default port).

import http from 'node:http';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { listRuns, getRun, getTrends, pruneArtifacts, ARTIFACTS_DIR } from './index.js';
import { enqueue, jobStatus, jobResult, subscribe, queueState, cancel, stop, killRunning } from './jobs.js';
import { gitBash, recordCmd, nodeLeaf } from './spawn.js';
import { listFlows, getFlow, resolveStep, resolveClickedRecordStep, saveValues, validName, flowExists } from './flows.js';
import { getWebuiBlockedFlowReportSafe } from './blocked-flows.js';
import { getSystemView } from './systems.js';
import { listAuthStates, listAuthStateSummaries, validApp, deleteAuthState } from './auth.js';
import { listApprovalsView } from './approvals.js';
import { rpaPost, rpaGet } from './routes-rpa.js';
import { approvePost, approveGet } from './routes-approve.js';
import { commandPlanPost, commandPlanGet, recordCommandGateRefusal } from './routes-command-plan.js';
import { issueSessionIfNeeded, approveGate } from './session.js';
import { getP0Readiness } from './readiness.js';
import { actorAccessView, authorizeWebuiPost, authorizeWebuiRequest } from './access.js';
import { applySecurityHeaders, authorizeCorsPreflight, authorizeHttpRequest, logoutSessionFromRequest, securityModeSummary } from './security.js';
import { redactObject, redactText } from './redact.js';
import { staticFilePolicy } from './secrets.js';
import { authorizeNoVncRoute, isNoVncRoutePath, noVncRegistryFromEnv, parseNoVncRoute, publicNoVncSession } from './novnc.js';
import { artifactRouteMetadata, authorizeArtifactRead } from './retention.js';
import { createDurableRunnerApiStore, createEnvRunnerIdentityResolver, runnerApiPost } from './runner-routes.js';
import { createSecretMigrationRoutes } from './secret-migration-routes.js';
import { tenantDeletionPost, tenantDeletionGet } from './tenant-deletion-routes.js';
import { releaseChecklistGet } from './release-checklist.js';

const require = createRequire(import.meta.url);
const { createAuditOutboxScheduler } = require('../lib/audit-outbox-scheduler.js');
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
const NOVNC_SESSIONS = noVncRegistryFromEnv(process.env);
const RUNNER_API_STORE = createDurableRunnerApiStore();
const RUNNER_API_IDENTITY = createEnvRunnerIdentityResolver(process.env);
const SECRET_MIGRATION_ROUTES = createSecretMigrationRoutes();
const AUDIT_OUTBOX_SCHEDULER = createAuditOutboxScheduler({ env: process.env });
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

function sendJson(res, code, obj, req = null) {
	const body = JSON.stringify(obj);
	applySecurityHeaders(res, { req });
	res.writeHead(code, {
		'Content-Type': 'application/json; charset=utf-8',
		'Content-Length': Buffer.byteLength(body),
	});
	res.end(body);
}

const notFound = (res, msg = 'not found') => sendJson(res, 404, { error: msg });

function denyAccess(res, decision) {
	return sendJson(res, 403, {
		error: 'forbidden',
		reason: decision.reason || 'permission denied',
		actor: decision.actor,
		tenantId: decision.tenantId,
		routeFamily: decision.routeFamily,
		requiredPermissions: decision.requiredPermissions,
	});
}

function noVncUnavailableBody(decision) {
	return {
		error: 'noVNC proxy disabled',
		reason: 'WebUI noVNC routes are authorization-only stubs and do not proxy or start noVNC',
		session: decision.session,
	};
}

function noVncDeniedBody(decision) {
	return {
		error: decision.error || 'forbidden',
		reason: decision.reason || 'noVNC access denied',
		tenantId: decision.tenantId,
		actor: decision.actor,
		requiredPermissions: decision.requiredPermissions,
	};
}

function authorizeNoVncRequest(req, url) {
	if (NOVNC_SESSIONS.error) {
		return {
			ok: false,
			code: 503,
			error: 'noVNC session registry unavailable',
			reason: NOVNC_SESSIONS.error,
		};
	}
	return authorizeNoVncRoute({
		registry: NOVNC_SESSIONS.registry,
		route: parseNoVncRoute(url),
		context: requestContext(req),
	});
}

function handleNoVncHttp(req, res, url) {
	const decision = authorizeNoVncRequest(req, url);
	if (!decision.ok) return sendJson(res, decision.code || 403, noVncDeniedBody(decision));
	return sendJson(res, 503, noVncUnavailableBody(decision));
}

function requestContext(req) {
	return req.context || req.security?.context || req.security || process.env;
}

function noVncTenantId(context) {
	return String(context?.tenantId || context?.tenant?.id || context?.actor?.tenantId || process.env.WEBUI_TENANT_ID || process.env.AQA_TENANT_ID || 'local').trim() || 'local';
}

function noVncActor(context) {
	return {
		id: String(context?.actor?.id || process.env.WEBUI_ACTOR_ID || process.env.AQA_ACTOR_ID || 'local').trim() || 'local',
		role: String(context?.actor?.role || process.env.WEBUI_ACTOR_ROLE || process.env.AQA_ACTOR_ROLE || 'operator').trim() || 'operator',
	};
}

function modelsNoVncSession(kind) {
	return ['record', 'auth'].includes(String(kind || ''));
}

function settleNoVncSessionForJob(job) {
	if (!job?.id || !NOVNC_SESSIONS.registry) return;
	const opts = { tenantId: job.tenantId, now: Date.now() };
	if (job.cancelled || job.status === 'cancelled' || job.durableStatus === 'canceled' || job.durableStatus === 'canceling') {
		NOVNC_SESSIONS.registry.cancelJob(job.id, { ...opts, reason: 'cancel' });
		return;
	}
	if (job.timedOut || job.durableStatus === 'expired') {
		NOVNC_SESSIONS.registry.expireJob(job.id, { ...opts, reason: 'timeout' });
		return;
	}
	NOVNC_SESSIONS.registry.finishJob(job.id, { ...opts, reason: 'job-complete' });
}

function withNoVncLifecycle(spec) {
	if (!modelsNoVncSession(spec?.kind)) return spec;
	const original = spec.onFinish;
	return {
		...spec,
		onFinish(job) {
			settleNoVncSessionForJob(job);
			if (typeof original === 'function') original(job);
		},
	};
}

function enqueueForRequest(req) {
	const context = requestContext(req);
	return (spec) => {
		const wrapped = withNoVncLifecycle(spec);
		const job = enqueue({ ...wrapped, context });
		if (!modelsNoVncSession(spec?.kind) || !NOVNC_SESSIONS.registry) return job;
		const session = NOVNC_SESSIONS.registry.allocate({
			tenantId: noVncTenantId(context),
			jobId: job.id,
			actor: noVncActor(context),
			createdAt: new Date().toISOString(),
		});
		return { ...job, noVncSession: publicNoVncSession(session) };
	};
}

function childEnvForRequest(req, extraEnv = null) {
	const context = requestContext(req);
	const tenantId = String(context?.tenantId || context?.tenant?.id || context?.actor?.tenantId || '').trim();
	const actorId = String(context?.actor?.id || context?.actorId || '').trim();
	const env = { ...(extraEnv || {}) };
	if (tenantId) {
		env.AQA_TENANT_ID = tenantId;
		env.WEBUI_TENANT_ID = tenantId;
	}
	if (actorId) {
		env.AQA_ACTOR_ID = actorId;
		env.WEBUI_ACTOR_ID = actorId;
	}
	return Object.keys(env).length ? env : null;
}

function gitBashForRequest(req) {
	return (script, args = [], extraEnv = null) => gitBash(script, args, childEnvForRequest(req, extraEnv));
}

function nodeLeafForRequest(req) {
	return (script, args = [], extraEnv = null) => nodeLeaf(script, args, childEnvForRequest(req, extraEnv));
}

function requireRouteAccess(req, p, bodyJson, res, method = req.method) {
	const decision = authorizeWebuiRequest(method, p, bodyJson || {}, requestContext(req));
	if (decision.ok) return true;
	denyAccess(res, decision);
	return false;
}

function requirePostAccess(req, p, bodyJson, res) {
	const decision = authorizeWebuiPost(p, bodyJson || {}, requestContext(req));
	if (decision.ok) return true;
	denyAccess(res, decision);
	return false;
}

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
// Compile is synchronous and does not drive a browser, so it does not go through the serial queue.
function runCapture(child) {
	return new Promise((resolve) => {
		let out = '';
		child.stdout?.on('data', (d) => (out += d));
		child.stderr?.on('data', (d) => (out += d));
		child.on('error', (e) => resolve({ code: -1, output: out + `\n[spawn error] ${e.message}` }));
		child.on('close', (c) => resolve({ code: c == null ? -1 : c, output: out }));
	});
}

function requirePlaywrightEngine(value, label) {
	if (value && value !== 'playwright') throw new Error(`${label}: WebUI is Playwright-only`);
	return 'playwright';
}

function normalizeExactTargetAllowlist(value, fallback = '') {
	const raw = String(value || fallback || '').trim();
	const entries = raw.split(',').map((entry) => entry.trim()).filter(Boolean);
	if (!entries.length) throw new Error('target allowlist is required');
	const origins = [];
	for (const entry of entries) {
		if (entry.includes('*')) throw new Error('target allowlist must use exact origins, not wildcards');
		let url;
		try {
			url = new URL(entry);
		} catch {
			throw new Error('target allowlist entries must be http(s) URLs');
		}
		if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('target allowlist entries must be http(s)');
		if (url.username || url.password) throw new Error('target allowlist entries must not contain credentials');
		if (url.pathname !== '/' || url.search || url.hash) throw new Error('target allowlist entries must be origins only');
		origins.push(url.origin);
	}
	return [...new Set(origins)].join(',');
}

const COMPILED_TEST_BLOCKER = 'compiled test is missing or older than the flow';

function devReadonlyScenarioBlocker(flow, { validateOnly }) {
	if (flow.runnable) return '';
	const reasons = Array.isArray(flow.scenarioStatus?.reasons) ? flow.scenarioStatus.reasons : [];
	const blockers = validateOnly ? reasons.filter((reason) => reason !== COMPILED_TEST_BLOCKER) : reasons;
	return blockers[0] || (!validateOnly ? flow.runBlockedReason : '') || '';
}

function normalizeJsonEnvValue(value, label) {
	const raw = String(value || '').trim();
	if (!raw) return '';
	if (raw.length > 65536) throw new Error(`${label} is too large`);
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(`${label} must be JSON`);
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${label} must be a JSON object`);
	return JSON.stringify(parsed);
}

function startUrlOrigin(value) {
	try {
		const url = new URL(String(value || ''));
		if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
	} catch {}
	return '';
}

function systemAuthSpawn(_engine, app, loginUrl, successUrl) {
	return gitBash('setup/auth.sh', [app, loginUrl, successUrl]);
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
// Windows sharing-violation/EBUSY while an artifact is still held open) destroys the socket
// instead of emitting an unhandled 'error' that would crash the whole single-process
// server; a client abort destroys the read stream so its fd is not leaked. Headers are
// always written before this is called.
function streamFile(res, filePath, opts) {
	const s = opts ? createReadStream(filePath, opts) : createReadStream(filePath);
	pipeline(s, res, (err) => {
		// Premature close == normal client abort (scrub/seek); don't log it as an error.
		if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
			console.error('[webui] stream error:', err.code || err.message);
		}
	});
}

function redactedTextBody(filePath) {
	const raw = readFileSync(filePath, 'utf8');
	const ext = path.extname(filePath).toLowerCase();
	if (ext === '.json') {
		try {
			return JSON.stringify(redactObject(JSON.parse(raw), 0), null, 2) + '\n';
		} catch {
			return redactText(raw, '', 0);
		}
	}
	if (ext === '.jsonl') {
		return raw.split(/\r?\n/).map((line) => {
			if (!line.trim()) return '';
			try {
				return JSON.stringify(redactObject(JSON.parse(line), 0));
			} catch {
				return redactText(line, '', 0);
			}
		}).join('\n');
	}
	// Whitespace-significant artifacts (results.tsv, aligned .txt/.log) must keep their column
	// structure; preserveWhitespace redacts secrets without collapsing tabs/runs of spaces.
	return raw.split(/\r?\n/).map((line) => redactText(line, '', 0, { preserveWhitespace: true })).join('\n');
}

function serveRedactedTextFile(req, res, filePath, type) {
	let body;
	try {
		body = redactedTextBody(filePath);
	} catch {
		return notFound(res);
	}
	applySecurityHeaders(res);
	res.setHeader('X-AQA-Redaction', 'applied');
	res.writeHead(200, {
		'Content-Type': type,
		'Content-Length': Buffer.byteLength(body),
		'Accept-Ranges': 'none',
		'Cache-Control': 'no-store',
	});
	if (req.method === 'HEAD') return res.end();
	res.end(body);
}

// Static artifact serve with HTTP Range support.
function serveFile(req, res, filePath, opts = {}) {
	let st;
	try {
		st = statSync(filePath);
	} catch {
		return notFound(res);
	}
	if (!st.isFile()) return notFound(res);

	const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
	if (opts.redact) return serveRedactedTextFile(req, res, filePath, type);

	const range = req.headers.range;
	applySecurityHeaders(res);

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
		applySecurityHeaders(res, { req });
		// Host-header allowlist — DNS-rebinding defense. Applies to GET and POST (GET routes serve
		// artifacts/PII and have no Origin check), so reject before any routing or side effect.
		if (!ALLOWED_HOSTS.has((req.headers.host || '').toLowerCase())) {
			return sendJson(res, 403, { error: 'host not allowed' });
		}
		const url = new URL(req.url, `http://${HOST}:${PORT}`);
		const p = url.pathname;
		if (req.method === 'OPTIONS') {
			const cors = authorizeCorsPreflight(req);
			if (!cors.ok) return sendJson(res, cors.code || 403, { error: cors.error || 'cors preflight refused', reason: cors.reason }, req);
			for (const [key, value] of Object.entries(cors.headers || {})) res.setHeader(key, value);
			res.writeHead(cors.code || 204, { 'Content-Length': 0 });
			return res.end();
		}
		const security = authorizeHttpRequest(req, p, { allowedHosts: ALLOWED_HOSTS });
		if (!security.ok) {
			return sendJson(res, security.code, { error: security.error, reason: security.reason });
		}
		req.security = security;
		req.context = security.context;

		if (req.method === 'GET' || req.method === 'HEAD') {
			if (!requireRouteAccess(req, p, null, res)) return;
		}

		if (req.method === 'POST') {
			const requestScopedEnqueue = enqueueForRequest(req);
			const requestGitBash = gitBashForRequest(req);
			const requestNodeLeaf = nodeLeafForRequest(req);
			// CSRF guard: browsers send Origin on cross-origin POST. Refuse anything not from us
			// (these endpoints spawn processes; a malicious page must not drive them).
			const origin = req.headers.origin;
			if (origin && req.context?.mode !== 'external') {
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
			if (p === '/api/run') {
				if (!requirePostAccess(req, p, null, res)) return;
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
				const job = requestScopedEnqueue({
					kind: 'run',
					label,
					commandSpec: { runner: 'gitBash', script: 'run.sh', args: glob ? [glob] : [] },
					spawnFn: () => requestGitBash('run.sh', glob ? [glob] : []),
				});
				return sendJson(res, 202, { job });
			}
			const mCancel = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(p);
			if (mCancel) {
				if (!requirePostAccess(req, p, null, res)) return;
				const ok = cancel(mCancel[1], requestContext(req));
				if (ok) NOVNC_SESSIONS.registry?.cancelJob?.(mCancel[1], { tenantId: noVncTenantId(requestContext(req)), now: Date.now(), reason: 'cancel' });
				return ok ? sendJson(res, 200, { ok: true }) : notFound(res, 'no such job');
			}

			// --- P2: recorder + flow editor ---
			let bodyJson;
			try {
				bodyJson = await readJson(req);
			} catch {
				return sendJson(res, 400, { error: 'invalid JSON body' });
			}
			const commandConfirm = /^\/api\/agent\/plans?\/[^/]+\/confirm(?:\/|$)/.test(p);
			if (commandConfirm && req.context?.mode !== 'external' && approveGate(req, res, ALLOWED_HOSTS, sendJson)) {
				recordCommandGateRefusal(p, res.statusCode === 401 ? 'session_missing' : 'origin_or_referer_required', { httpStatus: res.statusCode });
				return;
			}
			if (!requirePostAccess(req, p, bodyJson, res)) return;

			if (await runnerApiPost(p, bodyJson, res, {
				req,
				sendJson,
				runnerApi: {
					store: RUNNER_API_STORE,
					resolveRunnerIdentity: RUNNER_API_IDENTITY,
				},
			})) return;
			if (await SECRET_MIGRATION_ROUTES.post(p, bodyJson, res, { sendJson, request: req, context: requestContext(req) })) return;
			if (await tenantDeletionPost(p, bodyJson, res, { sendJson, context: requestContext(req) })) return;

			if (p === '/api/session/logout') {
				const result = logoutSessionFromRequest(req, res);
				return sendJson(res, 200, { ok: true, loggedOut: result.loggedOut });
			}

			// Effectful approve routes still require the existing same-origin session gate,
			// but authenticated external RBAC denies weaker roles before this route-specific
			// safety gate or any handler logic can run.
			if ((p.startsWith('/api/approve/') || commandConfirm) && approveGate(req, res, ALLOWED_HOSTS, sendJson)) {
				if (commandConfirm) {
					recordCommandGateRefusal(p, res.statusCode === 401 ? 'session_missing' : 'origin_or_referer_required', { httpStatus: res.statusCode });
				}
				return;
			}

			if (p === '/api/dev-integration-readonly') {
				const name = String(bodyJson.name || bodyJson.flow || '').trim();
				if (!validName(name)) return sendJson(res, 400, { error: 'invalid flow name (use [A-Za-z0-9_-])' });
				const flow = await getFlow(name);
				if (!flow) return sendJson(res, 400, { error: 'no such flow' });
				const environment = String(flow.environment || '').trim();
				const riskClass = String(flow.riskClass || '').trim();
				if (!['staging', 'live-readonly'].includes(environment)) {
					return sendJson(res, 409, { error: 'development read-only integration requires flow.environment staging or live-readonly' });
				}
				if (riskClass !== 'read') return sendJson(res, 409, { error: 'development read-only integration requires riskClass read' });
				const requestedMode = String(bodyJson.runMode || bodyJson.run_mode || environment).trim();
				if (requestedMode !== environment) return sendJson(res, 400, { error: `runMode must match flow.environment ${environment}` });
				let allowlist;
				try {
					allowlist = normalizeExactTargetAllowlist(bodyJson.allowlist || bodyJson.targetAllowlist, startUrlOrigin(flow.startUrl));
				} catch (e) {
					return sendJson(res, 400, { error: e.message });
				}
				const validateOnly = bodyJson.validateOnly === true || bodyJson.validate_only === true;
				const scenarioBlocker = devReadonlyScenarioBlocker(flow, { validateOnly });
				if (scenarioBlocker) {
					return sendJson(res, 409, {
						error: scenarioBlocker || 'flow is not ready for deterministic replay',
						state: flow.scenarioStatus?.state || 'not-ready',
					});
				}
				const args = validateOnly ? ['--validate-only', '--allowlist', allowlist, name] : ['--allowlist', allowlist, name];
				const env = { AQA_TARGET_ALLOWLIST: allowlist };
				try {
					const resolverEvidence = normalizeJsonEnvValue(bodyJson.resolverEvidence || bodyJson.resolver_evidence || '', 'resolverEvidence');
					const connectionIps = normalizeJsonEnvValue(bodyJson.connectionIps || bodyJson.connection_ips || '', 'connectionIps');
					if (resolverEvidence) env.AQA_EGRESS_RESOLVER_EVIDENCE = resolverEvidence;
					if (connectionIps) env.AQA_EGRESS_CONNECTION_IPS = connectionIps;
				} catch (e) {
					return sendJson(res, 400, { error: e.message });
				}
				const label = `dev-readonly ${validateOnly ? 'validate' : 'run'} ${name}`;
				const job = requestScopedEnqueue({
					kind: 'run',
					label,
					commandSpec: { runner: 'gitBash', script: 'bin/dev-integration-readonly.sh', args, env },
					spawnFn: () => requestGitBash('bin/dev-integration-readonly.sh', args, env),
					meta: {
						workflow: 'development-integration',
						run_mode: requestedMode,
						allowlist,
						result: 'pending',
						next_action: validateOnly ? 'run replay after validate-only passes' : 'review RUN_ID artifacts and issues_found',
						flow: name,
						system: flow.app || null,
						riskClass,
						productionOpenApprovalRequired: false,
						evidencePackRequired: false,
						retention: 'ephemeral-debug',
					},
				});
				return sendJson(res, 202, {
					job,
					mode: 'development-integration-readonly',
					run_mode: requestedMode,
					allowlist,
					approvalRequired: false,
					evidencePackRequired: false,
				});
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
				let engine;
				try { engine = requirePlaywrightEngine(bodyJson.engine || (app ? getSystemView(app, requestContext(req))?.engine : null), 'record.engine'); }
				catch (e) { return sendJson(res, 400, { error: e.message }); }
				// Re-recording overwrites flows/<name>.flow.json (and may lose manual resolutions);
				// require an explicit overwrite flag so it is never silent.
				if (flowExists(name) && bodyJson.overwrite !== true) {
					return sendJson(res, 409, { error: `flow '${name}' already exists — re-record will overwrite it`, exists: true });
				}
				// Per-recording stop-file the UI can touch for a graceful early finish (in tmpdir, not
				// the repo). jobs.stop() writes it; capture() watches it; runJob's finally removes it.
				const stopFile = path.join(os.tmpdir(), `aqa-stop-${name}-${Date.now()}`);
				const job = requestScopedEnqueue({
					kind: 'record',
					label: `record ${name} (${engine}, ${seconds}s)`,
					nonResumableReason: 'headed recording requires the original browser session and stop-file',
					spawnFn: () => recordCmd(name, startUrl, { app: app || undefined, seconds, stopFile, engine }),
					stopFile,
				});
				return sendJson(res, 202, { job, flow: name });
			}

			// Graceful early finish of a running recording (a COMPLETE capture; vs cancel's kill).
				// Body-less POST; sits after readJson, so the UI sends a "{}" body (see util.stopJob).
				const mStop = /^\/api\/jobs\/([^/]+)\/stop$/.exec(p);
				if (mStop) {
					return stop(mStop[1], requestContext(req)) ? sendJson(res, 200, { ok: true }) : sendJson(res, 409, { error: 'job not stoppable (not a running recording)' });
				}

				if (p === '/api/verify') {
					const name = String(bodyJson.name || '').trim();
					if (!flowExists(name)) return sendJson(res, 400, { error: 'no such flow' });
					const flow = await getFlow(name);
					if (flow.engineError) return sendJson(res, 400, { error: flow.engineError });
					const engine = flow.engine;
					if (engine !== 'playwright') return sendJson(res, 400, { error: `flow '${name}' is ${engine}; WebUI verify is Playwright-only` });
				const job = requestScopedEnqueue({
					kind: 'verify',
					label: `verify ${name} (${engine})`,
					commandSpec: { runner: 'nodeLeaf', script: 'bin/play-flow.mjs', args: ['--flow', `flows/${name}.flow.json`, '--verify'] },
					spawnFn: () => requestNodeLeaf('bin/play-flow.mjs', ['--flow', `flows/${name}.flow.json`, '--verify']),
				});
				return sendJson(res, 202, { job });
			}

			if (p === '/api/compile') {
					const name = String(bodyJson.name || '').trim();
					if (!flowExists(name)) return sendJson(res, 400, { error: 'no such flow' });
					const flow = await getFlow(name);
					if (flow.engineError) return sendJson(res, 400, { error: flow.engineError });
					const engine = flow.engine;
					if (engine !== 'playwright') return sendJson(res, 400, { error: `flow '${name}' is ${engine}; WebUI compile is Playwright-only` });
				// compile is deterministic and browser-free -> run directly (not via the serial queue).
				const { code, output } = await runCapture(requestGitBash('bin/probe-record.sh', ['compile', `flows/${name}.flow.json`]));
				return sendJson(res, 200, { ok: code === 0, code, output, testFile: code === 0 ? `tests/${name}.test.sh` : null });
			}

				// 결재/RPA routes (sync, NL command router, system registry) — see webui/routes-rpa.js.
				if (await commandPlanPost(p, bodyJson, res, { sendJson, enqueue: requestScopedEnqueue, gitBash: requestGitBash, nodeLeaf: requestNodeLeaf })) return;
				if (approvePost(p, bodyJson, res, { sendJson, enqueue: requestScopedEnqueue, nodeLeaf: requestNodeLeaf, gitBash: requestGitBash })) return;
				if (await rpaPost(p, bodyJson, res, { sendJson, enqueue: requestScopedEnqueue, authSpawn: systemAuthSpawn, nodeLeaf: requestNodeLeaf, context: requestContext(req) })) return;

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
				let engine;
				try { engine = requirePlaywrightEngine(bodyJson.engine, 'auth.engine'); }
				catch (e) { return sendJson(res, 400, { error: e.message }); }
				// setup/auth.sh opens headed Chrome for human OTP, then saves the state to local pilot
				// storage or imports it into the configured secret backend for external/encrypted mode.
				// Browser job -> through the single-slot serial queue. (successUrl is an inert arg via Git-Bash.)
				// Human-confirm-save: a tmpdir stop-file the UI touches via POST /api/jobs/:id/stop (jobs.stop)
				// to mean "I finished logging in — save now". This rescues portals that return to the EXACT login
				// URL after login, where URL auto-detect can never fire. Both auth drivers watch it;
				// runJob's finally removes the file.
				const authStopFile = path.join(os.tmpdir(), `aqa-auth-stop-${app}-${Date.now()}`);
				const job = requestScopedEnqueue({
					kind: 'auth',
					label: `auth ${app} (${engine})`,
					nonResumableReason: 'headed auth requires the original human login session and stop-file',
					stopFile: authStopFile || undefined,
					spawnFn: () => requestGitBash('setup/auth.sh', [app, loginUrl, successUrl], { AQA_AUTH_STOPFILE: authStopFile }),
				});
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

			const mResolveClicked = /^\/api\/flows\/([^/]+)\/resolve-(?:clicked|first)-record$/.exec(p);
			if (mResolveClicked) {
				let fname;
				try {
					fname = decodeURIComponent(mResolveClicked[1]);
				} catch {
					return notFound(res, 'no such flow');
				}
				const r = await resolveClickedRecordStep(
					fname,
					parseInt(bodyJson.step, 10),
					String(bodyJson.recipe || '').trim(),
					String(bodyJson.field || '').trim(),
				);
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
			if (!requireRouteAccess(req, p, null, res)) return;
			return sendJson(res, 405, { error: 'method not allowed' });
		}

		if (isNoVncRoutePath(p)) {
			return handleNoVncHttp(req, res, url);
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
			return sendJson(res, 200, queueState(requestContext(req)));
		}

		if (p === '/api/trends') {
			return sendJson(res, 200, await getTrends());
		}

		if (p === '/api/rbac' || p === '/api/session') {
			return sendJson(res, 200, actorAccessView(req.context));
		}

		if (p === '/api/auth') {
			return sendJson(res, 200, { apps: await listAuthStates(), states: await listAuthStateSummaries() });
		}

		if (p === '/api/readiness') {
			return sendJson(res, 200, await getP0Readiness());
		}

		if (await releaseChecklistGet(p, url, res, { sendJson, req })) return;
		if (await SECRET_MIGRATION_ROUTES.get(p, url, res, { sendJson, request: req, context: requestContext(req) })) return;
		if (await tenantDeletionGet(p, url, res, { sendJson, context: requestContext(req) })) return;

		if (p === '/api/approvals') {
			return sendJson(res, 200, { approvals: await listApprovalsView() });
		}

		if (approveGet(p, url, res, { sendJson })) return;
		if (commandPlanGet(p, url, res, { sendJson })) return;
		if (rpaGet(p, url, res, { sendJson, notFound, context: requestContext(req) })) return;

		if (p === '/api/flows') {
			return sendJson(res, 200, { flows: await listFlows() });
		}

		if (p === '/api/flows/blocked-report') {
			return sendJson(res, 200, await getWebuiBlockedFlowReportSafe());
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
			const jr = jobResult(mJobResult[1], requestContext(req));
			return jr ? sendJson(res, 200, jr) : notFound(res, 'no such job');
		}

		const mJob = /^\/api\/jobs\/([^/]+?)(\/stream)?$/.exec(p);
		if (mJob) {
			const id = mJob[1];
			if (mJob[2]) {
				// SSE: subscribe() owns the response lifecycle (replay + live + end/close).
				if (!subscribe(id, res, requestContext(req))) return notFound(res, 'no such job');
				return;
			}
			const js = jobStatus(id, requestContext(req));
			return js ? sendJson(res, 200, js) : notFound(res, 'no such job');
		}

		if (p.startsWith('/artifacts/')) {
			const full = safeResolve(ARTIFACTS_DIR, p.slice('/artifacts'.length));
			if (!full) return notFound(res, 'bad path');
			const policy = staticFilePolicy(full, { root: ARTIFACTS_DIR, artifact: true });
			if (!policy.allowed) return notFound(res, 'not found');
			const meta = artifactRouteMetadata({ artifactsDir: ARTIFACTS_DIR, filePath: full });
			if (!meta) return notFound(res, 'not found');
			const access = authorizeArtifactRead({ context: requestContext(req), runId: meta.runId, artifactPath: meta.artifactPath });
			if (!access.ok) {
				if (access.code === 410) return sendJson(res, 410, { error: 'gone', reason: access.reason });
				return notFound(res, 'not found');
			}
			return serveFile(req, res, full, { redact: policy.redact });
		}

		// Fall through: static asset from webui/public (app.js, app.css, favicon, ...).
		// serveFile() statSyncs in its own try/catch and 404s on miss/non-file, so no
		// existsSync pre-check (which would TOCTOU-throw a 500 and double-stat the file).
		const pub = safeResolve(PUBLIC_DIR, p);
		if (pub) {
			const policy = staticFilePolicy(pub, { root: PUBLIC_DIR });
			return policy.allowed ? serveFile(req, res, pub) : notFound(res, 'not found');
		}

		return notFound(res);
	} catch (e) {
		sendJson(res, 500, { error: String((e && e.message) || e) });
	}
});

const STATUS_TEXT = {
	401: 'Unauthorized',
	403: 'Forbidden',
	404: 'Not Found',
	410: 'Gone',
	503: 'Service Unavailable',
};

function socketJson(socket, code, obj) {
	const body = JSON.stringify(obj);
	socket.end([
		`HTTP/1.1 ${code} ${STATUS_TEXT[code] || 'Error'}`,
		'Content-Type: application/json; charset=utf-8',
		`Content-Length: ${Buffer.byteLength(body)}`,
		'Connection: close',
		'',
		body,
	].join('\r\n'));
}

function handleNoVncUpgrade(req, socket) {
	try {
		if (!ALLOWED_HOSTS.has((req.headers.host || '').toLowerCase())) {
			return socketJson(socket, 403, { error: 'host not allowed' });
		}
		const url = new URL(req.url, `http://${HOST}:${PORT}`);
		const p = url.pathname;
		if (!isNoVncRoutePath(p)) {
			return socketJson(socket, 404, { error: 'not found', reason: 'websocket upgrades are not accepted on this route' });
		}
		const security = authorizeHttpRequest(req, p, { allowedHosts: ALLOWED_HOSTS });
		if (!security.ok) {
			return socketJson(socket, security.code, { error: security.error, reason: security.reason });
		}
		req.security = security;
		req.context = security.context;
		const access = authorizeWebuiRequest('GET', p, {}, requestContext(req));
		if (!access.ok) {
			return socketJson(socket, 403, {
				error: 'forbidden',
				reason: access.reason || 'permission denied',
				actor: access.actor,
				tenantId: access.tenantId,
				requiredPermissions: access.requiredPermissions,
			});
		}
		const decision = authorizeNoVncRequest(req, url);
		if (!decision.ok) return socketJson(socket, decision.code || 403, noVncDeniedBody(decision));
		return socketJson(socket, 503, noVncUnavailableBody(decision));
	} catch (e) {
		return socketJson(socket, 503, { error: 'noVNC upgrade refused', reason: String((e && e.message) || e) });
	}
}

server.on('upgrade', (req, socket) => {
	handleNoVncUpgrade(req, socket);
});

server.on('error', (e) => {
	if (e.code === 'EADDRINUSE') {
		console.error(`[webui] port ${PORT} is already in use (set WEBUI_PORT to override).`);
	} else {
		console.error('[webui] server error:', e.message);
	}
	process.exit(1);
});

// Graceful shutdown: tree-kill any in-flight browser job, then exit.
let shuttingDown = false;
function shutdown(sig) {
	if (shuttingDown) return;
	shuttingDown = true;
	const closedNoVnc = NOVNC_SESSIONS.registry?.closeAll?.({ now: Date.now(), reason: 'server-shutdown' }) || [];
	if (closedNoVnc.length) console.log(`[webui] ${sig} closed ${closedNoVnc.length} noVNC session model(s)`);
	AUDIT_OUTBOX_SCHEDULER.stop({ wait: false });
	console.log(`[webui] ${sig} — killing any running job and exiting`);
	killRunning();
	server.close();
	process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.listen(PORT, HOST, () => {
	const security = securityModeSummary();
	console.log(`[webui] listening on http://${HOST}:${PORT}`);
	console.log(`[webui] security mode: ${security.mode}; auth=${security.auth}; tenant=${security.tenantId || 'unconfigured'}`);
	if (security.external) console.log(`[webui] auth provider: ${security.authProvider?.type || 'unconfigured'}; cors=${security.cors?.mode || 'deny-by-default'}`);
	if (security.external && !security.configured) console.error('[webui] external mode is fail-closed until WEBUI_AUTH_TOKEN and WEBUI_TENANT_ID are set');
	if (security.external) console.error('[webui] noVNC must remain disabled or be fronted by authenticated, tenant-scoped TLS before exposure');
	const auditScheduler = AUDIT_OUTBOX_SCHEDULER.start();
	if (auditScheduler.disabled) {
		console.log(`[webui] audit outbox scheduler disabled: ${auditScheduler.disabledReason}`);
	} else {
		console.log(`[webui] audit outbox scheduler enabled: interval=${auditScheduler.intervalMs}ms`);
	}
	console.log(`[webui] artifacts: ${ARTIFACTS_DIR}`);
	pruneArtifacts(KEEP_RUNS).then((r) => {
		if (r.pruned.length) console.log(`[webui] pruned ${r.pruned.length} old run dir(s), kept newest ${r.kept} (WEBUI_KEEP_RUNS=${KEEP_RUNS})`);
	});
});
