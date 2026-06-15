// costForecaster.mjs — U-65 public entry point for the backlog cost forecaster.
//
// Thin re-export of the canonical implementation in forecaster.mjs, kept as a stable named module so
// callers (and the cycle test suite) can import the forecaster by its feature name without depending on
// the internal file layout. The historical avg cost per [goal][risk] comes from app.stats; see
// forecaster.mjs for the estimation + fallback logic.
export {
  calculateBacklogForecast,
  statsToHistorical,
  recordGoalRiskCost,
  bucketKey,
  forecastBacklogCost,
} from './forecaster.mjs';
// U-65: re-export the named-role entry point so callers can import loadHistoricalStats from
// the public costForecaster module without knowing the internal file layout.
export { loadHistoricalStats } from './statsLoader.mjs';

// U-65: public, dependency-free entry point used by the planning pipeline (processCycle / planBuilder).
// Estimates the total remaining cost to clear `backlog` from a flat per-[goal][risk] historical-average
// map (`stats`, keyed "<goal>-<risk>"). Per-task price = the task's [goal][risk] historical average,
// falling back to the task's own `costEstimate`, then the global average across known buckets. Never
// throws: an empty backlog, missing buckets, and absent stats all degrade to a finite, non-negative
// total. Returns the total plus a per-task breakdown (the source signals how thin the data was).
export function computeForecast(stats, backlog) {
  const tasks = Array.isArray(backlog) ? backlog : [];
  const hist = stats && typeof stats === 'object' ? stats : {};

  const knownAvgs = Object.values(hist).map(Number).filter(Number.isFinite);
  const globalAvg = knownAvgs.length ? knownAvgs.reduce((a, b) => a + b, 0) / knownAvgs.length : 0;

  const breakdown = [];
  let totalCost = 0;

  for (const t of tasks) {
    const key = `${t?.goal ?? 'unknown'}-${t?.risk ?? 'unknown'}`;
    const histAvg = Number(hist[key]);
    const estimate = Number(t?.costEstimate);

    let cost;
    let source;
    if (Number.isFinite(histAvg)) {
      cost = histAvg;
      source = 'historical';
    } else if (Number.isFinite(estimate)) {
      cost = estimate;
      source = 'estimate';
    } else {
      cost = globalAvg;
      source = 'fallback';
    }

    totalCost += cost;
    breakdown.push({ taskId: t?.id ?? null, key, cost, source });
  }

  return { totalCost, breakdown, taskCount: tasks.length, methodology: 'historical-average' };
}
