// plugins/example-scorer/index.mjs — example custom-scoring plugin (U-44).
//
// Demonstrates the scoreTask plugin interface documented in autopilot/docs/INTEGRATION.md §3c.
// To use in your project:
//   1. Copy this file (or write your own) to autopilot/plugins/my-scorer/index.mjs
//   2. Add "scoring": { "plugin": "plugins/my-scorer/index.mjs" } to commercial/config.json
//   3. Import your scoreTask and call it in place of the built-in lib/score.mjs#scoreTask
//      (or submit a plugin-loader PR to wire it automatically — see INTEGRATION.md §3c)

/**
 * Custom task scorer — returns a plain numeric score (higher = selected sooner).
 *
 * This example applies a heavier userImpact weight than the built-in lib/score.mjs
 * to prioritise player-visible features above all other task categories.
 *
 * @param {object} task   — raw task object from state.json (has .dims, .goal, .userRequested, …)
 * @param {object} _state — current engine state (unused in this example; reserved for future use)
 * @param {object} _cfg   — resolved engine config (unused here; use for weight overrides if needed)
 * @returns {number} — numeric score; higher scores are selected first
 */
export function scoreTask(task, _state, _cfg) {
  const d = task.dims || {};
  const clamp = (n) => Math.max(0, Math.min(5, Number(n) || 0));
  // USER-REQUESTED override: anything dropped via inbox/ outranks all auto-generated tasks.
  const userBoost = task.userRequested ? 100000 : 0;
  // Heavier userImpact weight (10 vs the default 5) — customise per project.
  return (
    clamp(d.userImpact)   * 10 +
    clamp(d.adminImpact)  * 3  +
    clamp(d.reliability)  * 3  +
    clamp(d.productRisk)  * 2  +
    clamp(d.cleanupValue) * 1  +
    userBoost
  );
}

/** Plugin metadata consumed by the engine's plugin registry. */
export const pluginMeta = {
  id:          'example-scorer',
  type:        'scorer',
  description: 'Example custom-scoring plugin — heavier userImpact weight than the built-in scorer.',
  configKey:   'scoring.plugin',
};
