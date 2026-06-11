// workspace.mjs — the unifying WORKSPACE abstraction (multi-workspace foundation).
//
// Until now the engine's per-target facts — where it operates (root), where its state/queues/locks
// live, which budget scope + validation commands + git target apply — were resolved by FIVE separate
// module-level singletons (config-loader, lock-manager, git-config-loader) against ONE global
// config.json. That is implicitly "one workspace." This module bundles those facts into a single,
// nameable Workspace object so the engine can (a) declare exactly what it is allowed to touch, and
// (b) run multiple isolated workspaces on one machine.
//
// A Workspace is a PLAIN DATA object (UI-serializable):
//   {
//     id, label, isDefault,
//     root,                       // absolute dir the engine OPERATES ON (the target repo/worktree)
//     boundaries: { write[], read[] },  // absolute dirs the engine may touch (target-side guard)
//     stateDir, statePath,        // engine runtime state for THIS workspace (isolated)
//     queuePaths: { inboxDir, handoffDir, backlogFile, doneFile, stopFlag, lessonsPath, validationCacheFile },
//     lockPaths:  { supervisor, watchdog },
//     budgetScope,                // projectId key into config.budgets + state.tokenSpent (isolated)
//     validation,                 // the validation config for THIS workspace
//     git: { repository, branch, integrationBranch, baseBranch, commitPrefix, worktreePath, cwd }
//   }
//
// BACKWARD COMPATIBILITY: defaultWorkspace() is built to be byte-identical to the values the engine
// already resolves today (queuePaths.stateDir, lockPaths.*, gitConfig.cwd, the configured validation,
// repoGoal as the budget scope). So routing the engine through the default workspace changes NOTHING;
// only an explicitly-selected, named workspace gets its own isolated dirs.
import path from 'node:path';
import { config, paths, queuePaths, validation as defaultValidation } from '../config-loader.mjs';
import { lockPaths, resolveRepoGoal } from './lock-manager.mjs';
import { gitConfig } from './git-config-loader.mjs';
import { loadProfile } from './workspace-profile.mjs';
import { EngineError } from './engine-error.mjs';

const KINETIC_DIR = queuePaths.autopilotDir;

// Filesystem-safe, collision-resistant id segment (mirrors lock-manager's slug).
export function slugId(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Per-workspace engine-runtime layout under a given state dir. Centralizes every runtime file path so
// "where does workspace X keep its state/queues/locks/flags" has exactly one answer.
function runtimeLayout(stateDir, { handoffDir, inboxDir, supervisorLock, watchdogLock } = {}) {
  return {
    stateDir,
    statePath: path.join(stateDir, 'state.json'),
    queuePaths: {
      inboxDir: inboxDir || path.join(stateDir, 'inbox'),
      handoffDir: handoffDir || path.join(stateDir, 'handoff'),
      backlogFile: path.join(stateDir, 'backlog.md'),
      doneFile: path.join(stateDir, 'done.md'),
      stopFlag: path.join(stateDir, 'STOP'),
      lessonsPath: path.join(stateDir, 'lessons.json'),
      validationCacheFile: path.join(stateDir, 'validation-cache.json'),
    },
    lockPaths: {
      supervisor: supervisorLock || path.join(stateDir, 'supervisor.lock'),
      watchdog: watchdogLock || path.join(stateDir, 'watchdog.lock'),
    },
  };
}

// Resolve absolute boundary dirs from a (possibly relative) list, anchored at the workspace root.
function resolveBoundaries(root, extra = {}) {
  const norm = (arr) => [...new Set((arr || []).map((p) => path.resolve(root, p)))];
  const write = norm([root, ...(extra.write || [])]);
  // read defaults to write ∪ any explicit read dirs (you can always read what you can write).
  const read = norm([...write, ...(extra.read || [])]);
  return { write, read };
}

/**
 * THE DEFAULT WORKSPACE — a faithful wrapper over the engine's existing resolved values, so running
 * the engine through it is behavior-preserving. `gitRootOverride` honors the watchdog's
 * KINETIC_GIT_ROOT export exactly as supervisor.mjs does today.
 */
export function defaultWorkspace({ gitRootOverride = null } = {}) {
  const root = gitRootOverride || gitConfig.cwd;
  const id = resolveRepoGoal() || 'default';
  // The default workspace's PROFILE is config-driven (config.profile), so the engine layer carries no
  // hardcoded product identity. Set it to 'rushpoint' in config.json to keep the current backlog/
  // filters/prompt rules; omit it (or set 'generic') for a neutral engine.
  const profileId = config.profile || 'generic';
  return {
    id,
    label: id,
    isDefault: true,
    root,
    profileId,
    profile: loadProfile(profileId),
    boundaries: resolveBoundaries(root),
    // Use the engine's EXISTING runtime locations (not the generic per-workspace layout) so the default
    // run reads/writes the very same state.json, queues, locks and flags it always has.
    stateDir: queuePaths.stateDir,
    statePath: path.join(queuePaths.stateDir, 'state.json'),
    queuePaths: {
      inboxDir: queuePaths.inboxDir,
      handoffDir: queuePaths.handoffDir,
      backlogFile: queuePaths.backlogFile,
      doneFile: queuePaths.doneFile,
      stopFlag: path.join(queuePaths.stateDir, 'STOP'),
      lessonsPath: path.join(queuePaths.stateDir, 'lessons.json'),
      validationCacheFile: path.join(queuePaths.stateDir, 'validation-cache.json'),
    },
    lockPaths: { supervisor: lockPaths.supervisor, watchdog: lockPaths.watchdog },
    budgetScope: lockPaths.repoGoal || 'default',
    validation: defaultValidation,
    git: {
      repository: gitConfig.repository,
      branch: gitConfig.branch,
      integrationBranch: gitConfig.integrationBranch,
      baseBranch: gitConfig.baseBranch,
      commitPrefix: gitConfig.commitPrefix,
      worktreePath: gitConfig.worktreePath,
      cwd: root,
    },
  };
}

/**
 * Build an ISOLATED workspace from a registry entry. Every runtime location lands under
 * autopilot/state/workspaces/<id>/ so its state, queues, locks, STOP flag and validation cache can
 * never collide with another workspace's. Validation defaults to an EMPTY (no-op) command set — a
 * foreign repo must declare its own commands; we never run RushPoint's `npm run typecheck` against it.
 * (The always-on engine syntax/protected-core guardrails in validate.mjs still run regardless.)
 *
 * @param {object} entry  { id?, label?, root (required), branch?, integrationBranch?, baseBranch?,
 *                          commitPrefix?, budgetScope?, validation?, boundaries?:{write?,read?} }
 * @param {{repoRoot?:string, autopilotDir?:string}} [ctx]
 */
export function workspaceFromEntry(entry, ctx = {}) {
  if (!entry || !entry.root) throw new EngineError('Workspace entry requires a "root" path.', { code: 'WORKSPACE_BAD_ENTRY' });
  const repoRoot = ctx.repoRoot || paths.repoRoot;
  const autopilotDir = ctx.autopilotDir || KINETIC_DIR;
  const root = path.resolve(repoRoot, entry.root);
  const branch = entry.branch || entry.integrationBranch || '';
  const id = slugId(entry.id || [path.basename(root), slugId(branch.split('/').pop())].filter(Boolean).join('-'));
  if (!id) throw new EngineError('Workspace entry produced an empty id.', { code: 'WORKSPACE_BAD_ENTRY' });
  const stateDir = path.join(autopilotDir, 'state', 'workspaces', id);
  const layout = runtimeLayout(stateDir, {
    supervisorLock: path.join(stateDir, `${id}.supervisor.lock`),
    watchdogLock: path.join(stateDir, `${id}.watchdog.lock`),
  });
  const profileId = entry.profile || 'generic';
  return {
    id,
    label: entry.label || id,
    isDefault: false,
    root,
    profileId,
    profile: loadProfile(profileId),
    boundaries: resolveBoundaries(root, entry.boundaries || {}),
    ...layout,
    budgetScope: slugId(entry.budgetScope || id),
    // Foreign workspace → its own validation, or a SAFE empty set (engine guardrails still run).
    validation: entry.validation || { commands: [], lintRegressionGuard: false, e2e: { enabled: false, cmd: '', timeoutMs: 600000 } },
    git: {
      repository: root,
      branch,
      integrationBranch: entry.integrationBranch || branch || undefined,
      baseBranch: entry.baseBranch || undefined,
      commitPrefix: entry.commitPrefix || 'kinetic',
      worktreePath: null,
      cwd: root,
    },
  };
}

// ── Boundary enforcement (target-side guard) ────────────────────────────────
// withinBoundary answers "may the engine touch this path for this mode?" deterministically. A path is
// in-boundary if it equals or is nested under any declared boundary dir. This is the primitive that
// keeps the engine from acting outside the selected workspace.
export function withinBoundary(ws, absPath, mode = 'write') {
  const list = (ws && ws.boundaries && ws.boundaries[mode]) || [];
  const target = path.resolve(absPath);
  return list.some((b) => target === b || target.startsWith(b + path.sep));
}

export function assertWithinBoundary(ws, absPath, mode = 'write') {
  if (!withinBoundary(ws, absPath, mode)) {
    throw new EngineError(
      `Refusing to ${mode} "${absPath}" — outside workspace "${ws?.id}" ${mode} boundary [${((ws?.boundaries || {})[mode] || []).join(', ')}].`,
      { code: 'WORKSPACE_BOUNDARY', path: absPath }
    );
  }
}

// ── Display / serialization helpers (logs + future UI) ──────────────────────
export function describeWorkspace(ws) {
  return `workspace "${ws.id}"${ws.isDefault ? ' (default)' : ''} @ ${ws.root} · profile=${ws.profileId} · ` +
    `state=${ws.stateDir} · budget-scope=${ws.budgetScope} · branch=${ws.git.branch || '(current)'} · ` +
    `write-boundary=[${ws.boundaries.write.join(', ')}]`;
}

// A compact, UI-ready summary (no absolute-path noise beyond what a picker needs).
export function summarizeWorkspace(ws) {
  return {
    id: ws.id, label: ws.label, isDefault: !!ws.isDefault, root: ws.root, profileId: ws.profileId,
    branch: ws.git.branch || null, budgetScope: ws.budgetScope, stateDir: ws.stateDir,
  };
}
