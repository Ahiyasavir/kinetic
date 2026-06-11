// core/auditor/index.mjs — the generic regression-AUDIT workflow (second, independent consensus gate).
//
// Runs the `auditor` role and returns its parsed handoff (`audit.json`). This is the second reviewer
// that checks specifically for regressions, scope creep, and broken existing behavior — the host merges
// only when both the reviewer AND the auditor agree. Project-agnostic: what gets audited is described
// entirely by `vars` (TASK_JSON, IMPL_REPORT, VALIDATION, INTEGRATION_BRANCH, HANDOFF_PATH). The host
// (supervisor.mjs) owns the veto-on-objection merge policy; this module only runs the role.

export const HANDOFF_FILE = 'audit.json';

/**
 * @param {{invokeRole:Function, readHandoff:Function}} runner
 * @param {object} vars   prompt template variables
 * @param {string} [model]
 * @returns parsed audit handoff (or null)
 */
export async function runAuditor(runner, vars, model) {
  await runner.invokeRole('auditor', vars, model);
  return runner.readHandoff(HANDOFF_FILE);
}
