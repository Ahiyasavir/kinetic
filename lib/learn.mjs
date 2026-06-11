// learn.mjs — adaptive-cadence (velocity factor) + failure-learning (lessons) primitives.
// Pure, side-effect-light helpers so the supervisor AND the unit tests can exercise the same logic.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, Number(n))); }

// ---------- adaptive cadence ----------
// Velocity factor = (fraction of the cycle budget already used) / (fraction of the weekly window
// elapsed), scaled by a tuning sensitivity, clamped to [0.1, 2.0]. >1 ⇒ we're consuming the shared
// account faster than the wall clock and should throttle; ≤1 ⇒ we have headroom, run at full rate.
export function computeVelocityFactor({
  cycles = 0, windowStartedMs, now = Date.now(),
  resetIntervalDays = 7, maxCyclesPerDay = 24, velocitySensitivity = 1.0
} = {}) {
  const windowMs = (resetIntervalDays || 7) * 86400000;
  const elapsed = Math.max(0, now - (windowStartedMs ?? now));
  // floor the elapsed fraction so a just-rolled window (≈0 elapsed) can't divide-by-zero.
  const fractionWeekElapsed = Math.max(elapsed / windowMs, 1e-6);
  const budgetCycles = Math.max(1, (Number(maxCyclesPerDay) || 24) * (resetIntervalDays || 7));
  const fractionBudgetUsed = (Number(cycles) || 0) / budgetCycles;
  const sensitivity = Number(velocitySensitivity) || 1.0;
  let vf = (fractionBudgetUsed / fractionWeekElapsed) * sensitivity;
  if (!Number.isFinite(vf)) vf = 1.0;
  return clamp(vf, 0.1, 2.0);
}

// Throttled cadence: when over budget (vf>1) divide the configured rate by the factor, but never
// below `floor` cycles/day; otherwise use the full configured rate.
export function effectivePerDay(basePerDay, velocityFactor, floor = 4) {
  const base = Math.max(1, Number(basePerDay) || 24);
  if (!(velocityFactor > 1.0)) return base;
  return Math.max(floor, Math.floor(base / velocityFactor));
}

// ---------- failure-learning keywords ----------
const LESSON_STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'from', 'this', 'your', 'via', 'add', 'new', 'show', 'are',
  'all', 'can', 'not', 'into', 'when', 'each', 'they', 'them', 'will', 'have', 'has', 'was', 'were',
  'also', 'only', 'more', 'than', 'then', 'what', 'which', 'while', 'where', 'their', 'there', 'these',
  'those', 'should', 'would', 'could', 'about', 'after', 'before', 'over', 'under', 'task', 'make',
  'using', 'use', 'used', 'onto', 'some', 'such', 'very', 'just', 'both', 'same', 'does', 'done',
  'need', 'must', 'must', 'every', 'without', 'within', 'existing'
]);

// Split on whitespace/punctuation, lowercase, drop stop-words + short (<4) tokens, dedupe, cap at max.
export function extractKeywords(text, max = 20) {
  const seen = new Set();
  const out = [];
  for (const w of String(text || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 4 || LESSON_STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

// Jaccard set similarity over two keyword arrays (0..1).
export function jaccard(a, b) {
  const A = new Set(a || []), B = new Set(b || []);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// Highest-similarity lesson at/above the threshold, or null.
export function bestLessonMatch(candKeywords, lessons, threshold = 0.6) {
  let best = null;
  for (const l of lessons || []) {
    const sim = jaccard(candKeywords, l.keywords || []);
    if (sim >= threshold && (!best || sim > best.sim)) best = { sim, lesson: l };
  }
  return best;
}

// ---------- lessons.json persistence (graceful degradation) ----------
// Missing/corrupt file ⇒ warn, reset to [], keep running (never throw into the loop).
export function loadLessons(lessonsPath, logger = () => {}) {
  if (!existsSync(lessonsPath)) return [];
  try {
    const arr = JSON.parse(readFileSync(lessonsPath, 'utf8'));
    if (!Array.isArray(arr)) throw new Error('lessons.json is not an array');
    return arr;
  } catch (e) {
    logger(`⚠️ lessons.json unreadable (${e.message}) — resetting to [] and continuing.`);
    try { writeFileSync(lessonsPath, '[]', 'utf8'); } catch { /* best effort */ }
    return [];
  }
}

export function saveLessons(lessonsPath, arr) {
  writeFileSync(lessonsPath, JSON.stringify(Array.isArray(arr) ? arr : [], null, 2), 'utf8');
}
