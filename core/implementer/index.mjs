// core/implementer/index.mjs — the generic IMPLEMENT workflow.
//
// Runs the `implementer` role and returns its parsed handoff (`implementation.json`). The actual code
// edits, file paths, and validation commands are project-specific and live OUTSIDE core: the host
// (supervisor.mjs) supplies the task spec + revision feedback through `vars`, picks the implementer
// model, and runs deterministic validation/git after this returns. The core only invokes the role and
// reads its report, so the same workflow drives any project's implementer.

export const HANDOFF_FILE = 'implementation.json';

/**
 * @param {{invokeRole:Function, readHandoff:Function}} runner
 * @param {object} vars    prompt template variables. Beyond the task spec (TASK_JSON, REVISION_BLOCK,
 *                         HANDOFF_PATH …) the strict-TDD Green phase supplies:
 *                           • TEST_FILE_CONTENT   — exact content of the failing test to satisfy
 *                           • TEST_EXECUTION_ERROR — pre-rendered stack-trace block from the last test
 *                             run on a revision (empty on the first attempt / when the last run passed).
 *                         Both are plain strings forwarded verbatim into the prompt — no logic here.
 * @param {string} [model] model chosen by the host's risk/category routing
 * @returns parsed implementation handoff (or null)
 */
export async function runImplementer(runner, vars, model) {
  await runner.invokeRole('implementer', vars, model);
  return runner.readHandoff(HANDOFF_FILE);
}
