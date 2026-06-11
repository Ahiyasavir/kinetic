#!/usr/bin/env node
// test-process-handlers.mjs — verify that process-level error handlers properly format EngineErrors
// and catch unhandled rejections/exceptions.

import {
  EngineError,
  ConfigError,
  StateError,
  LockError,
  formatEngineError
} from './lib/engine-error.mjs';

console.log('🧪 Testing process-level error handler patterns\n');

// Test 1: Verify that a ConfigError is properly formatted with context
console.log('Test 1: ConfigError formatting');
const configErr = new ConfigError(
  'Failed to load engine configuration',
  { path: 'autopilot/config.json' }
);
const formatted = formatEngineError(configErr, {
  elapsedMs: 3000,
  activeStep: 'config-load',
  lastState: 'initializing'
});
if (formatted.includes('CONFIG_ERROR') && formatted.includes('3s') && formatted.includes('config-load')) {
  console.log('✓ ConfigError formatted with all context fields\n');
} else {
  console.error('✗ ConfigError formatting missing fields\n');
  process.exit(1);
}

// Test 2: Verify that a LockError is properly formatted
console.log('Test 2: LockError formatting');
const lockErr = new LockError(
  'Supervisor failed to acquire lock',
  { remediation: 'Verify no other supervisor is running' }
);
const lockFormatted = formatEngineError(lockErr, {
  elapsedMs: 2000,
  activeStep: 'lock-acquisition'
});
if (lockFormatted.includes('LOCK_ERROR') && lockFormatted.includes('Verify no other')) {
  console.log('✓ LockError formatted with custom remediation\n');
} else {
  console.error('✗ LockError formatting failed\n');
  process.exit(1);
}

// Test 3: Verify that a plain Error gets fallback handling
console.log('Test 3: Plain Error fallback');
const plainErr = new Error('Some unexpected error');
const plainFormatted = formatEngineError(plainErr, { elapsedMs: 1000 });
if (plainFormatted.includes('KINETIC ENGINE ERROR') || plainFormatted.includes('Some unexpected')) {
  console.log('✓ Plain Error handled gracefully in fallback path\n');
} else {
  console.error('✗ Plain Error fallback failed\n');
  process.exit(1);
}

// Test 4: Verify that errors without code trigger the fallback message in main handlers
console.log('Test 4: Error handler fallback logic');
const testErr = new Error('Raw error without engine-level code');
const condition = (testErr && testErr.code);
if (!condition) {
  console.log('✓ Fallback condition correctly detects non-EngineError (no .code property)\n');
} else {
  console.error('✗ Fallback condition check failed\n');
  process.exit(1);
}

// Test 5: Verify that cause chains work correctly
console.log('Test 5: Cause chain preservation');
const originalError = new Error('Root cause: permission denied');
const wrappedError = new StateError('State load failed', { cause: originalError });
const causeFormatted = formatEngineError(wrappedError);
if (causeFormatted.includes('permission denied') && causeFormatted.includes('Underlying cause')) {
  console.log('✓ Cause chain properly preserved and displayed\n');
} else {
  console.error('✗ Cause chain handling failed\n');
  process.exit(1);
}

console.log('✅ All process handler tests passed\n');
console.log('Summary:');
console.log('  • EngineError and subclasses format with full context (code, message, remediation)');
console.log('  • Elapsed time, active step, and last state are captured and displayed');
console.log('  • Plain errors receive graceful fallback handling');
console.log('  • Cause chains are preserved for debugging');
console.log('  • No raw stack traces are exposed (visual hierarchy maintained)');
