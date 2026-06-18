// cost-tracker.mjs — U-66-cont: per-task actual-cost recorder, keyed by [goal][risk].
//
// trackTaskCost() appends one completed task's REAL token cost (inputTokens + outputTokens +
// cacheReadTokens) into a bounded rolling array on the passed-in stats object:
//
//   appStats[goal][risk] = [{ inputTokens, outputTokens, cacheReadTokens }, …]   (last ROLLING_WINDOW)
//
// It mutates the object in place and is a pure data operation — no I/O, no config, no global state. The
// caller decides WHEN to record (the supervisor gates this behind config.costTracking.enabled). The
// rolling cap keeps each category's average responsive to recent cycles and bounds state growth.
//
// cost-stats.computeStats() reduces this structure into the GET /api/stats/cost payload. The supervisor
// records into state.stats.costHistory (the same [goal][risk] shape); control-api reads that back.

// Last N task costs retained per [goal][risk] bucket (drives the rolling average).
export const ROLLING_WINDOW = 10;

// Coerce a token count to a finite, non-negative number (a missing/garbage reading must never poison the
// rolling average).
function toTokens(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// Stable category key — tolerant of undefined/null/empty so a malformed task lands in an "unknown" bucket
// instead of breaking the recording.
function categoryKey(v) {
  return v === undefined || v === null || v === '' ? 'unknown' : String(v);
}

/**
 * Record one task's cost into the rolling [goal][risk] history on `appStats` (mutates in place).
 * Safe no-op (returns null) when `appStats` is not a usable object.
 *
 * @param {object} appStats  the stats object to mutate (e.g. state.stats or state.stats.costHistory)
 * @param {string|undefined} goal  task goal category
 * @param {string|number|undefined} risk  task risk category
 * @param {{inputTokens?:number, outputTokens?:number, cacheReadTokens?:number}} tokens
 * @returns {object|null}  the appended entry, or null when skipped
 */
export function trackTaskCost(appStats, goal, risk, tokens = {}) {
  if (!appStats || typeof appStats !== 'object') return null;

  const g = categoryKey(goal);
  const r = categoryKey(risk);

  if (!appStats[g] || typeof appStats[g] !== 'object' || Array.isArray(appStats[g])) appStats[g] = {};
  if (!Array.isArray(appStats[g][r])) appStats[g][r] = [];

  const entry = {
    inputTokens: toTokens(tokens && tokens.inputTokens),
    outputTokens: toTokens(tokens && tokens.outputTokens),
    cacheReadTokens: toTokens(tokens && tokens.cacheReadTokens),
  };

  const bucket = appStats[g][r];
  bucket.push(entry);
  while (bucket.length > ROLLING_WINDOW) bucket.shift();
  return entry;
}

/**
 * Record one completed task's real token cost into `app.stats[goal][risk]` (the rolling window of the
 * last ROLLING_WINDOW entries). This is the end-of-task recording API: the supervisor calls it after a
 * cycle completes with the task's goal/risk and the cycle's measured token usage.
 *
 * Positional token args (not a bag) so a caller can pass the three counts directly off the usage meter.
 * Safe no-op (returns null) when `app` is not a usable object, so a missing/garbage app store can never
 * interrupt the cycle.
 *
 * @param {string} taskId  task identifier (for the caller's context; not stored on the entry)
 * @param {string|undefined} goal  task goal category
 * @param {string|number|undefined} risk  task risk category
 * @param {number} inputTokens
 * @param {number} outputTokens
 * @param {number} cacheReadTokens
 * @param {{stats?:object}} app  the app store; `app.stats[goal][risk]` is created/appended in place
 * @returns {object|null}  the appended entry, or null when skipped
 */
export function recordTaskCost(taskId, goal, risk, inputTokens, outputTokens, cacheReadTokens, app) {
  if (!app || typeof app !== 'object') return null;
  if (!app.stats || typeof app.stats !== 'object' || Array.isArray(app.stats)) app.stats = {};
  return trackTaskCost(app.stats, goal, risk, { inputTokens, outputTokens, cacheReadTokens });
}
