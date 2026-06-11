// context-provider.mjs — assertions for the external codebase-context seam (U-37).
// Verifies: (1) no provider → graceful null (fallback to local analysis); (2) inline maps validate +
// load; (3) shape validation rejects incomplete bundles; (4) freshness validation rejects stale maps;
// (5) the memory cache reuses a fresh bundle; (6) provider errors fall back gracefully.
//   node autopilot/tests/context-provider.mjs
import assert from 'node:assert/strict';
import {
  loadContextMaps, validateContextMaps, summarizeContextMaps, clearContextCache, REQUIRED_MAP_KEYS
} from '../core/context-provider.mjs';

let passed = 0;
const acheck = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

const freshMaps = (over = {}) => ({
  fileIndex: { 'src/index.js': { lang: 'js', size: 100 } },
  symbolIndex: { main: { file: 'src/index.js', line: 1, kind: 'function' } },
  dependencyGraph: { 'src/index.js': [] },
  generatedAt: Date.now(),
  source: 'unit-test',
  ...over
});

// 1) No provider configured → ok:false (the graceful-fallback signal). Backward compatible.
await acheck('no provider resolves to ok:false (fallback to local analysis)', async () => {
  clearContextCache();
  const r = await loadContextMaps({});
  assert.equal(r.ok, false);
  assert.equal(r.maps, null);
});

// 2) Inline pre-computed maps validate + load.
await acheck('inline contextMaps load and validate', async () => {
  clearContextCache();
  const r = await loadContextMaps({ contextMaps: freshMaps() });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'unit-test');
  assert.ok(REQUIRED_MAP_KEYS.every((k) => r.maps[k]));
});

// 3) Shape validation rejects an incomplete bundle (missing dependencyGraph).
await acheck('incomplete bundle is rejected by shape validation', async () => {
  clearContextCache();
  const bad = freshMaps();
  delete bad.dependencyGraph;
  const v = validateContextMaps(bad);
  assert.equal(v.valid, false);
  const r = await loadContextMaps({ contextMaps: bad });
  assert.equal(r.ok, false); // → caller falls back to local analysis
});

// 4) Freshness validation rejects stale maps; without enforcement they still load.
await acheck('stale maps are rejected only when validateFreshness is on', async () => {
  clearContextCache();
  const stale = freshMaps({ generatedAt: Date.now() - 600000, source: 'stale-src' }); // 10 min old
  const enforced = await loadContextMaps({ contextMaps: stale, validateFreshness: true, maxStaleMs: 300000 });
  assert.equal(enforced.ok, false);
  assert.equal(enforced.fresh, false);
  const lenient = await loadContextMaps({ contextMaps: stale, validateFreshness: false });
  assert.equal(lenient.ok, true);
});

// 5) Memory cache reuses a fresh bundle (second load without re-invoking the provider fn).
await acheck('memory cache reuses a fresh bundle', async () => {
  clearContextCache();
  let calls = 0;
  const provider = { source: 'cached-src', getContextMaps: () => { calls++; return freshMaps({ source: 'cached-src' }); } };
  const first = await loadContextMaps({ provider, cacheStrategy: 'memory' });
  const second = await loadContextMaps({ provider, cacheStrategy: 'memory' });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.fromCache, true);
  assert.equal(calls, 1, 'provider should be invoked only once thanks to the cache');
});

// 6) A throwing provider falls back gracefully (ok:false, never an exception).
await acheck('provider error falls back gracefully', async () => {
  clearContextCache();
  const provider = { source: 'broken', getContextMaps: () => { throw new Error('boom'); } };
  const r = await loadContextMaps({ provider });
  assert.equal(r.ok, false);
  assert.match(r.reason, /provider error/);
});

// 7) summarizeContextMaps produces compact counts + samples for the prompt.
await acheck('summarizeContextMaps reports counts', async () => {
  const s = summarizeContextMaps(freshMaps());
  assert.equal(s.fileCount, 1);
  assert.equal(s.symbolCount, 1);
  assert.equal(s.dependencyNodes, 1);
});

console.log(`\ncontext-provider: ${passed} assertion group(s) passed.`);
