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
 * @param {object} vars    prompt template variables (TASK_JSON, REVISION_BLOCK, HANDOFF_PATH …)
 * @param {string} [model] model chosen by the host's risk/category routing
 * @returns parsed implementation handoff (or null)
 */
export async function runImplementer(runner, vars, model) {
  await runner.invokeRole('implementer', vars, model);
  return runner.readHandoff(HANDOFF_FILE);
}
