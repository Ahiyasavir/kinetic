// parallel-runner.mjs — simultaneous implementation of two independent tasks in isolated git worktrees.
//
// Instead of the default A→B sequential cycle, when the backlog has 2+ non-conflicting tasks and
// config.parallelExecution.enabled is true, this module:
//   1. Selects a second task from the backlog that doesn't overlap with the primary task's file surface
//   2. Creates two git worktrees (temporary branches off the integration branch)
//   3. Runs both implementers concurrently (I/O-bound — each spawns a Claude subprocess)
//   4. Returns both implementation results for sequential review + validation + merge by the supervisor
//
// Net win: wall-clock time for the implementation phase drops from ~A+B minutes to max(A,B) minutes
// (typically halving it for equal-sized tasks). Review + validation + merge remain sequential for safety.
//
// SAFETY:
//   - Each worktree is on an isolated branch — the main integration branch is untouched during impl.
//   - If either task fails, the other is unaffected (the worktree for the failed task is removed cleanly).
//   - On error, removeWorktree() is called in a finally block — no orphaned worktrees left on disk.
//   - The supervisor's existing review/validate/merge flow is UNCHANGED — parallel execution only
//     speeds up the IMPLEMENTATION phase, not the quality gates.
//
// FILE CONFLICT DETECTION (heuristic):
//   Tasks are treated as non-conflicting when their title+notes don't share the same top-level
//   directory or module name. This is a fast pre-flight heuristic, not a perfect guarantee.
//   The full git merge at the end will surface true conflicts; the supervisor handles them as it does
//   any other merge conflict (blocks the second task, re-queues it).

import path from 'node:path';

export const PARALLEL_DEFAULTS = Object.freeze({
  enabled: false,          // opt-in — enable in config.parallelExecution.enabled
  maxParallelTasks: 2,     // always 2 for v1 — more would require more complex merge logic
  minRiskForSerial: 4,     // tasks with risk >= this always run serially (too risky to parallel)
  worktreePrefix: 'kinetic-parallel',  // worktree directory name prefix (placed next to repo root)
});

function parallelConfig(config) {
  return { ...PARALLEL_DEFAULTS, ...(config && config.parallelExecution ? config.parallelExecution : {}) };
}

// Extract a rough set of "surface keywords" from a task's title and notes.
// Two tasks are considered potentially conflicting when they share ≥1 keyword from a conflict-sensitive
// set (module names, directory paths, schema names, API paths).
function taskSurface(task) {
  const text = `${task.title || ''} ${task.notes || ''}`.toLowerCase();
  // Extract words that look like file paths or module names (contain / or . or are camelCase/snake_case)
  const tokens = text.split(/\s+/);
  const surface = new Set();
  for (const tok of tokens) {
    const clean = tok.replace(/[^a-z0-9_./\-]/g, '');
    if (clean.length >= 4) surface.add(clean);
    // Also add the first path segment of anything that looks like a path
    if (clean.includes('/')) surface.add(clean.split('/')[0]);
  }
  return surface;
}

// True when two tasks look safe to run in parallel (no shared file surface keywords).
function safeToParallel(taskA, taskB, pc) {
  if ((taskA.risk || 0) >= pc.minRiskForSerial || (taskB.risk || 0) >= pc.minRiskForSerial) return false;
  // Always run security/migration/schema tasks serially
  const sensitive = ['security', 'migration', 'schema', 'data model', 'firestore', 'rules', 'auth'];
  // Scan BOTH goal and title — a truthy `goal` must not mask a sensitive keyword in the title.
  const isSecure = (t) => sensitive.some((s) => `${t.goal || ''} ${t.title || ''}`.toLowerCase().includes(s));
  if (isSecure(taskA) || isSecure(taskB)) return false;
  // Check for overlapping surface keywords
  const sA = taskSurface(taskA);
  const sB = taskSurface(taskB);
  for (const kw of sA) { if (sB.has(kw)) return false; }
  return true;
}

/**
 * Find a second task from the backlog that can safely run in parallel with primaryTask.
 * Returns the candidate task or null when no safe pair is found.
 *
 * @param {object} primaryTask    - the task already selected for this cycle
 * @param {object[]} backlog      - remaining backlog tasks (after primaryTask is removed)
 * @param {object} config         - engine config
 * @param {object} state          - current state (for cooldown checks)
 * @returns {object|null}
 */
export function findParallelCandidate(primaryTask, backlog, config, state) {
  const pc = parallelConfig(config);
  if (!pc.enabled) return null;
  const cycle = state && state.cycle ? state.cycle : 0;
  for (const candidate of backlog) {
    // Skip tasks on cooldown or blocked
    if (candidate.cooldownUntilCycle && candidate.cooldownUntilCycle > cycle) continue;
    if (candidate.status === 'blocked') continue;
    if (safeToParallel(primaryTask, candidate, pc)) return candidate;
  }
  return null;
}

/**
 * Run two implementer phases in parallel, each in an isolated git worktree.
 *
 * @param {object} taskA         - primary task
 * @param {object} taskB         - secondary (parallel) task
 * @param {string} gitRoot       - path to the main git working tree
 * @param {string} integBranch   - integration branch name (worktrees branch off this)
 * @param {string} commitPrefix  - commit message prefix (e.g. "kinetic")
 * @param {object} git           - git helper module (lib/git.mjs)
 * @param {Function} runImpl     - async (task, cwd) => implementation result from core.runImplementer
 * @param {object} config        - engine config
 * @param {Function} log         - supervisor logger
 * @returns {Promise<ParallelResult>}
 */
export async function runParallelImplementers(taskA, taskB, gitRoot, integBranch, commitPrefix, gitHelpers, runImpl, config, log) {
  const pc = parallelConfig(config);
  const repoParent = path.dirname(gitRoot);
  const wtA = path.join(repoParent, `${pc.worktreePrefix}-a`);
  const wtB = path.join(repoParent, `${pc.worktreePrefix}-b`);
  const brA = `parallel/${taskA.id}`;
  const brB = `parallel/${taskB.id}`;

  log(`[PARALLEL] Starting parallel implementation: ${taskA.id} ‖ ${taskB.id}`);

  // Create worktrees — each is an isolated checkout of the integration branch
  const createdA = await gitHelpers.ensureWorktree(gitRoot, wtA, brA, integBranch);
  const createdB = await gitHelpers.ensureWorktree(gitRoot, wtB, brB, integBranch);
  if (createdA) log(`[PARALLEL] Worktree A created: ${wtA} (branch ${brA})`);
  if (createdB) log(`[PARALLEL] Worktree B created: ${wtB} (branch ${brB})`);

  let resultA = null, resultB = null, errorA = null, errorB = null;

  try {
    const startMs = Date.now();
    // Run both implementers simultaneously — each spawns its own Claude subprocess
    const [resA, resB] = await Promise.allSettled([
      runImpl(taskA, wtA),
      runImpl(taskB, wtB),
    ]);
    const elapsedMs = Date.now() - startMs;
    log(`[PARALLEL] Both implementers finished in ${(elapsedMs / 1000).toFixed(0)}s`);

    if (resA.status === 'fulfilled') {
      resultA = resA.value;
      // Commit any uncommitted work left in worktree A
      await gitHelpers.commitAllIfDirty(wtA, `${commitPrefix}: ${taskA.id} ${taskA.title}`).catch(() => {});
    } else {
      errorA = resA.reason;
      log(`[PARALLEL] Task A (${taskA.id}) failed: ${resA.reason && resA.reason.message || resA.reason}`);
    }

    if (resB.status === 'fulfilled') {
      resultB = resB.value;
      await gitHelpers.commitAllIfDirty(wtB, `${commitPrefix}: ${taskB.id} ${taskB.title}`).catch(() => {});
    } else {
      errorB = resB.reason;
      log(`[PARALLEL] Task B (${taskB.id}) failed: ${resB.reason && resB.reason.message || resB.reason}`);
    }

    return {
      taskA, taskB,
      resultA, resultB,
      errorA, errorB,
      worktreeA: resultA ? wtA : null,
      worktreeB: resultB ? wtB : null,
      branchA: brA,
      branchB: brB,
      gitRoot,
    };
  } finally {
    // Clean up worktrees for any failed task — successful ones are cleaned up by the supervisor
    // after merge (it needs the worktree alive during review + validation + merge).
    if (!resultA) {
      await gitHelpers.removeWorktree(gitRoot, wtA).catch(() => {});
      // Also delete the branch if nothing was committed (await it — it runs in a cleanup finally).
      if (gitHelpers.git) await gitHelpers.git(gitRoot, ['branch', '-D', brA], { allowFail: true }).catch(() => {});
    }
    if (!resultB) {
      await gitHelpers.removeWorktree(gitRoot, wtB).catch(() => {});
      if (gitHelpers.git) await gitHelpers.git(gitRoot, ['branch', '-D', brB], { allowFail: true }).catch(() => {});
    }
  }
}

/**
 * Merge a completed parallel worktree back into the integration branch and clean up.
 * Called by the supervisor after a task's review + validation pass.
 *
 * @param {string} gitRoot       - main working tree
 * @param {string} integBranch   - integration branch
 * @param {string} worktreePath  - path to the worktree to merge
 * @param {string} branchName    - branch name in that worktree
 * @param {object} gitHelpers    - git helper module
 * @param {Function} log
 */
export async function mergeParallelWorktree(gitRoot, integBranch, worktreePath, branchName, gitHelpers, log) {
  try {
    // Merge the worktree's branch into integration (fast-forward when possible, else no-ff)
    log(`[PARALLEL] Merging ${branchName} into ${integBranch}…`);
    const { code, stderr } = await gitHelpers.git(gitRoot, ['merge', '--no-ff', branchName, '-m', `merge: parallel task ${branchName}`], { allowFail: true });
    if (code !== 0) {
      log(`[PARALLEL] Merge conflict on ${branchName}: ${stderr} — aborting merge`);
      await gitHelpers.git(gitRoot, ['merge', '--abort'], { allowFail: true });
      return false;
    }
    log(`[PARALLEL] Merged ${branchName} successfully`);
    return true;
  } finally {
    // Always remove the worktree and branch after merge attempt
    await gitHelpers.removeWorktree(gitRoot, worktreePath).catch(() => {});
    await gitHelpers.git(gitRoot, ['branch', '-D', branchName], { allowFail: true }).catch(() => {});
  }
}
