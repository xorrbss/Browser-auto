# TARGET ARCHITECTURE — Option B (Playwright executor) + SaaS deployment

**One-line:** keep the product's moat (declarative recipe → deterministic AI-free replay → safety gates →
audit) UNCHANGED; swap the browser executor to Playwright; split into a multi-tenant SaaS control plane +
a per-tenant VPC runner so tenant credentials/data never leave the tenant network.

Context: GENERAL enterprise RPA platform (any system, any business action — not approve-only).

```
            ┌──────────────────────── SaaS CONTROL PLANE (multi-tenant cloud) ───────────────────────┐
            │  Web UI · RBAC/multi-user · System & Recipe registry · Scheduler · Audit aggregation     │
            │  Job orchestration · Dashboards                                                          │
            │  HOLDS: tenant metadata, DECLARATIVE recipes (selectors, not secrets), job/audit refs    │
            │  HOLDS NO: tenant credentials, browser sessions, or business data                        │
            └───────────────▲───────────────────────────────────────────────────────────────────────┘
                            │  outbound-only (runner pulls jobs / pushes scrubbed status+audit refs)
   ════════════════════ TRUST BOUNDARY (the security split) ════════════════════════════════════════
                            │
            ┌───────────────┴──────────────── TENANT RUNNER (tenant VPC / on-prem) ───────────────────┐
            │  Deterministic Executor (PLAYWRIGHT) ── runs declarative recipes, NO AI at runtime       │
            │  Browser pool (headless, per-tenant isolated contexts)                                   │
            │  Secret store: encrypted storageState / credentials  (NEVER sent to control plane)       │
            │  On-prem LLM endpoint (classify/summarize) — confidential bodies stay in-network         │
            │  Local result + append-only audit store                                                  │
            └──────────────────────────────────────┬──────────────────────────────────────────────────┘
                                                    │ drives
                          Tenant's internal systems (groupware / ERP / HR / finance / ticketing …)
```

## Layer stack (moat preserved; only the executor changes)
1. **Authoring** — non-coder records a journey → DECLARATIVE recipe/flow artifact. Model may classify/
   select/filter; it NEVER authors steps or clicks. *(unchanged)*
2. **Deterministic execution** — a **Playwright** runner replays the recipe deterministically, AI-free.
   *(NEW engine, SAME contract: one journey = one declarative artifact, auditable replay)*
3. **Safety/governance** — dry-run → reviewed targets → plan-hash + target-set-hash → human confirm →
   durable audit; fail-closed on anything uncaptured/disabled. Generalizes to ALL effectful actions.
   *(unchanged)*
4. **Control plane (SaaS)** — UI, registries, scheduling, RBAC, audit, tenant mgmt. *(new: multi-tenancy)*
5. **Runner (per-tenant VPC)** — executor + browser pool + secrets + on-prem LLM + local audit. *(new split)*

## Trust boundary (the core SaaS decision)
- **Control plane = SaaS, multi-tenant, holds NO tenant secrets/data** — only metadata, declarative recipes
  (selectors are not secrets), and audit/job references.
- **Runner = in tenant network (VPC/on-prem appliance), holds ALL sensitive material** (sessions,
  credentials, business data, confidential bodies + the on-prem model).
- Runner connects **outbound-only** to the control plane (pulls jobs, pushes scrubbed status/audit refs).
  No inbound to the tenant network. → data residency + compliance satisfied.

## Auth model (the hardest SaaS problem — tool-independent, but Playwright-friendly)
Desktop headed login does not exist server-side. Flow:
1. Operator clicks "connect system X" in the SaaS UI.
2. Control plane signals the **tenant runner** to open a **HEADED browser inside the VPC**, **streamed**
   to the operator's browser (remote-control channel) → operator completes OTP/SSO.
3. Runner captures Playwright **storageState**, encrypts, stores **locally** (never sent to SaaS).
4. Replay uses the stored storageState **headless**; re-auth flow on expiry. OAuth/API where available.

## Carry-forward invariants (independent of driver)
- Model never authors steps / never clicks / never on the pass-fail or effectful path (structural).
- Deterministic, AI-free, auditable replay (now on Playwright).
- Effectful = fail-closed unless captured + dry-run + reviewed + confirmed + audited.
- Data residency: tenant credentials/data/confidential bodies never leave the tenant network.

## Migration delta (what changes vs stays)
- **STAYS:** recipe/flow schema, recorder concept, CommandPlan gates, audit model, DB schema, safety
  invariants, the entire governance + webui concept. (The moat is above the driver.)
- **CHANGES:** executor (agent-browser CLI → Playwright runner); auth (desktop headed → VPC remote-streamed
  headed → storageState); single localhost process → control-plane + runner split; add multi-tenancy/RBAC;
  browser pooling + per-tenant context isolation.
- **REMOVED:** agent-browser daemon + its wedge ops; the dual-auth (AUTH-DUP) — single Playwright stack.

## Sequencing (de-risk)
1. **Option B in-place first** (still single-host/on-prem): swap executor to Playwright under the existing
   recipe/gate/audit layer; prove parity on current flows. (No SaaS yet — lowest risk, biggest cleanup:
   kills dual-auth + daemon wedge.)
2. **Runner extraction**: package the executor + secrets + on-prem LLM as a deployable tenant runner;
   outbound job protocol.
3. **Control plane**: multi-tenant UI/registry/scheduler/RBAC/audit; holds no secrets.
4. **Remote-streamed auth** + browser pool + per-tenant isolation; OAuth where possible.
5. Harden: observability, autoscaling runners, key management, compliance (SOC2/data-residency).
```
```
