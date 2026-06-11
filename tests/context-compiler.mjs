// context-compiler.mjs — assertions for the deterministic P1 context compiler (lib/context-compiler.mjs).
// Verifies: keyword-driven file relevance (name + body hits), exclusion of unrelated files, the maxFiles
// cap, the metrics block (scanned/selected/reduction%), the advisory hint block, and the no-keyword/
// empty-list backward-compatible fallbacks. IO is INJECTED (files[] + readText) so the test is
// hermetic — no git, no disk.
//   node autopilot/tests/context-compiler.mjs
import assert from 'node:assert/strict';
import { compileContext, contextHintBlock } from '../lib/context-compiler.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// A small synthetic tracked-file set + their contents.
const FILES = [
  'apps/admin/src/pages/ControlRoomPage.tsx',
  'apps/admin/src/pages/LeaderboardPage.tsx',
  'functions/src/scoring/calculateScore.ts',
  'packages/shared/src/geo.ts',
  'apps/mobile/app/dashboard.tsx',
  'README.md',
  'node_modules/foo/index.js',            // must be skipped (SKIP_DIR)
  'package-lock.json',                    // must be skipped (SKIP_FILE)
  'assets/logo.png',                      // must be skipped (extension)
];
const CONTENT = {
  'apps/admin/src/pages/ControlRoomPage.tsx': 'export function ControlRoomPage() { /* control room dashboard */ }',
  'apps/admin/src/pages/LeaderboardPage.tsx': 'export function LeaderboardPage() { return null; }',
  'functions/src/scoring/calculateScore.ts': 'export function calculateScore() { return zScore(); } // scoring leaderboard',
  'packages/shared/src/geo.ts': 'export const haversine = () => 0;',
  'apps/mobile/app/dashboard.tsx': 'export default function Dashboard() {}',
  'README.md': 'project readme',
};
const readText = (rel) => (rel in CONTENT ? CONTENT[rel] : null);

// ── relevance: a task about the leaderboard scoring picks the scoring + leaderboard files ──
check('keyword scan surfaces name + body matches, ranks them first', () => {
  const r = compileContext({
    task: { title: 'Harden leaderboard scoring', acceptanceCriteria: ['fix zScore edge cases'] },
    repoRoot: '/x', files: FILES, readText, maxFiles: 8,
  });
  const picked = r.files.map((f) => f.path);
  assert.ok(picked.includes('functions/src/scoring/calculateScore.ts'), 'scoring file should be selected');
  assert.ok(picked.includes('apps/admin/src/pages/LeaderboardPage.tsx'), 'leaderboard page should be selected');
  // The scoring file has both a body hit (scoring/zScore) and a path hit (scoring) → ranks at/near top.
  assert.ok(r.files[0].score >= r.files[r.files.length - 1].score, 'results are score-sorted desc');
});

check('unrelated + non-source files are excluded', () => {
  const r = compileContext({
    task: { title: 'control room dashboard' }, repoRoot: '/x', files: FILES, readText, maxFiles: 8,
  });
  const picked = r.files.map((f) => f.path);
  assert.ok(!picked.includes('node_modules/foo/index.js'), 'node_modules skipped');
  assert.ok(!picked.includes('package-lock.json'), 'lockfile skipped');
  assert.ok(!picked.includes('assets/logo.png'), 'binary extension skipped');
  assert.ok(picked.includes('apps/admin/src/pages/ControlRoomPage.tsx'), 'control-room page matched on the name');
});

check('maxFiles caps the result set', () => {
  const r = compileContext({
    task: { title: 'scoring leaderboard control geo dashboard' }, repoRoot: '/x', files: FILES, readText, maxFiles: 2,
  });
  assert.ok(r.files.length <= 2, 'no more than maxFiles returned');
});

// ── metrics block ──
check('metrics report scanned/selected/reduction% sensibly', () => {
  const r = compileContext({
    task: { title: 'leaderboard scoring' }, repoRoot: '/x', files: FILES, readText, maxFiles: 8,
  });
  assert.equal(r.metrics.scanned, 6, 'scanned counts only scannable files (9 listed − 3 skipped)');
  assert.equal(r.metrics.selected, r.files.length);
  assert.ok(r.metrics.reductionPct >= 0 && r.metrics.reductionPct <= 100, 'reduction% in range');
  // Selecting a strict subset of the read pool ⇒ compiled bytes < original bytes ⇒ positive reduction.
  if (r.metrics.selected < r.metrics.scanned) assert.ok(r.metrics.reductionPct > 0, 'a subset means a real reduction');
});

// ── hint block ──
check('contextHintBlock renders the selected files; empty when nothing matched', () => {
  const r = compileContext({ task: { title: 'leaderboard scoring' }, repoRoot: '/x', files: FILES, readText });
  const block = contextHintBlock(r);
  assert.ok(block.includes('calculateScore.ts'), 'hint names a selected file');
  assert.ok(/Likely-relevant files/.test(block), 'hint has the advisory header');
  // No keyword match → empty result → empty hint (prompt unchanged, backward compatible).
  const none = compileContext({ task: { title: 'zzzz' }, repoRoot: '/x', files: FILES, readText });
  assert.equal(contextHintBlock(none), '', 'no matches → empty hint string');
});

// ── backward-compatible fallbacks ──
check('no keywords or empty file list → empty result, never throws', () => {
  const a = compileContext({ task: { title: '' }, repoRoot: '/x', files: FILES, readText });
  assert.deepEqual(a.files, []);
  const b = compileContext({ task: { title: 'scoring' }, repoRoot: '/x', files: [], readText });
  assert.deepEqual(b.files, []);
  assert.equal(b.metrics.scanned, 0);
});

// ── symbol-level reasons (area D: name the matching functions, not just the file) ──
check('reasons name the specific matching symbol (fn:<name>) when a declaration matches', () => {
  const r = compileContext({
    task: { title: 'control room dashboard' }, repoRoot: '/x', files: FILES, readText, maxFiles: 8,
  });
  const ctrl = r.files.find((f) => f.path.endsWith('ControlRoomPage.tsx'));
  assert.ok(ctrl, 'control-room page selected');
  assert.ok(ctrl.reasons.some((x) => x === 'fn:ControlRoomPage'), 'surfaces the matching exported symbol');
});
check('a file that DEFINES a matching symbol outranks one that only mentions the word', () => {
  const files = ['a/defines.ts', 'b/mentions.ts'];
  const content = {
    'a/defines.ts': 'export function leaderboard() { return 1; }',     // defines the symbol
    'b/mentions.ts': '// just a comment about the leaderboard somewhere',// only a body mention
  };
  const r = compileContext({ task: { title: 'leaderboard work' }, repoRoot: '/x', files, readText: (p) => content[p], maxFiles: 2 });
  assert.equal(r.files[0].path, 'a/defines.ts', 'the definer ranks first');
});

check('deterministic: identical inputs → identical output', () => {
  const args = { task: { title: 'leaderboard scoring geo' }, repoRoot: '/x', files: FILES, readText, maxFiles: 5 };
  assert.deepEqual(compileContext(args), compileContext(args));
});

console.log(`\ncontext-compiler: ${passed}/${passed} checks passed ✓`);
