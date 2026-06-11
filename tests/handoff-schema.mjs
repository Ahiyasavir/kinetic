// handoff-schema.mjs — assertions for the versioned handoff schema envelope (U-34). Verifies stamping is
// idempotent + non-destructive, validation is tolerant (legacy/unstamped accepted, never throws), an
// outdated/future version is classified correctly, and a foreign projectScope is flagged as a collision.
//   node autopilot/tests/handoff-schema.mjs
import assert from 'node:assert/strict';
import {
  HANDOFF_SCHEMA_VERSION,
  stampHandoff,
  validateHandoffSchema,
} from '../lib/handoff-schema.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// 1) stampHandoff adds the full envelope (version + timestamp + projectScope).
check('stampHandoff adds version/timestamp/projectScope', () => {
  const out = stampHandoff({ summary: 'x' }, { context: 'proj-a', timestamp: '2026-01-01T00:00:00.000Z' });
  assert.equal(out.version, HANDOFF_SCHEMA_VERSION);
  assert.equal(out.timestamp, '2026-01-01T00:00:00.000Z');
  assert.equal(out.projectScope, 'proj-a');
  assert.equal(out.summary, 'x'); // payload preserved
});

// 2) Idempotent + non-destructive — re-stamping keeps an explicit envelope already on the payload.
check('stampHandoff is idempotent (explicit envelope wins)', () => {
  const once = stampHandoff({ a: 1 }, { context: 'p', timestamp: '2026-01-01T00:00:00.000Z' });
  const twice = stampHandoff(once, { context: 'OTHER', timestamp: '2030-01-01T00:00:00.000Z' });
  assert.deepEqual(twice, once);
});

// 3) A current-version payload validates as ok.
check('validate accepts a current-version payload', () => {
  const v = validateHandoffSchema(stampHandoff({}, { context: 'p' }), { context: 'p', file: 'selection.json' });
  assert.equal(v.ok, true);
  assert.equal(v.status, 'ok');
  assert.equal(v.migration, null);
  assert.equal(v.scopeMismatch, false);
});

// 4) Backward compatible — a legacy/unstamped file is accepted (v0) with a migration message, no throw.
check('validate accepts legacy/unstamped as v0 with a migration message', () => {
  const v = validateHandoffSchema({ summary: 'old' }, { context: 'p', file: 'review.json' });
  assert.equal(v.ok, true);
  assert.equal(v.status, 'unstamped');
  assert.equal(v.version, 0);
  assert.ok(v.migration && v.migration.includes('review.json'));
});

// 5) A future version is NOT trusted; an outdated one is migrated on load.
check('validate flags future (untrusted) and outdated (migrated)', () => {
  const future = validateHandoffSchema({ version: HANDOFF_SCHEMA_VERSION + 1 }, { file: 'audit.json' });
  assert.equal(future.ok, false);
  assert.equal(future.status, 'future');
  if (HANDOFF_SCHEMA_VERSION > 1) {
    const old = validateHandoffSchema({ version: HANDOFF_SCHEMA_VERSION - 1 }, { file: 'audit.json' });
    assert.equal(old.ok, true);
    assert.equal(old.status, 'outdated');
  }
});

// 6) A projectScope from ANOTHER context is flagged — the cross-context collision signal (U-34's point).
check('validate flags a foreign projectScope (collision detection)', () => {
  const v = validateHandoffSchema(stampHandoff({}, { context: 'proj-b' }), { context: 'proj-a', file: 'selection.json' });
  assert.equal(v.scopeMismatch, true);
});

// 7) Tolerant of junk — null / non-object never throws.
check('validate never throws on null/non-object', () => {
  assert.equal(validateHandoffSchema(null).ok, false);
  assert.equal(validateHandoffSchema('nope').ok, false);
});

console.log(`\nhandoff-schema: ${passed} assertion group(s) passed.`);
