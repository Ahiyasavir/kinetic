// core/index.mjs — public entry-point for the kinetic CORE engine.
//
// The core packages the four generic agent workflows (selector / implementer / reviewer / auditor) and
// the role-invocation runtime that drives them. It is intentionally free of any host-project specifics
// (no RushPoint paths, Firestore, scoring, validation, or git) — a host wires those in once via
// createCore({...}) and gets back a ready-to-use set of role workflows.
//
// Typical host usage (see ./README.md for a full example):
//   import { createCore } from './core/index.mjs';
//   const core = createCore({ promptDir, handoffDir, cwd, config, runClaude, onUsage, log });
//   const selection = await core.runSelector(selectorVars);
//   const impl      = await core.runImplementer(implVars, model);
//   const review    = await core.runReviewer(reviewVars);
//   const audit     = await core.runAuditor(auditVars);

import { createRoleRunner } from './runtime.mjs';
import { runSelector } from './selector/index.mjs';
import { runTester } from './tester/index.mjs';
import { runImplementer } from './implementer/index.mjs';
import { runReviewer } from './reviewer/index.mjs';
import { runAuditor } from './auditor/index.mjs';
import { runArchitect } from './architect/index.mjs';

/**
 * Wire a host context into the core engine and return the bound role workflows + low-level helpers.
 * The context is forwarded verbatim to createRoleRunner() — see runtime.mjs for the field contract.
 */
export function createCore(ctx) {
  const runner = createRoleRunner(ctx);
  return {
    // low-level role runner + handoff helpers (bound to the host's handoff dir)
    invokeRole: runner.invokeRole,
    readHandoff: runner.readHandoff,
    clearHandoff: runner.clearHandoff,
    // high-level workflows: invoke a role and return its parsed handoff
    runSelector: (vars, model, opts) => runSelector(runner, vars, model, opts),
    runTester: (vars, model) => runTester(runner, vars, model),
    runImplementer: (vars, model) => runImplementer(runner, vars, model),
    runReviewer: (vars, model) => runReviewer(runner, vars, model),
    runAuditor: (vars, model) => runAuditor(runner, vars, model),
    // Stage-2 Architect Mode: decompose a macro-vision prompt with the premium (Fable 5) tier.
    runArchitect: (vars, model) => runArchitect(runner, vars, model),
  };
}

export { createRoleRunner, renderPrompt, extractJsonObject, readHandoff, clearHandoff } from './runtime.mjs';
export { runSelector } from './selector/index.mjs';
export { runTester } from './tester/index.mjs';
export { runImplementer } from './implementer/index.mjs';
export { runReviewer } from './reviewer/index.mjs';
export { runAuditor } from './auditor/index.mjs';
export { runArchitect } from './architect/index.mjs';
// Re-export shared universal type constants so consumers get them via the core entry-point.
export { TASK_CLASS, PROVIDER_TYPE } from '../shared/types.mjs';
// Project-agnostic config loader: normalizes legacy flat keys → engine/project shape + schema validation.
export {
  loadConfig,
  normalizeConfig,
  validateEngineConfig,
  DEFAULT_ENGINE_CONFIG,
  DEFAULT_PROJECT_CONFIG,
} from './config.mjs';
