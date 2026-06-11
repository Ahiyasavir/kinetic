#!/usr/bin/env node
// autopilot/tests/error-handling.test.mjs — System integration tests for engine error handling.
// Validates that all error-throwing code paths produce user-friendly, actionable error messages
// with no raw stack traces or internal jargon exposed to developers.

import assert from 'node:assert';
import { EngineError, ConfigError, StateError, LockError, ValidationError, OperationalError,
         formatEngineError, requireLocalPath, asEngineError } from '../lib/engine-error.mjs';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── Test 1: EngineError base class includes code and remediation ──
test('EngineError includes code, message, and remediation', () => {
  const err = new EngineError('Something went wrong', {
    code: 'TEST_ERROR',
    remediation: 'Try restarting the engine.'
  });

  assert.strictEqual(err.code, 'TEST_ERROR', 'should have error code');
  assert.strictEqual(err.remediation, 'Try restarting the engine.', 'should have remediation hint');
  assert.match(err.message, /Something went wrong/, 'should preserve message');
});

// ── Test 2: ConfigError provides file path and remediation ──
test('ConfigError includes file path and config-specific remediation', () => {
  const err = new ConfigError('Missing required field', {
    path: '/path/to/config.json'
  });

  assert.strictEqual(err.code, 'CONFIG_ERROR', 'should have CONFIG_ERROR code');
  assert.strictEqual(err.path, '/path/to/config.json', 'should include file path');
  assert.match(err.remediation, /config file/, 'remediation should mention config file');
  assert.match(err.remediation, /valid JSON/, 'remediation should mention JSON validity');
});

// ── Test 3: StateError provides file path and state-specific remediation ──
test('StateError includes file path and state-specific remediation', () => {
  const err = new StateError('Corrupted state file', {
    path: '/path/to/state.json'
  });

  assert.strictEqual(err.code, 'STATE_ERROR', 'should have STATE_ERROR code');
  assert.strictEqual(err.path, '/path/to/state.json', 'should include file path');
  assert.match(err.remediation, /state file/, 'remediation should mention state file');
  assert.match(err.remediation, /backup/, 'remediation should mention backup/restore');
});

// ── Test 4: LockError includes lock-specific remediation ──
test('LockError includes lock-specific remediation', () => {
  const err = new LockError('Could not acquire lock at /path/to/lock');

  assert.strictEqual(err.code, 'LOCK_ERROR', 'should have LOCK_ERROR code');
  assert.match(err.remediation, /another process/, 'remediation should mention other processes');
});

// ── Test 5: ValidationError captures details array ──
test('ValidationError captures validation details', () => {
  const details = ['error 1', 'error 2'];
  const err = new ValidationError('Validation failed', { details });

  assert.strictEqual(err.code, 'VALIDATION_ERROR', 'should have VALIDATION_ERROR code');
  assert.deepStrictEqual(err.details, details, 'should include validation details');
  assert.match(err.remediation, /validation errors/, 'remediation should mention validation');
});

// ── Test 6: OperationalError includes operation context ──
test('OperationalError includes operation context', () => {
  const err = new OperationalError('Git push failed', {
    operation: 'push to origin'
  });

  assert.strictEqual(err.code, 'OPERATIONAL_ERROR', 'should have OPERATIONAL_ERROR code');
  assert.match(err.remediation, /push to origin/, 'remediation should include operation context');
});

// ── Test 7: formatEngineError produces readable, structured output ──
test('formatEngineError formats error with full context', () => {
  const err = new ConfigError('Invalid JSON in config', {
    path: '/app/config.json'
  });

  const formatted = formatEngineError(err, {
    elapsedMs: 5000,
    activeStep: 'config-load',
    lastState: 'startup'
  });

  // Verify formatted output includes key context
  assert.match(formatted, /⚠️.*KINETIC ENGINE ERROR/, 'should include warning header');
  assert.match(formatted, /Error Code:.*CONFIG_ERROR/, 'should include error code');
  assert.match(formatted, /Message:.*Invalid JSON/, 'should include message');
  assert.match(formatted, /File:.*\/app\/config\.json/, 'should include file path');
  assert.match(formatted, /Active Step:.*config-load/, 'should include active step');
  assert.match(formatted, /Elapsed:.*5s/, 'should include elapsed time');
  assert.match(formatted, /Last State:.*startup/, 'should include last state');
  assert.match(formatted, /→ Remediation:/, 'should include remediation section');
});

// ── Test 8: formatEngineError does NOT expose raw stack traces ──
test('formatEngineError hides raw stack traces', () => {
  const err = new EngineError('Test error', {
    code: 'TEST',
    cause: new Error('Original error with stack trace')
  });

  const formatted = formatEngineError(err, {});

  // Stack traces (multiple lines of "at ...") should not appear
  assert(!formatted.includes('at '), 'should not include raw stack trace');
  assert(!formatted.match(/\n\s+at\s+/), 'should not have "at" lines from stack trace');
});

// ── Test 9: requireLocalPath throws EngineError for missing files ──
test('requireLocalPath throws EngineError with helpful message', () => {
  const missingPath = '/nonexistent/path/to/file.js';

  try {
    requireLocalPath(missingPath, 'test module');
    assert.fail('should have thrown');
  } catch (err) {
    assert(err instanceof EngineError, 'should throw EngineError');
    assert.strictEqual(err.code, 'ENGINE_MISSING_PATH', 'should have ENGINE_MISSING_PATH code');
    assert.match(err.message, /cannot find/, 'message should say "cannot find"');
    assert.match(err.message, /test module/, 'message should include resource type');
    assert.match(err.message, /engine-level fault/, 'message should explain it is an engine fault');
    assert.match(err.remediation, /Restore/, 'remediation should suggest restoration');
  }
});

// ── Test 10: asEngineError converts ENOENT to EngineError ──
test('asEngineError converts ENOENT file errors to EngineError', () => {
  const fsErr = new Error('ENOENT: no such file or directory');
  fsErr.code = 'ENOENT';

  const engineErr = asEngineError(fsErr, 'test resource', '/path/to/file');

  assert(engineErr instanceof EngineError, 'should return EngineError');
  assert.strictEqual(engineErr.code, 'ENGINE_MISSING_PATH', 'should mark as missing path');
  assert.match(engineErr.message, /cannot read/, 'message should say "cannot read"');
  assert.match(engineErr.message, /test resource/, 'message should include resource type');
  assert.strictEqual(engineErr.cause, fsErr, 'should preserve original error as cause');
});

// ── Test 11: asEngineError preserves non-ENOENT errors unchanged ──
test('asEngineError passes through non-ENOENT errors unchanged', () => {
  const permErr = new Error('Permission denied');
  permErr.code = 'EACCES';

  const result = asEngineError(permErr, 'test', '/path');

  assert.strictEqual(result, permErr, 'should return original error unchanged');
});

// ── Test 12: Error has cause chain for debugging ──
test('EngineError preserves cause chain for debugging', () => {
  const originalErr = new Error('Underlying cause');
  const wrappedErr = new ConfigError('Config load failed', {
    cause: originalErr
  });

  assert.strictEqual(wrappedErr.cause, originalErr, 'should preserve cause chain');
  assert(wrappedErr.message.includes('Config load'), 'should have outer message');
});

// ── Test 13: formatEngineError includes underlying cause ──
test('formatEngineError includes underlying cause in output', () => {
  const originalErr = new Error('network timeout');
  const engineErr = new OperationalError('API call failed', {
    cause: originalErr
  });

  const formatted = formatEngineError(engineErr);

  assert.match(formatted, /→ Underlying cause:/, 'should include cause section');
  assert.match(formatted, /network timeout/, 'should include cause message');
});

// ── Test 14: Error messages are actionable (not generic) ──
test('Error messages are specific and actionable', () => {
  const testCases = [
    { err: new ConfigError('test', { path: '/etc/config' }), shouldInclude: '/etc/config' },
    { err: new LockError('test', { remediation: 'delete lock file' }), shouldInclude: 'delete lock file' },
    { err: new StateError('test', { path: '/var/state' }), shouldInclude: '/var/state' },
  ];

  for (const { err, shouldInclude } of testCases) {
    const remediation = err.remediation;
    assert.match(remediation, RegExp(shouldInclude.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      `remediation should include actionable details: "${shouldInclude}"`);
  }
});

// ── Test 15: formatEngineError separates concern levels (warning, action, details) ──
test('formatEngineError uses visual hierarchy for readability', () => {
  const err = new ConfigError('test', { path: '/config', cause: new Error('JSON parse failed') });
  const formatted = formatEngineError(err, { activeStep: 'init' });

  assert.match(formatted, /━━━━━━/, 'should include visual separators');
  assert.match(formatted, /⚠️\s+KINETIC ENGINE ERROR/, 'should include warning emoji and label');
  assert.match(formatted, /→ Remediation:/, 'should mark remediation with arrow');
  assert.match(formatted, /→ Underlying cause:/, 'should mark cause with arrow');
});

// ── Run all tests ──
async function runTests() {
  console.log(`Running ${tests.length} error-handling system integration tests...\n`);

  let passed = 0;
  let failed = 0;

  for (const { name, fn } of tests) {
    try {
      fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (err) {
      console.error(`✗ ${name}`);
      console.error(`  ${err.message}\n`);
      failed++;
    }
  }

  console.log(`\n${passed} passed, ${failed} failed out of ${tests.length} tests.`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error('Test suite error:', err);
  process.exit(1);
});
