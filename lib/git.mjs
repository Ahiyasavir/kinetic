// git.mjs — thin git helpers. Guarantees the integration branch only advances via reviewed merges.
import { execFile } from 'node:child_process';
import path from 'node:path';

function git(cwd, args, { allowFail = false } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !allowFail) return reject(new Error(`git ${args.join(' ')}: ${stderr || err.message}`));
      resolve({ code: err ? err.code || 1 : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

export async function currentBranch(cwd) {
  const { stdout } = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return stdout.trim();
}

export async function branchExists(cwd, name) {
  const { code } = await git(cwd, ['rev-parse', '--verify', '--quiet', name], { allowFail: true });
  return code === 0;
}

export async function isClean(cwd) {
  const { stdout } = await git(cwd, ['status', '--porcelain']);
  return stdout.trim() === '';
}

// Ensure the integration branch exists (created off baseBranch) and is checked out, working tree clean.
export async function ensureIntegrationBranch(cwd, integration, base) {
  if (!(await isClean(cwd))) {
    // Stash stray *tracked* changes so the supervisor starts from a clean tree.
    // NOTE: no `-u` — we must never stash untracked files (that would hide the autopilot/ dir
    // itself before it is committed, breaking prompt/lib reads mid-run).
    await git(cwd, ['stash', 'push', '-m', 'kinetic-autostash'], { allowFail: true });
  }
  if (!(await branchExists(cwd, integration))) {
    const baseRef = (await branchExists(cwd, base)) ? base : await currentBranch(cwd);
    await git(cwd, ['branch', integration, baseRef], { allowFail: true });
  }
  await git(cwd, ['checkout', integration]);
}

// Commit any uncommitted work left in the tree (the implementer may forget, or hit its turn limit
// mid-task). `-e kinetic` is unnecessary here — autopilot/state is gitignored and tooling is
// already committed — but we exclude nothing else so the implementer's app changes are captured.
// Returns true if a commit was made.
export async function commitAllIfDirty(cwd, message) {
  const { stdout } = await git(cwd, ['status', '--porcelain']);
  if (stdout.trim() === '') return false;
  await git(cwd, ['add', '-A']);
  const res = await git(cwd, ['commit', '-m', message], { allowFail: true });
  return res.code === 0;
}

export async function revParse(cwd, ref = 'HEAD') {
  const { stdout } = await git(cwd, ['rev-parse', ref]);
  return stdout.trim();
}

export async function resetHard(cwd, sha) {
  // SAFETY GUARD: only roll back to `sha` if it is an ANCESTOR of the current HEAD. A stale baseSha
  // persisted in state.json (from a cycle that ran before later commits) must NEVER rewind the branch
  // past legitimate work — that silently destroyed committed tooling/state twice. If `sha` is not an
  // ancestor, just discard the working-tree changes (reset --hard HEAD) instead of time-travelling.
  if (sha) {
    const anc = await git(cwd, ['merge-base', '--is-ancestor', sha, 'HEAD'], { allowFail: true });
    if (anc.code !== 0) {
      await git(cwd, ['reset', '--hard', 'HEAD'], { allowFail: true });
      await git(cwd, ['clean', '-fd', '-e', 'kinetic'], { allowFail: true });
      return;
    }
  }
  await git(cwd, ['reset', '--hard', sha || 'HEAD'], { allowFail: true });
  await git(cwd, ['clean', '-fd', '-e', 'kinetic'], { allowFail: true });
}

// Snapshot-and-reset model: work happens directly on the integration branch (no cycle branches,
// which raced with the implementer's own git in a shared worktree). Ensure we're on integration
// and clean, then the caller snapshots HEAD; on failure the caller resets --hard back to it.
export async function ensureOnIntegration(cwd, integration) {
  await git(cwd, ['checkout', integration], { allowFail: true });
  await git(cwd, ['reset', '--hard'], { allowFail: true });
  await git(cwd, ['clean', '-fd', '-e', 'kinetic'], { allowFail: true });
}

// Return to the integration branch after the implementer ran, keeping any uncommitted working-tree
// changes (so they can be committed on integration). If the implementer switched branches, this
// brings us back; uncommitted edits carry across a clean checkout.
export async function checkoutIntegrationKeepingWork(cwd, integration) {
  const cur = await currentBranch(cwd);
  if (cur !== integration) await git(cwd, ['checkout', integration], { allowFail: true });
}

export async function diffAgainst(cwd, ref) {
  const { stdout } = await git(cwd, ['diff', '--stat', ref + '...HEAD'], { allowFail: true });
  return stdout;
}

// Plain list of changed file paths (one per line) between `ref` and HEAD. Unlike the --stat
// output from diffAgainst (a human-readable churn report), this is machine-parseable: each
// line is exactly a repo-relative path, with renames reported as the new path. Used by the
// doc-sync audit, which needs clean paths, not the +/- bar graph.
export async function changedFilesAgainst(cwd, ref) {
  const { stdout } = await git(cwd, ['diff', '--name-only', ref + '...HEAD'], { allowFail: true });
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

export async function hasCommitsBeyond(cwd, ref, branch) {
  const { stdout } = await git(cwd, ['rev-list', '--count', `${ref}..${branch}`], { allowFail: true });
  return Number(stdout.trim()) > 0;
}

// ── Worktree management (U-35) ──────────────────────────────────────────────────────────────────
// Config-driven git-worktree support so the kinetic can manage an isolated checkout of any target
// repository/branch (resolved by lib/git-config-loader.mjs) instead of operating in-place. Purely
// additive — the default RushPoint config configures no worktree, so none of this runs for that run.

// Raw `git worktree list --porcelain` output for the repo at `cwd`.
export async function listWorktrees(cwd) {
  const { stdout } = await git(cwd, ['worktree', 'list', '--porcelain'], { allowFail: true });
  return stdout;
}

// True when a worktree is already registered at `worktreePath` (path-normalized comparison).
export async function worktreeExists(cwd, worktreePath) {
  const want = path.resolve(worktreePath);
  const out = await listWorktrees(cwd);
  return out.split('\n').some((line) =>
    line.startsWith('worktree ') && path.resolve(line.slice('worktree '.length).trim()) === want);
}

// Ensure a worktree for `branch` exists at `worktreePath`, creating the branch off `base` if missing.
// Idempotent — returns true if it created the worktree, false if it already existed.
export async function ensureWorktree(cwd, worktreePath, branch, base) {
  if (await worktreeExists(cwd, worktreePath)) return false;
  if (await branchExists(cwd, branch)) {
    await git(cwd, ['worktree', 'add', worktreePath, branch]);
  } else {
    const baseRef = base && (await branchExists(cwd, base)) ? base : await currentBranch(cwd);
    await git(cwd, ['worktree', 'add', '-b', branch, worktreePath, baseRef]);
  }
  return true;
}

// Detach + remove a managed worktree (best-effort). Leaves the branch and primary tree intact.
export async function removeWorktree(cwd, worktreePath) {
  await git(cwd, ['worktree', 'remove', '--force', worktreePath], { allowFail: true });
}
