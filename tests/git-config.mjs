// git-config.mjs — assertions for config-driven git target resolution + worktree management (U-35).
// Verifies: (1) the RushPoint config (no repository/branch/worktreeName) stays in-place/backward
// compatible; (2) an external-repo config resolves the target repo, branch and sibling worktree path;
// (3) the integration path — the kinetic can initialize and manage a git worktree for a brand-new,
// NON-RushPoint test repository on a configured branch.
//   node autopilot/tests/git-config.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { resolveGitConfig } from '../lib/git-config-loader.mjs';
import * as git from '../lib/git.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const acheck = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

const REPO_ROOT = '/repos/anchor'; // arbitrary anchor for the pure-resolver assertions

// 1) Backward compatible: no git block → in-place on the anchor repo, no worktree, cwd = repository.
check('no git block resolves to the in-place anchor repo (backward compatible)', () => {
  const r = resolveGitConfig({}, REPO_ROOT);
  assert.equal(r.repository, path.resolve(REPO_ROOT));
  assert.equal(r.worktreeName, null);
  assert.equal(r.worktreePath, null);
  assert.equal(r.cwd, path.resolve(REPO_ROOT));
  assert.equal(r.fromConfig, false);
});

// 2) The legacy fields alone (RushPoint config) still resolve in-place; branch falls back to integration.
check('legacy git block (integrationBranch only) stays in-place; branch = integrationBranch', () => {
  const r = resolveGitConfig({ git: { integrationBranch: 'autopilot/topo', baseBranch: 'main', commitPrefix: 'kinetic' } }, REPO_ROOT);
  assert.equal(r.cwd, path.resolve(REPO_ROOT));
  assert.equal(r.worktreeName, null);
  assert.equal(r.branch, 'autopilot/topo');
  assert.equal(r.integrationBranch, 'autopilot/topo');
  assert.equal(r.fromConfig, false); // none of the NEW portability fields are set
});

// 3) An external-repo config resolves the target repo, branch, and a SIBLING worktree path.
check('external repository + branch + worktreeName resolve to absolute paths', () => {
  const r = resolveGitConfig({ git: { repository: '../other-repo', branch: 'main', worktreeName: 'ap-wt' } }, REPO_ROOT);
  assert.equal(r.repository, path.resolve(REPO_ROOT, '../other-repo'));
  assert.equal(r.branch, 'main');
  assert.equal(r.worktreeName, 'ap-wt');
  // worktree is a sibling of the repository (standard git layout), and cwd points at it.
  assert.equal(r.worktreePath, path.resolve(REPO_ROOT, '../other-repo', '..', 'ap-wt'));
  assert.equal(r.cwd, r.worktreePath);
  assert.equal(r.fromConfig, true);
});

// 4) An absolute repository path is honored as-is.
check('absolute repository path is honored', () => {
  const abs = path.resolve('/somewhere/repo');
  const r = resolveGitConfig({ git: { repository: abs } }, REPO_ROOT);
  assert.equal(r.repository, abs);
});

// 5) INTEGRATION: spin up a fresh non-RushPoint git repo and let the engine manage a worktree for it.
await acheck('manages a worktree for a non-RushPoint test repository', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ap-gittest-'));
  const repo = path.join(tmp, 'sample-app');
  try {
    // Build a minimal, totally unrelated repo (no RushPoint anything).
    const run = (args, cwd) => execFileSync('git', args, { cwd, stdio: 'pipe' });
    execFileSync('git', ['init', '-q', repo], { cwd: tmp, stdio: 'pipe' });
    run(['config', 'user.email', 'test@example.com'], repo);
    run(['config', 'user.name', 'Test'], repo);
    run(['symbolic-ref', 'HEAD', 'refs/heads/main'], repo);
    writeFileSync(path.join(repo, 'index.js'), 'console.log("hello from a non-rushpoint app");\n');
    run(['add', '-A'], repo);
    run(['commit', '-q', '-m', 'initial'], repo);

    // Resolve the engine's view of this external repo + a managed feature branch + worktree.
    const r = resolveGitConfig({ git: { repository: repo, branch: 'autopilot/work', worktreeName: 'sample-app-ap' } }, tmp);
    assert.equal(r.repository, path.resolve(repo));
    assert.equal(r.worktreePath, path.resolve(tmp, 'sample-app-ap'));

    // The engine creates the worktree on the configured branch (branch does not exist yet → created off base).
    const created = await git.ensureWorktree(r.repository, r.worktreePath, r.branch, 'main');
    assert.equal(created, true, 'expected the worktree to be created');
    assert.equal(await git.worktreeExists(r.repository, r.worktreePath), true, 'worktree should now exist');
    assert.equal(await git.currentBranch(r.worktreePath), 'autopilot/work', 'worktree is checked out on the configured branch');

    // Idempotent — a second ensure is a no-op (returns false), and the engine can commit work in it.
    assert.equal(await git.ensureWorktree(r.repository, r.worktreePath, r.branch, 'main'), false);
    writeFileSync(path.join(r.worktreePath, 'feature.txt'), 'kinetic change\n');
    assert.equal(await git.commitAllIfDirty(r.worktreePath, 'kinetic: add feature'), true);
    assert.equal(await git.isClean(r.worktreePath), true, 'worktree is clean after commit');

    // And it can be torn down without disturbing the primary repo.
    await git.removeWorktree(r.repository, r.worktreePath);
    assert.equal(await git.worktreeExists(r.repository, r.worktreePath), false, 'worktree removed');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

console.log(`\ngit-config: ${passed} assertion group(s) passed.`);
