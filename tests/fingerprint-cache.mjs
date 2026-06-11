// fingerprint-cache.mjs — assertions for the P2 prompt fingerprint cache (lib/fingerprint-cache.mjs).
// Verifies: stable order-independent fingerprints; a fingerprint CHANGES when the queue identity or
// phase changes; cache hit/miss + hit-rate stats; token/cost savings credited on a hit; LRU eviction;
// and that ONLY decisions (not implementation output) are the intended payload (we store/replay a
// selection verdict). Pure — operates on a plain state object.
//   node autopilot/tests/fingerprint-cache.mjs
import assert from 'node:assert/strict';
import {
  fingerprint, selectorFingerprint, getCachedDecision, putCachedDecision, cacheHitRate
} from '../lib/fingerprint-cache.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const mkState = (over = {}) => ({
  goalPhase: 'features',
  queues: {
    backlog: [{ id: 'B1', title: 'a' }, { id: 'B2', title: 'b' }],
    done: [{ id: 'D1', title: 'd' }],
    blocked: [],
  },
  ...over,
});

// ── fingerprint stability + sensitivity ──
check('fingerprint is order-independent over queue contents', () => {
  const s1 = mkState();
  const s2 = mkState({ queues: { backlog: [{ id: 'B2', title: 'b' }, { id: 'B1', title: 'a' }], done: [{ id: 'D1', title: 'd' }], blocked: [] } });
  assert.equal(selectorFingerprint(s1), selectorFingerprint(s2), 'reordered-but-equal backlog → same fp');
});

check('fingerprint changes when a task is added / retitled / phase changes', () => {
  const base = selectorFingerprint(mkState());
  const added = selectorFingerprint(mkState({ queues: { backlog: [{ id: 'B1', title: 'a' }, { id: 'B2', title: 'b' }, { id: 'B3', title: 'c' }], done: [{ id: 'D1', title: 'd' }], blocked: [] } }));
  const retitled = selectorFingerprint(mkState({ queues: { backlog: [{ id: 'B1', title: 'A!' }, { id: 'B2', title: 'b' }], done: [{ id: 'D1', title: 'd' }], blocked: [] } }));
  const phased = selectorFingerprint(mkState({ goalPhase: 'ui' }));
  assert.notEqual(base, added, 'adding a task changes the fp');
  assert.notEqual(base, retitled, 'retitling changes the fp');
  assert.notEqual(base, phased, 'phase change changes the fp');
});

check('fingerprint() is deterministic + key-order independent for plain objects', () => {
  assert.equal(fingerprint({ a: 1, b: 2 }), fingerprint({ b: 2, a: 1 }));
  assert.notEqual(fingerprint({ a: 1 }), fingerprint({ a: 2 }));
});

// ── cache hit / miss + stats ──
check('miss then put then hit; stats + hit-rate track correctly', () => {
  const state = mkState();
  const fp = selectorFingerprint(state);
  assert.equal(getCachedDecision(state, fp), null, 'first lookup misses');
  putCachedDecision(state, fp, { selected: { id: 'B1' } });
  const hit = getCachedDecision(state, fp, { tokens: 8000, costUsd: 0.02 });
  assert.deepEqual(hit, { selected: { id: 'B1' } }, 'hit returns the stored decision');
  assert.equal(state.fpCache.stats.hits, 1);
  assert.equal(state.fpCache.stats.misses, 1);
  assert.equal(state.fpCache.stats.tokensSaved, 8000, 'tokens credited on hit');
  assert.equal(Math.round(state.fpCache.stats.costSavedUsd * 100), 2, 'cost credited on hit');
  assert.equal(cacheHitRate(state), 0.5, '1 hit / (1 hit + 1 miss)');
});

// ── LRU eviction ──
check('LRU evicts the oldest beyond max; recently-hit entries survive', () => {
  const state = mkState();
  putCachedDecision(state, 'k1', { v: 1 }, { max: 2 });
  putCachedDecision(state, 'k2', { v: 2 }, { max: 2 });
  getCachedDecision(state, 'k1');                 // bump k1 to most-recent
  putCachedDecision(state, 'k3', { v: 3 }, { max: 2 }); // evicts k2 (the oldest), keeps k1
  assert.equal(state.fpCache.entries.k2, undefined, 'k2 evicted');
  assert.ok(state.fpCache.entries.k1, 'k1 survived (recently used)');
  assert.ok(state.fpCache.entries.k3, 'k3 present');
  assert.ok(state.fpCache.order.length <= 2, 'order bounded by max');
});

// ── eligibility: the candidate set drives the key (cooldown can't be bypassed) ──
check('selectorFingerprint keys on the supplied candidate set (eligibility-aware)', () => {
  const state = mkState();
  const full = state.queues.backlog;                 // [B1, B2]
  const pool = full.filter((t) => t.id !== 'B2');     // B2 "on cooldown" → excluded from selectable pool
  const fpFull = selectorFingerprint(state, full);
  const fpPool = selectorFingerprint(state, pool);
  assert.notEqual(fpFull, fpPool, 'dropping a cooled task from the pool changes the fingerprint → cache miss');
  // Default (no candidates) uses the full backlog — must equal the explicit-full form.
  assert.equal(selectorFingerprint(state), fpFull, 'omitting candidates falls back to the full backlog');
});

check('null/no-pick decisions are simply not cached by the caller contract (we never store falsy)', () => {
  // The supervisor only calls putCachedDecision when selection.selected is truthy. Sanity: storing a
  // value and reading it back round-trips; this test documents that the cache itself stores whatever
  // it's given (the guard lives at the call site).
  const state = mkState();
  putCachedDecision(state, 'kx', { selected: { id: 'Z' } });
  assert.deepEqual(getCachedDecision(state, 'kx'), { selected: { id: 'Z' } });
});

console.log(`\nfingerprint-cache: ${passed}/${passed} checks passed ✓`);
