// git-config-loader.mjs — centralized, config-driven resolution of the git VCS target (U-35):
// WHICH repository, branch and (optional) worktree the kinetic operates on.
//
// Until now the supervisor's git operations were anchored to a single hardcoded location —
// `path.resolve(__dirname, '..')`, i.e. the repo the kinetic itself lives in — so the engine could
// only ever drive the RushPoint checkout. This module is the seam that lets kinetic.config.json point
// the engine at ANY external repository/branch (and optionally manage it in a dedicated git worktree),
// exactly mirroring the U-25/U-31/U-32 config-driven path seams.
//
// Pure + side-effect-free: `resolveGitConfig(config)` takes the parsed config object and returns the
// resolved absolute paths + the git config values. It never reads the filesystem or runs git, so it is
// safe to import from anywhere (including the frozen entry-points once the Strangler-Fig freeze lifts).
//
// Backward compatible: when config.git omits the new `repository` / `branch` / `worktreeName` fields,
// every value defaults to the current RushPoint layout (repository = the kinetic's own repo root,
// branch = git.integrationBranch, no separate worktree) so an older/minimal config keeps the EXACT
// current behavior — zero engine change for the existing run.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, paths } from '../config-loader.mjs';

/**
 * Pure resolver. Given the parsed config and the kinetic's own repo root, resolve the git target.
 *
 * @param {object} cfg       the parsed kinetic config (provides `git`)
 * @param {string} repoRoot  the repo the kinetic lives in (the anchor for relative `repository`)
 * @returns {{
 *   fromConfig: boolean, repository: string, branch: string, worktreeName: (string|null),
 *   worktreePath: (string|null), cwd: string, integrationBranch: (string|undefined),
 *   baseBranch: (string|undefined), commitPrefix: (string|undefined), rel: object
 * }}
 *   `repository` — absolute path to the target repo (relative forms resolve against `repoRoot`).
 *   `worktreePath` — absolute path to the managed worktree (a sibling of `repository`), or null.
 *   `cwd` — the working directory git/file operations should run in: the worktree if one is
 *           configured, otherwise the repository itself. This is the single value callers consume.
 */
export function resolveGitConfig(cfg = config, repoRoot = paths.repoRoot) {
  const g = { ...(cfg.git || {}) };
  delete g._comment; // documentation only — never treat as config

  // New, optional U-35 fields. Absent → current RushPoint layout (in-place on the kinetic's repo).
  const repoRel = g.repository || '.';
  const repository = path.resolve(repoRoot, repoRel);

  // The active branch: explicit git.branch, else the existing integrationBranch (the legacy default).
  const branch = g.branch || g.integrationBranch || '';

  // Optional dedicated worktree. Placed as a SIBLING of the repository (standard git worktree layout),
  // so the engine can manage an isolated checkout without touching the repo's primary working tree.
  const worktreeName = g.worktreeName || null;
  const worktreePath = worktreeName ? path.resolve(repository, '..', worktreeName) : null;

  const cwd = worktreePath || repository;

  return {
    fromConfig: Boolean(cfg.git && (g.repository || g.branch || g.worktreeName)),
    repository,
    branch,
    worktreeName,
    worktreePath,
    cwd,
    // Passthrough of the existing git block so callers have one resolved object for all git config.
    integrationBranch: g.integrationBranch,
    baseBranch: g.baseBranch,
    commitPrefix: g.commitPrefix,
    rel: { repository: repoRel, branch, worktreeName: worktreeName || null } // portable forms (logging)
  };
}

// Pre-resolved against the live config + the kinetic's own repo root (mirrors config-loader's
// queuePaths / lock-manager's lockPaths) — the form supervisor.mjs and watchdog.mjs consume directly.
export const gitConfig = resolveGitConfig();

/** One-line startup confirmation that the git target came from config.json (not hardcoded). */
export function gitConfigResolvedLine() {
  const src = gitConfig.fromConfig ? 'config.json' : 'hardcoded defaults (no config.git.repository/branch/worktreeName)';
  return `config-loaded git target from ${src} → repository=${gitConfig.rel.repository} ` +
    `branch=${gitConfig.branch || '(current)'} worktree=${gitConfig.worktreeName || '(in-place)'}`;
}

// CLI: print the confirmation + the absolute resolution so the wiring is verifiable today.
//   node autopilot/lib/git-config-loader.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(gitConfigResolvedLine());
  console.log(JSON.stringify(gitConfig, null, 2));
}
