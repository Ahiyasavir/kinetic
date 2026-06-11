// reliability.mjs — assertions for the reliability-hardening change set:
//   • task-class.mjs  — class taxonomy + per-class review policy
//   • evidence.mjs    — on-disk artifact + wiring checks (truthful completion)
//   • reconcile.mjs   — disk-as-truth reconciliation (demote stale-done, unblock deadlock victims)
//   • circuit-breaker — regression (still trips)
//   • protect.frozenProtectedFiles — structural-block guard input
//   • prompts render with no unsubstituted {{placeholders}}
//   node autopilot/tests/reliability.mjs
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
// Absolute paths derived from this file's location so tests work regardless of CWD.
const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const KINETIC_DIR = path.resolve(TESTS_DIR, '..');
const REPO_ROOT = path.resolve(KINETIC_DIR, '..');
import { classifyTask, reviewPolicy, selectionPolicy } from '../lib/task-class.mjs';
import { checkEvidence, hasStructuredArtifacts } from '../lib/evidence.mjs';
import { analyzeState, applyReconciliation } from '../lib/reconcile.mjs';
import { recordCycleOutcome } from '../lib/circuit-breaker.mjs';
import { frozenProtectedFiles } from '../lib/protect.mjs';
import { renderPrompt } from '../core/runtime.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const acheck = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

// ── task classification ───────────────────────────────────────────────────
check('engine task classified engine + product gate OFF (the deadlock fix)', () => {
  const t = { goal: 'structure', title: 'architecture: abstract paths', risk: 3 };
  assert.equal(classifyTask(t, {}), 'engine');
  const p = reviewPolicy('engine', {});
  assert.equal(p.productGate, false);
  assert.equal(p.gitDiffRequired, false);
  assert.equal(selectionPolicy('engine', {}).requiresProductDiff, false);
});
check('product task keeps the strict product gate', () => {
  assert.equal(classifyTask({ goal: 'product', title: 'product: screen' }, {}), 'product');
  const p = reviewPolicy('product', {});
  assert.ok(p.productGate && p.gitDiffRequired);
});
check('title prefix beats ambiguous goal (user/structure → real class)', () => {
  assert.equal(classifyTask({ goal: 'user', title: 'chore: scrub logs' }, {}), 'maintenance');
  assert.equal(classifyTask({ goal: 'user', title: 'migration: move schema v2' }, {}), 'migration');
});
check('unknown task defaults to product (never silently relax the gate)', () => {
  assert.equal(classifyTask({ goal: 'mystery', title: 'do a thing' }, {}), 'product');
});
check('config can override the class map', () => {
  assert.equal(classifyTask({ goal: 'reliability', title: 'x' }, { taskClasses: { map: { reliability: 'engine' } } }), 'engine');
});

// ── evidence (truthful completion) ────────────────────────────────────────
check('wired module → evidence present', () => {
  const e = checkEvidence({ verifyArtifacts: [{ path: 'autopilot/lib/circuit-breaker.mjs', wired: true }] });
  assert.equal(e.ok, true);
});
check('dead file (imported by nothing) → evidence incomplete (rejects false-done)', () => {
  // Use absolute path for fs ops; the artifact path is relative to REPO_ROOT (evidence default).
  const abs = path.join(KINETIC_DIR, 'lib', '__dead_test.mjs');
  writeFileSync(abs, 'export const x = 1;\n');
  const e = checkEvidence({ verifyArtifacts: [{ path: 'autopilot/lib/__dead_test.mjs', wired: true }] });
  rmSync(abs);
  assert.equal(e.ok, false);
  assert.ok(e.unwired.length === 1);
});
check('missing module → evidence incomplete', () => {
  const e = checkEvidence({ verifyArtifacts: [{ path: 'autopilot/lib/nope.mjs' }] });
  assert.equal(e.ok, false);
  assert.ok(e.missing.length === 1);
});
check('free-text verifiedArtifact does NOT count as structured (no destructive demote)', () => {
  assert.equal(hasStructuredArtifacts({ verifiedArtifact: 'lib/foo.mjs' }), false);
  assert.equal(hasStructuredArtifacts({ verifyArtifacts: [{ path: 'x' }] }), true);
});

// ── reconciliation (disk as source of truth) ──────────────────────────────
check('reconcile demotes structured stale-done; unblocks structural deadlock victim (not done)', () => {
  const state = {
    cycle: 1,
    current: null,
    queues: {
      backlog: [],
      done: [{ id: 'D1', title: 'd', verifyArtifacts: [{ path: 'autopilot/lib/nope.mjs' }] }],
      blocked: [{ id: 'B1', goal: 'architecture', title: 'architecture: x',
        blockReason: 'PRODUCT DELIVERY GATE FAIL: no player-visible change',
        verifyArtifacts: [{ path: 'autopilot/lib/circuit-breaker.mjs', wired: true }] }],
    },
  };
  const r = analyzeState(state, {}, REPO_ROOT);
  assert.deepEqual(r.staleDone.map((x) => x.id), ['D1']);
  assert.deepEqual(r.staleBlocked.map((x) => x.id), ['B1']);
  applyReconciliation(state, r, { stampCycle: 1 });
  assert.ok(state.queues.blocked.some((t) => t.id === 'D1'));      // D1 demoted to blocked
  assert.ok(state.queues.backlog.some((t) => t.id === 'B1'));      // B1 unblocked for re-review
  assert.ok(!state.queues.done.some((t) => t.id === 'B1'));        // but NOT auto-marked done
  assert.equal(state.queues.backlog.find((t) => t.id === 'B1').needsReReview, true);
});
check('reconcile ignores legacy free-text done tasks (no false demotion)', () => {
  const state = { cycle: 1, current: null, queues: { backlog: [], blocked: [],
    done: [{ id: 'L1', title: 'l', verifiedArtifact: 'core/{a,b}/index.mjs' }] } };
  const r = analyzeState(state, {}, '.');
  assert.equal(r.staleDone.length, 0);
});

// ── circuit breaker regression ────────────────────────────────────────────
check('circuit breaker still trips on consecutive crashes', () => {
  let st = {}, r;
  for (let i = 0; i < 3; i++) r = recordCycleOutcome(st, { circuitBreaker: { enabled: true, maxConsecutiveFailures: 3 } }, 'crash');
  assert.equal(r.tripped, true);
});

// ── structural-block guard input ──────────────────────────────────────────
check('frozenProtectedFiles empty once core/.ready lifts the freeze (no false structural blocks)', () => {
  assert.equal(frozenProtectedFiles().length, 0);
});

// ── prompts render with all placeholders supplied ─────────────────────────
await acheck('reviewer/implementer/auditor render with no {{placeholder}} leaks', async () => {
  const dir = path.join(KINETIC_DIR, 'prompts');
  const sets = {
    reviewer: { TASK_JSON: '{}', TASK_CLASS: 'engine', REVIEW_POLICY: '{}', EVIDENCE: 'ok', IMPL_REPORT: '{}', VALIDATION: 'ok', INTEGRATION_BRANCH: 'b', HANDOFF_PATH: 'h' },
    implementer: { TASK_JSON: '{}', TASK_CLASS: 'engine', CYCLE_BRANCH: 'b', REVISION_BLOCK: '', CONTEXT_HINT: '', PROFILE_RULES: '', HANDOFF_PATH: 'h' },
    auditor: { TASK_JSON: '{}', TASK_CLASS: 'engine', EVIDENCE: 'ok', IMPL_REPORT: '{}', VALIDATION: 'ok', INTEGRATION_BRANCH: 'b', HANDOFF_PATH: 'h' },
  };
  for (const [name, vars] of Object.entries(sets)) {
    const out = await renderPrompt(dir, name, vars);
    assert.equal(out.match(/\{\{[A-Z_]+\}\}/g), null, `${name} has unsubstituted placeholders`);
  }
});

console.log(`\nreliability: ${passed}/${passed} checks passed ✓`);
