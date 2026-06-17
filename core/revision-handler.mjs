// core/revision-handler.mjs — U-66: bounded revision loop for plan validation.
//
// Wraps lib/revisionHandler.mjs's attemptRevision with a clean public signature.
// Advisory only — never blocks a cycle; escalates gracefully after maxRetries exhausted
// and logs failures through handleValidationFailure when a logger is supplied.
//
// Wired: imported + called in supervisor.mjs in the post-runPlanner validation path.
import { attemptRevision, handleValidationFailure } from '../lib/revisionHandler.mjs';

/**
 * Re-try plan validation up to opts.maxRetries times (default 3).
 * The `validate` function (async (plan, intent) => { valid, feedback }) is injected so
 * this stays provider-neutral and testable. An optional `revise` hook can return a patched
 * plan between attempts. Escalates (flags for review) when retries are exhausted.
 *
 * @param {string} plan    the micro-plan text to validate
 * @param {string} intent  the locked intent anchor markdown
 * @param {{ maxRetries?: number, validate?: Function, revise?: Function,
 *           logger?: { error?: Function, info?: Function } }} [opts]
 * @returns {Promise<{ valid: boolean, attempts: number, escalated: boolean,
 *                     flagged: boolean, action: string, feedback: string }>}
 */
export async function revisionLoop(plan, intent, opts = {}) {
  const maxRetries = Number.isFinite(Number(opts.maxRetries)) ? Number(opts.maxRetries) : 3;
  const result = await attemptRevision(plan, intent, {
    maxRetries,
    validate: opts.validate || null,
    revise: opts.revise || null,
  });
  if (!result.valid && opts.logger) {
    await handleValidationFailure(result.lastResult || { valid: false }, opts.logger).catch(() => {});
  }
  return {
    ...result,
    feedback: result.lastResult?.feedback || result.lastResult?.reason || '',
  };
}
