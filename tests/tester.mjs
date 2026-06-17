// tests/tester.mjs — verify the Tester phase module is importable and wired correctly.
// Uses node:test (the engine's test runner) — NOT @jest/globals, which is not a dependency.
// Static evidence marker: tester-test-suite-v2

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runTester,
  HANDOFF_FILE,
  detectTestRunner,
  buildRunnerContext,
} from '../core/tester/index.mjs';

test('exports runTester function', () => {
  assert.equal(typeof runTester, 'function');
});

test('exports HANDOFF_FILE = tester.json', () => {
  assert.equal(HANDOFF_FILE, 'tester.json');
});

test('runTester invokes the tester role and returns the parsed handoff', async () => {
  let invokedRole = null;
  const runner = {
    invokeRole: async (role) => {
      invokedRole = role;
      return { ok: true };
    },
    readHandoff: async () => ({ testContent: '', testCount: 0 }),
  };
  const vars = {
    TASK_JSON: '{}',
    TARGET_FILES: 'foo.js',
    PROJECT_CONTEXT: 'ctx',
    CYCLE_NUM: 1,
    HANDOFF_PATH: 'path/to/tester.json',
  };
  const result = await runTester(runner, vars, 'claude-opus-4-7');
  assert.equal(invokedRole, 'tester', 'should invoke the tester role');
  assert.deepEqual(result, { testContent: '', testCount: 0 });
});

test('runTester auto-injects RUNNER_CONTEXT when absent', async () => {
  let passedVars = null;
  const runner = {
    invokeRole: async (_role, vars) => {
      passedVars = vars;
      return { ok: true };
    },
    readHandoff: async () => ({}),
  };
  // No REPO_ROOT → defaults to the native node:test runner context.
  await runTester(runner, { TASK_JSON: '{}' });
  assert.ok(passedVars.RUNNER_CONTEXT, 'RUNNER_CONTEXT should be injected');
  assert.match(passedVars.RUNNER_CONTEXT, /node:test/, 'default runner is node:test');
});

test('detectTestRunner: no package.json → node:test fallback', () => {
  const info = detectTestRunner('/path/that/does/not/exist');
  assert.equal(info.runner, 'node');
  assert.equal(info.command, 'node --test');
});

test('buildRunnerContext renders a framework-correct block per runner', () => {
  assert.match(buildRunnerContext({ runner: 'vitest', command: 'npx vitest run' }), /vitest/);
  assert.match(buildRunnerContext({ runner: 'jest', command: 'npm test' }), /@jest\/globals/);
  assert.match(buildRunnerContext({ runner: 'node', command: 'node --test' }), /node:test/);
});
