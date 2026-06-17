// usage-ledger.mjs — self-tracked, timestamped token-spend ledger.
//
// WHY: Claude Code's statusline (CLAUDE_CODE_STATUS_COMMAND) is the only channel that carries
// Anthropic's real 5h/7d reset timestamps — but it ONLY fires in the interactive UI, NOT in the
// headless `claude -p` mode the engine runs. So `usage-snapshot.json` is never written and the engine
// has no live view of either rate-limit window. The previous fallback tracked only a coarse 7-day
// counter and literally set `fiveHour: null` (no 5h awareness at all), which is exactly how the loop
// kept blind-sleeping ~45 min on a limit that had already cleared.
//
// This module removes that dependency for the engine's OWN consumption: every call's token spend is
// appended with a wall-clock timestamp, and rolling 5h / 7d sums are derived locally. It is the
// authoritative local source for both windows.
//
// HONEST BOUNDARY: the Claude account is SHARED with the user's own sessions. The ledger sees only
// what the ENGINE spends, so against a shared-account limit it under-counts the user's slice. It can
// never perfectly predict a shared limit — that information simply isn't exposed to a headless client.
// The operational guarantee comes from pairing this with the probe-before-resume loop (supervisor:
// pauseForRateLimit), which actively re-checks every few minutes and so never over-waits regardless of
// prediction accuracy. The ledger makes the *estimate* good; the probe makes being wrong *cheap*.

export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000;

// Cap the ledger so it can never grow unbounded inside state.json. 7 days of busy cycles is well under
// this; entries older than the 7-day window are pruned on every append anyway.
const MAX_ENTRIES = 5000;

/**
 * Append a token-spend observation to the ledger and prune anything older than 7 days.
 * Stored on state.usage.ledger as a compact array of [tsMs, tokens] pairs (small in JSON).
 *
 * @param {object} state   full state.json object (uses state.usage.ledger)
 * @param {number} tokens  tokens spent in this observation (input+output+cache — caller decides)
 * @param {number} [nowMs] injectable clock for tests; defaults to Date.now()
 * @returns {Array<[number, number]>} the pruned ledger
 */
export function recordSpend(state, tokens, nowMs = Date.now()) {
  if (!state.usage) state.usage = {};
  const t = Number(tokens) || 0;
  const ledger = Array.isArray(state.usage.ledger) ? state.usage.ledger : [];
  if (t > 0) ledger.push([nowMs, t]);

  // Prune entries outside the 7-day window (the widest we ever query), then bound the length.
  const cutoff = nowMs - SEVEN_DAY_MS;
  let pruned = ledger.filter(([ts]) => ts >= cutoff);
  if (pruned.length > MAX_ENTRIES) pruned = pruned.slice(pruned.length - MAX_ENTRIES);

  state.usage.ledger = pruned;
  return pruned;
}

/**
 * Sum tokens spent within the last `windowMs`.
 *
 * @param {object} state
 * @param {number} windowMs
 * @param {number} [nowMs]
 * @returns {number} tokens spent in the window
 */
export function windowSpend(state, windowMs, nowMs = Date.now()) {
  const ledger = Array.isArray(state?.usage?.ledger) ? state.usage.ledger : [];
  const cutoff = nowMs - windowMs;
  let sum = 0;
  for (const [ts, tok] of ledger) {
    if (ts >= cutoff) sum += Number(tok) || 0;
  }
  return sum;
}

/** Tokens spent in the trailing 5-hour window. */
export function fiveHourSpend(state, nowMs = Date.now()) {
  return windowSpend(state, FIVE_HOUR_MS, nowMs);
}

/** Tokens spent in the trailing 7-day window. */
export function sevenDaySpend(state, nowMs = Date.now()) {
  return windowSpend(state, SEVEN_DAY_MS, nowMs);
}

/**
 * Derive a 5-hour usage view from the ledger, expressed in the same shape getBestUsage() returns for
 * the other windows so the supervisor can consume it uniformly.
 *
 * The 5h window is ROLLING (sliding), so there is no single "resetAt" the way the fixed 7-day quota
 * window has. We report the moment the OLDEST in-window entry ages out as `resetAt` — i.e. when the
 * current 5h pressure would meaningfully ease if no further spend occurs. With an empty ledger the
 * pressure is already zero, so resetAt is now.
 *
 * @param {object} state
 * @param {number} [quotaTokens] optional 5h token budget to compute usedPercent against
 * @param {number} [nowMs]
 */
export function fiveHourView(state, quotaTokens = null, nowMs = Date.now()) {
  const ledger = Array.isArray(state?.usage?.ledger) ? state.usage.ledger : [];
  const cutoff = nowMs - FIVE_HOUR_MS;
  const inWindow = ledger.filter(([ts]) => ts >= cutoff);
  const spent = inWindow.reduce((s, [, tok]) => s + (Number(tok) || 0), 0);

  // Oldest in-window entry → when it ages out the rolling pressure drops.
  const oldestTs = inWindow.length ? Math.min(...inWindow.map(([ts]) => ts)) : nowMs;
  const resetAt = inWindow.length ? oldestTs + FIVE_HOUR_MS : nowMs;

  const usedPercent = quotaTokens && quotaTokens > 0 ? (spent / quotaTokens) * 100 : null;

  return {
    usedPercent,
    resetAt,
    spentTokens: spent,
    quotaTokens: quotaTokens || null,
    entries: inWindow.length,
  };
}
