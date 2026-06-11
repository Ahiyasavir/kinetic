// token-counter.mjs — pure, stateless per-project token accounting (U-33).
//
// Decoupled from the budget-pacing mechanism (lib/token-pacer.mjs) so the kinetic can run against
// multiple independent projects/workspaces without their token counters cross-contaminating. The
// counter knows NOTHING about budgets or cadence — it only maintains a per-project running total under
// `state.tokenSpent[projectId]`. The pacer reads that total + config to make pacing decisions.
//
// Pure interface: every function takes the current state and returns a NEW state (the input is never
// mutated), so callers thread the result through without hidden side-effects.

/**
 * Add `amount` tokens to a project's running total. Pure: returns a new state with an updated
 * `tokenSpent` map; the input `state` is left untouched.
 * @param {string} projectId  isolated budget namespace (e.g. repo+goal slug)
 * @param {number} amount      tokens consumed (input+output) to add
 * @param {object} state       current state (may omit `tokenSpent`)
 * @returns {object} updated state
 */
export function countTokens(projectId, amount, state = {}) {
  if (!projectId) return state;
  const add = Number(amount) || 0;
  const tokenSpent = { ...(state && state.tokenSpent) };
  tokenSpent[projectId] = (Number(tokenSpent[projectId]) || 0) + add;
  return { ...state, tokenSpent };
}

/** Tokens spent so far by a single project (0 when never counted). */
export function tokensSpent(projectId, state = {}) {
  return Number(state && state.tokenSpent && state.tokenSpent[projectId]) || 0;
}

/** Clear a single project's counter (e.g. on a budget-window reset) without touching the others. */
export function resetProjectTokens(projectId, state = {}) {
  const tokenSpent = { ...(state && state.tokenSpent) };
  delete tokenSpent[projectId];
  return { ...state, tokenSpent };
}
