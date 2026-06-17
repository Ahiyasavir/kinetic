// core/plan-validator.mjs — U-66: plan validation with < 30s timeout guard.
//
// Wraps lib/planValidator.mjs for the core layer. Supports both LLM (Haiku) and
// deterministic modes — dispatch is based on whether an invoker is provided.
// Always returns { valid: boolean, feedback: string }.
//
// Wired: imported + called in supervisor.mjs after the runPlanner() planning gate.
import { validatePlan } from '../lib/planValidator.mjs';

// Hard timeout: 25s to leave 5s headroom under the 30s SLA.
const HAIKU_TIMEOUT_MS = 25_000;

/**
 * Validate `plan` against `intent`. When `invoker` (async (prompt, model) => string) is
 * provided, calls the Haiku model with a hard < 30s timeout. Without an invoker, falls back
 * to the deterministic structural check (synchronous; always fast).
 *
 * @param {string} plan    the micro-plan text to validate
 * @param {string} intent  the locked intent anchor markdown
 * @param {Function} [invoker] async model invoker (optional)
 * @param {string} [model] model id (default: claude-haiku-4-5)
 * @returns {Promise<{ valid: boolean, feedback: string }>}
 */
export async function validatePlanViaHaiku(plan, intent, invoker, model = 'claude-haiku-4-5') {
  let result;
  if (typeof invoker === 'function') {
    // LLM form — enforce a hard timeout so the gate never stalls.
    result = await Promise.race([
      validatePlan(intent, plan, invoker, model),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('validatePlanViaHaiku: timed out (>25s)')),
          HAIKU_TIMEOUT_MS,
        )),
    ]);
    // LLM result shape: { verdict: 'APPROVE'|'REJECT', reason }
    if (result && typeof result.verdict === 'string') {
      return { valid: result.verdict === 'APPROVE', feedback: result.reason || '' };
    }
  } else {
    // Deterministic form — no invoker, no network, always well within the 30s SLA.
    result = await validatePlan(plan, intent);
  }
  const valid = !!(result && (result.valid === true || result.status === 'pass'));
  return { valid, feedback: result?.reason || result?.feedback || '' };
}
