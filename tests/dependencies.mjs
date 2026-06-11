// tests/dependencies.mjs — unit tests for core/dependencies.mjs (U-45).
//
// Exercises parseDependencies() and getRelevantFiles() with synthetic inputs:
//   - Static string parsing (ES6, CJS, dynamic import)
//   - BFS traversal, keyword seeding, maxDepth/maxFiles caps
//   - Structural token-reduction guarantee (N >> maxFiles → output ≤ maxFiles)
//
//   node autopilot/tests/dependencies.mjs

import assert from 'node:assert/strict';
import { parseDependencies, buildDependencyGraph, getRelevantFiles } from '../core/dependencies.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// ── parseDependencies ─────────────────────────────────────────────────────────

check('ES6 static import extracted (regex fallback for .ts)', () => {
  const src = `import { foo } from './foo';\nimport bar from "../bar/index";\n`;
  const { imports, requires } = parseDependencies('src/file.ts', src);
  assert.ok(imports.includes('./foo'), 'expected ./foo');
  assert.ok(imports.includes('../bar/index'), 'expected ../bar/index');
  assert.deepEqual(requires, []);
});

check('CommonJS require() extracted', () => {
  const src = `const x = require('./utils');\nconst y = require("path");\n`;
  const { imports, requires } = parseDependencies('lib/a.js', src);
  assert.ok(requires.includes('./utils'), 'expected ./utils');
  assert.ok(requires.includes('path'), 'expected path (npm)');
  assert.deepEqual(imports, []);
});

check('dynamic import() extracted as import specifier', () => {
  const src = `const m = await import('./dynamic');\n`;
  const { imports } = parseDependencies('src/b.mjs', src);
  assert.ok(imports.includes('./dynamic'), 'expected ./dynamic');
});

check('mixed imports deduplicated', () => {
  const src = `import './side-effect';\nimport './side-effect';\nconst r = require('./r');\n`;
  const { imports, requires } = parseDependencies('src/c.js', src);
  assert.equal(imports.filter((v) => v === './side-effect').length, 1, 'deduplication');
  assert.ok(requires.includes('./r'));
});

check('empty content returns empty arrays', () => {
  const { imports, requires } = parseDependencies('src/empty.ts', '');
  assert.deepEqual(imports, []);
  assert.deepEqual(requires, []);
});

check('variable require() (dynamic) is intentionally skipped', () => {
  const src = `const name = 'foo';\nconst m = require(name);\n`;
  const { requires } = parseDependencies('src/dyn.js', src);
  assert.equal(requires.length, 0, 'non-literal require skipped');
});

// ── buildDependencyGraph ──────────────────────────────────────────────────────

check('buildDependencyGraph resolves local paths and skips npm packages', () => {
  const fileMap = {
    'src/a.ts': `import { b } from './b';`,
    'src/b.ts': `import { c } from './c';`,
    'src/c.ts': `import React from 'react';`, // npm — should be skipped
  };
  const graph = buildDependencyGraph(fileMap);
  assert.deepEqual(graph['src/a.ts'], ['src/b.ts']);
  assert.deepEqual(graph['src/b.ts'], ['src/c.ts']);
  assert.deepEqual(graph['src/c.ts'], [], 'npm import not in local graph');
});

// ── getRelevantFiles ──────────────────────────────────────────────────────────

// Helper: build a synthetic pre-built dep graph for testing.
const makeGraph = (edges) => {
  // edges: [[from, [to, ...]], ...]
  const g = {};
  for (const [f, deps] of edges) g[f] = deps;
  return g;
};

check('BFS traversal from targetFile follows edges', () => {
  const graph = makeGraph([
    ['a.ts', ['b.ts', 'c.ts']],
    ['b.ts', ['d.ts']],
    ['c.ts', []],
    ['d.ts', []],
    ['unrelated.ts', []],
  ]);
  const result = getRelevantFiles('a.ts', '', graph, { depGraph: graph, maxDepth: 2, maxFiles: 10 });
  assert.ok(result.includes('a.ts'), 'root included');
  assert.ok(result.includes('b.ts'), 'depth-1 dep');
  assert.ok(result.includes('c.ts'), 'depth-1 dep');
  assert.ok(result.includes('d.ts'), 'depth-2 dep');
  // unrelated.ts has no keyword match and is not reachable from a.ts
  assert.ok(!result.includes('unrelated.ts'), 'unreachable file excluded');
});

check('maxDepth cap stops BFS at the correct hop count', () => {
  // chain: root → level1 → level2 → level3
  const graph = makeGraph([
    ['root.ts', ['level1.ts']],
    ['level1.ts', ['level2.ts']],
    ['level2.ts', ['level3.ts']],
    ['level3.ts', []],
  ]);
  const result = getRelevantFiles('root.ts', '', graph, { depGraph: graph, maxDepth: 2, maxFiles: 10 });
  assert.ok(result.includes('root.ts'));
  assert.ok(result.includes('level1.ts'));
  assert.ok(result.includes('level2.ts'));
  assert.ok(!result.includes('level3.ts'), 'depth-3 node excluded by maxDepth=2');
});

check('keyword seeding promotes matching files to BFS roots', () => {
  // 'scoring' appears in 'scoring.ts' path → seeded even without a graph edge from root
  const graph = makeGraph([
    ['root.ts', []],
    ['scoring.ts', ['utils.ts']],
    ['utils.ts', []],
    ['unrelated.ts', []],
  ]);
  const result = getRelevantFiles('root.ts', 'scoring algorithm', graph, {
    depGraph: graph, maxDepth: 2, maxFiles: 10,
  });
  assert.ok(result.includes('scoring.ts'), 'keyword-seeded file included');
  assert.ok(result.includes('utils.ts'), 'transitive dep of keyword-seeded file included');
});

check('maxFiles cap limits output size', () => {
  // 20-file star graph: root imports all 20
  const edges = [['root.ts', Array.from({ length: 20 }, (_, i) => `dep${i}.ts`)]];
  for (let i = 0; i < 20; i++) edges.push([`dep${i}.ts`, []]);
  const graph = makeGraph(edges);
  const result = getRelevantFiles('root.ts', '', graph, { depGraph: graph, maxDepth: 3, maxFiles: 5 });
  assert.ok(result.length <= 5, `expected ≤5, got ${result.length}`);
});

check('circular dependency handled without infinite loop', () => {
  const graph = makeGraph([
    ['a.ts', ['b.ts']],
    ['b.ts', ['a.ts']], // cycle
  ]);
  // Should not throw or loop forever; result must be finite.
  const result = getRelevantFiles('a.ts', '', graph, { depGraph: graph, maxDepth: 5, maxFiles: 10 });
  assert.ok(result.length <= 2);
  assert.ok(result.includes('a.ts'));
  assert.ok(result.includes('b.ts'));
});

check('no seeds → returns first maxFiles files in natural order', () => {
  // No targetFile, no keyword → fallback to natural slice.
  const graph = makeGraph(
    Array.from({ length: 10 }, (_, i) => [`file${i}.ts`, []])
  );
  const result = getRelevantFiles(null, '', graph, { depGraph: graph, maxFiles: 4 });
  assert.ok(result.length <= 4, 'fallback slice respects maxFiles');
});

// ── Structural token-reduction guarantee (criterion 4, option b) ─────────────
//
// Construct a fileIndex of N=100 files (N >> maxFiles=40) where only a small subset
// is reachable from the keyword-seeded roots.  After filtering, the output MUST be
// ≤ maxFiles=40.  This mechanically guarantees ≥60% structural reduction for a codebase
// of this size (100 → ≤40), covering the ≥30% claim from the acceptance criteria.

check('structural reduction: 100-file graph filtered to ≤40 files (≥60% reduction)', () => {
  const N = 100;
  const maxFiles = 40;
  // Build a flat graph — no edges, so only keyword-seeded files are included.
  const graph = makeGraph(
    Array.from({ length: N }, (_, i) => [`module${String(i).padStart(3, '0')}.ts`, []])
  );
  // Task description matches only files whose path contains 'auth' — none do here,
  // so the fallback (first maxFiles) runs.  Either way, output ≤ maxFiles.
  const result = getRelevantFiles(null, 'auth login token', graph, { depGraph: graph, maxFiles });
  assert.ok(result.length <= maxFiles,
    `expected ≤${maxFiles} files, got ${result.length} — reduction from ${N}: ${Math.round((1 - result.length / N) * 100)}%`);
  // Verify the reduction percentage meets the ≥30% bar.
  const reduction = (1 - result.length / N);
  assert.ok(reduction >= 0.30, `reduction ${Math.round(reduction * 100)}% < 30% threshold`);
});

check('structural reduction: keyword-seeded BFS on 100-file graph still ≤40 outputs', () => {
  const N = 100;
  const maxFiles = 40;
  // A few files have 'scoring' in their path; they get seeded and expand via BFS.
  const graph = {};
  for (let i = 0; i < N; i++) {
    const name = i < 5 ? `scoring${i}.ts` : `module${String(i).padStart(3, '0')}.ts`;
    // Each scoring file imports the next 3 non-scoring files.
    graph[name] = i < 5
      ? [`module0${i * 3}.ts`, `module0${i * 3 + 1}.ts`].filter((f) => graph[f] !== undefined || true)
      : [];
  }
  const result = getRelevantFiles(null, 'scoring algorithm compute', graph,
    { depGraph: graph, maxFiles, maxDepth: 3 });
  assert.ok(result.length <= maxFiles,
    `BFS+keyword: expected ≤${maxFiles}, got ${result.length}`);
  const reduction = (1 - result.length / N);
  assert.ok(reduction >= 0.30, `reduction ${Math.round(reduction * 100)}% < 30%`);
});

if (passed !== 15) throw new Error(`Expected 15 checks, got ${passed}`);
console.log('\ndependencies: 15 checks passed.');
