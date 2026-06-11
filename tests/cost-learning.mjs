// cost-learning.mjs — assertions for the P3 cost-learning layer (lib/cost-learning.mjs).
// Verifies: the class:risk bucket key; rolling-window recording with eviction at the window cap;
// improvedEstimate returns null below minSamples (fallback to the governor's global average) and the
// bucket mean at/above it; separate buckets stay independent; and that it only refines an estimate
// (the governor's hard guards are not touched here — that's asserted in budget-routing/quota-discovery).
//   node autopilot/tests/cost-learning.mjs
import assert from 'node:assert/strict';
import { costKey, recordCycleCost, learnedStats, improvedEstimate } from '../lib/cost-learning.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const engineTask = { goal: 'architecture', title: 'architecture: abstract paths', risk: 3 };
const productTask = { goal: 'product', title: 'product: screen', risk: 1 };

// ── bucket key ──
check('costKey is class:riskLevel', () => {
  assert.equal(costKey(engineTask, {}), 'engine:r3');
  assert.equal(costKey(productTask, {}), 'product:r1');
  assert.equal(costKey({ goal: 'product', title: 'x' }, {}), 'product:r?', 'missing risk → r?');
});

// ── recording + minSamples gate ──
check('improvedEstimate returns null below minSamples (fallback), bucket mean at/above', () => {
  const state = {};
  recordCycleCost(state, engineTask, { tokens: 100_000, retries: 0 }, {});
  recordCycleCost(state, engineTask, { tokens: 200_000, retries: 1 }, {});
  assert.equal(improvedEstimate(state, engineTask, {}), null, '2 samples < minSamples(3) → null (use global avg)');
  recordCycleCost(state, engineTask, { tokens: 300_000, retries: 2 }, {});
  const est = improvedEstimate(state, engineTask, {});
  assert.equal(est, 200_000, 'mean of 100k/200k/300k');
  const stats = learnedStats(state, engineTask, {});
  assert.equal(stats.count, 3);
  assert.equal(stats.avgRetries, 1, 'mean retries (0+1+2)/3');
  assert.equal(stats.key, 'engine:r3');
});

// ── buckets are independent ──
check('different class:risk buckets do not cross-contaminate', () => {
  const state = {};
  for (let i = 0; i < 3; i++) recordCycleCost(state, engineTask, { tokens: 500_000 }, {});
  assert.equal(improvedEstimate(state, engineTask, {}), 500_000);
  assert.equal(improvedEstimate(state, productTask, {}), null, 'product bucket still has no samples');
});

// ── rolling window eviction ──
check('rolling window keeps only the last 20 samples (adaptive)', () => {
  const state = {};
  for (let i = 1; i <= 25; i++) recordCycleCost(state, engineTask, { tokens: i * 10_000 }, {});
  const stats = learnedStats(state, engineTask, {});
  assert.equal(stats.count, 20, 'capped at 20 samples');
  // Only samples 6..25 (×10k) remain → mean = (6+25)/2 ×10k = 155k.
  assert.equal(stats.avgTokens, 155_000, 'window dropped the oldest 5');
});

check('config map override flows through classifyTask into the key', () => {
  const cfg = { taskClasses: { map: { reliability: 'engine' } } };
  assert.equal(costKey({ goal: 'reliability', title: 'x', risk: 2 }, cfg), 'engine:r2');
});

console.log(`\ncost-learning: ${passed}/${passed} checks passed ✓`);
