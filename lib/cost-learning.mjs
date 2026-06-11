// cost-learning.mjs — learn the REAL per-cycle token cost by (task class, risk level) so the budget
// governor's per-cycle estimate gets sharper over time. This is an ADVISORY refinement only: it can
// improve the governor's `avg`/estimate input, but it NEVER overrides the governor's hard rules
// (reserve, hardStop, downgrade thresholds). The conservative padding (safetyMargin × retryBuffer) the
// governor applies still wraps whatever estimate we feed it.
//
// Storage lives in state.costHistory: { [key]: { samples:[tokens...], retries:[n...], count } } where
// key = `${class}:${riskLevel}`. A bounded rolling window (last N=20 samples per key) keeps it adaptive
// and small. Only used once a key has ≥ minSamples (default 3) observations — below that we return null
// and the caller falls back to the governor's existing global average (backward compatible).
import { classifyTask } from './task-class.mjs';

const WINDOW = 20;       // rolling samples retained per key
const MIN_SAMPLES = 3;   // below this, not enough signal — fall back to the global estimate

// Bucket the engineering risk (1–5, may be undefined) into a stable key segment.
function riskLevel(task) {
  const r = Number(task?.risk);
  if (!Number.isFinite(r)) return 'r?';
  return `r${Math.max(0, Math.min(5, Math.round(r)))}`;
}

// The learning key for a task: "class:riskLevel" (e.g. "engine:r3", "product:r1").
export function costKey(task, config) {
  return `${classifyTask(task || {}, config || {})}:${riskLevel(task)}`;
}

function ensureHistory(state) {
  if (!state.costHistory || typeof state.costHistory !== 'object') state.costHistory = {};
  return state.costHistory;
}

// Record an observed cycle cost for a task's class/risk bucket. tokens = input+output for the cycle;
// retries = how many revise attempts it took (0-based). Keeps a rolling window of the last WINDOW.
export function recordCycleCost(state, task, { tokens = 0, retries = 0 } = {}, config) {
  const hist = ensureHistory(state);
  const key = costKey(task, config);
  const e = hist[key] || (hist[key] = { samples: [], retries: [], count: 0 });
  e.samples.push(Math.max(0, Math.round(Number(tokens) || 0)));
  e.retries.push(Math.max(0, Math.round(Number(retries) || 0)));
  if (e.samples.length > WINDOW) e.samples.shift();
  if (e.retries.length > WINDOW) e.retries.shift();
  e.count = e.samples.length;
  return e;
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

// Class/risk-aware stats for a task, or null if we don't yet have enough samples for its bucket.
// @returns {{key, avgTokens, avgRetries, count} | null}
export function learnedStats(state, task, config, { minSamples = MIN_SAMPLES } = {}) {
  const hist = state?.costHistory;
  if (!hist) return null;
  const key = costKey(task, config);
  const e = hist[key];
  if (!e || e.count < minSamples) return null;
  return { key, avgTokens: mean(e.samples), avgRetries: mean(e.retries), count: e.count };
}

// An IMPROVED per-cycle token estimate for this task's bucket, or null to signal "no learned signal —
// use the governor's global average". The governor still applies its own conservative padding on top of
// whatever number it ultimately uses, so this only sharpens the central estimate, never relaxes a guard.
export function improvedEstimate(state, task, config, opts = {}) {
  const stats = learnedStats(state, task, config, opts);
  return stats ? stats.avgTokens : null;
}
