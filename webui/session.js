// webui/session.js — server-anchored session + the CSRF/auth gate for the EFFECTFUL auto-approve route.
//
// The webui is loopback + single-user, but POST /api/approve/* clicks the REAL Hiworks 확인 with NO human,
// so it gets STRICTER protection than the rest of the UI (DESIGN §5; red-team R1 / T8):
//   • a session cookie (HttpOnly; SameSite=Strict) is minted on GET / and REQUIRED on POST /api/approve/* —
//     so only a request from a browser that actually loaded THIS server's page can drive an approval
//     (a blind same-OS local POST that never loaded the page has no cookie ⇒ refused);
//   • /api/approve/* additionally requires a PRESENT, host-matching Origin OR Referer — never the
//     absent-Origin fall-through the general POST guard allows (that fall-through is the accepted I7
//     local-non-browser residual for READ routes; it must NOT extend to the effectful approve path).
// In-memory store (a single-user local host) — sessions live for the server's lifetime; a restart re-mints.
// No Secure flag (loopback is plain HTTP); add it behind TLS for a fronted deployment.

import crypto from 'node:crypto';

const COOKIE = 'aqa_sess';
const valid = new Set();

function parseCookies(header) {
	const out = {};
	for (const part of String(header || '').split(';')) {
		const i = part.indexOf('=');
		if (i < 0) continue;
		out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
	}
	return out;
}

export function hasValidSession(req) {
	const cur = parseCookies(req.headers.cookie)[COOKIE];
	return !!(cur && valid.has(cur));
}

// issueSessionIfNeeded(req,res): on GET /, mint a session cookie when the request carries no valid one.
// Call BEFORE serveFile writes its own headers (Set-Cookie via setHeader survives serveFile's writeHead,
// which sets only Content-Type/Length/Accept-Ranges).
export function issueSessionIfNeeded(req, res) {
	if (hasValidSession(req)) return;
	const id = crypto.randomBytes(32).toString('hex');
	valid.add(id);
	res.setHeader('Set-Cookie', `${COOKIE}=${id}; HttpOnly; SameSite=Strict; Path=/`);
}

// approveGate(req,res,allowedHosts,sendJson): returns TRUE if the request is BLOCKED (a 403/401 was sent),
// FALSE if it may proceed. Apply to EVERY POST /api/approve/* (run + stop are both effectful). Fail-closed.
export function approveGate(req, res, allowedHosts, sendJson) {
	const hostOf = (h) => { try { return new URL(h).host.toLowerCase(); } catch { return null; } };
	const oh = req.headers.origin ? hostOf(req.headers.origin) : null;
	const rh = req.headers.referer ? hostOf(req.headers.referer) : null;
	// (1) present, host-matching Origin OR Referer — never absent-fall-through (T8 / R1).
	if (!(oh && allowedHosts.has(oh)) && !(rh && allowedHosts.has(rh))) {
		sendJson(res, 403, { error: 'approve requires a present, same-origin Origin or Referer (CSRF)' });
		return true;
	}
	// (2) a valid server session cookie — binds the effectful action to a real loaded page (DESIGN §5).
	if (!hasValidSession(req)) {
		sendJson(res, 401, { error: 'no approve session — open the web UI (GET /) first so a session cookie is set' });
		return true;
	}
	return false;
}
