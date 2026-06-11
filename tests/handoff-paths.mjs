// handoff-paths.mjs — assertions for context-aware handoff file naming (U-34). Verifies two project
// contexts resolve DISTINCT handoff filenames (no collision), the mapping is deterministic + idempotent,
// and the legacy generic basenames survive when no context is derivable (backward compatible).
//   node autopilot/tests/handoff-paths.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveContextId, contextualName, resolveHandoffPath } from '../lib/handoff-paths.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

const ROLES = ['selection.json', 'implementation.json', 'review.json', 'audit.json'];

// 1) An explicit config.handoff.context drives the contextId (deterministically derived from config).
check('contextId comes from config.handoff.context when set', () => {
  assert.equal(resolveContextId({ handoff: { context: 'Proj A' } }), 'proj-a'); // slugified
  assert.equal(resolveContextId({ projectIdentifier: 'Other_Project' }), 'other-project'); // legacy alias
});

// 2) Falls back to the repo+goal slug (same identity as locks/budgets) when no explicit context.
check('contextId falls back to repo+goal slug', () => {
  const cfg = { git: { integrationBranch: 'autopilot/topo' } };
  // repoGoal = <repo dir>-topo; we only assert it ends with the goal segment and is non-empty.
  const id = resolveContextId(cfg);
  assert.ok(id.endsWith('-topo'), `expected repo+goal slug ending in -topo, got "${id}"`);
});

// 3) The tag is inserted before the extension for every role file.
check('contextualName tags before the extension', () => {
  assert.equal(contextualName('selection.json', 'ctx'), 'selection-ctx.json');
  assert.equal(contextualName('implementation.json', 'ctx'), 'implementation-ctx.json');
});

// 4) Two different contexts NEVER produce the same filename — the whole point (collision-free).
check('distinct contexts yield distinct filenames for every role', () => {
  for (const f of ROLES) {
    const a = contextualName(f, 'proj-a');
    const b = contextualName(f, 'proj-b');
    assert.notEqual(a, b, `${f} collided across contexts`);
  }
});

// 5) Idempotent — re-tagging an already-tagged name does not double-append the context.
check('contextualName is idempotent', () => {
  const once = contextualName('audit.json', 'ctx');
  assert.equal(contextualName(once, 'ctx'), once);
});

// 6) Backward compatible — an empty context passes the generic basename through unchanged (the no-op
//    fallback used when no context is derivable). resolveContextId itself always yields at least the
//    repo-directory slug, so the empty path is exercised via an explicit empty context here.
check('empty context preserves the legacy generic basename', () => {
  for (const f of ROLES) assert.equal(contextualName(f, ''), f);
});

// 7) resolveHandoffPath(context, filename) returns the absolute, tagged path under the given dir.
check('resolveHandoffPath joins dir + tagged basename', () => {
  const p = resolveHandoffPath('ctx', 'review.json', path.join('any', 'handoff'));
  assert.equal(path.basename(p), 'review-ctx.json');
  assert.ok(p.includes(path.join('any', 'handoff')));
});

console.log(`\nhandoff-paths: ${passed} assertion group(s) passed.`);
