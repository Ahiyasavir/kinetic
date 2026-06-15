// revisionHandler.mjs — U-65: handle plan-validation failures without a human in the loop.
//
// When the plan validator rejects a plan, the supervisor needs a bounded, fully-automated recovery
// path: log the failure, re-validate up to a retry cap, and — if the retries are exhausted — escalate
// (flag for manual review) rather than silently proceeding or blocking forever. This module is the
// recovery primitive; it stays advisory (it never blocks a cycle) and runs no interactive prompts.

// Default cap on automated re-validation attempts. Intent U-65: validation must stay fast (< 30s) and
// fully automated, so the loop is small and bounded.
const DEFAULT_MAX_RETRIES = 3;

function toMessages(validationResult) {
  const errs = validationResult && (validationResult.errors || validationResult.violations || validationResult.reason);
  if (!errs) return [];
  const list = Array.isArray(errs) ? errs : [errs];
  return list.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).filter(Boolean);
}

/**
 * Log a plan-validation failure and report the recovery action. Called on every rejection so the
 * cause is recorded even when an automated fix is still pending. Safe with or without a logger.
 *
 * @param {{ valid?:boolean, errors?:Array, violations?:Array, reason?:string }} validationResult
 * @param {{ error?:Function, info?:Function }} [logger]
 * @returns {{ flagged:boolean, manualReviewRequired:boolean, action:string, errors:string[] }}
 */
export async function handleValidationFailure(validationResult, logger) {
  const messages = toMessages(validationResult);
  const summary = messages.join('; ') || 'unknown plan-validation error';
  if (logger && typeof logger.error === 'function') {
    logger.error(`Plan validation failed: ${summary}`);
  } else if (logger && typeof logger.info === 'function') {
    logger.info(`Plan validation failed: ${summary}`);
  }
  return {
    flagged: true,
    manualReviewRequired: true,
    action: 'flagged_for_review',
    errors: messages,
  };
}

/**
 * Re-validate a plan up to `maxRetries` times. A caller-supplied `validate(plan, intent)` is injected
 * so this stays provider-neutral and testable; when no validator is given the loop is a no-op and the
 * call escalates immediately. Optionally a `revise(plan, intent, lastResult)` hook can return a patched
 * plan between attempts. Escalates (flags for manual review) when retries are exhausted.
 *
 * @param {string} plan
 * @param {string} intent
 * @param {{ maxRetries?:number, validate?:Function, revise?:Function }} [opts]
 * @returns {Promise<{ valid:boolean, attempts:number, retriesAttempted:number, escalated:boolean,
 *                     requiresEscalation:boolean, flagged:boolean, action:string, lastResult:* }>}
 */
export async function attemptRevision(plan, intent, opts = {}) {
  const maxRetries = Number.isFinite(Number(opts.maxRetries)) ? Number(opts.maxRetries) : DEFAULT_MAX_RETRIES;
  const validate = typeof opts.validate === 'function' ? opts.validate : null;
  const revise = typeof opts.revise === 'function' ? opts.revise : null;

  let current = plan;
  let attempts = 0;
  let lastResult = null;

  for (let i = 0; i < maxRetries; i++) {
    attempts = i + 1;
    if (!validate) break;
    lastResult = await validate(current, intent);
    const ok = lastResult && (lastResult.valid === true || lastResult.status === 'pass');
    if (ok) {
      return {
        valid: true,
        attempts,
        retriesAttempted: attempts,
        escalated: false,
        requiresEscalation: false,
        flagged: false,
        action: i === 0 ? 'none' : 'auto_fix_successful',
        lastResult,
      };
    }
    if (revise) {
      const revised = await revise(current, intent, lastResult);
      if (typeof revised === 'string' && revised) current = revised;
    }
  }

  // Retries exhausted (or none configured) — escalate for manual review rather than block the cycle.
  return {
    valid: false,
    attempts,
    retriesAttempted: attempts,
    escalated: true,
    requiresEscalation: true,
    flagged: true,
    action: maxRetries === 0 ? 'escalated' : 'flagged_for_review',
    lastResult,
  };
}

export default { handleValidationFailure, attemptRevision };
