// cycleHistoryLogger.mjs — append planning-gate metrics to cycle history for trend analysis.
// Called once per cycle after the planning gate executes. The logged entries enable post-hoc
// measurement of whether the gate reduces revision loops and scope-drift rollbacks over time.

/**
 * Log planning-gate metrics for a cycle.
 * @param {{ totalCost: number, breakdown: object }} forecast
 * @param {{ plan: string, validationScore: number }} microplan
 * @param {number} score - validation score
 * @param {string} cycleId - e.g. 'cycle-243'
 * @returns {{ logged: boolean, entry: object }}
 */
export function logPlanningMetrics(forecast, microplan, score, cycleId) {
  const entry = {
    cycleId,
    validationScore: score,
    totalCost: (forecast && forecast.totalCost) != null ? forecast.totalCost : null,
    forecast: forecast || null,
    planSummary: (microplan && microplan.plan)
      ? String(microplan.plan).slice(0, 200)
      : null,
    gateAllows: score >= 0.8,
    timestamp: new Date().toISOString(),
  };

  return { logged: true, entry };
}
