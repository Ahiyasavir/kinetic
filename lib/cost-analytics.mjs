// cost-analytics.mjs — U-66-cont: the in-process per-task cost recorder behind GET /api/stats/cost.
//
// Holds a singleton `app.stats` store keyed by [goal][risk], each bucket a bounded rolling window of the
// last ROLLING_WINDOW task costs ({ inputTokens, outputTokens, cacheReadTokens }). recordTaskCost() is
// called at the end of each task; getAllStats() / calculateRollingAverages() feed the dashboard endpoint.
//
// This is the unit-test-facing surface. The supervisor also persists the SAME [goal][risk] shape into
// state.stats.costHistory (cost-tracker.trackTaskCost) so the control server — a separate process — can
// read it back via control-api.getCostAnalytics. Both paths share cost-tracker/cost-stats, so the
// rolling-window cap and the average math stay identical.
import { trackTaskCost } from './cost-tracker.mjs';
import { computeStats } from './cost-stats.mjs';

// The singleton store: appStats[goal][risk] = [{ inputTokens, outputTokens, cacheReadTokens }, …].
const appStats = {};

// Cost tracking is opt-out: only an explicit `config.costTracking.enabled === false` disables recording.
function trackingDisabled(config) {
  return !!(config && config.costTracking && config.costTracking.enabled === false);
}

/**
 * Record one completed task's real token cost into app.stats[goal][risk] (rolling window of ROLLING_WINDOW).
 * Error-tolerant: never throws and never returns an error, so a recording failure can't break the cycle.
 *
 * @param {string} taskId  the task identifier (for the caller's context; not stored on the entry)
 * @param {string} goal    task goal category
 * @param {string|number} risk  task risk category
 * @param {{inputTokens?:number, outputTokens?:number, cacheReadTokens?:number}} costMetrics
 * @param {object} [config]  engine config; `{ costTracking: { enabled: false } }` makes this a no-op
 */
export function recordTaskCost(taskId, goal, risk, costMetrics = {}, config) {
  try {
    if (trackingDisabled(config)) return;
    trackTaskCost(appStats, goal, risk, costMetrics);
  } catch { /* error-tolerant: a cost-recording failure must not interrupt the cycle */ }
}

/** The raw [goal][risk] rolling-window store (live reference) for endpoint/byGoal/byRisk construction. */
export function getAllStats() {
  return appStats;
}

/**
 * Rolling averages per [goal][risk] over the retained window:
 *   { [goal]: { [risk]: { avgInputTokens, avgOutputTokens, avgCacheRead, cycleCount } } }
 * Empty object when nothing has been recorded.
 */
export function calculateRollingAverages() {
  const full = computeStats(appStats);
  const out = {};
  for (const goal of Object.keys(appStats)) {
    if (full[goal]) out[goal] = full[goal];
  }
  return out;
}

/** Clear the singleton store (test isolation / a fresh accounting window). */
export function resetStats() {
  for (const k of Object.keys(appStats)) delete appStats[k];
}
