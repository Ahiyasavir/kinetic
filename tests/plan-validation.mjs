// plan-validation.mjs — U-66: integration tests for the intent/plan/validate flow.
// Run: node --test autopilot/tests/plan-validation.mjs
// MARKER: plan-validation tests — 10 tests

import { test } from 'node:test';
import assert from 'node:assert';
import { writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeIntentLocked, markIntentLocked } from '../core/intent-writer.mjs';
import { validatePlanViaHaiku } from '../core/plan-validator.mjs';
import { revisionLoop } from '../core/revision-handler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(__dirname, '..', 'state', 'handoff', '_test-u66-plan-validation-tmp');

const task = {
  id: 'U-66-test',
  title: 'test intent/plan validation',
  acceptanceCriteria: ['writeIntentLocked creates a file', 'validatePlanViaHaiku returns { valid, feedback }'],
  intent: {
    must: ['intent.md written and locked by Selector immediately after task selection'],
    mustNot: ['Do not modify task selection scoring'],
    successSignal: 'cycle completes with plan_validated=true in history',
  },
};

const PLAN_VALID = `
- core/intent-writer.mjs — create and export writeIntentLocked(task, intent)
- core/plan-validator.mjs — create and export validatePlanViaHaiku(plan, intent, task)
- supervisor.mjs — insert intent-writer call after Selector phase
`.trim();

const INTENT_MD = `# Intent anchor — U-66-test
> Locked at selection.

## must
- intent.md written and locked by Selector immediately after task selection

## mustNot
- Do not modify task selection scoring

## successSignal
cycle completes with plan_validated=true in history
`;

test('setup: create tmp dir', async () => {
  await mkdir(TMP, { recursive: true });
});

// ── 1. writeIntentLocked ──────────────────────────────────────────────────────
test('writeIntentLocked writes intent-{taskId}.md to handoffDir', async () => {
  const result = await writeIntentLocked(task, TMP);
  assert.strictEqual(result.locked, true, 'locked must be true');
  assert.ok(result.intentPath.endsWith('intent-U-66-test.md'), 'path must include task id');
  assert.ok(existsSync(result.intentPath), 'intent file must exist on disk');
  const content = await readFile(result.intentPath, 'utf8');
  assert.ok(content.includes('U-66-test'), 'content must include task id');
  assert.ok(content.includes('must'), 'content must include "must" section');
});

// ── 2. markIntentLocked ───────────────────────────────────────────────────────
test('markIntentLocked sets state.intent_locked from planResult', () => {
  const state = {};
  const planResult = { skipped: false, intentPath: path.join(TMP, 'intent-U-66-test.md') };
  const locked = markIntentLocked(state, planResult);
  assert.strictEqual(locked, true, 'markIntentLocked should return true');
  assert.strictEqual(state.intent_locked, true, 'state.intent_locked should be true');
});

test('markIntentLocked returns false when planResult.skipped', () => {
  const state = {};
  markIntentLocked(state, { skipped: true, intentPath: 'x' });
  assert.strictEqual(state.intent_locked, false, 'intent_locked should be false when skipped');
});

test('markIntentLocked returns false when planResult is null', () => {
  const state = {};
  markIntentLocked(state, null);
  assert.strictEqual(state.intent_locked, false, 'intent_locked should be false when no planResult');
});

// ── 3. validatePlanViaHaiku (deterministic form, no invoker) ─────────────────
test('validatePlanViaHaiku (static) returns { valid, feedback } for a concrete plan', async () => {
  const result = await validatePlanViaHaiku(PLAN_VALID, INTENT_MD);
  assert.strictEqual(typeof result.valid, 'boolean', 'valid must be boolean');
  assert.strictEqual(typeof result.feedback, 'string', 'feedback must be string');
});

test('validatePlanViaHaiku (static) rejects an empty plan', async () => {
  const result = await validatePlanViaHaiku('', INTENT_MD);
  assert.strictEqual(result.valid, false, 'empty plan must be invalid');
  assert.ok(result.feedback.length > 0, 'feedback must explain the failure');
});

test('validatePlanViaHaiku completes in well under 25s (deterministic, no LLM)', async () => {
  const start = Date.now();
  await validatePlanViaHaiku(PLAN_VALID, INTENT_MD);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 5000, `validation took ${elapsed}ms — must be < 5000ms without an invoker`);
});

// ── 4. revisionLoop ──────────────────────────────────────────────────────────
test('revisionLoop with validate fn returns { valid, attempts, feedback }', async () => {
  const result = await revisionLoop(PLAN_VALID, INTENT_MD, {
    maxRetries: 1,
    validate: (p, i) => validatePlanViaHaiku(p, i),
  });
  assert.strictEqual(typeof result.valid, 'boolean', 'valid must be boolean');
  assert.strictEqual(typeof result.attempts, 'number', 'attempts must be number');
  assert.strictEqual(typeof result.feedback, 'string', 'feedback must be string');
});

test('revisionLoop escalates after maxRetries with no valid plan', async () => {
  const alwaysFail = async () => ({ valid: false, feedback: 'forced fail', status: 'fail', reason: 'forced fail' });
  const result = await revisionLoop('', INTENT_MD, { maxRetries: 2, validate: alwaysFail });
  assert.strictEqual(result.escalated, true, 'must escalate when retries exhausted');
  assert.strictEqual(result.valid, false, 'must report invalid');
});

test('revisionLoop with maxRetries=0 escalates immediately', async () => {
  const result = await revisionLoop('', INTENT_MD, { maxRetries: 0 });
  assert.strictEqual(result.escalated, true, 'must escalate immediately with maxRetries=0');
});

test('cleanup: remove tmp dir', async () => {
  await rm(TMP, { recursive: true, force: true }).catch(() => {});
});
