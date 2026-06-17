// forecaster.mjs — U-65: backlog cost forecaster.
//
// At the start of each cycle (after the Selector ranks tasks, before implementation begins) the
// supervisor estimates the total remaining token cost to clear the backlog. Inputs:
//   (a) Historical avg cost per [goal][risk] bucket from app.stats.costsByGoalAndRisk
//       (recorded by recordGoalRiskCost() after every completed cycle).
//   (b) The current backlog task list (state.queues.backlog).
//
// Advisory only — never modifies state, blocks a cycle, or affects selection/routing. The supervisor
// calls forecastBacklogCost() and logs the result; it does not gate on it.

import { learnedStats } from './cost-learning.mjs';

// Rolling cost samples retained per [goal][risk] bucket on app.stats.
const GOAL_RISK_WINDOW = 20;

// Floor estimate per task when no history exists at all (no [goal][risk] data and no [class:risk]
// fallback). Keeps a brand-new install's forecast non-zero and order-of-magnitude sensible.
const DEFAULT_TOKENS_PER_TASK = 50_000;

function isFiniteNum(v) {
  return Number.isFinite(Number(v));
}

function mean(arr) {
  return arr.length ? arr.reduce((a, b) => a + (Number(b) || 0), 0) / arr.length : 0;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Bucketing + recording
// ───────────────────────────────────────────────────────────────────────────────────────────────

// The stable bucket key for a task's goal + risk. Tolerant of undefined goal/risk so a malformed task
// never breaks the forecast — it simply lands in an "unknown" bucket.
export function bucketKey(goal, risk) {
  return `${goal ?? 'unknown'}.${risk ?? 'unknown'}`;
}

// Record one observed cycle cost into the [goal][risk] rolling window on app.stats (mutates `stats` in
// place). Bounded to the last GOAL_RISK_WINDOW samples per bucket. Ignored for non-finite / negative
// costs so a missing usage reading can never poison the average. Safe no-op when `stats` is absent.
export function recordGoalRiskCost(stats, goal, risk, cost) {
  if (!stats || typeof stats !== 'object') return null;
  const c = Number(cost);
  if (!Number.isFinite(c) || c < 0) return null;
  if (!stats.costsByGoalAndRisk || typeof stats.costsByGoalAndRisk !== 'object') {
    stats.costsByGoalAndRisk = {};
  }
  const key = bucketKey(goal, risk);
  const arr = stats.costsByGoalAndRisk[key] || (stats.costsByGoalAndRisk[key] = []);
  arr.push(c);
  if (arr.length > GOAL_RISK_WINDOW) arr.shift();
  return arr;
}

// Reduce the raw rolling sample arrays in app.stats.costsByGoalAndRisk into the per-bucket
// { avgCost, count } map that calculateBacklogForecast consumes. Missing / malformed input → {}.
export function statsToHistorical(appStats) {
  const buckets = appStats && typeof appStats === 'object' ? appStats.costsByGoalAndRisk : null;
  const out = {};
  if (buckets && typeof buckets === 'object') {
    for (const [key, samples] of Object.entries(buckets)) {
      if (!Array.isArray(samples)) continue;
      const nums = samples.map(Number).filter(Number.isFinite);
      if (nums.length) out[key] = { avgCost: mean(nums), count: nums.length };
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Pure core: estimate total remaining cost from a [goal][risk] history map
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Estimate the total remaining cost to clear `backlogTasks` from the per-[goal][risk] historical
 * averages in `historicalStats`. Never throws: an empty backlog, missing buckets, and absent stats all
 * degrade gracefully.
 *
 * Per-task estimate:
 *   - the task's own [goal][risk] bucket has an avgCost → use it
 *   - otherwise → the global mean avgCost across every known bucket (0 when there is no history at all),
 *     recorded as a fallback (so the caller can see how thin the data is).
 *
 * @param {Array<{goal?:string, risk?:(string|number)}>} backlogTasks  pending tasks
 * @param {Object<string, {avgCost:number, count?:number}>} historicalStats  keyed by `${goal}.${risk}`
 * @returns {{
 *   totalCost:number,
 *   breakdown:Object<string, {count:number, avgCost:number, total:number}>,
 *   missing:string[],
 *   fallbackUsed:boolean,
 *   taskCount:number
 * }}
 */
export function calculateBacklogForecast(backlogTasks, historicalStats) {
  const tasks = Array.isArray(backlogTasks) ? backlogTasks : [];
  const stats = historicalStats && typeof historicalStats === 'object' ? historicalStats : {};

  // Global fallback: the mean avgCost across every bucket that carries a usable number. Used for tasks
  // whose own [goal][risk] bucket has no history. 0 when there is no history at all.
  const knownAvgs = Object.values(stats)
    .filter((s) => s && isFiniteNum(s.avgCost))
    .map((s) => Number(s.avgCost));
  const globalAvg = knownAvgs.length ? mean(knownAvgs) : 0;

  const breakdown = {};
  const missing = [];
  let totalCost = 0;
  let fallbackUsed = false;

  for (const t of tasks) {
    const key = bucketKey(t?.goal, t?.risk);
    const entry = stats[key];
    const hasData = entry && isFiniteNum(entry.avgCost);
    const avgCost = hasData ? Number(entry.avgCost) : globalAvg;

    if (!hasData) {
      fallbackUsed = true;
      if (!missing.includes(key)) missing.push(key);
    }

    totalCost += avgCost;
    if (!breakdown[key]) breakdown[key] = { count: 0, avgCost, total: 0 };
    breakdown[key].count += 1;
    breakdown[key].total += avgCost;
  }

  return { totalCost, breakdown, missing, fallbackUsed, taskCount: tasks.length };
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// Supervisor-facing wrapper (reads live engine state)
// ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Forecast the total token cost to clear the live backlog. Primary signal is the learned per-[goal][risk]
 * average from app.stats (the task's source (a)); when a task's [goal][risk] bucket has no history yet we
 * fall back to the per-[class:risk] cost-learning average, then to a fixed floor — so the estimate is
 * useful from the first cycles and self-sharpens as [goal][risk] data accumulates.
 *
 * @param {object} state   flat in-memory state (reads state.stats.costsByGoalAndRisk, state.costHistory,
 *                         state.queues.backlog)
 * @param {object} config  engine config (forwarded to learnedStats for [class:risk] bucket resolution)
 * @returns {{
 *   totalTokens:number,
 *   backlogSize:number,
 *   taskForecasts:Array<{id:*, key:string, tokens:number, source:('goal-risk'|'class-risk'|'fallback')}>,
 *   fromHistory:number,
 *   source:('goal-risk'|'class-risk'|'default')
 * }}
 */
export function forecastBacklogCost(state, config) {
  const backlog = state?.queues?.backlog ?? [];
  const goalRiskHist = statsToHistorical(state?.stats);
  // velocityFactor > 1 means the engine is burning budget faster than planned; effective per-cycle
  // throughput (tasks completed per available budget unit) is inversely scaled.
  const velocityFactor = Math.max(0.1, Number(state?.usage?.velocityFactor) || 1.0);

  const goalRiskAvgs = Object.values(goalRiskHist).map((s) => s.avgCost);
  const goalRiskGlobal = goalRiskAvgs.length ? mean(goalRiskAvgs) : null;

  const taskForecasts = backlog.map((task) => {
    const key = bucketKey(task?.goal, task?.risk);
    const gr = goalRiskHist[key];
    if (gr) return { id: task?.id, key, tokens: gr.avgCost, source: 'goal-risk' };

    const learned = learnedStats(state, task, config);
    if (learned) return { id: task?.id, key, tokens: learned.avgTokens, source: 'class-risk' };

    return { id: task?.id, key, tokens: goalRiskGlobal ?? DEFAULT_TOKENS_PER_TASK, source: 'fallback' };
  });

  const totalTokens = taskForecasts.reduce((sum, t) => sum + t.tokens, 0);
  const backlogSize = backlog.length;
  const fromHistory = taskForecasts.filter((t) => t.source !== 'fallback').length;
  const source = goalRiskGlobal != null ? 'goal-risk' : (fromHistory > 0 ? 'class-risk' : 'default');

  // forecastCycles: backlogSize divided by per-cycle throughput. With velocityFactor=1.0 throughput=1
  // task/cycle; higher factor = higher burn rate = fewer cycles per budget unit, so more cycles needed.
  const perCycleThroughput = 1 / velocityFactor;
  const forecastCycles = backlogSize > 0 ? Math.ceil(backlogSize / perCycleThroughput) : 0;

  // forecastUsd: (avg tokens per task) × forecastCycles × dollars-per-token.
  const perCycleTokens = backlogSize > 0 ? totalTokens / backlogSize : 0;
  const dollarsPerToken = Number(config?.costs?.dollarsPerToken) || 0.000003;
  const forecastUsd = perCycleTokens * forecastCycles * dollarsPerToken;

  return { totalTokens, backlogSize, taskForecasts, fromHistory, source, forecastCycles, forecastUsd };
}
