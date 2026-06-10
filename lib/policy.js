// lib/policy.js — the DETERMINISTIC unattended-eligibility evaluator (dev/active/phase2-guarded-approve/
// UNATTENDED-CRITERIA.md, SHADOW slice). PURE: given a synced doc + a policy + today (YYYY-MM-DD KST), it decides
// whether the doc WOULD be auto-approved — but it NEVER approves/clicks (the SHADOW evaluator audits the
// would-decision only). NO LLM is on this path. FAIL-CLOSED: any criterion DECLARED in the policy that cannot be
// POSITIVELY confirmed ⇒ ineligible. Criteria that need the LIVE page (the form-type h1, a Gate-B-captured amount
// cell) are not DB-decidable ⇒ a policy carrying them yields 'requires-live' (the DB shadow defers; the future
// live shadow decides). A heuristic amount ceiling (no Gate-B) is REFUSED (unattended must not trust it).
//
// CommonJS (shared by bin/shadow-eval.js + the unit test, like lib/db.js).
'use strict';

// globMatch('IB-품의-*', s): a SIMPLE glob (only '*' is special) → anchored exact match.
function globMatch(glob, s) {
	const re = '^' + String(glob).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$';
	return new RegExp(re).test(String(s == null ? '' : s));
}
function safeRe(p) { try { return new RegExp(p); } catch { return null; } }
function ymd(s) { const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(s || '')); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null; }
// daysBetween(submitted, nowYMD): integer days (now - submitted) by the YYYY-MM-DD prefix; null if unparseable.
function daysBetween(submitted, nowYMD) { const a = ymd(submitted), b = ymd(nowYMD); return a != null && b != null ? Math.round((b - a) / 86400000) : null; }

// validatePolicy(p): structural validation. Returns { ok, reason }.
function validatePolicy(p) {
	if (!p || typeof p !== 'object') return { ok: false, reason: 'policy must be an object' };
	if (!p.id || typeof p.id !== 'string') return { ok: false, reason: 'policy.id (string) required' };
	if (!p.app || typeof p.app !== 'string') return { ok: false, reason: 'policy.app (string) required' };
	if (p.phase && !['shadow', 'sampled', 'unattended'].includes(p.phase)) return { ok: false, reason: `policy.phase "${p.phase}" invalid` };
	// POSITIVE-MATCH ALLOWLIST (UNATTENDED-CRITERIA §1): a policy MUST positively select — at least one of
	// docIdGlobs / drafterPattern / deptPattern / requireContentMarkers. An empty eligibility would mark EVERY
	// doc would-approve (match-everything), the opposite of an allowlist ⇒ REFUSE (fail-closed). (maxDocAgeDays
	// and the live-only formType/amount are filters, not positive selectors, so they don't satisfy this.)
	const e = p.eligibility && typeof p.eligibility === 'object' ? p.eligibility : {};
	const hasPositive = (Array.isArray(e.docIdGlobs) && e.docIdGlobs.length > 0) || !!e.drafterPattern || !!e.deptPattern || (Array.isArray(e.requireContentMarkers) && e.requireContentMarkers.length > 0);
	if (!hasPositive) return { ok: false, reason: 'policy.eligibility must carry ≥1 POSITIVE selector (docIdGlobs / drafterPattern / deptPattern / requireContentMarkers) — a match-everything policy is refused (fail-closed)' };
	return { ok: true, reason: '' };
}

// evaluatePolicy(doc, policy, nowYMD): { eligible, stage, reason, verdicts, liveRequired }.
//   stage ∈ 'would-approve' | 'would-skip' | 'requires-live'.  doc = a synced approvals row
//   {doc_id, drafter, dept, submitted_at, title, raw_text, summary, amount, status}.
function evaluatePolicy(doc, policy, nowYMD) {
	const e = (policy && policy.eligibility) || {};
	const verdicts = [];
	const add = (rule, pass, detail) => verdicts.push({ rule, pass, detail });

	// only a not-yet-decided doc is a candidate
	if (doc.status && doc.status !== 'fetched') add('status', false, `status=${doc.status} (not fetched)`);
	if (Array.isArray(e.docIdGlobs) && e.docIdGlobs.length) {
		const ok = e.docIdGlobs.some((g) => globMatch(g, doc.doc_id));
		add('docIdGlobs', ok, ok ? doc.doc_id : `${doc.doc_id} ∉ ${JSON.stringify(e.docIdGlobs)}`);
	}
	if (e.drafterPattern) { const re = safeRe(e.drafterPattern); add('drafterPattern', !!(re && re.test(doc.drafter || '')), re ? `drafter="${doc.drafter}"` : `bad regex ${e.drafterPattern}`); }
	if (e.deptPattern) { const re = safeRe(e.deptPattern); add('deptPattern', !!(re && re.test(doc.dept || '')), re ? `dept="${doc.dept}"` : `bad regex ${e.deptPattern}`); }
	if (Number.isFinite(e.maxDocAgeDays)) { const d = daysBetween(doc.submitted_at, nowYMD); add('maxDocAgeDays', d != null && d >= 0 && d <= e.maxDocAgeDays, d == null ? `unparseable submitted_at "${doc.submitted_at}"` : `${d}d vs ≤${e.maxDocAgeDays}`); }
	if (Array.isArray(e.requireContentMarkers) && e.requireContentMarkers.length) {
		// Haystack is DETERMINISTIC scraped text ONLY (title + raw_text) — NEVER doc.summary, which is on-prem
		// LLM output (lib/llm.js, db SCRAPED_COLS). Including it would let a hallucinated or prompt-injected
		// marker in the summary satisfy a would-approve criterion, breaking this file's "NO LLM on this path"
		// fail-closed invariant (header). A content marker must come from text the site actually rendered.
		const hay = [doc.title, doc.raw_text].filter(Boolean).join(' ');
		const missing = e.requireContentMarkers.filter((m) => !hay.includes(m));
		add('requireContentMarkers', missing.length === 0, missing.length ? `missing ${JSON.stringify(missing)}` : 'all present');
	}

	// LIVE-ONLY criteria (not DB-decidable). A heuristic amount ceiling (no Gate-B) is FAIL-CLOSED here.
	const liveRequired = [];
	if (e.formTypeAllow || e.formTypeDeny) liveRequired.push('formType');
	if (policy && policy.amount && Number.isFinite(policy.amount.maxAmount)) {
		if (policy.amount.gateBCaptured) liveRequired.push('amount');
		else add('amount-gateB', false, 'amount ceiling set but gateBCaptured:false — drafter-typed label is unreliable, ineligible for unattended (fail-closed)');
	}

	const firstFail = verdicts.find((v) => !v.pass);
	if (firstFail) return { eligible: false, stage: 'would-skip', reason: firstFail.rule, verdicts, liveRequired };
	if (liveRequired.length) return { eligible: false, stage: 'requires-live', reason: 'live-only: ' + liveRequired.join(','), verdicts, liveRequired };
	return { eligible: true, stage: 'would-approve', reason: '', verdicts, liveRequired };
}

module.exports = { evaluatePolicy, validatePolicy, globMatch, daysBetween };
