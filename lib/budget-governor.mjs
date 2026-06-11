// budget-governor.mjs — DETERMINISTIC pre-cycle budget gate. Provider-neutral (works in TOKENS, the
// one unit every provider exposes). NO LLM reasoning: a fixed formula decides, before each cycle, whether
// the next action is allowed, must downgrade to cheaper models, or must stop — so quota is preserved by
// preventing overspend BEFORE it happens (not detected after).
//
// ───────────────────────── THE FORMULA ─────────────────────────
//   Inputs (all window-scoped; the weekly window resets state.usage counters):
//     Q  = weekly token quota            (config.budgetGovernor.weeklyTokenQuota, else the per-project
//                                          cap config.budgets[projectId].maxTokensPerCycle, else ∞)
//     S  = tokens spent this window      (state.usage.inputTokens + state.usage.outputTokens)
//     n  = cycles run this window        (state.usage.cycles)
//     ρ  = reserveFraction      (0.10)   never-spend reserve, held back from Q
//     σ  = safetyMargin         (0.15)   conservative padding on the per-cycle estimate
//     β  = retryBuffer          (1.50)   assume the next cycle may cost 50% more (revise retries)
//     H  = hardStopFraction     (0.95)   absolute hard stop at 95% of Q
//     D  = downgradeFraction    (0.80)   begin downgrading models at 80% of usable budget
//     m  = minCycleTokens     (50_000)   floor for the per-cycle estimate (never optimistic-low)
//
//   Derived:
//     avg = n > 0 ? S / n : m                       observed mean cycle cost this window
//     E   = max(m, avg) × (1 + σ) × β               CONSERVATIVE estimate of the NEXT cycle  (retry buffer)
//     U   = Q × (1 − ρ)                             usable budget (reserve withheld)
//     P   = S + E                                   projected spend after the next cycle
//
//   Decision (first match wins — deterministic, auditable):
//     S ≥ Q × H   → STOP        "hard quota guard"
//     P >  U      → STOP        "next cycle would breach usable budget"
//     P >  U × D  → DOWNGRADE   "approaching budget — cheaper models only"
//     else        → PROCEED
//
//   Reported: headroom = max(0, U − S);  cyclesLeft = E > 0 ? floor(headroom / E) : ∞
//
// Backward compatible: with no quota configured (Q = ∞) the governor always returns PROCEED, so existing
// cadence-only pacing is unchanged until a quota is set.

export const GOVERNOR_DEFAULTS = Object.freeze({
  enabled: true,
  weeklyTokenQuota: null,
  reserveFraction: 0.10,
  safetyMargin: 0.15,
  retryBuffer: 1.50,
  hardStopFraction: 0.95,
  downgradeFraction: 0.80,
  minCycleTokens: 50_000,
  // P4 — Usage-limit discovery. When the real quota cannot be discovered (no explicit weeklyTokenQuota
  // AND no per-project cap), the safe default is NOT "assume unlimited". With safeMode:true the governor
  // (a) tightens its fractions when the quota is only ESTIMATED, and (b) holds a standing DOWNGRADE
  // posture (cheaper models) when the quota is UNKNOWN — it never STOPS on an unknown quota, so it can't
  // deadlock. safeMode defaults FALSE → existing "unknown quota ⇒ always proceed" behavior is preserved.
  safeMode: false,
  safeReserveFraction: 0.25,
  safeDowngradeFraction: 0.50,
  safeHardStopFraction: 0.75,
});

export function governorConfig(config) {
  return { ...GOVERNOR_DEFAULTS, ...((config && config.budgetGovernor) || {}) };
}

// Classify how well we know the spending limit (P4 — never silently assume unlimited):
//   'known'     — an explicit weeklyTokenQuota is configured (a real, intended ceiling)
//   'estimated' — no explicit quota, but a per-project cap (budgets[projectId].maxTokensPerCycle) exists
//   'unknown'   — neither is configured; the true provider quota is undiscovered
export function detectQuotaMode(config, projectId) {
  const g = governorConfig(config);
  if (Number.isFinite(g.weeklyTokenQuota) && g.weeklyTokenQuota > 0) return 'known';
  const b = ((config && config.budgets) || {})[projectId];
  const cap = b && Number(b.maxTokensPerCycle);
  return Number.isFinite(cap) && cap > 0 ? 'estimated' : 'unknown';
}

// Apply Safe-Mode tightening to the effective fractions for a given quota mode. Returns a copy of `g`
// with reserve raised + downgrade/hardStop lowered when safeMode is on and the quota is not fully known.
// 'known' quota is never tightened (the operator set a deliberate ceiling).
function effectiveFractions(g, mode) {
  if (!g.safeMode || mode === 'known') return g;
  return {
    ...g,
    reserveFraction: Math.max(g.reserveFraction, g.safeReserveFraction),
    downgradeFraction: Math.min(g.downgradeFraction, g.safeDowngradeFraction),
    hardStopFraction: Math.min(g.hardStopFraction, g.safeHardStopFraction),
  };
}

// Resolve the weekly token quota Q (provider-neutral). Priority: explicit weeklyTokenQuota → the
// per-project cumulative cap (config.budgets[projectId].maxTokensPerCycle) → ∞ (unconstrained).
export function resolveQuota(config, projectId) {
  const g = governorConfig(config);
  if (Number.isFinite(g.weeklyTokenQuota) && g.weeklyTokenQuota > 0) return g.weeklyTokenQuota;
  const b = ((config && config.budgets) || {})[projectId];
  const cap = b && Number(b.maxTokensPerCycle);
  return Number.isFinite(cap) && cap > 0 ? cap : Infinity;
}

// Window-scoped tokens spent + cycles, from state.usage (reset on the weekly roll).
function windowSpend(state) {
  const u = (state && state.usage) || {};
  const spent = (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0);
  const cycles = Number(u.cycles) || 0;
  return { spent, cycles };
}

// Conservative estimate of the NEXT cycle's tokens: max(floor, observed mean) × (1+σ) × retryBuffer.
export function estimateNextCycleTokens(state, config) {
  const g = governorConfig(config);
  const { spent, cycles } = windowSpend(state);
  const avg = cycles > 0 ? spent / cycles : g.minCycleTokens;
  return Math.max(g.minCycleTokens, avg) * (1 + g.safetyMargin) * g.retryBuffer;
}

// THE GATE. Pure: reads state + config, returns a decision object. Never mutates, never calls an LLM.
//   action ∈ 'proceed' | 'downgrade' | 'stop'
export function governCycle(state, config, projectId) {
  const gRaw = governorConfig(config);
  const quotaMode = detectQuotaMode(config, projectId);
  const g = effectiveFractions(gRaw, quotaMode);
  const quota = resolveQuota(config, projectId);
  const { spent, cycles } = windowSpend(state);
  const estimate = estimateNextCycleTokens(state, config);

  const base = { projectId, quota, quotaMode, spent, cycles, estimate, safeMode: !!g.safeMode };
  if (!g.enabled || !Number.isFinite(quota)) {
    // Unconstrained (no discoverable quota). Default: proceed (backward compatible). Safe Mode posture
    // (P4): never assume unlimited — hold a standing DOWNGRADE (cheaper models) rather than full-rate.
    // Still never STOP here, so an undiscovered quota can never deadlock the loop.
    if (g.enabled && g.safeMode && quotaMode === 'unknown') {
      return { action: 'downgrade',
        reason: 'SAFE MODE: token quota undiscovered — preferring cheaper models (never assume unlimited)',
        ...base, usable: Infinity, projected: spent + estimate, headroom: Infinity, cyclesLeft: Infinity, fractionUsed: 0 };
    }
    return { action: 'proceed', reason: g.enabled ? 'no token quota configured (unconstrained)' : 'governor disabled',
      ...base, usable: Infinity, projected: spent + estimate, headroom: Infinity, cyclesLeft: Infinity, fractionUsed: 0 };
  }

  const usable = quota * (1 - g.reserveFraction);
  const projected = spent + estimate;
  const headroom = Math.max(0, usable - spent);
  const cyclesLeft = estimate > 0 ? Math.floor(headroom / estimate) : Infinity;
  const fractionUsed = quota > 0 ? spent / quota : 0;
  const safeTag = (g.safeMode && quotaMode !== 'known') ? ` [SAFE MODE: ${quotaMode} quota — tightened]` : '';
  const out = { ...base, usable, projected, headroom, cyclesLeft, fractionUsed };

  if (spent >= quota * g.hardStopFraction) {
    return { action: 'stop', reason: `hard quota guard: spent ${pct(spent, quota)} ≥ ${pct(quota * g.hardStopFraction, quota)} (hardStop)${safeTag}`, ...out };
  }
  if (projected > usable) {
    return { action: 'stop', reason: `next cycle would breach usable budget: projected ${fmt(projected)} > usable ${fmt(usable)} (reserve ${(g.reserveFraction * 100).toFixed(0)}% held)${safeTag}`, ...out };
  }
  if (projected > usable * g.downgradeFraction) {
    return { action: 'downgrade', reason: `approaching budget: projected ${fmt(projected)} > ${(g.downgradeFraction * 100).toFixed(0)}% of usable — cheaper models only${safeTag}`, ...out };
  }
  return { action: 'proceed', reason: `within budget: projected ${fmt(projected)} ≤ ${(g.downgradeFraction * 100).toFixed(0)}% of usable; ~${cyclesLeft} cycle(s) of headroom${safeTag}`, ...out };
}

function fmt(n) { return Number.isFinite(n) ? `${Math.round(n / 1000)}k tok` : '∞'; }
function pct(n, d) { return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a'; }
