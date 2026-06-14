// lib/path-validator.mjs — path normalization and boundary validation utilities (U-62).
//
// Re-exports the canonical path validation functions from core/pathValidator.mjs so that
// callers can import from the conventional lib/ directory while the logic stays in one place.
//
// Public API:
//   isWithinWorktree(filePath, root) → boolean
//     Returns true when filePath resolves to root or any path below it.
//     Handles ../  traversal, redundant slashes, and absolute paths.
//
//   validatePath(filePath, worktreeRoot) → string (resolved absolute path)
//     Resolves filePath against worktreeRoot and throws if it escapes the boundary.
//     Also rejects null, undefined, and empty-string filePaths.

export { isWithinWorktree, validatePath } from '../core/pathValidator.mjs';
