// token-budget.mjs — integration assertions for the decoupled token counter + budget pacer (U-33).
// Verifies two concurrent projects can exhaust independent token budgets WITHOUT interfering with each
// other (one going over budget never throttles the other).
//   node autopilot/tests/token-budget.mjs
import assert from 'node:assert/strict';
import { countTokens, tokensSpent, resetProjectTokens } from '../lib/token-counter.mjs';
import { isWithinBudget, budgetTokenCap, projectBudget } from '../lib/token-pacer.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// Two concurrent projects, each with its own independent budget.
const config = {
  budgets: {
    'proj-a': { maxTokensPerCycle: 1000, maxSpendPerEvent: 10 },
    'proj-b': { maxTokensPerCycle: 5000, maxSpendPerEvent: 50 }
  }
};

// 1) The counter is pure — it returns a NEW state and never mutates the input.
check('countTokens is pure (input state untouched)', () => {
  const before = { tokenSpent: { 'proj-a': 100 } };
  const after = countTokens('proj-a', 50, before);
  assert.equal(before.tokenSpent['proj-a'], 100, 'input must not mutate');
  assert.equal(after.tokenSpent['proj-a'], 150);
  assert.notStrictEqual(before, after);
});

// 2) Spending on one project does not touch another project's counter.
check('per-project counters are isolated', () => {
  let state = {};
  state = countTokens('proj-a', 300, state);
  state = countTokens('proj-b', 999, state);
  state = countTokens('proj-a', 200, state);
  assert.equal(tokensSpent('proj-a', state), 500);
  assert.equal(tokensSpent('proj-b', state), 999);
});

// 3) Two projects exhaust their OWN budgets independently — no cross-contamination.
check('concurrent projects exhaust independent budgets without interference', () => {
  let state = {};
  // proj-a burns past its 1000 cap; proj-b stays well under its 5000 cap.
  state = countTokens('proj-a', 1200, state);
  state = countTokens('proj-b', 400, state);
  assert.equal(isWithinBudget('proj-a', config, state), false, 'proj-a is over its budget');
  assert.equal(isWithinBudget('proj-b', config, state), true, 'proj-b is unaffected by proj-a');

  // Now proj-b crosses its own (larger) cap; proj-a recovering tokens must not rescue/affect it.
  state = countTokens('proj-b', 5000, state);
  assert.equal(isWithinBudget('proj-b', config, state), false, 'proj-b now over its own budget');
  assert.equal(tokensSpent('proj-a', state), 1200, 'proj-a counter unchanged by proj-b spend');
});

// 4) A project with no configured budget is unconstrained (cadence-only pacing preserved).
check('unconfigured project is always within budget', () => {
  const state = countTokens('proj-unknown', 9e9, {});
  assert.equal(isWithinBudget('proj-unknown', config, state), true);
  assert.equal(budgetTokenCap(projectBudget('proj-unknown', config)), Infinity);
});

// 5) Resetting one project's counter leaves the others intact.
check('resetProjectTokens isolates the reset', () => {
  let state = {};
  state = countTokens('proj-a', 500, state);
  state = countTokens('proj-b', 700, state);
  state = resetProjectTokens('proj-a', state);
  assert.equal(tokensSpent('proj-a', state), 0);
  assert.equal(tokensSpent('proj-b', state), 700);
});

console.log(`\ntoken-budget: ${passed} assertion group(s) passed.`);
