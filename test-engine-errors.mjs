#!/usr/bin/env node
// test-engine-errors.mjs — verify engine error classes and formatEngineError function.

import {
  EngineError,
  ConfigError,
  StateError,
  LockError,
  ValidationError,
  OperationalError,
  formatEngineError,
  requireLocalPath
} from './lib/engine-error.mjs';

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

function run() {
  for (const { name, fn } of tests) {
    try {
      fn();
      console.log(`✓ ${name}`);
      passed++;
    } catch (e) {
      console.error(`✗ ${name}: ${e.message}`);
      failed++;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

// Test 1: EngineError basic structure
test('EngineError has code, message, remediation', () => {
  const err = new EngineError('test message', { code: 'TEST_CODE', remediation: 'fix this' });
  if (err.code !== 'TEST_CODE') throw new Error('code not set');
  if (err.message !== 'test message') throw new Error('message not set');
  if (err.remediation !== 'fix this') throw new Error('remediation not set');
  if (err.name !== 'EngineError') throw new Error('name not set');
});

// Test 2: ConfigError inherits from EngineError
test('ConfigError inherits EngineError properties', () => {
  const err = new ConfigError('config bad', { path: '/tmp/config.json' });
  if (err.code !== 'CONFIG_ERROR') throw new Error('code not CONFIG_ERROR');
  if (err.path !== '/tmp/config.json') throw new Error('path not set');
  if (err.name !== 'ConfigError') throw new Error('name not ConfigError');
});

// Test 3: StateError inherits from EngineError
test('StateError inherits EngineError properties', () => {
  const err = new StateError('state corrupt', { path: '/tmp/state.json' });
  if (err.code !== 'STATE_ERROR') throw new Error('code not STATE_ERROR');
  if (err.path !== '/tmp/state.json') throw new Error('path not set');
  if (err.name !== 'StateError') throw new Error('name not StateError');
});

// Test 4: LockError with custom remediation
test('LockError accepts custom remediation', () => {
  const err = new LockError('lock failed', { remediation: 'custom fix' });
  if (err.code !== 'LOCK_ERROR') throw new Error('code not LOCK_ERROR');
  if (err.remediation !== 'custom fix') throw new Error('custom remediation not used');
  if (err.name !== 'LockError') throw new Error('name not LockError');
});

// Test 5: LockError uses default remediation
test('LockError uses default remediation when not provided', () => {
  const err = new LockError('lock failed');
  if (!err.remediation.includes('another process')) throw new Error('default remediation not used');
});

// Test 6: ValidationError has details
test('ValidationError supports details array', () => {
  const err = new ValidationError('validation failed', { details: ['error 1', 'error 2'] });
  if (err.code !== 'VALIDATION_ERROR') throw new Error('code not VALIDATION_ERROR');
  if (!Array.isArray(err.details) || err.details.length !== 2) throw new Error('details not set');
});

// Test 7: OperationalError with operation context
test('OperationalError supports operation context', () => {
  const err = new OperationalError('op failed', { operation: 'git clone' });
  if (err.code !== 'OPERATIONAL_ERROR') throw new Error('code not OPERATIONAL_ERROR');
  if (!err.remediation.includes('git clone')) throw new Error('operation not in remediation');
});

// Test 8: formatEngineError produces readable output
test('formatEngineError produces formatted output', () => {
  const err = new EngineError('test failed', { code: 'TEST', remediation: 'do this' });
  const formatted = formatEngineError(err, { elapsedMs: 5000, activeStep: 'test-step' });
  if (!formatted.includes('KINETIC ENGINE ERROR')) throw new Error('header missing');
  if (!formatted.includes('test failed')) throw new Error('message missing');
  if (!formatted.includes('TEST')) throw new Error('code missing');
  if (!formatted.includes('do this')) throw new Error('remediation missing');
  if (!formatted.includes('test-step')) throw new Error('activeStep missing');
  if (!formatted.includes('5s')) throw new Error('elapsed time missing');
});

// Test 9: formatEngineError with underlying cause
test('formatEngineError shows underlying cause', () => {
  const cause = new Error('root cause');
  const err = new EngineError('wrapper', { code: 'WRAPPED', cause });
  const formatted = formatEngineError(err);
  if (!formatted.includes('root cause')) throw new Error('cause not shown');
  if (!formatted.includes('Underlying cause')) throw new Error('cause label missing');
});

// Test 10: formatEngineError with error without code (fallback)
test('formatEngineError works with non-EngineError', () => {
  const err = new Error('plain error');
  const formatted = formatEngineError(err);
  if (!formatted.includes('plain error')) throw new Error('message missing');
});

// Test 11: requireLocalPath throws for missing file
test('requireLocalPath throws for missing file', () => {
  try {
    requireLocalPath('/nonexistent/path/to/file.mjs', 'test artifact');
    throw new Error('should have thrown');
  } catch (e) {
    if (!(e instanceof EngineError)) throw new Error('not an EngineError');
    if (e.code !== 'ENGINE_MISSING_PATH') throw new Error('code not ENGINE_MISSING_PATH');
    if (!e.message.includes('test artifact')) throw new Error('artifact name not in message');
  }
});

// Test 12: requireLocalPath returns path on success
test('requireLocalPath returns path for existing file', () => {
  // Use this file itself
  const result = requireLocalPath(import.meta.url.replace('file:///', ''), 'this test file');
  if (!result.includes('test-engine-errors')) throw new Error('path not returned');
});

console.log(`\n🧪 Running ${tests.length} engine error tests...\n`);
run();
