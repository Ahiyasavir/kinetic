# Budget Governor · Model Routing · Non-LLM Verification · Provider Adapters

Safety/cost/portability layer for the autonomous loop. **Algorithmic control over LLM judgment** — every
gating decision is a deterministic formula; the LLM is used only for ambiguous interpretation and review.

---

## 1. Budget Governor (deterministic, pre-cycle) — `lib/budget-governor.mjs`

Runs **before each cycle** and decides `proceed | downgrade | stop` from a fixed formula (no LLM). Prevents
overspend *before* it happens. Provider-neutral: works in **tokens**.

### Formula
```
Q   weekly token quota   = config.budgetGovernor.weeklyTokenQuota
                           ?? config.budgets[projectId].maxTokensPerCycle   ?? ∞
S   window tokens spent  = state.usage.inputTokens + state.usage.outputTokens   (resets weekly)
n   window cycles        = state.usage.cycles
avg = n > 0 ? S/n : minCycleTokens
E   est. NEXT cycle      = max(minCycleTokens, avg) × (1 + safetyMargin) × retryBuffer   ← conservative
U   usable budget        = Q × (1 − reserveFraction)        ← reserve withheld, never spent
P   projected            = S + E
```
### Decision (first match wins — auditable)
| Condition | Action | Meaning |
|---|---|---|
| `S ≥ Q × hardStopFraction` | **stop** | hard quota guard (absolute ceiling) |
| `P > U` | **stop** | next cycle would breach usable budget |
| `P > U × downgradeFraction` | **downgrade** | approaching budget → cheaper models only |
| else | **proceed** | within budget |

`headroom = max(0, U − S)` · `cyclesLeft = ⌊headroom / E⌋`

### Thresholds (defaults, all in `config.budgetGovernor`)
| Key | Default | Role |
|---|---|---|
| `reserveFraction` | `0.10` | never-spend reserve |
| `safetyMargin` | `0.15` | conservative estimate padding |
| `retryBuffer` | `1.50` | assume next cycle may cost 50% more (revise retries) |
| `hardStopFraction` | `0.95` | absolute hard stop |
| `downgradeFraction` | `0.80` | begin downgrading |
| `minCycleTokens` | `50000` | estimate floor (never optimistic-low) |

- **stop** writes the STOP flag (watchdog stays down) → resume after the weekly window resets with `start`.
- Every cycle persists the decision to **`state.budget`** for audit. Inspect token-free: `supervisor.mjs verify`.
- `Q = ∞` (no quota) → always `proceed` → **backward compatible** (cadence-only pacing unchanged).

---

## 2. Model Routing (class + risk + budget) — `lib/route.mjs`

Deterministic; the LLM never chooses its own budget path. Works in **logical tiers** (`strong | mid | cheap`)
resolved to concrete ids by the active provider adapter.

```
Base tier:
  risk ≥ opusMinRisk (3)                          → strong
  architectural keyword OR class == migration     → strong
  class ∈ {maintenance} AND risk ≤ 1              → cheap
  else                                            → mid
Budget overlay (from the governor's persisted action):
  action == 'downgrade' → drop ONE tier (strong→mid→cheap; cheap stays cheap)
  action == 'stop'      → loop halts (no model)
```
Tiers map via `config.models`: `strong→implementerHigh`, `mid→implementerLow`, `cheap→implementerLowest`.

---

## 3. Non-LLM Verification gauntlet — `lib/verify.mjs`

Cheap/decidable checks run before (and independently of) any LLM review. **"PASS typecheck/build/lint" is
necessary but NEVER sufficient** — `ok` also requires class-appropriate delivery proof.

| Check | Source | Blocking |
|---|---|---|
| typecheck / lint / build | `runValidation` result | yes |
| file existence + **import/wiring** (dead-file detector) | `evidence.checkEvidence` | yes (if artifacts declared) |
| product diff (tracked change) — product class only | git diff | yes for product; n/a for engine |
| duplicates · contradictions · stale done/blocked | `reconcile.analyzeState` | report (`verify` CLI) |

The LLM is reserved for the **non-mechanical** part: acceptance-criteria intent, behavioral regressions,
scope creep, NL synthesis. If mechanical checks fail, the cycle blocks deterministically (no token spent).

---

## 4. Provider Adapters — `lib/providers/`

Core policy (routing/budgeting/verification) is vendor-neutral. A `ProviderAdapter` maps logical tiers +
a normalized result shape onto a concrete provider.

```
interface ProviderAdapter {
  id
  run({prompt,cwd,config,label,model}) → { ok, text, usage:{input_tokens,output_tokens,cache_*}, costUsd }
  resolveModel(tierOrId, config) → concrete id     // 'strong'|'mid'|'cheap' → config.models.*
  estimateTokens(text) → number                    // provider-neutral (≈ chars/4)
  tokensOf(result) → number ; priceOf(result, config) → USD
  isRateLimit(err) → bool ; retryAfterMs(err) → number|null
}
```
- `getAdapter(config)` resolves `config.provider` (default `claude`); unknown id **throws** (no silent wrong-vendor fallback).
- The Claude adapter wraps `lib/claude.mjs` 1:1 (behavior-preserving). It is injected at the **single seam**
  `createCore({ runClaude: getAdapter(config).run })`.
- **Add a provider** (Cursor / Windsurf / Antigravity / OpenAI-compatible): create `lib/providers/<id>.mjs`
  implementing the interface, `registerAdapter()` it, set `config.provider`, point `config.models` at its ids.
  No change to `route.mjs` / `budget-governor.mjs` / `verify.mjs`.

---

## Operator commands (all token-free except `run`)
```
supervisor.mjs verify        # budget decision + non-LLM repo audit (0 tokens)
supervisor.mjs status        # adds the budget-governor line
supervisor.mjs reconcile     # disk-truth reconciliation (dry-run)
supervisor.mjs reset-breaker # clear a tripped circuit breaker
```

## Tests
`tests/budget-routing.mjs` — 23 assertions (budget gating, routing decisions, downgrade, non-LLM
verification, adapter registry/resolution). `tests/reliability.mjs` — 14 (task-class/evidence/reconcile).
