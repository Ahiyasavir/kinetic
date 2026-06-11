// core/architect/index.mjs — the generic ARCHITECT workflow (Stage 2).
//
// Runs the `architect` role and returns its parsed handoff (`architect.json`). Like every core role
// this is project-agnostic: it only renders the architect prompt, invokes the model (the PREMIUM tier —
// Fable 5 — resolves via config.models.architect in the runtime), and reads the structured plan back.
// The host (supervisor.mjs via lib/architect.mjs) owns detection of macro-vision prompts and the
// validation/normalization of the returned plan into a dependency-ordered backlog.

export const HANDOFF_FILE = 'architect.json';

/**
 * @param {{invokeRole:Function, readHandoff:Function}} runner  from createRoleRunner()/createCore()
 * @param {object} vars   architect prompt vars (see lib/architect.mjs#buildArchitectVars)
 * @param {string} [model] model override (defaults to config.models.architect → 'premium' tier)
 * @returns parsed architect plan handoff (or null)
 */
export async function runArchitect(runner, vars, model) {
  await runner.invokeRole('architect', vars, model);
  return runner.readHandoff(HANDOFF_FILE);
}
