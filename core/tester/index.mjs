// core/tester/index.mjs — the generic TEST-GENERATION workflow.
//
// Runs the `tester` role to generate a Jest test suite from the task specification and target files.
// The tester analyzes the task acceptance criteria, implementation hints, and relevant source files
// to produce a comprehensive test file that the implementer must pass before marking the task ready.
// This phase runs immediately after Selector (once a task is chosen) and before Implementer begins,
// establishing a quality gate at specification time rather than post-implementation.

export const HANDOFF_FILE = 'tester.json';

/**
 * @param {{invokeRole:Function, readHandoff:Function}} runner
 * @param {object} vars  prompt template variables (TASK_JSON, TARGET_FILES, HANDOFF_PATH …)
 * @param {string} [model] model override for test generation
 * @returns parsed tester handoff (or null) — includes testFilePath + testContent + cost metadata
 */
export async function runTester(runner, vars, model) {
  await runner.invokeRole('tester', vars, model);
  return runner.readHandoff(HANDOFF_FILE);
}
