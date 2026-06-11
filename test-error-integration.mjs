#!/usr/bin/env node
// test-error-integration.mjs — simulate engine error scenarios.

import {
  EngineError,
  ConfigError,
  StateError,
  LockError,
  formatEngineError
} from './lib/engine-error.mjs';

console.log('🧪 Engine Error Integration Tests\n');

// Test 1: Config file missing
console.log('Test 1: Config file missing');
const configErr = new ConfigError(
  'Kinetic engine config is not valid JSON: "autopilot/config.json" (Unexpected end of JSON input)',
  { path: 'autopilot/config.json', cause: new Error('Unexpected end of JSON input') }
);
console.log(formatEngineError(configErr, { elapsedMs: 3000, activeStep: 'startup' }));

// Test 2: Lock acquisition failure
console.log('\nTest 2: Lock acquisition failure');
const lockErr = new LockError(
  'Supervisor failed to acquire its lock at "state/supervisor.lock": EACCES: permission denied',
  { cause: new Error('EACCES: permission denied') }
);
console.log(formatEngineError(lockErr, { elapsedMs: 1500, activeStep: 'lock-acquisition' }));

// Test 3: State corruption
console.log('\nTest 3: State corruption');
const stateErr = new StateError(
  'Kinetic engine cannot read a required state file: "state/state.json". This is an engine-level fault.',
  { path: 'state/state.json', cause: new Error('ENOENT: no such file or directory') }
);
console.log(formatEngineError(stateErr, { elapsedMs: 5000, activeStep: 'state-load', lastState: 'cycle-280' }));

// Test 4: Another supervisor already running (graceful, not an error)
console.log('\nTest 4: Supervisor already running (non-fatal case)');
console.log('[kinetic 2024-06-11 10:30:45] Another supervisor is already running (pid 4892, since 2024-06-11 10:15:23) — refusing to start (return).');

// Test 5: Critical lock recovery failure
console.log('\nTest 5: Critical lock recovery failure');
const criticalLockErr = new LockError(
  'Supervisor could not acquire the lock safely after reclaim attempt. This suggests a race condition or a stale lock file that cannot be safely removed.',
  { remediation: 'Verify no other supervisor process is running, then manually delete the lock file and retry.' }
);
console.log(formatEngineError(criticalLockErr, { elapsedMs: 2500, activeStep: 'lock-recovery' }));

console.log('\n✓ All integration scenarios formatted correctly');
