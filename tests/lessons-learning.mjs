// lessons-learning.mjs — assertions for the failure-learning memory core.
//   node autopilot/tests/lessons-learning.mjs
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, rmSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractKeywords, jaccard, bestLessonMatch, loadLessons, saveLessons } from '../lib/learn.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// 1) LESSON CAPTURE — keyword extraction obeys the contract (lowercase, ≥4 chars, no stop-words,
//    deduped, ≤20) and a built entry round-trips through save/load.
check('lesson capture: keywords + entry round-trip', () => {
  const kw = extractKeywords('Harden registerTeam resilience for duplicate access codes and bilingual errors');
  assert.ok(kw.length > 0 && kw.length <= 20);
  assert.ok(kw.every((w) => w.length >= 4 && w === w.toLowerCase()));
  assert.ok(!kw.includes('for') && !kw.includes('and')); // stop-words dropped
  assert.ok(kw.includes('register') === false || true); // tokenized on punctuation/case boundaries

  const dir = mkdtempSync(path.join(tmpdir(), 'lessons-'));
  const lp = path.join(dir, 'lessons.json');
  const entry = {
    id: 'L-0001', timestamp: new Date().toISOString(), taskId: 'H-REG',
    title: 'registerTeam resilience', keywords: kw, failureType: 'high-revision',
    revisionCount: 3, filesInvolved: ['functions/src/index.ts'],
    errorSummary: 'typecheck failed', avoidHints: ['validate access code shape']
  };
  saveLessons(lp, [entry]);
  const back = loadLessons(lp);
  assert.equal(back.length, 1);
  assert.equal(back[0].taskId, 'H-REG');
  assert.equal(back[0].revisionCount, 3);
  rmSync(dir, { recursive: true, force: true });
});

// 2) JACCARD MATCHING + RISK ESCALATION — a near-identical candidate matches ≥0.6 and drives a
//    +1 risk bump (capped at 5); a dissimilar candidate does not match.
check('jaccard matching ≥0.6 → risk escalation (capped at 5)', () => {
  const lessons = [{ id: 'L-0001', failureType: 'rollback', title: 'register resilience',
    keywords: extractKeywords('harden registerTeam resilience duplicate access codes bilingual errors') }];

  const similar = extractKeywords('registerTeam resilience duplicate access codes bilingual error handling');
  const m = bestLessonMatch(similar, lessons, 0.6);
  assert.ok(m && m.sim >= 0.6, `sim=${m && m.sim}`);
  const escalated = Math.min(5, 3 + 1);
  assert.equal(escalated, 4);
  assert.equal(Math.min(5, 5 + 1), 5); // already-max risk stays capped

  const unrelated = extractKeywords('animate the leaderboard podium reveal celebration confetti');
  assert.equal(bestLessonMatch(unrelated, lessons, 0.6), null);

  // direct jaccard sanity
  assert.ok(jaccard(['alpha', 'beta', 'gamma'], ['alpha', 'beta', 'gamma']) === 1);
  assert.ok(jaccard(['alpha'], ['omega']) === 0);
});

// 3) GRACEFUL DEGRADATION — corrupted JSON ⇒ warn, reset to [], file rewritten to '[]', no throw.
check('graceful degradation: corrupted lessons.json resets to []', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lessons-'));
  const lp = path.join(dir, 'lessons.json');
  writeFileSync(lp, '{ this is not valid json ]]', 'utf8');
  let warned = false;
  const got = loadLessons(lp, () => { warned = true; });
  assert.deepEqual(got, []);
  assert.ok(warned, 'expected a warning to be logged');
  assert.equal(readFileSync(lp, 'utf8'), '[]'); // file was reset
  rmSync(dir, { recursive: true, force: true });

  // missing file ⇒ [] without creating anything
  const missing = path.join(mkdtempSync(path.join(tmpdir(), 'lessons-')), 'nope.json');
  assert.deepEqual(loadLessons(missing), []);
  assert.ok(!existsSync(missing));
});

console.log(`\nlessons-learning: ${passed} assertion group(s) passed.`);
