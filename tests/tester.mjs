// tests/tester.mjs — verify the Tester phase module is importable and wired correctly

import { describe, it, expect } from '@jest/globals';
import { runTester } from '../core/tester/index.mjs';

describe('Tester phase module', () => {
  it('should export runTester function', () => {
    expect(typeof runTester).toBe('function');
  });

  it('should export HANDOFF_FILE constant', async () => {
    const { HANDOFF_FILE } = await import('../core/tester/index.mjs');
    expect(HANDOFF_FILE).toBe('tester.json');
  });

  it('runTester accepts runner and vars and optional model', async () => {
    const runner = {
      invokeRole: async () => ({ ok: true }),
      readHandoff: async () => ({ testContent: '', testCount: 0 })
    };
    const vars = {
      TASK_JSON: '{}',
      TARGET_FILES: 'foo.js',
      PROJECT_CONTEXT: 'ctx',
      CYCLE_NUM: 1,
      HANDOFF_PATH: 'path/to/tester.json'
    };
    const result = await runTester(runner, vars, 'claude-opus-4-7');
    expect(result).toBeDefined();
  });
});
