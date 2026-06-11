// circuit-breaker.mjs — engine safety halt for the autonomous loop (SaaS hardening; highest-priority
// reliability primitive). The supervisor runs unattended against a SHARED, paid Claude account, so a
// runaway state (repeated crashes, a rate-limit storm, churn that never merges, or unbounded spend) must
// be able to STOP the loop instead of burning the account. This module owns the trip LOGIC only — it
// mutates `state.circuitBreaker` counters and decides when to trip; the supervisor performs the actual
// side effects (write the STOP flag, persist state, exit), so this stays pure and unit-testable.
//
// Trip conditions (each independently configurable; set a threshold to 0/null to disable that one):
//   • maxConsecutiveFailures    — back-to-back crash/error cycles (runaway error loop)
//   • maxConsecutiveRateLimits  — back-to-back rate-limit hits (quota storm; pausing isn't recovering)
//   • maxConsecutiveUnproductive— back-to-back non-merge cycles (churn: working but never delivering)
//   • maxWindowCostUsd          — hard $ ceiling on the current pacing window (opt-in; null = off)
//
// Config-driven via config.circuitBreaker; safe by omission — no config block → DEFAULTS apply and the
// cost ceiling stays off, so existing runs are unaffected until thresholds are tuned.

export const DEFAULTS = Object.freeze({
  enabled: true,
  maxConsecutiveFailures: 5,
  maxConsecutiveRateLimits: 8,
  maxConsecutiveUnproductive: 12,
  maxWindowCostUsd: null, // opt-in: set a number to cap window spend
});

export function breakerConfig(config) {
  return { ...DEFAULTS, ...((config && config.circuitBreaker) || {}) };
}

// Ensure the breaker sub-state exists; returns it. Idempotent — safe to call every load.
export function ensureBreaker(state) {
  if (!state.circuitBreaker || typeof state.circuitBreaker !== 'object') {
    state.circuitBreaker = {};
  }
  const b = state.circuitBreaker;
  if (typeof b.consecutiveFailures !== 'number') b.consecutiveFailures = 0;
  if (typeof b.consecutiveRateLimits !== 'number') b.consecutiveRateLimits = 0;
  if (typeof b.consecutiveUnproductive !== 'number') b.consecutiveUnproductive = 0;
  if (typeof b.tripped !== 'boolean') b.tripped = false;
  if (!('trippedAt' in b)) b.trippedAt = null;
  if (!('reason' in b)) b.reason = null;
  if (!('trips' in b)) b.trips = 0; // lifetime trip count (telemetry)
  return b;
}

export function isTripped(state) {
  return !!(state.circuitBreaker && state.circuitBreaker.tripped);
}

// Record a finished cycle's outcome and decide whether the breaker trips.
//   kind: 'merged' | 'unproductive' | 'crash' | 'rate-limit'
// A 'merged' (productive) cycle clears every consecutive counter — the loop is healthy again.
// Returns { tripped: boolean, reason: string|null }.
export function recordCycleOutcome(state, config, kind) {
  const b = ensureBreaker(state);
  const cfg = breakerConfig(config);
  if (!cfg.enabled) return { tripped: false, reason: null };

  switch (kind) {
    case 'merged':
      b.consecutiveFailures = 0;
      b.consecutiveRateLimits = 0;
      b.consecutiveUnproductive = 0;
      return { tripped: false, reason: null };
    case 'crash':
      b.consecutiveFailures += 1;
      b.consecutiveRateLimits = 0;
      b.consecutiveUnproductive = 0;
      break;
    case 'rate-limit':
      b.consecutiveRateLimits += 1;
      // a rate-limit isn't a code failure; don't touch the failure/unproductive streaks
      break;
    case 'unproductive':
      b.consecutiveUnproductive += 1;
      b.consecutiveFailures = 0;
      b.consecutiveRateLimits = 0;
      break;
    default:
      return { tripped: false, reason: null };
  }

  if (cfg.maxConsecutiveFailures && b.consecutiveFailures >= cfg.maxConsecutiveFailures) {
    return tripResult(`${b.consecutiveFailures} consecutive failed cycles ≥ maxConsecutiveFailures (${cfg.maxConsecutiveFailures})`);
  }
  if (cfg.maxConsecutiveRateLimits && b.consecutiveRateLimits >= cfg.maxConsecutiveRateLimits) {
    return tripResult(`${b.consecutiveRateLimits} consecutive rate-limit hits ≥ maxConsecutiveRateLimits (${cfg.maxConsecutiveRateLimits})`);
  }
  if (cfg.maxConsecutiveUnproductive && b.consecutiveUnproductive >= cfg.maxConsecutiveUnproductive) {
    return tripResult(`${b.consecutiveUnproductive} consecutive non-merge cycles ≥ maxConsecutiveUnproductive (${cfg.maxConsecutiveUnproductive})`);
  }
  return { tripped: false, reason: null };
}

// Hard spend ceiling on the current pacing window. Reads state.usage.costUsd (self-metered by the
// supervisor). Returns { tripped, reason }. No-op unless maxWindowCostUsd is a positive number.
export function checkCostCeiling(state, config) {
  const cfg = breakerConfig(config);
  if (!cfg.enabled || !cfg.maxWindowCostUsd || cfg.maxWindowCostUsd <= 0) return { tripped: false, reason: null };
  ensureBreaker(state);
  const spent = (state.usage && Number(state.usage.costUsd)) || 0;
  if (spent >= cfg.maxWindowCostUsd) {
    return { tripped: true, reason: `window spend $${spent.toFixed(2)} ≥ maxWindowCostUsd ($${Number(cfg.maxWindowCostUsd).toFixed(2)})` };
  }
  return { tripped: false, reason: null };
}

// Stamp the breaker as tripped on the state object. The caller still owns the side effects (STOP flag,
// persist, exit). `at` is supplied by the caller (supervisor passes nowIso()) so this module stays free
// of Date usage and remains deterministic for tests.
export function tripBreaker(state, reason, at) {
  const b = ensureBreaker(state);
  b.tripped = true;
  b.reason = reason;
  b.trippedAt = at || null;
  b.trips += 1;
  return b;
}

// Operator reset — clears the trip and all streaks so the loop can resume.
export function resetBreaker(state) {
  const b = ensureBreaker(state);
  b.tripped = false;
  b.reason = null;
  b.trippedAt = null;
  b.consecutiveFailures = 0;
  b.consecutiveRateLimits = 0;
  b.consecutiveUnproductive = 0;
  return b;
}

function tripResult(reason) {
  return { tripped: true, reason };
}
