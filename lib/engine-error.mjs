// engine-error.mjs — typed, descriptive exceptions for kinetic ENGINE faults (missing local code
// paths, config errors, state corruption, lock failures, etc.) as opposed to product/task failures.
// Throwing these instead of raw errors makes faults immediately diagnosable in run.log.

import { existsSync } from 'node:fs';

// Base class for all engine-level errors. Includes a structured format: code, message, remediation.
export class EngineError extends Error {
  constructor(message, { code = 'ENGINE_ERROR', cause, path: filePath, remediation = '' } = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.remediation = remediation;
    if (cause !== undefined) this.cause = cause;
    if (filePath !== undefined) this.path = filePath;
  }
}

// Config file missing/invalid (JSON parse error, missing required fields, etc).
export class ConfigError extends EngineError {
  constructor(message, { cause, path: filePath } = {}) {
    super(message, {
      code: 'CONFIG_ERROR',
      cause,
      path: filePath,
      remediation: `Check the config file at "${filePath}" exists and is valid JSON. Restore from git if needed.`
    });
    this.name = 'ConfigError';
  }
}

// State file missing/corrupted (state.json, lessons.json, handoff files, etc).
export class StateError extends EngineError {
  constructor(message, { cause, path: filePath } = {}) {
    super(message, {
      code: 'STATE_ERROR',
      cause,
      path: filePath,
      remediation: `Check the state file at "${filePath}" exists and is valid JSON. Restore from backup or run supervisor init again.`
    });
    this.name = 'StateError';
  }
}

// Lock acquisition/release failure (supervisor.lock, watchdog.lock, etc).
export class LockError extends EngineError {
  constructor(message, { cause } = {}) {
    super(message, {
      code: 'LOCK_ERROR',
      cause,
      remediation: 'Check if another process holds the lock or if the lock file is stale. Delete the lock file only if certain no other process is running.'
    });
    this.name = 'LockError';
  }
}

// Validation failure (lint errors, type errors, build failures, etc).
export class ValidationError extends EngineError {
  constructor(message, { cause, details = [] } = {}) {
    super(message, {
      code: 'VALIDATION_ERROR',
      cause,
      remediation: 'Address the validation errors above before retrying. Check the full output for details.'
    });
    this.name = 'ValidationError';
    this.details = details;
  }
}

// Operational/runtime errors (git failures, inbox read errors, handoff missing, etc).
export class OperationalError extends EngineError {
  constructor(message, { cause, operation = '', remediation = '' } = {}) {
    super(message, {
      code: 'OPERATIONAL_ERROR',
      cause,
      remediation: remediation || `The operation "${operation}" failed unexpectedly. Check the logs above for details.`
    });
    this.name = 'OperationalError';
  }
}

// Assert a required local path exists, throwing a descriptive EngineError naming the missing artifact
// instead of letting a downstream read fail with a bare ENOENT. `what` is a human label (e.g.
// "prompt template", "config file", "supervisor entry-point"). Returns the path on success for chaining.
export function requireLocalPath(filePath, what) {
  if (!existsSync(filePath)) {
    throw new EngineError(
      `Kinetic engine cannot find a required ${what}: "${filePath}". This is an engine-level fault ` +
      `(a missing local code path) — not a task failure. Restore the file or fix the configured path ` +
      `before the loop can run.`,
      { code: 'ENGINE_MISSING_PATH', path: filePath }
    );
  }
  return filePath;
}

// Translate a raw fs error into a descriptive EngineError when it is a missing-file (ENOENT) fault,
// preserving the original as `cause`. Non-ENOENT errors are returned unchanged so callers can rethrow.
export function asEngineError(err, what, filePath) {
  if (err && err.code === 'ENOENT') {
    return new EngineError(
      `Kinetic engine cannot read a required ${what}: "${filePath}". This is an engine-level fault ` +
      `(a missing local code path) — not a task failure.`,
      { code: 'ENGINE_MISSING_PATH', path: filePath, cause: err }
    );
  }
  return err;
}

// Format an engine error for human-readable console/log output, including code, message, and remediation.
export function formatEngineError(err, context = {}) {
  const { elapsedMs = null, activeStep = null, lastState = null } = context;
  let output = '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
  output += '⚠️  KINETIC ENGINE ERROR\n';
  output += '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n';

  if (err.name) output += `Error Type: ${err.name}\n`;
  if (err.code) output += `Error Code: ${err.code}\n`;
  output += `Message: ${err.message}\n`;
  if (err.path) output += `File: ${err.path}\n`;

  if (activeStep) output += `Active Step: ${activeStep}\n`;
  if (elapsedMs !== null) output += `Elapsed: ${Math.round(elapsedMs / 1000)}s\n`;
  if (lastState) output += `Last State: ${lastState}\n`;

  if (err.remediation) {
    output += `\n→ Remediation: ${err.remediation}\n`;
  }

  if (err.cause && err.cause.message) {
    output += `\n→ Underlying cause: ${err.cause.message}\n`;
  }

  output += '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n';
  return output;
}
