// planning-gate.mjs — U-83 + U-71 coverage.
// Run: node --test autopilot/tests/planning-gate.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runPlanner } from '../lib/planner.mjs';
import { shouldRunBlockedReview } from '../agents/blocked-reviewer.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function tmp() { return mkdtempSync(path.join(tmpdir(), 'plan-gate-')); }

test('U-83: intent anchor is always written with the three locked sections', async () => {
  const dir = tmp();
  const task = {
    id: 'T-1', title: 'add foo', risk: 1,
    acceptanceCriteria: ['foo exists'],
    intent: { must: ['foo exists', 'foo wired'], mustNot: ['no src/'], successSignal: 'import works' },
  };
  const r = await runPlanner(task, dir, { planningGate: { enabled: true, minRisk: 3 } }, async () => '', () => {});
  assert.ok(existsSync(r.intentPath), 'intent.md written');
  const txt = readFileSync(r.intentPath, 'utf8');
  assert.match(txt, /## must/);
  assert.match(txt, /## mustNot/);
  assert.match(txt, /## successSignal/);
  rmSync(dir, { recursive: true, force: true });
});

test('U-83: enabled:false is a full no-op (a cycle can still complete)', async () => {
  const dir = tmp();
  const r = await runPlanner({ id: 'T-2', title: 'x', risk: 5 }, dir, { planningGate: { enabled: false } }, async () => '', () => {});
  assert.strictEqual(r.skipped, true);
  assert.strictEqual(r.intentPath, null);
  assert.strictEqual(r.planPath, null);
  rmSync(dir, { recursive: true, force: true });
});

test('U-83: risk < minRisk writes the intent but skips the micro-plan', async () => {
  const dir = tmp();
  let invoked = 0;
  const r = await runPlanner({ id: 'T-3', title: 'tiny', risk: 1, acceptanceCriteria: ['x'] },
    dir, { planningGate: { enabled: true, minRisk: 3 } }, async () => { invoked++; return ''; }, () => {});
  assert.ok(existsSync(r.intentPath), 'intent still written');
  assert.strictEqual(r.planPath, null, 'no plan for low risk');
  assert.strictEqual(invoked, 0, 'no LLM call for low risk');
  rmSync(dir, { recursive: true, force: true });
});

test('U-83: risk >= minRisk drafts + Haiku-validates the plan (APPROVE)', async () => {
  const dir = tmp();
  const logs = [];
  const invoker = async (prompt) =>
    prompt.includes('Does the plan')
      ? '{ "verdict": "APPROVE", "reason": "ok" }'
      : '- lib/foo.mjs — create runFoo()';
  const r = await runPlanner({ id: 'T-4', title: 'add foo', risk: 4, acceptanceCriteria: ['foo'] },
    dir, { planningGate: { enabled: true, minRisk: 3, model: 'm' } }, invoker, (m) => logs.push(m));
  assert.ok(existsSync(r.planPath), 'plan.md written');
  assert.strictEqual(r.planApproved, true);
  assert.ok(logs.some((l) => /Haiku validation/.test(l)), 'validation call logged');
  rmSync(dir, { recursive: true, force: true });
});

test('U-83: REJECT triggers one revision then proceeds anyway (never blocks)', async () => {
  const dir = tmp();
  let validateCalls = 0;
  const invoker = async (prompt) => {
    if (prompt.includes('Does the plan')) {
      validateCalls++;
      return '{ "verdict": "REJECT", "reason": "missing wiring" }';
    }
    return '- lib/foo.mjs — create runFoo()';
  };
  const r = await runPlanner({ id: 'T-5', title: 'add foo', risk: 5, acceptanceCriteria: ['foo'] },
    dir, { planningGate: { enabled: true, minRisk: 3 } }, invoker, () => {});
  assert.strictEqual(validateCalls, 2, 'validated twice (initial + after one revise)');
  assert.strictEqual(r.planApproved, false, 'still rejected, but did not throw');
  assert.ok(existsSync(r.planPath), 'plan written regardless');
  rmSync(dir, { recursive: true, force: true });
});

test('U-83: static evidence marker present in planner source', () => {
  const src = readFileSync(path.join(__dirname, '..', 'lib', 'planner.mjs'), 'utf8');
  assert.ok(src.includes('// planning gate: intent anchor written'), 'marker present');
});

test('U-71: shouldRunBlockedReview gates on interval, blocked count, and enabled flag', () => {
  const blocked = (n) => ({ cycle: n, queues: { blocked: [{ id: 'B-1' }] } });
  // Fires only on the interval boundary
  assert.strictEqual(shouldRunBlockedReview(blocked(10), { blockedReview: { intervalCycles: 10 } }), true);
  assert.strictEqual(shouldRunBlockedReview(blocked(11), { blockedReview: { intervalCycles: 10 } }), false);
  // No blocked tasks → never runs
  assert.strictEqual(shouldRunBlockedReview({ cycle: 10, queues: { blocked: [] } }, {}), false);
  // Disabled → never runs
  assert.strictEqual(shouldRunBlockedReview(blocked(10), { blockedReview: { enabled: false } }), false);
});
