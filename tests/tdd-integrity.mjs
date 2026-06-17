// tests/tdd-integrity.mjs — the TDD Red→Green integrity policy (classifyTestGate).
// Run: node --test --test-force-exit tests/tdd-integrity.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTestGate } from '../lib/tdd-integrity.mjs';

test('Red on baseline + Green after = authoritative behavioral proof, not blocking', () => {
  const g = classifyTestGate({ redVerified: true, greenPassed: true });
  assert.equal(g.authoritative, true);
  assert.equal(g.blocking, false);
  assert.equal(g.status, 'red-green');
});

test('vacuous test (passed pre-impl) is NOT proof and is NON-blocking (avoids deadlock)', () => {
  const g = classifyTestGate({ redVerified: false, greenPassed: true });
  assert.equal(g.authoritative, false, 'a test green-before-and-after proves nothing about the change');
  assert.equal(g.blocking, false, 'must not block — the implementer cannot fix the Tester\'s weak test');
  assert.equal(g.status, 'vacuous');
  assert.match(g.note, /vacuous|never Red/i);
});

test('failing test after implementation always blocks, regardless of Red status', () => {
  for (const redVerified of [true, false, null]) {
    const g = classifyTestGate({ redVerified, greenPassed: false });
    assert.equal(g.blocking, true, `greenPassed=false must block (redVerified=${redVerified})`);
    assert.equal(g.status, 'green-fail');
  }
});

test('inconclusive baseline → green accepted but flagged unverified (weaker signal)', () => {
  const g = classifyTestGate({ redVerified: null, greenPassed: true });
  assert.equal(g.authoritative, false);
  assert.equal(g.blocking, false);
  assert.equal(g.status, 'green-unverified');
});

test('no test produced → gate inactive, never blocks', () => {
  const g = classifyTestGate({ redVerified: null, greenPassed: null });
  assert.equal(g.blocking, false);
  assert.equal(g.authoritative, false);
  assert.equal(g.status, 'no-test');
});

test('defensive: empty/absent argument does not throw and yields the inactive gate', () => {
  assert.doesNotThrow(() => classifyTestGate());
  assert.equal(classifyTestGate().status, 'no-test');
});
