// priority.mjs — assertions for Stage 2 smart prioritization + dependency eligibility.
//   • priority.mjs — bands, dep gating, foreground/background selectablePool
//   • score.mjs    — effectiveTaskPriority + rankBacklog band gate (high>medium>background)
//   node autopilot/tests/priority.mjs
import assert from 'node:assert/strict';
import {
  PRIORITIES, PRIORITY_RANK, normalizePriority, taskPrereqs, arePrereqsMet, selectablePool,
} from '../lib/priority.mjs';
import { rankBacklog, effectiveTaskPriority, isCleanup } from '../lib/score.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const CFG = { scoring: { weights: { userImpact: 5, adminImpact: 3, reliability: 3, productRisk: 2, cleanupValue: 1 }, categoryBonus: {} } };
const task = (o) => ({ goal: 'gameplay', dims: { userImpact: 3, adminImpact: 0, reliability: 0, productRisk: 0, cleanupValue: 0 }, effort: 3, deps: [], ...o });

// ── bands ────────────────────────────────────────────────────────────────────
check('normalizePriority defaults unknown/empty to medium', () => {
  assert.equal(normalizePriority(undefined), 'medium');
  assert.equal(normalizePriority('HIGH'), 'high');
  assert.equal(normalizePriority('background'), 'background');
  assert.equal(normalizePriority('bogus'), 'medium');
});
check('PRIORITY_RANK orders high < medium < background', () => {
  assert.ok(PRIORITY_RANK.high < PRIORITY_RANK.medium);
  assert.ok(PRIORITY_RANK.medium < PRIORITY_RANK.background);
  assert.deepEqual(PRIORITIES, ['high', 'medium', 'background']);
});

// ── dependency eligibility ─────────────────────────────────────────────────────
check('taskPrereqs dedups deps; parent_task_id is NOT a prereq', () => {
  assert.deepEqual(taskPrereqs(task({ deps: ['A', 'A', 'B'], parent_task_id: 'EPIC' })), ['A', 'B']);
});
check('arePrereqsMet: empty deps always eligible; partial done → not eligible', () => {
  assert.equal(arePrereqsMet(task({ deps: [] }), new Set()), true);
  assert.equal(arePrereqsMet(task({ deps: ['X'] }), new Set(['X'])), true);
  assert.equal(arePrereqsMet(task({ deps: ['X', 'Y'] }), new Set(['X'])), false);
});

// ── selectablePool: strict foreground-before-background + dep gate ──────────────
check('selectablePool exposes foreground (high+medium); hides background while foreground eligible', () => {
  const tasks = [
    task({ id: 'h', priority: 'high' }),
    task({ id: 'm', priority: 'medium' }),
    task({ id: 'b', priority: 'background' }),
  ];
  const r = selectablePool(tasks, new Set(), effectiveTaskPriority);
  assert.equal(r.band, 'foreground');
  assert.deepEqual(r.pool.map((t) => t.id).sort(), ['h', 'm']);
});
check('selectablePool falls through to background only when no foreground is eligible', () => {
  const tasks = [task({ id: 'b1', priority: 'background' }), task({ id: 'b2', priority: 'background' })];
  const r = selectablePool(tasks, new Set(), effectiveTaskPriority);
  assert.equal(r.band, 'background');
  assert.deepEqual(r.pool.map((t) => t.id).sort(), ['b1', 'b2']);
});
check('selectablePool defers a foreground task whose deps are unmet → background runs instead', () => {
  const tasks = [
    task({ id: 'fg', priority: 'high', deps: ['done-later'] }), // not eligible yet
    task({ id: 'bg', priority: 'background' }),
  ];
  const r = selectablePool(tasks, new Set(), effectiveTaskPriority);
  assert.equal(r.band, 'background');               // the only ELIGIBLE task is background
  assert.deepEqual(r.pool.map((t) => t.id), ['bg']);
  assert.deepEqual(r.waiting.map((t) => t.id), ['fg']);
});
check('user-requested tasks are always foreground regardless of band', () => {
  const tasks = [task({ id: 'u', priority: 'background', userRequested: true })];
  const r = selectablePool(tasks, new Set(), effectiveTaskPriority);
  assert.equal(r.band, 'foreground');
  assert.deepEqual(r.pool.map((t) => t.id), ['u']);
});

// ── effectiveTaskPriority (score.mjs) ──────────────────────────────────────────
check('effectiveTaskPriority: explicit wins; pure cleanup → background; else medium', () => {
  assert.equal(effectiveTaskPriority(task({ priority: 'high' })), 'high');
  assert.equal(effectiveTaskPriority(task({ priority: 'background' })), 'background');
  const cleanup = task({ dims: { userImpact: 0, adminImpact: 0, reliability: 0, productRisk: 0, cleanupValue: 4 } });
  assert.equal(isCleanup(cleanup), true);
  assert.equal(effectiveTaskPriority(cleanup), 'background');     // inferred
  assert.equal(effectiveTaskPriority(task({})), 'medium');
});

// ── rankBacklog band gate ───────────────────────────────────────────────────────
check('rankBacklog: a high-scoring BACKGROUND task never outranks an eligible foreground task', () => {
  const hugeBg = task({ id: 'bg', priority: 'background', dims: { userImpact: 5, adminImpact: 5, reliability: 5, productRisk: 5, cleanupValue: 5 } });
  const smallFg = task({ id: 'fg', priority: 'medium', dims: { userImpact: 1, adminImpact: 0, reliability: 0, productRisk: 0, cleanupValue: 0 } });
  const ranked = rankBacklog([hugeBg, smallFg], CFG);
  assert.equal(ranked[0].task.id, 'fg');            // foreground first despite far lower score
  assert.equal(ranked[1].task.id, 'bg');
});
check('rankBacklog: user tasks still rank ahead of everything (band gate applies to non-user only)', () => {
  const user = task({ id: 'u', userRequested: true, userTaskSeq: 1, priority: 'background' });
  const high = task({ id: 'h', priority: 'high' });
  const ranked = rankBacklog([high, user], CFG);
  assert.equal(ranked[0].task.id, 'u');
});

console.log(`\npriority: ${passed} checks passed.`);
