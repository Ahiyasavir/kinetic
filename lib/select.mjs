// select.mjs — Git diff extraction for modified files (U-52).
//
// Optimizes the Selector context by reading git diffs of modified files instead of
// full file contents, reducing token usage by 10–30% in modification-heavy cycles.
//
// Exports:
//   getModifiedFilesDiffs(repoRoot, opts)  → Promise<{diffs: Record<path, diffHunk>, stats}>
//   extractDiffStats(diffText)              → {added, deleted, modified}

import { execSync, spawnSync } from 'node:child_process';
import path from 'node:path';

/**
 * Get git diff for a single file (HEAD vs working tree).
 * @param {string} filePath   relative file path
 * @param {string} repoRoot   repository root
 * @returns {string|null}     diff hunks or null if not modified
 */
function getFileDiff(filePath, repoRoot) {
  try {
    const result = spawnSync('git', ['diff', 'HEAD', '--', filePath], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 // 1MB per file diff
    });
    if (result.error) return null;
    const output = result.stdout || '';
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

/**
 * List files modified in the working tree vs HEAD.
 * @param {string} repoRoot
 * @returns {string[]} array of relative file paths
 */
function listModifiedFiles(repoRoot) {
  try {
    const result = spawnSync('git', ['diff', 'HEAD', '--name-only'], {
      cwd: repoRoot,
      encoding: 'utf8'
    });
    if (result.error) return [];
    return result.stdout
      .trim()
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Extract diff statistics (added/deleted/modified line counts).
 * @param {string} diffText git diff output
 * @returns {{added: number, deleted: number, modified: number}}
 */
export function extractDiffStats(diffText) {
  if (!diffText) return { added: 0, deleted: 0, modified: 0 };
  const lines = diffText.split('\n');
  let added = 0, deleted = 0, modified = 0;
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) added++;
    else if (line.startsWith('-') && !line.startsWith('---')) deleted++;
  }
  modified = Math.min(added, deleted);
  return { added, deleted, modified };
}

/**
 * Get diffs for all modified files in the repo.
 * @param {string} repoRoot   repository root
 * @param {{maxDiffBytes?: number, enableDiffMode?: boolean}} [opts]
 *   maxDiffBytes: cap total diff output (default 500KB)
 *   enableDiffMode: when false, returns empty object (disable feature via config)
 * @returns {Promise<{diffs: Record<string, string>, stats: Record<string, {added, deleted, modified}>, totalBytes: number}>}
 */
export async function getModifiedFilesDiffs(repoRoot, opts = {}) {
  const { maxDiffBytes = 500_000, enableDiffMode = true } = opts;

  if (!enableDiffMode) {
    return { diffs: {}, stats: {}, totalBytes: 0 };
  }

  const modified = listModifiedFiles(repoRoot);
  if (!modified.length) {
    return { diffs: {}, stats: {}, totalBytes: 0 };
  }

  const diffs = {};
  const stats = {};
  let totalBytes = 0;

  for (const filePath of modified) {
    const diff = getFileDiff(filePath, repoRoot);
    if (diff) {
      const bytes = Buffer.byteLength(diff, 'utf8');
      // Stop accumulating if we exceed budget.
      if (totalBytes + bytes > maxDiffBytes) break;
      diffs[filePath] = diff;
      stats[filePath] = extractDiffStats(diff);
      totalBytes += bytes;
    }
  }

  return { diffs, stats, totalBytes };
}

/**
 * Format diffs for injection into a prompt context block.
 * @param {Record<string, string>} diffs      {filepath: diffContent}
 * @param {Record<string, object>} stats      {filepath: {added, deleted, modified}}
 * @returns {string}  formatted prompt block
 */
export function formatDiffsForContext(diffs, stats) {
  if (!Object.keys(diffs).length) return '';

  const lines = ['## Modified Files (git diffs)'];
  for (const [filePath, diff] of Object.entries(diffs)) {
    const s = stats[filePath];
    lines.push(
      `\n### ${filePath} (+${s?.added || 0}−${s?.deleted || 0})`,
      '```diff',
      diff.slice(0, 2000), // cap per-file excerpt
      (diff.length > 2000 ? '... (truncated)' : ''),
      '```'
    );
  }
  return lines.filter(Boolean).join('\n');
}
