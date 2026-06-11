# Commercial SaaS Blueprint — Autonomous Agent Engine

> Pivot target: turn the RushPoint kinetic engine into a multi-tenant, commercial autonomous-agent
> platform that any customer can point at their own repo with their own API key.
>
> **Key principle: build on the existing architecture, don't rebuild it.** The U-25–U-37 refactor
> already made the engine config-driven and project-agnostic (paths, validation, locks, budgets,
> handoff contexts, git target, telemetry, context-provider). Those seams *are* the SaaS foundation.

## The five pillars

### 1. Circuit Breakers — ✅ DONE (highest priority, shipped)
A safety halt for the unattended loop running against a shared/paid account.
- **Code:** `lib/circuit-breaker.mjs` (pure trip logic) + `supervisor.mjs` (halt/guard/CLI).
- **Trips on:** N consecutive crash cycles · N consecutive rate-limit hits · N consecutive non-merge
  cycles (churn) · window spend ≥ `maxWindowCostUsd`. A `merged` cycle clears the streaks.
- **Halt mechanism:** writes the STOP flag → both supervisor (loop boundary) and watchdog stay down;
  startup guard refuses to run while tripped. Survives process death.
- **Config:** `config.circuitBreaker` (all thresholds tunable; `enabled:false` disables).
- **Resume:** `node autopilot/supervisor.mjs reset-breaker && node autopilot/supervisor.mjs start`.
- **SaaS evolution:** per-tenant breakers (one tenant tripping never halts another) — folds into pillar 3.

### 2. BYOK (Bring Your Own Key) & Cost Tracking
- **Existing:** `state.usage` self-meters tokens/cost; `config.budgets` caps per-project tokens;
  the new cost-ceiling breaker enforces a hard $ cap.
- **Queued:** **U-42** — extract model definitions into a modular provider-mapping system supporting
  OpenRouter + custom endpoints (this is the BYOK seam: a tenant supplies key + endpoint).
- **Remaining for SaaS:** per-tenant key storage (encrypted, never logged), per-tenant cost ledger
  (extend `state.usage` into the per-tenant namespace from pillar 3), spend alerts before the ceiling.

### 3. Multi-Tenant Architecture — ➕ QUEUED (new)
Separated state + config + lock + budget per tenant so no tenant can read/write/throttle another.
- **Existing seams to extend:** per-project `budgets` (U-33), per-context `handoff` tags (U-34),
  per-repoGoal `locks` (U-32), `git.repository`/`worktreeName` target (U-35), queue-path config (U-31).
- **New task queued:** *"multi-tenant isolation — fully separated state/config/lock/budget namespace
  per tenant."* Risk 4.
- **Design direction:** a `tenantId` becomes the top-level namespace key for state files, lock names,
  budget counters, and worktree roots — everything already keyed by `PROJECT_ID`/`repoGoal` generalizes.

### 4. Sandboxed Execution Preparation — ➕ QUEUED (new)
Run each cycle's shell/git/file ops inside an isolated, resource-limited sandbox scoped to the tenant's
worktree, so untrusted tenant repos can't touch the host.
- **New task queued:** *"sandboxed execution preparation — define + stub the seam."* Risk 4.
- **Design direction:** abstract the exec surface (`lib/claude.mjs` CLI spawn, `lib/git.mjs`,
  `lib/validate.mjs`) behind an executor interface with a default in-process impl and a future
  container/VM impl. Pair with pillar 3 (one sandbox per tenant worktree).

### 5. Control Dashboard UI — already QUEUED
- **U-59** — local Express/React dashboard inside `autopilot/ui` to visualize queues, budget pacing,
  cycle logs. For SaaS this becomes the per-tenant control plane (status, breaker reset, spend, logs).

## Related work already in the backlog (do not duplicate)
- **U-60** ARCH-BLUEPRINT: decouple the engine from the project (generic agent core) — the umbrella.
- **U-41** strict JSON Schema for config (third-party validation).
- **U-43** generic integration guide (connect the engine to any TS project).
- **U-44** template distribution bundle separating commercial core from OSS plugins.
- **U-56** dynamic model router (Haiku risk-1 / Sonnet risk-3+) — cost optimization.

> ⚠️ The backlog currently has duplicate pairs (U-45≡U-50, U-46≡U-51, U-47≡U-54, U-48≡U-55,
> U-49≡U-53). De-dupe before a SaaS sprint so effort isn't double-counted.

## Suggested sequence
1. ✅ Circuit breaker (done).
2. U-42 BYOK/provider-mapping (unblocks customer onboarding).
3. Multi-tenant isolation (the core SaaS primitive; per-tenant cost ledger rides on it).
4. Sandboxed execution (security gate before accepting untrusted repos).
5. U-59 dashboard → per-tenant control plane.

## Models
Engine model routing is already cost-tuned for current models (`config.models`):
selector/auditor → `claude-haiku-4-5`, reviewer + low-risk implementer → `claude-sonnet-4-6`,
high-risk implementer → `claude-opus-4-8`. (Claude 3.5 Sonnet was requested but is deprecated and
slower/less capable than Sonnet 4.6 — kept on 4.6 for the same speed/cost intent. Override in
`config.models` if a specific 3.5 pin is truly required.)
