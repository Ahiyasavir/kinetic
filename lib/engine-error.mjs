// engine-error.mjs — a typed, descriptive exception for kinetic ENGINE faults (a missing local code
// path: a prompt template, the config file, or the supervisor entry-point), as opposed to product/task
// failures. Throwing one of these instead of letting a raw `ENOENT: no such file or directory` bubble
// up makes the fault immediately diagnosable in run.log — it names WHAT the engine was looking for and
// WHERE, and states plainly that it is an engine-level fault, not a failed work cycle.

import { existsSync } from 'node:fs';

export class EngineError extends Error {
  constructor(message, { code = 'ENGINE_ERROR', cause, path: filePath } = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    if (cause !== undefined) this.cause = cause;
    if (filePath !== undefined) this.path = filePath;
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
