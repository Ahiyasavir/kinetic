// budget-governor.mjs — DETERMINISTIC pre-cycle budget gate. Provider-neutral (works in TOKENS, the
// one unit every provider exposes). NO LLM reasoning: a fixed formula decides, before each cycle, whether
// the next action is allowed, must downgrade to cheaper models, or must stop — so quota is preserved by
// preventing overspend BEFORE it happens (not detected after).
//
// ───────────────────────── THE FORMULA ─────────────────────────
//   Inputs (all window-scoped; the weekly window resets state.usage counters):
//     Q  = weekly token quota            (inferred from live statusline when available; else
//                                          config.budgetGovernor.weeklyTokenQuota as manual override;
//                                          else config.budgets[projectId].maxTokensPerCycle; else ∞)
//     S  = tokens spent this window      (state.usage.inputTokens + state.usage.outputTokens + cache)
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
// SMART QUOTA — self-calibrating from Claude's live statusline:
//   When the statusline snapshot (state/usage-snapshot.json) reports a fresh sevenDay.usedPercent,
//   the governor infers the real quota as:  Q_inferred = localSpent / (usedPercent / 100)
//   This auto-calibrates every cycle — no manual weeklyTokenQuota required.  weeklyTokenQuota in
//   config now acts as a manual CEILING override (use it to be conservative); remove it to let
//   the governor discover the real quota from Claude's own rate-limit data.
//   Minimum usedPercent threshold (5%) prevents wild swings early in the week when both S and % are tiny.
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

// Well-known Anthropic tier quotas (weekly token ceilings). Used by /api/calibrate's `tier` shorthand
// so the user can say `tier: 'pro'` instead of looking up the exact number.
export const TIER_QUOTAS = Object.freeze({
  free:   25_000_000,   // ~25M tokens/week
  pro:    56_000_000,   // ~56M tokens/week (known Pro-tier ceiling)
  max:   200_000_000,   // ~200M tokens/week
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

// Infer the real weekly token quota from a live statusline snapshot.
// When Claude's rate-limit response says "you've used X% of your 7-day quota" and our local tracker
// reports S tokens spent, the real quota is approximately S / (X/100).
// Returns a finite number when the inference is reliable (usedPercent ≥ minPct and localSpent > 0),
// otherwise returns null (fall through to config/per-project cap).
export function inferQuotaFromLiveUsage(liveUsage, localSpent, minPct = 5) {
  const pct = liveUsage && liveUsage.sevenDay && liveUsage.sevenDay.usedPercent;
  if (!Number.isFinite(pct) || pct < minPct) return null;   // too little data — unreliable
  if (!Number.isFinite(localSpent) || localSpent <= 0) return null;
  const inferred = localSpent / (pct / 100);
  // Sanity: reject obviously wild inferences (< 10M or > 10B tokens)
  if (inferred < 10_000_000 || inferred > 10_000_000_000) return null;
  return Math.round(inferred);
}

// Resolve the weekly token quota Q (provider-neutral). Priority:
//   1. calibrated quota from state (user-provided ground truth via POST /api/calibrate — takes
//      precedence over live inference because: (a) live inference is unreliable in headless mode
//      where the statusline probe can return stale or low % values, and (b) the inference formula
//      Q = localSpent / usedPct breaks when localSpent already includes an externalTokenOffset that
//      was itself computed against a different quota baseline — producing a compounding inflation
//      spiral (e.g. 172M / 7% = 2.5B). When the user has explicitly stated their quota via
//      calibration, that is the authoritative ceiling; the live probe is a fallback for the
//      uncalibrated case only.)
//   2. explicit weeklyTokenQuota in config (a real, intended ceiling)
//   3. inferred from live statusline (legacy fallback — only when no explicit ceiling exists)
//   4. per-project cumulative cap (config.budgets[projectId].maxTokensPerCycle)
//   5. ∞ (unconstrained — cadence-only pacing)
//
// liveUsage is the result of getBestUsage() from usage-provider.mjs (optional).
// localSpent is the window-scoped token spend from windowSpend(state).
// state is the engine state (optional); when provided, reads state.usage.calibratedQuota.
//
// PRIORITY NOTE (changed 2026-06-17): the explicit config ceiling now beats live inference. The
// inference formula (quota = localSpent / usedPct) is fragile and, now that localSpent is the TRUE
// measured account-wide usage (lib/usage-reader.mjs), it actively MISFIRES — a stale/low statusline
// usedPct against a large measured spend produced absurd quotas (e.g. 222M / 18% = 1.2B), which then
// override the real ceiling and zero out the displayed fraction. An explicitly configured quota is a
// deliberate, stable ceiling and must win. Inference survives only for installs with NO config quota.
export function resolveQuota(config, projectId, liveUsage, localSpent, state) {
  // 1. Calibrated quota from state (set by /api/calibrate with actualQuota or tier). Authoritative
  //    home is state.usage.calibratedQuota (survives weekly rollover); state.budget.calibratedQuota is
  //    the mirrored copy in the budget block — honored as a fallback so the budget block is a real,
  //    self-sufficient persistence source even if usage counters are ever wiped independently.
  const calibratedUsage = state && state.usage && Number(state.usage.calibratedQuota);
  if (Number.isFinite(calibratedUsage) && calibratedUsage > 0) return calibratedUsage;
  const calibratedBudget = state && state.budget && Number(state.budget.calibratedQuota);
  if (Number.isFinite(calibratedBudget) && calibratedBudget > 0) return calibratedBudget;
  // 2. Explicit ceiling from config — beats fragile live inference (see PRIORITY NOTE above).
  const g = governorConfig(config);
  if (Number.isFinite(g.weeklyTokenQuota) && g.weeklyTokenQuota > 0) return g.weeklyTokenQuota;
  // 3. Live inference — Claude's own rate-limit data (legacy fallback when no explicit ceiling is set)
  if (liveUsage && liveUsage.sevenDayTrust && liveUsage.sevenDayTrust !== 'none') {
    const inferred = inferQuotaFromLiveUsage(liveUsage, localSpent);
    if (inferred !== null) return inferred;
  }
  // 4. Per-project cap
  const b = ((config && config.budgets) || {})[projectId];
  const cap = b && Number(b.maxTokensPerCycle);
  return Number.isFinite(cap) && cap > 0 ? cap : Infinity;
}

// Window-scoped tokens spent + cycles, from state.usage (reset on the weekly roll).
// IMPORTANT: cache tokens (read + creation) are included because Claude Code's weekly usage
// meter counts them. Omitting them caused the governor to see ~1% of actual spend (1.3M vs 126M).
//
// MEASURED ACCOUNT USAGE (preferred, set by lib/usage-reader.mjs): when the supervisor (or the
// control API) has read the TRUE account-wide weekly spend from Claude's own transcripts
// (~/.claude/projects/**/*.jsonl — includes the user's interactive sessions, not just the engine),
// it stores it on `state.usage.measuredWeeklyTokens`. That number IS the real position, so we use it
// directly and ignore the engine-only counters + external offset. This makes calibration obsolete.
//
// EXTERNAL OFFSET (legacy fallback): before measured usage existed, the only way to account for the
// user's invisible interactive sessions on the shared account was a manual `/api/calibrate` that wrote
// `usage.externalTokenOffset` = (reportedSpent − engineTracked). Kept as a fallback so older state and
// installs without transcript access still work. Reset to 0 on weekly rollover.
function windowSpend(state) {
  const u = (state && state.usage) || {};
  const cycles = Number(u.cycles) || 0;
  // Preferred: true measured account-wide weekly usage.
  const measured = Number(u.measuredWeeklyTokens);
  if (Number.isFinite(measured) && measured > 0) return { spent: measured, cycles };
  // Fallback: engine-tracked counters + any manual calibration offset.
  const engineTracked = (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0)
    + (Number(u.cacheReadTokens) || 0) + (Number(u.cacheCreationTokens) || 0);
  const externalOffset = Number(u.externalTokenOffset) || 0;
  return { spent: engineTracked + externalOffset, cycles };
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
//   liveUsage — optional result of getBestUsage() from usage-provider.mjs; when provided, the quota
//               is inferred from Claude's real rate-limit data (self-calibrating — no static number needed).
export function governCycle(state, config, projectId, liveUsage) {
  const gRaw = governorConfig(config);
  const { spent, cycles } = windowSpend(state);
  const quota = resolveQuota(config, projectId, liveUsage, spent, state);
  // Determine where the quota came from to tag quotaMode/quotaSource correctly.
  // Priority mirrors resolveQuota: calibrated > live-inference > config > per-project.
  const calibratedQuota = (state && ((state.usage && Number(state.usage.calibratedQuota)) || (state.budget && Number(state.budget.calibratedQuota)))) || null;
  const calibratedQuotaIsActive = Number.isFinite(calibratedQuota) && calibratedQuota > 0;
  // Live inference is only attempted when no calibratedQuota is set AND the snapshot is trusted —
  // this MUST mirror resolveQuota's gate (sevenDayTrust !== 'none'); otherwise quotaMode/quotaSource
  // could be tagged 'known'/'statusline-inferred' while resolveQuota actually fell through to config
  // or the per-project cap, misreporting why a decision was made.
  const inferredQuota = !calibratedQuotaIsActive && liveUsage && liveUsage.sevenDayTrust && liveUsage.sevenDayTrust !== 'none'
    ? inferQuotaFromLiveUsage(liveUsage, spent) : null;
  const quotaMode = (calibratedQuotaIsActive || inferredQuota !== null) ? 'known' : detectQuotaMode(config, projectId);
  const g = effectiveFractions(gRaw, quotaMode);
  const estimate = estimateNextCycleTokens(state, config);

  const quotaSource = calibratedQuotaIsActive ? 'user-calibrated'
    : inferredQuota !== null ? 'statusline-inferred'
    : (Number.isFinite(governorConfig(config).weeklyTokenQuota) ? 'config-override' : 'per-project-cap');
  // Surface the persisted calibrated quota (if any) so the budget block in state.json carries it.
  const base = { projectId, quota, quotaMode, quotaSource, calibratedQuota: calibratedQuotaIsActive ? calibratedQuota : null, spent, cycles, estimate, safeMode: !!g.safeMode };
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
