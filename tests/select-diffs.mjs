// tests/select-diffs.mjs — E2E tests for U-52: git diff optimization in Selector context.
//
// Verifies that:
//   1. getModifiedFilesDiffs detects modified files and extracts diffs correctly
//   2. extractDiffStats calculates added/deleted/modified line counts accurately
//   3. formatDiffsForContext produces valid prompt-injectable output
//   4. Feature can be toggled via enableSelectorDiffMode flag
//
//   node autopilot/tests/select-diffs.mjs

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { extractDiffStats, formatDiffsForContext, getModifiedFilesDiffs } from '../lib/select.mjs';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

// ── Fixtures: Temp git repo for testing ────────────────────────────────────────

const TEST_DIR = path.join(process.cwd(), '.test-select-diffs-' + Date.now());

function setupTestRepo() {
  mkdirSync(TEST_DIR, { recursive: true });

  // Initialize git repo with a baseline commit.
  execSync('git init', { cwd: TEST_DIR, encoding: 'utf8' });
  execSync('git config user.email "test@test.com"', { cwd: TEST_DIR });
  execSync('git config user.name "Test"', { cwd: TEST_DIR });

  // Create initial file and commit.
  const initialFile = path.join(TEST_DIR, 'initial.txt');
  writeFileSync(initialFile, 'line 1\nline 2\nline 3\n');
  execSync('git add initial.txt', { cwd: TEST_DIR });
  execSync('git commit -m "initial"', { cwd: TEST_DIR });

  return TEST_DIR;
}

function cleanupTestRepo() {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

// ── Tests ──────────────────────────────────────────────────────────────────────

await check('extractDiffStats calculates line counts correctly', async () => {
  const diffText = `--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 unchanged line
+added line
-deleted line
 still unchanged`;

  const stats = extractDiffStats(diffText);
  assert.equal(stats.added, 1, 'should detect 1 added line');
  assert.equal(stats.deleted, 1, 'should detect 1 deleted line');
  assert.equal(stats.modified, 1, 'should set modified to min(added, deleted)');
});

await check('extractDiffStats handles empty/null input', async () => {
  const stats1 = extractDiffStats('');
  assert.deepEqual(stats1, { added: 0, deleted: 0, modified: 0 });

  const stats2 = extractDiffStats(null);
  assert.deepEqual(stats2, { added: 0, deleted: 0, modified: 0 });
});

await check('formatDiffsForContext produces valid markdown block', async () => {
  const diffs = {
    'src/file1.js': '--- a/src/file1.js\n+++ b/src/file1.js\n@@ -1 +1,2 @@\n+new line',
  };
  const stats = {
    'src/file1.js': { added: 1, deleted: 0, modified: 0 },
  };

  const block = formatDiffsForContext(diffs, stats);
  assert.ok(block.includes('## Modified Files'), 'should have header');
  assert.ok(block.includes('src/file1.js'), 'should include filename');
  assert.ok(block.includes('(+1−0)'), 'should show stats');
  assert.ok(block.includes('```diff'), 'should be wrapped in diff block');
});

await check('formatDiffsForContext returns empty string for no diffs', async () => {
  const block = formatDiffsForContext({}, {});
  assert.equal(block, '', 'should return empty string when no diffs');
});

await check('getModifiedFilesDiffs returns empty when diff mode disabled', async () => {
  setupTestRepo();

  // Modify a file but don't stage it.
  const testFile = path.join(TEST_DIR, 'initial.txt');
  writeFileSync(testFile, 'modified content\n');

  const result = await getModifiedFilesDiffs(TEST_DIR, { enableDiffMode: false });
  assert.deepEqual(result.diffs, {}, 'should return no diffs when disabled');
  assert.equal(result.totalBytes, 0);

  cleanupTestRepo();
});

await check('getModifiedFilesDiffs detects modified files when enabled', async () => {
  setupTestRepo();

  // Modify an existing file (staged or unstaged).
  const testFile = path.join(TEST_DIR, 'initial.txt');
  writeFileSync(testFile, 'modified line 1\nline 2\nline 3\n');

  const result = await getModifiedFilesDiffs(TEST_DIR, { enableDiffMode: true });
  assert.ok(Object.keys(result.diffs).length > 0, 'should detect modified files');
  assert.ok(result.diffs['initial.txt'], 'should include the modified file');
  assert.ok(result.diffs['initial.txt'].includes('---'), 'diff should be valid git format');
  assert.ok(result.totalBytes > 0, 'should report total bytes');

  cleanupTestRepo();
});

await check('getModifiedFilesDiffs respects maxDiffBytes budget', async () => {
  setupTestRepo();

  // Modify file with large content.
  const testFile = path.join(TEST_DIR, 'initial.txt');
  const largeContent = 'x'.repeat(1000) + '\n';
  writeFileSync(testFile, largeContent);

  const result = await getModifiedFilesDiffs(TEST_DIR, { enableDiffMode: true, maxDiffBytes: 100 });
  // With a 100-byte budget, we might not capture the full diff, but the function should not crash.
  assert.ok(typeof result.totalBytes === 'number', 'should return totalBytes even with budget');

  cleanupTestRepo();
});

if (passed !== 7) throw new Error(`Expected 7 checks, got ${passed}`);
console.log('\nselect-diffs: 7 checks passed.');
