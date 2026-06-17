// cost-stats.mjs — U-66-cont: reduce the rolling [goal][risk] cost history into the GET /api/stats/cost
// payload.
//
// computeStats(appStats) consumes the structure cost-tracker.trackTaskCost() (or costTracker's
// state.stats.costHistory) builds — appStats[goal][risk] = [{ inputTokens, outputTokens, cacheReadTokens }] —
// and returns, in ONE object:
//   • per-[goal][risk] rolling averages at the top level:  out[goal][risk] = { avgInputTokens,
//     avgOutputTokens, avgCacheRead, cycleCount }
//   • byGoal / byRisk token-sum aggregates collapsed across the other dimension
//   • totalCycles, avgCostPerCycle (weighted over every recorded task), and variance of per-task cost
//
// Pure + total: malformed / empty input degrades to a valid all-zero object (never throws). Cost per task
// is inputTokens + outputTokens + cacheReadTokens (cache-inclusive, matching the budget governor).

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

// Population variance (mean of squared deviations): 0 for <2 samples or identical values, >0 otherwise.
function variance(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return mean(arr.map((x) => (x - m) ** 2));
}

function entryCost(e) {
  return num(e && e.inputTokens) + num(e && e.outputTokens) + num(e && e.cacheReadTokens);
}

function addAggregate(map, key, entries) {
  let agg = map[key];
  if (!agg) agg = map[key] = { totalInputTokens: 0, totalOutputTokens: 0, totalCacheRead: 0, cycleCount: 0 };
  for (const e of entries) {
    agg.totalInputTokens += num(e && e.inputTokens);
    agg.totalOutputTokens += num(e && e.outputTokens);
    agg.totalCacheRead += num(e && e.cacheReadTokens);
    agg.cycleCount += 1;
  }
}

/**
 * Reduce the rolling [goal][risk] cost history into the dashboard payload.
 *
 * @param {object} appStats  appStats[goal][risk] = [{ inputTokens, outputTokens, cacheReadTokens }]
 * @returns {object}  per-goal/risk averages at the top level + { byGoal, byRisk, totalCycles,
 *                    avgCostPerCycle, variance }
 */
export function computeStats(appStats) {
  const out = { byGoal: {}, byRisk: {}, totalCycles: 0, avgCostPerCycle: 0, variance: 0 };
  if (!appStats || typeof appStats !== 'object') return out;

  let totalCost = 0;
  const allCosts = [];

  for (const [goal, riskMap] of Object.entries(appStats)) {
    if (!riskMap || typeof riskMap !== 'object' || Array.isArray(riskMap)) continue;
    const goalOut = {};
    for (const [risk, entries] of Object.entries(riskMap)) {
      if (!Array.isArray(entries)) continue;
      goalOut[risk] = {
        avgInputTokens: mean(entries.map((e) => num(e && e.inputTokens))),
        avgOutputTokens: mean(entries.map((e) => num(e && e.outputTokens))),
        avgCacheRead: mean(entries.map((e) => num(e && e.cacheReadTokens))),
        cycleCount: entries.length,
      };
      out.totalCycles += entries.length;
      for (const e of entries) {
        const c = entryCost(e);
        totalCost += c;
        allCosts.push(c);
      }
      addAggregate(out.byGoal, goal, entries);
      addAggregate(out.byRisk, risk, entries);
    }
    out[goal] = goalOut;
  }

  out.avgCostPerCycle = out.totalCycles > 0 ? totalCost / out.totalCycles : 0;
  out.variance = variance(allCosts);
  return out;
}
