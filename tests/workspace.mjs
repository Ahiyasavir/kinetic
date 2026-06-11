// workspace.mjs — assertions for the multi-workspace foundation:
//   • workspace.mjs          — Workspace abstraction, boundary guard, default = existing values
//   • workspace-registry.mjs — registry load/select, explicit selection, graceful fallback
//   • control-api.mjs        — thin UI-facing queries + safe stop/resume flag toggles
// All hermetic: registry tests use a temp file; control-API stop/resume uses a temp state dir.
//   node autopilot/tests/workspace.mjs
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import {
  defaultWorkspace, workspaceFromEntry, withinBoundary, assertWithinBoundary, slugId, summarizeWorkspace,
} from '../lib/workspace.mjs';
import { loadRegistry, listWorkspaces, selectWorkspace } from '../lib/workspace-registry.mjs';
import * as api from '../lib/control-api.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };
const acheck = async (name, fn) => { await fn(); passed++; console.log(`  ✓ ${name}`); };

// ── default workspace = the engine's existing resolved values (backward-compatible anchor) ──
check('default workspace is marked default and roots its runtime under autopilot/state', () => {
  const d = defaultWorkspace();
  assert.equal(d.isDefault, true);
  assert.ok(d.id && typeof d.id === 'string', 'has a stable id (the config-derived repoGoal)');
  // The default keeps the engine's EXISTING state.json location (…/state/state.json), not the
  // per-workspace …/state/workspaces/<id>/ layout — so the live run is untouched.
  assert.ok(d.statePath.replaceAll('\\', '/').endsWith('/state/state.json'), 'default state path is the existing one');
  assert.ok(!d.stateDir.includes(path.join('workspaces')), 'default does not nest under workspaces/');
  assert.equal(d.git.cwd, d.root, 'git cwd is the workspace root');
});

check('KINETIC_GIT_ROOT override is honored by the default workspace', () => {
  const d = defaultWorkspace({ gitRootOverride: path.join(tmpdir(), 'some-worktree') });
  assert.equal(d.root, path.join(tmpdir(), 'some-worktree'));
  assert.equal(d.git.cwd, d.root);
});

// ── named workspace: fully isolated runtime layout ──
check('named workspace isolates state/queues/locks under state/workspaces/<id>', () => {
  const w = workspaceFromEntry({ id: 'demo', root: '../demo-app' });
  assert.equal(w.isDefault, false);
  assert.equal(w.id, 'demo');
  const sd = w.stateDir.replaceAll('\\', '/');
  assert.ok(sd.endsWith('/state/workspaces/demo'), `isolated state dir, got ${sd}`);
  assert.ok(w.statePath.startsWith(w.stateDir), 'state.json under the workspace state dir');
  assert.ok(w.lockPaths.supervisor.startsWith(w.stateDir), 'locks under the workspace state dir');
  assert.ok(w.queuePaths.stopFlag.startsWith(w.stateDir), 'STOP flag under the workspace state dir');
  assert.equal(w.budgetScope, 'demo', 'budget scope defaults to the id');
  assert.deepEqual(w.validation.commands, [], 'foreign workspace defaults to an empty (safe) validation set');
});

check('workspaceFromEntry requires a root', () => {
  assert.throws(() => workspaceFromEntry({ id: 'x' }), /requires a "root"/);
});

// ── per-workspace isolation: NO shared runtime paths between workspaces ──
check('two workspaces share NO state/lock/budget/flag path (isolation invariant)', () => {
  const a = workspaceFromEntry({ id: 'alpha', root: '../alpha' });
  const b = workspaceFromEntry({ id: 'beta', root: '../beta' });
  const d = defaultWorkspace();
  const fields = (w) => [w.stateDir, w.statePath, w.lockPaths.supervisor, w.lockPaths.watchdog,
    w.queuePaths.stopFlag, w.queuePaths.validationCacheFile, w.queuePaths.lessonsPath, w.budgetScope];
  const A = new Set(fields(a)), B = fields(b), D = fields(d);
  for (const x of [...B, ...D]) assert.ok(!A.has(x), `no overlap: ${x}`);
  assert.notEqual(a.budgetScope, b.budgetScope);
  assert.notEqual(a.budgetScope, d.budgetScope);
});

// ── boundary guard ──
check('withinBoundary: root + nested allowed; outside + sibling rejected', () => {
  const w = workspaceFromEntry({ id: 'b', root: '/repo/target' });
  assert.equal(withinBoundary(w, '/repo/target'), true, 'the root itself');
  assert.equal(withinBoundary(w, '/repo/target/src/app.ts'), true, 'nested path');
  assert.equal(withinBoundary(w, '/repo/other'), false, 'sibling repo rejected');
  assert.equal(withinBoundary(w, '/repo/targetX'), false, 'prefix-but-not-nested rejected (no boundary escape)');
  assert.equal(withinBoundary(w, '/etc/passwd'), false, 'unrelated path rejected');
});

check('assertWithinBoundary throws an EngineError for an out-of-boundary path', () => {
  const w = workspaceFromEntry({ id: 'b', root: '/repo/target' });
  assert.doesNotThrow(() => assertWithinBoundary(w, '/repo/target/x'));
  assert.throws(() => assertWithinBoundary(w, '/repo/elsewhere'), /outside workspace "b" write boundary/);
});

check('explicit boundaries widen the allowed set (read ⊇ write)', () => {
  const w = workspaceFromEntry({ id: 'b', root: '/repo/target', boundaries: { read: ['/repo/shared'] } });
  assert.equal(withinBoundary(w, '/repo/shared/lib.ts', 'read'), true, 'extra read dir allowed for read');
  assert.equal(withinBoundary(w, '/repo/shared/lib.ts', 'write'), false, 'but NOT for write');
});

check('slugId is filesystem-safe', () => {
  assert.equal(slugId('My App/Feature 2'), 'my-app-feature-2');
  assert.equal(slugId('  --x--  '), 'x');
});

// ── registry: load + explicit selection + graceful fallback ──
const REG = path.join(mkdtempSync(path.join(tmpdir(), 'rp-reg-')), 'workspaces.json');

check('registry always includes the default even with a file present; entries are added', () => {
  writeFileSync(REG, JSON.stringify({ workspaces: [{ id: 'demo', label: 'Demo', root: '../demo' }] }), 'utf8');
  const reg = loadRegistry({ registryPath: REG });
  const ids = listWorkspaces(reg).map((w) => w.id);
  assert.ok(ids.includes('demo'), 'file entry present');
  assert.ok(ids.some((id) => reg.byId.get(id).isDefault), 'default present');
  assert.ok(ids.length >= 2);
});

check('selectWorkspace: null → default; unknown id → throws (no silent fallback)', () => {
  const reg = loadRegistry({ registryPath: REG });
  assert.equal(selectWorkspace(reg, null).id, reg.defaultId, 'null selects default');
  assert.equal(selectWorkspace(reg, 'demo').id, 'demo');
  assert.throws(() => selectWorkspace(reg, 'nope'), /Unknown workspace "nope"/);
});

check('a file entry duplicating the default id is ignored with a warning', () => {
  const reg0 = loadRegistry({ registryPath: REG });
  writeFileSync(REG, JSON.stringify({ workspaces: [{ id: reg0.defaultId, root: '.' }] }), 'utf8');
  const reg = loadRegistry({ registryPath: REG });
  assert.ok(reg.warnings.some((w) => /duplicates the default/.test(w)), 'duplicate warned');
});

check('missing/corrupt registry → default-only, never throws', () => {
  const missing = loadRegistry({ registryPath: path.join(tmpdir(), 'does-not-exist-xyz.json') });
  assert.equal(missing.workspaces.length, 1, 'only the default');
  writeFileSync(REG, '{ not json', 'utf8');
  const corrupt = loadRegistry({ registryPath: REG });
  assert.equal(corrupt.workspaces.length, 1, 'corrupt file → default only');
  assert.ok(corrupt.warnings.some((w) => /unreadable/.test(w)));
});

// ── control API (UI-facing) ──
await acheck('getWorkspaces returns a picker list including the default', () => {
  const { defaultId, workspaces } = api.getWorkspaces();
  assert.ok(workspaces.some((w) => w.id === defaultId), 'default in the list');
});

await acheck('getStatus on a never-run workspace reports exists:false (no crash)', async () => {
  const w = workspaceFromEntry({ id: 'never-run', root: '../never' });
  const s = await api.getStatus(w);
  assert.equal(s.exists, false);
  assert.equal(s.workspace.id, 'never-run');
  assert.ok(typeof s.quotaMode === 'string', 'quota mode still reported');
});

await acheck('requestStop / clearStop toggle the workspace STOP flag (safe pause control)', async () => {
  const w = workspaceFromEntry({ id: 'stoppable', root: '../stoppable' });
  mkdirSync(w.stateDir, { recursive: true });
  try {
    assert.equal(api.isStopRequested(w), false);
    api.requestStop(w, 'test pause');
    assert.equal(api.isStopRequested(w), true, 'stop flag raised');
    assert.equal(existsSync(w.queuePaths.stopFlag), true);
    api.clearStop(w);
    assert.equal(api.isStopRequested(w), false, 'stop flag cleared');
  } finally {
    rmSync(w.stateDir, { recursive: true, force: true }); // remove ONLY this workspace's own dir
  }
});

await acheck('addTask writes into the workspace OWN inbox (per-workspace task isolation)', async () => {
  const w = workspaceFromEntry({ id: 'taskable', root: '../taskable' });
  mkdirSync(w.stateDir, { recursive: true });
  try {
    const out = await api.addTask(w, 'make the thing better\ngoal: ui');
    assert.equal(out.workspace, 'taskable');
    assert.ok(out.file.startsWith(w.queuePaths.inboxDir), 'task landed in THIS workspace inbox');
    assert.equal(existsSync(out.file), true);
    await assert.rejects(() => api.addTask(w, '   '), /empty task/);
  } finally {
    rmSync(w.stateDir, { recursive: true, force: true });
  }
});

console.log(`\nworkspace: ${passed}/${passed} checks passed ✓`);
