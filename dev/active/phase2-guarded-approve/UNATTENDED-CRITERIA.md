# Unattended auto-approve — criteria & policy framework (DESIGN ONLY)

> **STATUS: DESIGN ONLY. This document does NOT enable unattended approval.** Unattended LIVE auto-approve
> stays **fail-closed/forbidden** (`bin/scheduled-task.sh` refuses `--live`; the leaf refuses live under
> `AQA_SCHEDULED_NO_LIVE`) until (a) the owner **signs off** on a concrete policy per system, and (b) the
> three operator-accompanied **prerequisites** in §9 clear. The framework below is the missing third
> prerequisite ("agreed auto-approve criteria"). It must **never** weaken the deterministic per-doc guards
> and **the model must never decide eligibility** — eligibility is 100% deterministic.

Synthesized from a 3-lens design workflow (criteria schema · adversarial safety · operational graduation),
grounded in `approve/approve-run.mjs`, `recipes/SCHEMA.md`, `bin/scheduled-task.sh`, DESIGN.md (§14) and
`REDTEAM-AUTO-APPROVE.md`.

## 0. The question
When may the machine approve an item with **no human in the loop**? Today: never (fail-closed). The two
built modes both have a human or a strong gate: **reviewed** (the operator checks each item) and **typed
full-auto** (the deterministic guards — incl. an amount ceiling — are the sole safety, run supervised).
Unattended removes the operator from the loop entirely, so it needs an explicit, deterministic, conservative
**eligibility policy** plus a staged path to earn trust.

## 1. Core principle — positive-match allowlist, fail-closed
**The machine auto-approves ONLY items that POSITIVELY and DETERMINISTICALLY match every rule in an explicit
per-system policy. Everything else is routed to the human reviewed queue — never approved, never silently
dropped.** Eligibility is the intersection of allowlists; any criterion that cannot be evaluated *reliably*
(missing field, unreadable page, heuristic-only amount, anomaly) ⇒ **INELIGIBLE ⇒ human**. The unattended
path handles the *easy, safe, recurring* subset; humans keep the long tail.

## 2. The policy (`data/policies/<name>.json`, gitignored — may carry dept/drafter PII)
A committed-by-the-operator, versioned JSON the leaf reads and evaluates deterministically. Proposed shape:

```jsonc
{
  "id": "hiworks-recurring-v1",        // versioned; written into every audit row (policyId)
  "app": "hiworks",                     // resolves recipe/state/listUrl via the registry (P2)
  "phase": "shadow",                    // shadow | sampled | unattended  (graduation, §7 — starts at shadow)
  "sampleRate": 0.05,                   // phase=sampled: fraction approved live; the rest shadow-evaluated
  "eligibility": {
    "docIdGlobs": ["IB-품의-*", "IB-지출(거래처)-*"],   // doc-id prefix/glob allowlist (deterministic)
    "formTypeAllow": ["지출결의서(거래처)"],            // live h1 must be in this list (readable h1 required)
    "formTypeDeny":  ["수의계약", "특별 지출"],           // explicit never-list (drift backstop)
    "drafterPattern": "^(재무팀|경영지원).*",            // optional regex on the synced drafter/dept; absent ⇒ no constraint
    "deptPattern":    "재무|경영",
    "maxDocAgeDays":  30,                              // submitted within N days (reads submitted_at); absent ⇒ no age gate
    "requireContentMarkers": ["정기", "급여"]           // optional: each must appear in the live body (recurring-template proof)
  },
  "amount": {
    "gateBCaptured": false,             // TRUE only when §9-2 pinned the EXACT 총액 cell for THIS form
    "maxAmount": 1000000                // hard 원 ceiling; REQUIRED unless gateBCaptured && deterministic
  },
  "caps": { "maxPerTick": 10, "maxPerDay": 50, "maxAmountPerDay": 50000000, "minTickGapMin": 60 },
  "window": { "startKST": "09:00", "endKST": "18:00", "weekdaysOnly": true },  // no overnight/weekend approvals
  "anomaly": { "haltAfterConsecutiveSkips": 5, "alert": "data/policy-alerts.jsonl" }
}
```

All fields are **allowlists / hard bounds** evaluated against the **synced DB + the live page**, never the
model. An absent optional field means "no constraint *added*" — it never loosens a built-in guard.

## 3. Deterministic eligibility evaluation (in the leaf, per-doc, fail-closed, audited)
For each candidate the leaf computes an **eligibility verdict** BEFORE the existing per-doc guards, and
records the per-criterion result in the audit (`stage: "eligibility"`, detail = which rule failed):
1. `doc_id` matches a `docIdGlobs` entry, AND is NOT in `formTypeDeny`, AND within `window`/`caps`;
2. synced **title present** (already required) + live h1 **readable** and ∈ `formTypeAllow` (∉ `formTypeDeny`);
3. `drafter`/`dept`/`submitted_at`/`requireContentMarkers` (when configured) all positively satisfied;
4. **amount**: if `amount.gateBCaptured` ⇒ the deterministic ceiling applies; else the policy MUST carry a
   positive `maxAmount` AND the heuristic parse must yield a figure ≤ ceiling — **a non-parseable amount on
   a money-bearing form ⇒ INELIGIBLE** (never "approve because we couldn't read the amount");
5. caps (`maxPerTick`/`maxPerDay`/`maxAmountPerDay`/`minTickGapMin`) not exceeded (read from `policy-ticks.jsonl`).
Any failure ⇒ **`skipped: ineligible:<rule>`** ⇒ the doc stays for human review. Only an all-green verdict
proceeds into the unchanged deterministic guards (unique cell open → urlGlob → idLabel → title binding →
amount → 승인-radio → 확인 → positive 완료 verify → audit).

## 4. Non-negotiable safety invariants (U-series; in addition to the built per-doc guards)
- **U1 Deterministic eligibility.** No model output is on the eligibility or click path (structural).
- **U2 Positive-match-only, fail-closed.** Approve only on an all-green verdict; any unverifiable criterion
  ⇒ human queue. Never approve "by default" or "because a check was inconclusive".
- **U3 Amount reliability.** Amount-dependent unattended approval REQUIRES a per-form **Gate-B amount-cell
  capture** (`gateBCaptured`). Without it the amount label is drafter-typed heuristic ⇒ a money-bearing form
  is INELIGIBLE for unattended (use reviewed instead). No unattended unbounded-value approve, ever.
- **U4 Hard caps + rate.** Per-tick/per-day count, per-day amount, min tick gap, time-window. `clicksIssued`
  binds the irreversible-click cap. A cap breach halts before the next doc.
- **U5 Unchanged durable guards.** Append-only fsync'd audit (now tagged with `policyId`) + crash
  reconciliation + kill-switch (`data/approve-STOP`) all still apply; a `policy-ticks.jsonl` adds per-tick audit.
- **U6 Single-user, operator-controlled host.** Same I7 residual; documented + enforced operationally.
- **U7 Anomaly ⇒ halt + alert.** Form-type drift (deny-list hit / unknown form on a money path), over-ceiling,
  K consecutive skips, any `reconcile-uncertain`, session-expiry redirects ⇒ stop the policy + alert the operator.
- **U8 Phase-gated, operator-signed.** Default = forbidden. Each graduation step (§7) requires explicit
  owner sign-off on the audit evidence.

## 5. What MUST stay human (never unattended)
Forms/items **not** on the allowlist · any criterion unverifiable · value above the hard ceiling · a form
with **no Gate-B amount cell** on a money path · **new/first-seen form types** (drift) · novel drafters/depts ·
anomalies/reconcile-uncertain · anything the operator hasn't soaked in shadow. When in doubt → human.

## 6. Failure modes the framework must answer (from the red-team lens)
- **Drafter-typed amount label (F8).** → U3 (Gate-B required; else reviewed). Heuristic ceiling never gates an
  unattended money approval.
- **Drifted/malicious doc on the allowlist (F7).** A previously-approved doc re-opened with mutated content.
  → content markers + amount re-check + form-type at click time; reviewed mode for anything re-presented; the
  deny-list + anomaly-halt for new shapes. (A full content fingerprint is the DESIGN.md I4 hardening if needed.)
- **New form type appears (drift).** `formTypeAllow` is a *positive* list ⇒ unknown forms skip (safe), AND
  the anomaly monitor alerts so genuine high-value docs aren't silently parked forever (false-negative risk).
- **DB staleness → title mismatch (false negative).** Sync before each policy tick; title mismatch ⇒ skip
  (safe) + surface in the reconciliation/needs-review view so a real doc isn't lost.
- **Session expiry mid-batch (F5).** Pre-tick session-freshness probe (refuse if > 24h / not logged in);
  url-mismatch guard aborts on redirect; reconciliation resolves stranded clicks.
- **Audit tear / concurrency (F9).** PID-aware mkdir lock (one leaf at a time) + per-line fsync + reconciliation.

## 7. Graduation path (earn trust in stages; each step operator-signed)
- **P-a SHADOW (default entry).** The policy **evaluates eligibility and audits "would-approve"**, but the
  leaf **never clicks** (dry-run only). Soak ≥ **7 clean days**: the operator compares the would-approve set
  against real content; "clean" = every doc approved-would or skipped-for-a-documented-reason, no surprises.
  *This is also a permanently-valid end-state: shadow-triage + human-reviewed clicks.*
- **P-b SAMPLED.** Approve live only a tiny rate (`sampleRate`, default 5%) of matching docs; the rest stay
  shadow. Validates the live mechanics (trusted click → 승인-stamp → completion → DB transition) at minimal
  financial exposure. Mandatory human spot-check of each live approval + easy rollback. ≥ **3 clean days**.
- **P-c BOUNDED UNATTENDED.** The host scheduler (`bin/scheduled-task.sh`, once `--live` is unlocked for a
  signed policy) runs the policy on a cadence within `window`/`caps`, with **real-time monitoring + alerting
  + a hard kill**. Still bounded (small `maxPerTick`, daily caps, single-user host).
- **Advance prerequisites:** P-a→P-b needs the §9 live-e2e + (for money paths) Gate-B capture + 7 clean
  shadow days + sign-off; P-b→P-c needs 3 clean sampled days + the monitoring/alert/kill wiring + sign-off.

## 8. Monitoring, audit, accountability
- **Per-doc audit (extended):** add `policyId` to every `approve-audit.jsonl` row + a new `eligibility` stage.
- **Per-tick audit (new):** `data/policy-ticks.jsonl` — one line per scheduled tick (policyId, at, evaluated,
  approved, skipped-by-reason, caps-state) for rate enforcement + a webui **Policy Health** card (active
  policy, last tick, 7-day success rate, last-10-tick timeline, anomaly flags).
- **Operator identity (M4 gap, Q3).** Today the audit records the OS user + the live approver's 결재선 role,
  not which human triggered the run. A webui session/login binding the operator id into the audit is the
  accountability hardening for regulated use (open question §10).

## 9. Prerequisites before ANY unattended LIVE (operator-accompanied — unchanged gates)
1. **Live end-to-end** approval on a disposable 대기 doc (confirm 확인 commits, 승인-stamp on the self-line
   today, doc leaves 대기) — proves the recipe's locators + completion marker on the real system.
2. **Gate-B amount-cell capture** per money-bearing form (pin the EXACT 총액 cell so the ceiling is
   deterministic, not the drafter-typed-label heuristic) — required to set `amount.gateBCaptured: true`.
3. **Owner-signed policy** (this framework, filled in) per system: which forms are unattended-eligible vs
   reviewed-only, ceilings + justification, caps, `--live` opt-in, anomaly/escalation rules, retention.

## 10. Open questions (the operator/owner decides)
- Per-form unattended-eligibility + ceilings (e.g. 지출결의서 ≤ 1M unattended; 품의 reviewed-only; 수의계약 never).
- Drafter/dept allowlist policy (exact vs regex; maintenance owner).
- Schedule cadence + `window` (hourly? business-hours-only? freeze after 18:00?).
- Operator identity/MFA binding into the audit (Q3) — needed for regulated financial workflows?
- Endpoint/host threat model for the single-user assumption (Q2): restricted account / sandbox?
- Reviewed-mode "adequate review" expectations + UI signals (Q6).

## 11. Implementation roadmap (ONLY after §9 + sign-off — not now)
- **Step 1 (cheap, safe, no live):** add `policyId` to the audit + a `data/policies/` loader + the
  **deterministic eligibility evaluator** wired to **SHADOW** (evaluate + audit, never click). This is
  buildable + testable browser-free now and is useful immediately (triage). It does NOT enable any live click.
- **Step 2:** `policy-ticks.jsonl` + the Policy Health card + anomaly monitor/alert + session-freshness probe.
- **Step 3 (gated):** sampled-live + monitoring; then bounded unattended via the scheduler — each behind the
  §9 prerequisites + an owner sign-off, re-red-teamed before live.

**Net:** the SAFEST and immediately-buildable slice is **SHADOW eligibility + the human-reviewed click**
(unattended for triage, human for the irreversible action). Actual unattended *clicks* are earned through
P-b/P-c with the prerequisites + sign-off, and stay fail-closed until then.
