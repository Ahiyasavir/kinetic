// core/pathValidator.mjs — path validation utilities for sandbox isolation (U-62).
//
// Provides the canonical path-boundary functions used by WorktreeExecutor and Sandbox
// to prevent untrusted tenant operations from escaping the worktree root.
//
// All functions are synchronous and pure — no I/O, no side effects.

import path from 'node:path';

/**
 * Returns true when filePath resolves to a location that is at or below root.
 * Handles path traversal (../), redundant slashes, and absolute paths.
 *
 * @param {string} filePath  — path to check (absolute or relative to root)
 * @param {string} root      — the worktree boundary (absolute path)
 * @returns {boolean}
 */
export function isWithinWorktree(filePath, root) {
  if (filePath == null || typeof filePath !== 'string') return false;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, filePath);
  const boundary = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  return resolved === resolvedRoot || resolved.startsWith(boundary);
}

/**
 * Resolves filePath against worktreeRoot and throws if it escapes the boundary.
 * Rejects: null, undefined, empty string, and any path that resolves outside root.
 *
 * @param {string} filePath       — path to validate (absolute or relative)
 * @param {string} worktreeRoot   — the isolation boundary
 * @returns {string} resolved absolute path (guaranteed within boundary)
 * @throws {Error} when filePath is invalid or outside the worktree
 */
export function validatePath(filePath, worktreeRoot) {
  if (filePath == null || filePath === '') {
    throw new Error(
      `validatePath: filePath must be a non-empty string, got ${JSON.stringify(filePath)}`
    );
  }
  if (!isWithinWorktree(filePath, worktreeRoot)) {
    const resolvedRoot = path.resolve(worktreeRoot);
    const resolved = path.resolve(resolvedRoot, filePath);
    throw new Error(
      `Path validation failed: "${filePath}" resolves to "${resolved}" which is outside ` +
      `worktree boundary "${worktreeRoot}". ` +
      `(HE: אימות נתיב נכשל — הנתיב מחוץ לעץ העבודה)`
    );
  }
  return path.resolve(path.resolve(worktreeRoot), filePath);
}
