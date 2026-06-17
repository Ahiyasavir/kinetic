// cost-projector.mjs — U-66-cont: project a weekly spend from the observed average cost per cycle.
//
// projectWeeklyCost(avgCostPerCycle) linearly extrapolates the rolling per-cycle cost out to a 7-day
// window by assuming a steady cadence (DEFAULT_CYCLES_PER_WEEK, overridable). Advisory only — it feeds the
// GET /api/stats/cost dashboard's projectedWeeklySpend and never gates a cycle.

// Steady-cadence assumption: ~one cycle every 30 min → 48/day → 336/week. The engine's actual cadence is
// AIMD-paced, so this is a planning estimate, not a guarantee.
export const DEFAULT_CYCLES_PER_WEEK = 7 * 24 * 2;

/**
 * @param {number} avgCostPerCycle  average per-cycle cost (tokens) from computeStats
 * @param {number} [cyclesPerWeek=DEFAULT_CYCLES_PER_WEEK]  assumed cycles per week
 * @returns {number}  projected weekly spend (>= 0); 0 for non-positive / non-finite input
 */
export function projectWeeklyCost(avgCostPerCycle, cyclesPerWeek = DEFAULT_CYCLES_PER_WEEK) {
  const per = Number(avgCostPerCycle);
  const rate = Number(cyclesPerWeek);
  if (!Number.isFinite(per) || per <= 0 || !Number.isFinite(rate) || rate <= 0) return 0;
  return per * rate;
}
