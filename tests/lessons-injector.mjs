// lessons-injector.mjs — unit tests for the rule-lesson injection system (U-48).
//   node autopilot/tests/lessons-injector.mjs
//
// Verifies: schema loading, implementer filtering by active file pattern,
// reviewer filtering by task goal/class, formatted block output, and graceful
// fallback when lessons-rules.json is absent or empty.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  loadRuleLessons,
  filterForImplementer,
  filterForReviewer,
  formatLessonsBlock,
} from '../lib/lessons-injector.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// Fixture rule lessons covering the canonical schema shape
const FIXTURE_LESSONS = [
  {
    id: 'R-0001',
    category: 'task-classification',
    ruleText: 'Engine tasks whose deliverables live in the gitignored autopilot/ tree MUST be classified as engine, not product.',
    applicableFilePatterns: ['autopilot/**/*.mjs', 'autopilot/**/*.json'],
    tags: ['architecture', 'engine', 'task-classification', 'product-gate'],
  },
  {
    id: 'R-0002',
    category: 'verification',
    ruleText: 'verifyArtifact contains markers MUST be static string literals, never template literals.',
    applicableFilePatterns: ['autopilot/tests/*.mjs', 'autopilot/tests/**/*.mjs'],
    tags: ['verification', 'artifacts', 'static-markers', 'testing'],
  },
  {
    id: 'R-0003',
    category: 'wiring',
    ruleText: 'Every new module created for an engine task MUST be imported/consumed by at least one other module.',
    applicableFilePatterns: ['autopilot/**/*.mjs'],
    tags: ['architecture', 'engine', 'wiring', 'dead-file'],
  },
];

// 1) LOAD — round-trips through a temp file; accepts { lessons: [...] } wrapper.
check('loadRuleLessons: reads { lessons:[...] } schema correctly', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lessons-rules-'));
  const p = path.join(dir, 'lessons-rules.json');
  writeFileSync(p, JSON.stringify({ lessons: FIXTURE_LESSONS }), 'utf8');
  const loaded = loadRuleLessons(p);
  assert.equal(loaded.length, 3);
  assert.equal(loaded[0].id, 'R-0001');
  assert.equal(loaded[1].category, 'verification');
  assert.ok(typeof loaded[2].ruleText === 'string' && loaded[2].ruleText.length > 0);
  rmSync(dir, { recursive: true, force: true });
});

// 2) GRACEFUL FALLBACK — missing file, empty file, invalid JSON all return [].
check('loadRuleLessons: graceful fallback on absent/empty/corrupt file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lessons-rules-'));

  // Missing file
  assert.deepEqual(loadRuleLessons(path.join(dir, 'nope.json')), []);

  // Empty object
  const emptyPath = path.join(dir, 'empty.json');
  writeFileSync(emptyPath, '{}', 'utf8');
  assert.deepEqual(loadRuleLessons(emptyPath), []);

  // Invalid JSON — must not throw
  const badPath = path.join(dir, 'bad.json');
  writeFileSync(badPath, '{ not valid ]]', 'utf8');
  let warned = false;
  const result = loadRuleLessons(badPath, () => { warned = true; });
  assert.deepEqual(result, []);
  assert.ok(warned, 'expected a warning log for corrupt file');

  rmSync(dir, { recursive: true, force: true });
});

// 3) IMPLEMENTER FILTER — active files matching patterns trigger injection.
check('filterForImplementer: matches autopilot/**/*.mjs pattern → injects R-0001 and R-0003', () => {
  const activeFiles = ['autopilot/lib/lessons-injector.mjs', 'autopilot/core/implementer/index.mjs'];
  const matched = filterForImplementer(FIXTURE_LESSONS, activeFiles);
  const ids = matched.map((l) => l.id);
  assert.ok(ids.includes('R-0001'), 'R-0001 must be injected when autopilot/ files are active');
  assert.ok(ids.includes('R-0003'), 'R-0003 must be injected when autopilot/ files are active');
});

check('filterForImplementer: test file pattern → injects R-0002', () => {
  const activeFiles = ['autopilot/tests/lessons-injector.mjs'];
  const matched = filterForImplementer(FIXTURE_LESSONS, activeFiles);
  const ids = matched.map((l) => l.id);
  assert.ok(ids.includes('R-0002'), 'R-0002 must be injected when test files are active');
});

check('filterForImplementer: unrelated files → no injection', () => {
  const activeFiles = ['apps/mobile/app/dashboard.tsx', 'functions/src/index.ts'];
  const matched = filterForImplementer(FIXTURE_LESSONS, activeFiles);
  assert.equal(matched.length, 0);
});

check('filterForImplementer: empty activeFiles → no injection', () => {
  assert.deepEqual(filterForImplementer(FIXTURE_LESSONS, []), []);
});

// 4) REVIEWER FILTER — task goal/class tags drive injection.
check('filterForReviewer: task goal=architecture → injects R-0001 and R-0003', () => {
  const task = { goal: 'architecture', class: 'engine' };
  const matched = filterForReviewer(FIXTURE_LESSONS, task);
  const ids = matched.map((l) => l.id);
  assert.ok(ids.includes('R-0001'), 'architecture tag must match R-0001');
  assert.ok(ids.includes('R-0003'), 'architecture tag must match R-0003');
});

check('filterForReviewer: task goal=verification → injects R-0002', () => {
  const task = { goal: 'verification' };
  const matched = filterForReviewer(FIXTURE_LESSONS, task);
  const ids = matched.map((l) => l.id);
  assert.ok(ids.includes('R-0002'), 'verification tag must match R-0002');
});

check('filterForReviewer: no goal/class → returns all lessons (inject everything)', () => {
  const matched = filterForReviewer(FIXTURE_LESSONS, {});
  assert.equal(matched.length, FIXTURE_LESSONS.length);
});

// 5) FORMAT BLOCK — visible injection output in the prompt.
check('formatLessonsBlock: produces a visible ## section with lesson IDs', () => {
  const block = formatLessonsBlock(FIXTURE_LESSONS, 'Applicable lessons from past cycles:');
  assert.ok(block.includes('## Applicable lessons from past cycles:'));
  assert.ok(block.includes('[R-0001]'), 'R-0001 must be visible in the formatted block');
  assert.ok(block.includes('[R-0002]'), 'R-0002 must be visible in the formatted block');
  assert.ok(block.includes('[R-0003]'), 'R-0003 must be visible in the formatted block');
  assert.ok(block.includes('task-classification'), 'category must appear in the block');
  // Full content visible: concrete lesson text injected
  assert.ok(block.includes('Engine tasks whose deliverables live in the gitignored autopilot/ tree'));
  console.log('\n  [Injected prompt block sample]:\n' + block.split('\n').map((l) => '    ' + l).join('\n'));
});

check('formatLessonsBlock: empty lessons → empty string (no section header)', () => {
  const block = formatLessonsBlock([], 'Should not appear');
  assert.equal(block, '');
});

// 6) END-TO-END SIMULATION — implementer prompt injection for an engine task.
check('end-to-end: implementer lesson injection visible for engine task', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lessons-rules-'));
  const p = path.join(dir, 'lessons-rules.json');
  writeFileSync(p, JSON.stringify({ lessons: FIXTURE_LESSONS }), 'utf8');

  const ruleLessons = loadRuleLessons(p);
  const activeFiles = ['autopilot/core/implementer/index.mjs', 'autopilot/tests/lessons-injector.mjs'];
  const applicableLessons = filterForImplementer(ruleLessons, activeFiles);
  const APPLICABLE_LESSONS = formatLessonsBlock(applicableLessons, 'Applicable lessons from past cycles:');

  // Simulate prompt template substitution
  const promptTemplate = 'You are the implementer.\n{{APPLICABLE_LESSONS}}\n## Rules\n...';
  const rendered = promptTemplate.replace('{{APPLICABLE_LESSONS}}', APPLICABLE_LESSONS);

  assert.ok(rendered.includes('[R-0001]'), 'R-0001 must appear in the rendered implementer prompt');
  assert.ok(rendered.includes('[R-0002]'), 'R-0002 must appear for test file pattern match');
  assert.ok(rendered.includes('[R-0003]'), 'R-0003 must appear for autopilot/**/*.mjs match');
  assert.ok(!rendered.includes('{{APPLICABLE_LESSONS}}'), 'placeholder must be replaced');

  rmSync(dir, { recursive: true, force: true });
});

if (passed !== 12) throw new Error(`Expected 12 checks, got ${passed}`);
console.log('\nlessons-injector: 12 checks passed.');
