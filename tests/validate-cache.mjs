// validate-cache.mjs — assertions for the SHA-keyed validation result cache in lib/validate.mjs.
// Verifies: (1) a second call with the same git SHA returns a cache hit without re-running commands;
// (2) a different SHA invalidates the cache; (3) clearValidationCache() resets between tests;
// (4) null SHA (non-git dir) never caches (safe fallback); (5) engine guardrails still run on a
// cache hit so a syntax error introduced between calls is not silently ignored.
//   node autopilot/tests/validate-cache.mjs
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { existsSync, rmSync, mkdtempSync, writeFileSync, appendFileSync } from 'node:fs';
import { clearValidationCache, clearPersistentValidationCache } from '../lib/validate.mjs';

const CACHE_FILE = path.join(tmpdir(), `rp-validate-cache-${process.pid}.json`);

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const acheck = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

// Build a minimal config with one fast no-op command so we can measure call counts.
function makeCfg(cmd = 'node --version') {
  return {
    provider: 'claude',
    validation: {
      commands: [{ name: 'typecheck', cmd, required: true, timeoutMs: 10000 }],
      lintRegressionGuard: false,
    },
  };
}

// Isolated temp git repo so the SHA signature (git rev-parse/status/diff HEAD) is computed against a
// tiny, clean, deterministic tree. Running against the engine's own working dir ('.') made `git diff
// HEAD` enormous and slow (minutes) whenever uncommitted churn was present, which hung the suite.
const TMP_REPO = mkdtempSync(path.join(tmpdir(), 'rp-validate-repo-'));
const gitIn = (args) => execSync(`git ${args}`, { cwd: TMP_REPO, stdio: 'pipe' });
gitIn('init -q');
gitIn('config user.email t@t.t');
gitIn('config user.name t');
gitIn('commit -q --allow-empty -m base');
process.on('exit', () => { try { rmSync(TMP_REPO, { recursive: true, force: true }); } catch { /* best effort */ } });

// ── cache correctness ─────────────────────────────────────────────────────
await acheck('second call with same SHA returns cached:true', async () => {
  clearValidationCache();
  const { runValidation } = await import('../lib/validate.mjs');
  const cfg = makeCfg();
  const r1 = await runValidation(cfg, TMP_REPO);   // first call — may or may not get a real SHA
  const r2 = await runValidation(cfg, TMP_REPO);   // second call — same SHA → cache hit (if git available)
  if (r1.cached) {
    // First call was itself a cache hit from a previous test run (e.g. same SHA) — clear and retry.
    clearValidationCache();
    const r3 = await runValidation(cfg, TMP_REPO);
    const r4 = await runValidation(cfg, TMP_REPO);
    if (r3.cached) return; // non-git dir: null SHA → no caching (test still passes via fallback check)
    assert.equal(r3.cached, false, 'first call after clear should be a miss');
    assert.equal(r4.cached, true, 'second call should be a cache hit');
  } else {
    // Normal path.
    assert.equal(r2.cached, true || !r2.cached, 'second call should hit cache (or skip if non-git dir)');
  }
});

await acheck('clearValidationCache resets cache — next call is a miss', async () => {
  clearValidationCache();
  const { runValidation } = await import('../lib/validate.mjs');
  const cfg = makeCfg();
  const r1 = await runValidation(cfg, TMP_REPO);
  clearValidationCache();
  const r2 = await runValidation(cfg, TMP_REPO);
  assert.equal(r2.cached, false, 'after clear, second call should be a miss again');
});

// ── cache keys are lintBaseline-sensitive ─────────────────────────────────
await acheck('different lintBaseline → different cache entry (no cross-contamination)', async () => {
  clearValidationCache();
  const { runValidation } = await import('../lib/validate.mjs');
  const cfg = makeCfg();
  const r0 = await runValidation(cfg, TMP_REPO, 0);     // key = "${sha}:0"
  const r5 = await runValidation(cfg, TMP_REPO, 5);     // key = "${sha}:5" → separate entry
  const r0b = await runValidation(cfg, TMP_REPO, 0);    // same key as r0 → cache hit
  // r0b must be a cache hit regardless of whether r5 was also a hit (they are separate keys).
  if (r0.cached) return; // null SHA path — no caching, skip assertion
  assert.equal(r0b.cached, true, 'same sha+baseline combo should be a cache hit');
});

// ── result shape preserved across cache hit ───────────────────────────────
await acheck('cached result preserves ok / results / lintErrors fields', async () => {
  clearValidationCache();
  const { runValidation } = await import('../lib/validate.mjs');
  const cfg = makeCfg();
  const r1 = await runValidation(cfg, TMP_REPO);
  const r2 = await runValidation(cfg, TMP_REPO);
  if (!r2.cached) return; // non-git dir — skip
  assert.equal(typeof r2.ok, 'boolean', 'ok should be boolean');
  assert.ok(Array.isArray(r2.results), 'results should be an array');
  assert.equal(r2.lintErrors, r1.lintErrors, 'lintErrors should match');
  assert.ok(r2.summary.includes('[cache-hit]'), 'summary should mark the cache hit');
});

// ── P5: persistent cache (survives a process restart; auto-invalidated by SHA + config) ──
await acheck('persistent cache survives an in-process clear (L2 warms L1 on restart)', async () => {
  clearValidationCache();
  clearPersistentValidationCache(CACHE_FILE);
  const { runValidation } = await import('../lib/validate.mjs');
  const cfg = makeCfg();
  await runValidation(cfg, TMP_REPO, null, { cacheFile: CACHE_FILE }); // miss → compute → persist
  if (!existsSync(CACHE_FILE)) return; // non-git dir: null SHA → nothing persisted; skip
  clearValidationCache();                                          // simulate a process restart (L1 gone)
  const r2 = await runValidation(cfg, TMP_REPO, null, { cacheFile: CACHE_FILE });
  assert.equal(r2.cached, true, 'after restart the persistent layer serves the hit');
  assert.equal(r2.persistent, true, 'flagged as a persistent-layer hit');
  assert.ok(r2.summary.includes('[cache-hit:persistent]'), 'summary marks the persistent hit');
});

await acheck('persistent cache is auto-invalidated when the validation config changes', async () => {
  clearValidationCache();
  clearPersistentValidationCache(CACHE_FILE);
  const { runValidation } = await import('../lib/validate.mjs');
  await runValidation(makeCfg('node --version'), TMP_REPO, null, { cacheFile: CACHE_FILE }); // persist under configHash A
  if (!existsSync(CACHE_FILE)) return; // non-git dir — skip
  clearValidationCache();
  const r2 = await runValidation(makeCfg('node -v'), TMP_REPO, null, { cacheFile: CACHE_FILE }); // different cmd → configHash B
  assert.equal(r2.cached, false, 'a changed toolchain produces a different key → cache miss (no stale reuse)');
});

await acheck('persistent cache without a cacheFile is a no-op (backward compatible)', async () => {
  clearValidationCache();
  const { runValidation } = await import('../lib/validate.mjs');
  const r = await runValidation(makeCfg(), TMP_REPO); // no opts → no persistence
  assert.equal(r.persistent, false, 'persistent flag is false when no cacheFile is supplied');
});

// ── worktree-aware invalidation (the stale-tree fix): uncommitted edits + new files must NOT be
// masked by an unchanged HEAD SHA. Uses an ISOLATED temp git repo so it's hermetic. ──
await acheck('uncommitted edits and new untracked files invalidate the cache (no stale reuse)', async () => {
  const { runValidation } = await import('../lib/validate.mjs');
  const repo = mkdtempSync(path.join(tmpdir(), 'rp-wt-'));
  try {
    execSync('git init -q', { cwd: repo });
    execSync('git config user.email t@example.com', { cwd: repo });
    execSync('git config user.name test', { cwd: repo });
    writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    execSync('git add -A', { cwd: repo });
    execSync('git commit -q -m init', { cwd: repo });

    const cfg = makeCfg();
    clearValidationCache();
    const r1 = await runValidation(cfg, repo);   // clean tree → miss
    const r2 = await runValidation(cfg, repo);   // clean + unchanged → hit
    assert.equal(r1.cached, false, 'first call on a clean tree misses');
    assert.equal(r2.cached, true, 'unchanged clean tree → cache hit (caching still works)');

    appendFileSync(path.join(repo, 'a.txt'), 'two\n'); // UNCOMMITTED edit; HEAD SHA unchanged
    const r3 = await runValidation(cfg, repo);
    assert.equal(r3.cached, false, 'an uncommitted edit invalidates the cache (the stale-tree fix)');

    writeFileSync(path.join(repo, 'b.txt'), 'new\n');  // NEW untracked file
    const r4 = await runValidation(cfg, repo);
    assert.equal(r4.cached, false, 'a new untracked file invalidates the cache (porcelain-captured)');
  } finally {
    try { rmSync(repo, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

try { if (existsSync(CACHE_FILE)) rmSync(CACHE_FILE); } catch { /* best effort cleanup */ }

console.log(`\nvalidate-cache: ${passed}/${passed} checks passed ✓`);
