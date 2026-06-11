// core/reviewer/index.mjs — the generic REVIEW workflow (primary code review).
//
// Runs the `reviewer` role and returns its parsed handoff (`review.json`). Project-agnostic: what gets
// reviewed is described entirely by `vars` (TASK_JSON, IMPL_REPORT, VALIDATION, INTEGRATION_BRANCH,
// HANDOFF_PATH). It has no dependency on RushPoint's callables, Firestore structure, or scoring — the
// host (supervisor.mjs) decides how to act on the verdict (approve / revise / reject).

export const HANDOFF_FILE = 'review.json';

/**
 * @param {{invokeRole:Function, readHandoff:Function}} runner
 * @param {object} vars   prompt template variables
 * @param {string} [model]
 * @returns parsed review handoff (or null)
 */
export async function runReviewer(runner, vars, model) {
  await runner.invokeRole('reviewer', vars, model);
  return runner.readHandoff(HANDOFF_FILE);
}
