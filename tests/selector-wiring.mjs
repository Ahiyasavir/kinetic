// tests/selector-wiring.mjs — smoke test for the U-45 dependency-optimization seam in selector/index.mjs.
//
// Verifies that runSelector() filters contextMaps.fileIndex to the dependency-relevant subset
// before calling invokeRole, and that disableDependencyOptimization bypasses the filter.
// No LLM calls are made — invokeRole is a mock that captures the enriched vars.
//
//   node autopilot/tests/selector-wiring.mjs

import assert from 'node:assert/strict';
import { runSelector } from '../core/selector/index.mjs';
import { clearContextCache } from '../core/context-provider.mjs';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

// ── Fixtures ──────────────────────────────────────────────────────────────────
// 10-file universe: 3 "auth" files (keyword-seeded) each import 2 shared lib files.
// The remaining 5 files are unrelated — no keyword match, no graph edge from roots.

const TOTAL = 10;
const authFiles  = ['src/auth/login.ts', 'src/auth/token.ts', 'src/auth/utils.ts'];
const authDeps   = ['src/lib/crypto.ts', 'src/lib/session.ts'];
const unrelated  = ['src/ui/button.ts', 'src/ui/form.ts', 'src/ui/modal.ts',
                    'src/api/endpoint.ts', 'src/api/schema.ts'];

const allFiles = [...authFiles, ...authDeps, ...unrelated];
assert.equal(allFiles.length, TOTAL);

function makeContextMaps(source) {
  const fileIndex = {}, symbolIndex = {}, dependencyGraph = {};
  for (const f of allFiles) {
    fileIndex[f]        = { size: 500 };
    symbolIndex[f]      = { file: f };
    dependencyGraph[f]  = [];
  }
  for (const af of authFiles) dependencyGraph[af] = [...authDeps];
  return { fileIndex, symbolIndex, dependencyGraph, generatedAt: Date.now(), source };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

await check('runSelector injects filtered CONTEXT_MAPS when dependency optimization is active', async () => {
  clearContextCache();
  let capturedVars = null;
  const mockRunner = {
    invokeRole: async (_role, vars) => { capturedVars = vars; },
    readHandoff: async () => ({}),
  };

  // CANDIDATES contains 'auth login' → 3 auth files are keyword-seeded → BFS adds 2 deps = 5 < 10
  await runSelector(
    mockRunner,
    { CANDIDATES: 'auth login', WEAK_BACKLOG: '' },
    undefined,
    { contextMaps: makeContextMaps('test-filtered'), disableDependencyOptimization: false },
  );

  assert.ok(capturedVars !== null, 'invokeRole was called');
  assert.ok(capturedVars.CONTEXT_MAPS, 'CONTEXT_MAPS was injected into vars');

  const summary = JSON.parse(capturedVars.CONTEXT_MAPS);
  assert.ok(typeof summary.fileCount === 'number', 'fileCount is present in summary');
  assert.ok(
    summary.fileCount < TOTAL,
    `expected filtered fileCount < ${TOTAL}, got ${summary.fileCount}`,
  );
  assert.ok(
    summary.fileCount <= 5,
    `expected fileCount ≤5 (3 auth + 2 deps), got ${summary.fileCount}`,
  );
});

await check('runSelector includes all files when disableDependencyOptimization=true', async () => {
  clearContextCache();
  let capturedVars = null;
  const mockRunner = {
    invokeRole: async (_role, vars) => { capturedVars = vars; },
    readHandoff: async () => ({}),
  };

  await runSelector(
    mockRunner,
    { CANDIDATES: 'auth login', WEAK_BACKLOG: '' },
    undefined,
    { contextMaps: makeContextMaps('test-unfiltered'), disableDependencyOptimization: true },
  );

  assert.ok(capturedVars !== null, 'invokeRole was called');
  assert.ok(capturedVars.CONTEXT_MAPS, 'CONTEXT_MAPS was injected into vars');

  const summary = JSON.parse(capturedVars.CONTEXT_MAPS);
  assert.equal(
    summary.fileCount,
    TOTAL,
    `expected all ${TOTAL} files when optimization disabled, got ${summary.fileCount}`,
  );
});

if (passed !== 2) throw new Error(`Expected 2 checks, got ${passed}`);
console.log('\nselector-wiring: 2 checks passed.');
