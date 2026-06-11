// verify.mjs — the deterministic, NON-LLM verification gauntlet. Cheap, fast, auditable checks run
// BEFORE (and independently of) any LLM review, so the expensive model is reserved for genuine ambiguity.
// Composes the existing primitives into one verdict:
//   • file existence + import/WIRING ......... evidence.checkEvidence  (a file nothing imports is dead)
//   • typecheck / lint / build ............... the supervisor's runValidation result (passed in)
//   • diff inspection ........................ did product work actually change tracked files?
//   • duplicate detection .................... reconcile.analyzeState (backlog near-dupes)
//   • state reconciliation ................... reconcile (stale done/blocked)  [report only]
//
// CORE PRINCIPLE (enforced here): "PASS typecheck/build/lint" is NECESSARY but NOT SUFFICIENT. A green
// build on a dead/unwired module, or on a product task that changed nothing visible, is NOT done. The
// gauntlet's `ok` therefore requires the evidence + class-appropriate delivery check, not just validation.
//
// What's intentionally left to the LLM: judging acceptance-criteria *intent*, regressions in behavior,
// scope creep, and natural-language synthesis. This module answers only the mechanical, decidable parts.

import { checkEvidence } from './evidence.mjs';
import { classifyTask, reviewPolicy } from './task-class.mjs';
import { analyzeState } from './reconcile.mjs';

// Per-task mechanical verdict. Inputs:
//   task        the task (may declare verifyArtifacts)
//   config      project config (for class/policy)
//   validation  the runValidation result { ok, results?, summary } (optional)
//   hasDiff     boolean — did tracked files change this cycle (optional; product relevance)
//   repoRoot    repo root for evidence resolution
// Returns { ok, llmNeeded, class, checks:[{name, ok, blocking, detail}] }.
export function nonLlmVerify({ task, config = {}, validation = null, hasDiff = null, repoRoot } = {}) {
  const cls = classifyTask(task, config);
  const policy = reviewPolicy(cls, config);
  const checks = [];

  // 1) Validation (typecheck/lint/build) — necessary, not sufficient.
  if (validation) {
    checks.push({ name: 'validation', ok: !!validation.ok, blocking: true, detail: validation.summary || (validation.ok ? 'green' : 'failing') });
  }

  // 2) On-disk evidence: artifacts exist AND are wired. Blocking when the task declares any.
  const ev = checkEvidence(task, repoRoot);
  if (ev.evidence !== 'none') {
    checks.push({ name: 'evidence(file+wiring)', ok: ev.ok, blocking: true, detail: ev.summary });
  } else {
    checks.push({ name: 'evidence(file+wiring)', ok: true, blocking: false, detail: 'no artifacts declared (cannot prove on disk — rely on review)' });
  }

  // 3) Delivery check by class: product must have a tracked diff; engine/maint/migration must NOT be
  //    judged by diff (gitignored) — their delivery proof is the evidence check above.
  if (hasDiff !== null) {
    if (policy.gitDiffRequired) {
      checks.push({ name: 'product-diff', ok: !!hasDiff, blocking: true, detail: hasDiff ? 'tracked files changed' : 'no tracked change — product task delivered nothing' });
    } else {
      checks.push({ name: 'product-diff', ok: true, blocking: false, detail: 'class is gitignored engine/maint/migration — diff not required (expected empty)' });
    }
  }

  const blockingFails = checks.filter((c) => c.blocking && !c.ok);
  const ok = blockingFails.length === 0;
  // The LLM is only needed when the mechanical checks pass (no point reviewing broken work) — its job is
  // the non-mechanical part (intent, regressions, scope). If mechanical checks fail, block deterministically.
  return { ok, llmNeeded: ok, class: cls, checks, blockingFails: blockingFails.map((c) => c.name) };
}

// Repo-level mechanical scan (no task): duplicates + state contradictions + stale done/blocked. Pure
// report — used by the `verify` CLI to audit the whole backlog without spending a single token.
export function nonLlmAudit(state, config, repoRoot) {
  const r = analyzeState(state, config, repoRoot);
  return {
    duplicates: r.duplicates,
    contradictions: r.contradictions,
    staleDone: r.staleDone,
    staleBlocked: r.staleBlocked,
    clean: !r.duplicates.length && !r.contradictions.length && !r.staleDone.length && !r.staleBlocked.length,
  };
}
