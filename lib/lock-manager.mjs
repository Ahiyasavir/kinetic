// lock-manager.mjs — centralized, config-driven resolution of the engine's process-lock file paths
// (supervisor.lock / watchdog.lock), U-32.
//
// The lock BASENAMES are no longer hardcoded in supervisor.mjs / watchdog.mjs: they are resolved at
// engine startup from autopilot/config.json → locks (templates with a {repoGoal} variable). Including
// a repository/goal segment in the name (e.g. 'rushpoint-kinetic-topo.watchdog.lock') means two
// kinetic instances pointed at different target repos/goals can run concurrently without their
// process locks colliding — and lays the groundwork for multi-project portability.
//
// Mirrors the U-25/U-31 config-driven seam pattern. Backward compatible: when config.json omits a
// `locks` block, we fall back to the original hardcoded 'watchdog.lock'/'supervisor.lock' basenames so
// an older/minimal config keeps the EXACT current behavior (no collision segment, no breaking change).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, paths, queuePaths } from '../config-loader.mjs';

// Original hardcoded basenames — the graceful fallback when config.locks is absent.
const DEFAULT_LOCKS = {
  watchdog: 'watchdog.lock',
  supervisor: 'supervisor.lock'
};

// Slugify into a filesystem-safe, collision-resistant lock segment.
function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The "active target repository goal" segment (U-32). Combines the repo directory name with the active
 * goal — the branch suffix after the last '/' of git.integrationBranch (falling back to baseBranch) —
 * e.g. repo "Rushpoint-kinetic" + integration branch "autopilot/topo" → "rushpoint-kinetic-topo".
 * An explicit config.locks.repoGoal overrides the derivation.
 */
export function resolveRepoGoal(cfg = config, repoRoot = paths.repoRoot) {
  const explicit = cfg.locks && cfg.locks.repoGoal;
  if (explicit) return slug(explicit);
  const repoSlug = slug(path.basename(repoRoot));
  const branch = (cfg.git && (cfg.git.integrationBranch || cfg.git.baseBranch)) || '';
  const goal = slug(branch.split('/').pop());
  return [repoSlug, goal].filter(Boolean).join('-');
}

// Substitute the {repoGoal} template variable in a lock basename.
function applyTemplate(tpl, repoGoal) {
  return String(tpl).replace(/\{repoGoal\}/g, repoGoal);
}

/**
 * Pure resolver: given the config and the state directory, return the resolved lock-file basenames +
 * absolute paths. Falls back to the hardcoded basenames when config.locks is absent.
 */
export function resolveLocks(cfg = config, stateDir = queuePaths.stateDir) {
  const repoGoal = resolveRepoGoal(cfg);
  const rawLocks = { ...(cfg.locks || {}) };
  delete rawLocks._comment;   // documentation only
  delete rawLocks.repoGoal;   // resolved above, not a template
  const tpl = { ...DEFAULT_LOCKS, ...rawLocks };
  const watchdogName = cfg.locks ? applyTemplate(tpl.watchdog, repoGoal) : DEFAULT_LOCKS.watchdog;
  const supervisorName = cfg.locks ? applyTemplate(tpl.supervisor, repoGoal) : DEFAULT_LOCKS.supervisor;
  return {
    repoGoal,
    fromConfig: Boolean(cfg.locks),
    watchdogName,
    supervisorName,
    watchdog: path.join(stateDir, watchdogName),
    supervisor: path.join(stateDir, supervisorName)
  };
}

// Pre-resolved against the live config + state dir (mirrors config-loader's queuePaths) — the form
// supervisor.mjs and watchdog.mjs consume directly.
export const lockPaths = resolveLocks();

/** One-line startup confirmation that the lock paths were resolved from config.json (not hardcoded). */
export function locksResolvedLine() {
  const src = lockPaths.fromConfig ? 'config.json' : 'hardcoded defaults (no config.locks)';
  return `config-loaded lock paths from ${src} → watchdog=${lockPaths.watchdogName} ` +
    `supervisor=${lockPaths.supervisorName} (repoGoal=${lockPaths.repoGoal || 'n/a'})`;
}

// CLI: print the confirmation + the absolute resolution so the wiring is verifiable today.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(locksResolvedLine());
  console.log(JSON.stringify(lockPaths, null, 2));
}
