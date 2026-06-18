// stats.mjs — U-66-cont: the app.stats reduction surface for cycle cost analytics.
//
// This is the high-level read API the cost dashboard (GET /api/stats/cost) and unit tests use. It sits on
// top of the lower-level primitives so the rolling-window math stays in ONE place:
//   • computeRollingAverages — per-[goal][risk] rolling averages (delegates to cost-stats.computeStats)
//   • projectWeeklySpend      — linear weekly extrapolation of the per-cycle cost (cost-projector)
//
// Both are pure + total: malformed/empty input degrades to a valid empty/zero result and never throws, so
// a cost-analytics read can never break a request handler.
import { computeStats } from './cost-stats.mjs';
import { projectWeeklyCost, DEFAULT_CYCLES_PER_WEEK } from './cost-projector.mjs';

/**
 * Rolling averages per [goal][risk] over the retained window:
 *   { [goal]: { [risk]: { avgInputTokens, avgOutputTokens, avgCacheRead, cycleCount } } }
 *
 * Returns {} for empty/malformed input. Only goals actually present in `statsData` appear in the result
 * (computeStats also carries byGoal/byRisk/totals at the top level — those are stripped here so the
 * shape is purely the per-category averages).
 *
 * @param {object} statsData  statsData[goal][risk] = [{ inputTokens, outputTokens, cacheReadTokens }]
 * @returns {object}  per-goal/risk rolling averages
 */
export function computeRollingAverages(statsData) {
  const out = {};
  if (!statsData || typeof statsData !== 'object' || Array.isArray(statsData)) return out;
  const full = computeStats(statsData);
  for (const goal of Object.keys(statsData)) {
    if (full[goal]) out[goal] = full[goal];
  }
  return out;
}

/**
 * Project weekly spend from the observed average cost per cycle (linear extrapolation over a steady
 * cadence). Advisory only — feeds the dashboard's projectedWeeklySpend, never gates a cycle.
 *
 * @param {number} avgCostPerCycle  average per-cycle cost from computeStats
 * @param {number} [cyclesPerWeek=DEFAULT_CYCLES_PER_WEEK]  assumed cycles per week
 * @returns {number}  projected weekly spend (>= 0); 0 for non-positive / non-finite input
 */
export function projectWeeklySpend(avgCostPerCycle, cyclesPerWeek = DEFAULT_CYCLES_PER_WEEK) {
  return projectWeeklyCost(avgCostPerCycle, cyclesPerWeek);
}
