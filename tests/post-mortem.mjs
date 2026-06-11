// post-mortem.mjs — assertions for the post-mortem agent (core/post-mortem.mjs).
//   node autopilot/tests/post-mortem.mjs
import assert from 'node:assert/strict';
import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractRule, rulesNearDuplicate, runPostMortem } from '../core/post-mortem.mjs';
import { loadLessons } from '../lib/learn.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// 1) extractRule — product-gate failure produces the correct rule.
check('extractRule: product-gate failure → correct rule', () => {
  const task = { id: 'U-99', title: 'build engine thing', goal: 'architecture', class: 'engine',
    acceptanceCriteria: [], notes: '' };
  const review = { reasons: ['PRODUCT GATE FAILURE: no visible product change committed; gitDiffRequired=true but no git diff'], requiredFixes: [] };
  const rule = extractRule(task, { failureType: 'blocked', revisionCount: 0, review, validation: { summary: 'ok' } });
  assert.ok(rule.includes('engine') || rule.includes('product-delivery') || rule.includes('class'),
    `expected rule about engine/product-gate, got: ${rule}`);
});

// 2) extractRule — marker-absent failure produces the correct rule.
check('extractRule: marker-absent failure → mentions static literals', () => {
  const task = { id: 'U-45', title: 'dependency parser', goal: 'optimization', class: 'engine',
    acceptanceCriteria: [], notes: '' };
  const review = { reasons: ['MARKER ABSENT: template literal used instead of static string'], requiredFixes: [] };
  const rule = extractRule(task, { failureType: 'blocked', revisionCount: 0, review, validation: { summary: 'ok' } });
  assert.ok(rule.toLowerCase().includes('literal') || rule.includes('static'),
    `expected rule about static literals, got: ${rule}`);
});

// 3) extractRule — high-revision failure mentions revision count.
check('extractRule: high-revision failure → mentions revision count', () => {
  const task = { id: 'U-10', title: 'refactor large module', goal: 'architecture', class: 'engine',
    acceptanceCriteria: ['do X', 'verify Y'], notes: '',
    impl: { filesChanged: ['autopilot/core/foo.mjs', 'autopilot/core/bar.mjs'] } };
  const rule = extractRule(task, { failureType: 'high-revision', revisionCount: 4,
    impl: { filesChanged: ['autopilot/core/foo.mjs'] },
    review: { reasons: [], requiredFixes: [] }, validation: { summary: 'ok' } });
  assert.ok(rule.includes('4') || rule.includes('revision'),
    `expected rule mentioning revision count, got: ${rule}`);
});

// 4) rulesNearDuplicate — same/similar rules match; dissimilar rules do not.
check('rulesNearDuplicate: similar rules match, dissimilar do not', () => {
  const a = 'Never classify engine tasks as product class; all autopilot deliverables must use engine gate';
  const b = 'Never classify engine maintenance tasks as product class; deliverables in autopilot tree use engine gate';
  assert.ok(rulesNearDuplicate(a, b), 'expected near-duplicate to match');

  const c = 'TypeScript changes must pass typecheck before committing for engine tasks';
  assert.ok(!rulesNearDuplicate(a, c), 'expected dissimilar rules not to match');

  // Identical short strings match
  assert.ok(rulesNearDuplicate('abc', 'abc'));
  // Different short strings do not
  assert.ok(!rulesNearDuplicate('abc', 'xyz'));
});

// 5) runPostMortem — persists entry with new schema fields (rule, context, firstSeen, occurrenceCount).
check('runPostMortem: persists entry with rule/context/firstSeen/occurrenceCount', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'postmortem-'));
  const lp = path.join(dir, 'lessons.json');
  const task = { id: 'U-77', title: 'add leaderboard page', goal: 'product', class: 'product',
    acceptanceCriteria: ['show top 10 teams'], notes: '' };
  const ctx = {
    failureType: 'rollback',
    revisionCount: 2,
    impl: { filesChanged: ['apps/admin/src/pages/LeaderboardPage.tsx'] },
    validation: { summary: 'typecheck FAILED: cannot find module' },
    review: { reasons: ['TypeScript errors in LeaderboardPage'], requiredFixes: ['fix import path'] },
  };
  const entry = runPostMortem(lp, task, ctx, () => {});
  assert.ok(entry, 'expected an entry to be returned');
  assert.ok(typeof entry.rule === 'string' && entry.rule.length > 0, 'entry.rule must be a non-empty string');
  assert.ok(typeof entry.context === 'string', 'entry.context must be a string');
  assert.ok(typeof entry.firstSeen === 'string', 'entry.firstSeen must be an ISO string');
  assert.equal(entry.occurrenceCount, 1, 'occurrenceCount must start at 1');
  assert.equal(entry.failureType, 'rollback');
  // Legacy fields still present
  assert.equal(entry.taskId, 'U-77');
  assert.ok(Array.isArray(entry.keywords) && entry.keywords.length > 0);
  assert.ok(typeof entry.errorSummary === 'string');
  rmSync(dir, { recursive: true, force: true });
});

// 6) runPostMortem — near-duplicate rule increments occurrenceCount instead of creating a new entry.
check('runPostMortem: near-duplicate rule increments occurrenceCount (no new entry)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'postmortem-'));
  const lp = path.join(dir, 'lessons.json');
  const baseTask = { id: 'U-10', title: 'engine task alpha', goal: 'architecture', class: 'engine',
    acceptanceCriteria: [], notes: '' };
  const baseCtx = {
    failureType: 'blocked',
    revisionCount: 0,
    impl: {},
    validation: { summary: 'ok' },
    review: { reasons: ['PRODUCT GATE FAILURE: no visible product change committed; gitDiffRequired=true but no git diff'], requiredFixes: [] },
  };
  // First occurrence
  runPostMortem(lp, baseTask, baseCtx, () => {});

  // Second occurrence (different task, same failure pattern)
  const task2 = { id: 'U-11', title: 'engine task beta', goal: 'architecture', class: 'engine',
    acceptanceCriteria: [], notes: '' };
  runPostMortem(lp, task2, baseCtx, () => {});

  const lessons = loadLessons(lp);
  assert.equal(lessons.length, 1, 'near-duplicate must not create a second entry');
  assert.equal(lessons[0].occurrenceCount, 2, 'occurrenceCount must be incremented to 2');
  rmSync(dir, { recursive: true, force: true });
});

// 7) runPostMortem — same task+failureType (same rule) never creates a duplicate entry.
// The near-duplicate check fires first (same rule → high token similarity → increments occurrenceCount).
check('runPostMortem: same taskId+failureType never creates a duplicate entry', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'postmortem-'));
  const lp = path.join(dir, 'lessons.json');
  const task = { id: 'U-55', title: 'unique task', goal: 'gameplay', class: 'product',
    acceptanceCriteria: [], notes: '' };
  const ctx = { failureType: 'rollback', revisionCount: 1, impl: {},
    validation: { summary: 'FAIL' }, review: { reasons: ['bad approach'], requiredFixes: [] } };
  runPostMortem(lp, task, ctx, () => {});
  const result2 = runPostMortem(lp, task, ctx, () => {});
  // Near-duplicate rule match → returns the updated existing entry (not null), increments occurrenceCount
  assert.ok(result2 !== null, 'second call must return the updated existing entry (near-dup match)');
  const lessons = loadLessons(lp);
  assert.equal(lessons.length, 1, 'only one entry should exist — no duplicate created');
  assert.equal(lessons[0].occurrenceCount, 2, 'occurrenceCount must be 2 after second call');
  rmSync(dir, { recursive: true, force: true });
});

if (passed !== 7) throw new Error(`Expected 7 checks, got ${passed}`);
console.log('post-mortem: 7 checks passed.');
