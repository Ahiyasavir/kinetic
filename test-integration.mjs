// test-integration.mjs — U-66: integration test for the intent/plan/validate flow.
//
// Verifies: (a) writeIntentLocked writes a file + sets intent_locked, (b) validatePlanViaHaiku
// runs deterministically in well under 30s, (c) revisionLoop invokes the validator and returns
// the expected shape, and (d) markIntentLocked updates state correctly from a planResult.
//
// Run: node autopilot/test-integration.mjs
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeIntentLocked, markIntentLocked } from './core/intent-writer.mjs';
import { validatePlanViaHaiku } from './core/plan-validator.mjs';
import { revisionLoop } from './core/revision-handler.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP = path.join(__dirname, 'state', 'handoff', '_test-u66-tmp');
let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    fail++;
  }
}

// ── setup ─────────────────────────────────────────────────────────────────────
await mkdir(TMP, { recursive: true });

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

console.log('\nU-66 integration test: intent/plan/validate flow\n');

// ── 1. writeIntentLocked ──────────────────────────────────────────────────────
await test('writeIntentLocked writes intent-{taskId}.md to handoffDir', async () => {
  const result = await writeIntentLocked(task, TMP);
  assert(result.locked === true, 'locked must be true');
  assert(result.intentPath.endsWith('intent-U-66-test.md'), 'path must include task id');
  assert(existsSync(result.intentPath), 'intent file must exist on disk');
  const content = await readFile(result.intentPath, 'utf8');
  assert(content.includes('U-66-test'), 'content must include task id');
  assert(content.includes('must'), 'content must include "must" section');
});

// ── 2. markIntentLocked ───────────────────────────────────────────────────────
await test('markIntentLocked sets state.intent_locked from planResult', () => {
  const state = {};
  const planResult = { skipped: false, intentPath: path.join(TMP, 'intent-U-66-test.md') };
  const locked = markIntentLocked(state, planResult);
  assert(locked === true, 'markIntentLocked should return true');
  assert(state.intent_locked === true, 'state.intent_locked should be true');
});

await test('markIntentLocked returns false when planResult.skipped', () => {
  const state = {};
  markIntentLocked(state, { skipped: true, intentPath: 'x' });
  assert(state.intent_locked === false, 'intent_locked should be false when skipped');
});

await test('markIntentLocked returns false when planResult is null', () => {
  const state = {};
  markIntentLocked(state, null);
  assert(state.intent_locked === false, 'intent_locked should be false when no planResult');
});

// ── 3. validatePlanViaHaiku (deterministic form, no invoker) ─────────────────
await test('validatePlanViaHaiku (static) returns { valid, feedback } for a concrete plan', async () => {
  const result = await validatePlanViaHaiku(PLAN_VALID, INTENT_MD);
  assert(typeof result.valid === 'boolean', 'valid must be boolean');
  assert(typeof result.feedback === 'string', 'feedback must be string');
});

await test('validatePlanViaHaiku (static) rejects an empty plan', async () => {
  const result = await validatePlanViaHaiku('', INTENT_MD);
  assert(result.valid === false, 'empty plan must be invalid');
  assert(result.feedback.length > 0, 'feedback must explain the failure');
});

await test('validatePlanViaHaiku completes in well under 25s (deterministic, no LLM)', async () => {
  const start = Date.now();
  await validatePlanViaHaiku(PLAN_VALID, INTENT_MD);
  const elapsed = Date.now() - start;
  assert(elapsed < 5000, `validation took ${elapsed}ms — must be < 5000ms without an invoker`);
});

// ── 4. revisionLoop ──────────────────────────────────────────────────────────
await test('revisionLoop with validate fn returns { valid, attempts, feedback }', async () => {
  const result = await revisionLoop(PLAN_VALID, INTENT_MD, {
    maxRetries: 1,
    validate: (p, i) => validatePlanViaHaiku(p, i),
  });
  assert(typeof result.valid === 'boolean', 'valid must be boolean');
  assert(typeof result.attempts === 'number', 'attempts must be number');
  assert(typeof result.feedback === 'string', 'feedback must be string');
});

await test('revisionLoop escalates after maxRetries with no valid plan', async () => {
  // Force a permanent failure by always returning invalid.
  const alwaysFail = async () => ({ valid: false, feedback: 'forced fail', status: 'fail', reason: 'forced fail' });
  const result = await revisionLoop('', INTENT_MD, { maxRetries: 2, validate: alwaysFail });
  assert(result.escalated === true, 'must escalate when retries exhausted');
  assert(result.valid === false, 'must report invalid');
});

await test('revisionLoop with maxRetries=0 escalates immediately', async () => {
  const result = await revisionLoop('', INTENT_MD, { maxRetries: 0 });
  assert(result.escalated === true, 'must escalate immediately with maxRetries=0');
});

// ── cleanup + report ──────────────────────────────────────────────────────────
await rm(TMP, { recursive: true, force: true }).catch(() => {});

console.log(`\nResult: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
