// usage-provider.mjs — multi-tier usage provider for Kinetic.
//
// Trust hierarchy (highest → lowest):
//   1. statusline   — Claude Code feeds real Anthropic rate-limit data via CLAUDE_CODE_STATUS_COMMAND
//   2. predicted    — estimated from state.usage token counters (existing budget-governor tracking)
//   3. unknown      — no data available
//
// The supervisor reads the best available source to:
//   (a) compute an accurate 5-hour and 7-day reset time for rate-limit pausing
//   (b) display via `node supervisor.mjs usage`
//   (c) cross-check local token tracking for drift

import { readFileSync } from 'node:fs';

// Maximum age of a statusline snapshot before we treat it as stale (30 min).
const SNAPSHOT_MAX_AGE_MS = 30 * 60 * 1000;

/**
 * Read and validate the statusline snapshot written by statusline-capture.mjs.
 * Returns null if missing, unparseable, or stale.
 */
export function readSnapshot(snapshotPath) {
  try {
    const raw = readFileSync(snapshotPath, 'utf8');
    const snap = JSON.parse(raw);
    if (!snap || typeof snap.observedAt !== 'number') return null;
    const age = Date.now() - snap.observedAt;
    if (age > SNAPSHOT_MAX_AGE_MS) return { ...snap, stale: true };
    return snap;
  } catch {
    return null;
  }
}

/**
 * Compute a usage estimate purely from state.usage token counters.
 * This is the existing budget-governor logic expressed as a UsageResult.
 *
 * @param {object} state   - full state.json object
 * @param {object} config  - resolved config (weeklyBudget.*)
 * @returns UsageResult with trust='predicted'
 */
export function predictFromState(state, config) {
  const u = state?.usage || {};
  const wb = config?.weeklyBudget || {};
  const bg = state?.budget || {};

  // Replicate windowSpend from budget-governor.mjs
  const spent = (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0)
    + (Number(u.cacheReadTokens) || 0) + (Number(u.cacheCreationTokens) || 0);

  const quota = bg.quota || 200_000_000; // known from the governor's last run
  const usedPercent = quota > 0 ? (spent / quota) * 100 : null;

  const windowResetAt = u.windowResetAt ? new Date(u.windowResetAt).getTime() : null;
  const windowStartAt = u.windowStartedAt ? new Date(u.windowStartedAt).getTime() : null;

  // Estimate per-cycle token burn for drift projection
  const cycles = Number(u.cycles) || 0;
  const avgTokensPerCycle = cycles > 0 ? spent / cycles : null;

  return {
    observedAt: Date.now(),
    sevenDay: {
      usedPercent,
      resetAt: windowResetAt,
      startAt: windowStartAt,
      spentTokens: spent,
      quotaTokens: quota,
    },
    fiveHour: null, // kinetic doesn't track the 5h window locally
    source: 'predicted',
    trust: 'medium',
    meta: {
      avgTokensPerCycle,
      cycles,
      costUsd: Number(u.costUsd) || 0,
    },
  };
}

/**
 * Return the best available usage snapshot, merging statusline + prediction.
 *
 * Priority:
 *   - sevenDay: statusline if fresh, else predicted
 *   - fiveHour: statusline only (we have no local 5h tracker)
 *
 * @param {object} state
 * @param {object} config
 * @param {string} snapshotPath  - path to state/usage-snapshot.json
 * @returns {UsageResult}
 */
export function getBestUsage(state, config, snapshotPath) {
  const snap = snapshotPath ? readSnapshot(snapshotPath) : null;
  const pred = predictFromState(state, config);

  const snapFresh = snap && !snap.stale;
  const snapStale = snap && snap.stale;

  // sevenDay: prefer fresh statusline, fall back to stale, then prediction
  let sevenDay, sevenDaySource, sevenDayTrust;
  if (snapFresh && snap.sevenDay?.usedPercent != null) {
    sevenDay = snap.sevenDay;
    sevenDaySource = 'statusline';
    sevenDayTrust = 'high';
  } else if (snapStale && snap.sevenDay?.usedPercent != null) {
    sevenDay = snap.sevenDay;
    sevenDaySource = 'statusline (stale)';
    sevenDayTrust = 'medium';
  } else {
    sevenDay = pred.sevenDay;
    sevenDaySource = 'predicted';
    sevenDayTrust = 'medium';
  }

  // fiveHour: statusline only
  let fiveHour = null, fiveHourSource = 'none', fiveHourTrust = 'none';
  if (snapFresh && snap.fiveHour?.usedPercent != null) {
    fiveHour = snap.fiveHour;
    fiveHourSource = 'statusline';
    fiveHourTrust = 'high';
  } else if (snapStale && snap.fiveHour?.usedPercent != null) {
    fiveHour = snap.fiveHour;
    fiveHourSource = 'statusline (stale)';
    fiveHourTrust = 'low';
  }

  // Drift: difference between statusline 7d% and our predicted %
  let drift = null;
  if (snapFresh && snap.sevenDay?.usedPercent != null && pred.sevenDay?.usedPercent != null) {
    drift = snap.sevenDay.usedPercent - pred.sevenDay.usedPercent;
  }

  const lastObservedAt = (snapFresh || snapStale) ? snap.observedAt : Date.now();

  return {
    sevenDay,
    sevenDaySource,
    sevenDayTrust,
    fiveHour,
    fiveHourSource,
    fiveHourTrust,
    drift,
    lastObservedAt,
    meta: pred.meta,
  };
}

/**
 * Format a usage report for `node supervisor.mjs usage`.
 */
export function formatUsageReport(usage) {
  const lines = ['Usage Summary', '─────────────'];

  const fmtPct = (p) => p != null ? `${p.toFixed(1)}%` : 'unknown';
  const fmtReset = (ms) => {
    if (!ms) return 'unknown';
    const dt = new Date(ms);
    const diff = ms - Date.now();
    const h = Math.floor(Math.abs(diff) / 3600000);
    const m = Math.floor((Math.abs(diff) % 3600000) / 60000);
    const inStr = diff > 0 ? `in ${h}h ${m}m` : `${h}h ${m}m ago`;
    return `${dt.toISOString().slice(0, 16)} UTC  (${inStr})`;
  };

  lines.push('');
  lines.push('Seven-day:');
  lines.push(`  ${fmtPct(usage.sevenDay?.usedPercent)}`);
  lines.push(`  Reset:      ${fmtReset(usage.sevenDay?.resetAt)}`);
  if (usage.sevenDay?.spentTokens != null) {
    lines.push(`  Tokens:     ${Math.round(usage.sevenDay.spentTokens / 1000)}k / ${Math.round((usage.sevenDay.quotaTokens || 0) / 1000)}k`);
  }
  lines.push(`  Source:     ${usage.sevenDaySource}`);
  lines.push(`  Confidence: ${usage.sevenDayTrust.toUpperCase()}`);

  lines.push('');
  lines.push('Five-hour:');
  if (usage.fiveHour) {
    lines.push(`  ${fmtPct(usage.fiveHour?.usedPercent)}`);
    lines.push(`  Reset:      ${fmtReset(usage.fiveHour?.resetAt)}`);
    lines.push(`  Source:     ${usage.fiveHourSource}`);
    lines.push(`  Confidence: ${usage.fiveHourTrust.toUpperCase()}`);
  } else {
    lines.push('  (not available — statusline snapshot not yet written)');
    lines.push('  The first claude call this session will populate it.');
  }

  if (usage.drift != null) {
    const sign = usage.drift >= 0 ? '+' : '';
    lines.push('');
    lines.push(`Prediction drift:  ${sign}${usage.drift.toFixed(1)}% (statusline vs local tracker)`);
  }

  lines.push('');
  lines.push(`Last observation:  ${new Date(usage.lastObservedAt).toISOString().slice(0, 16)} UTC`);

  if (usage.meta?.cycles) {
    lines.push(`Avg tokens/cycle:  ${usage.meta.avgTokensPerCycle != null ? Math.round(usage.meta.avgTokensPerCycle / 1000) + 'k' : 'unknown'}`);
    lines.push(`Total cost:        $${(usage.meta.costUsd || 0).toFixed(2)} this window`);
  }

  return lines.join('\n');
}
