// task-ops.mjs — race-safe task management mutations (delete / retry / bump) driven from the UI.
//
// THE RACE: the supervisor reads state.json at cycle start and writes it at cycle end from an in-memory
// copy. A UI that edits state.json mid-cycle would have its edit overwritten by that end-of-cycle save.
//
// THE FIX (mirrors the inbox pattern): every op is appended to `<stateDir>/task-ops.json`. The op is
// applied immediately to state.json for instant feedback when the engine is idle/paused (the common
// case), AND the supervisor drains the same file at the TOP of each cycle and RE-APPLIES it
// idempotently — so if a mid-cycle save clobbered the edit, the next cycle restores it. All ops are
// idempotent (deleting an absent task / bumping a front task / retrying a backlog task are no-ops), so
// double application is harmless.
import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

const OPS_BASENAME = 'task-ops.json';
const MAX_OPS = 500; // backstop so a long-stopped engine can't grow the file without bound

function opsPath(stateDir) { return path.join(stateDir, OPS_BASENAME); }

function readOps(stateDir) {
  const p = opsPath(stateDir);
  if (!existsSync(p)) return [];
  try { const a = JSON.parse(readFileSync(p, 'utf8')); return Array.isArray(a) ? a : []; }
  catch { return []; }
}

function writeOps(stateDir, ops) {
  const p = opsPath(stateDir);
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(ops.slice(-MAX_OPS), null, 2), 'utf8');
  renameSync(tmp, p);
}

/** Append one op ({ op, taskId, at }) to the workspace's task-ops file. */
export function enqueueTaskOp(stateDir, op) {
  const ops = readOps(stateDir);
  ops.push(op);
  writeOps(stateDir, ops);
  return op;
}

/** Remove the ops file (called by the supervisor after it has drained + applied everything). */
export function clearTaskOps(stateDir) {
  const p = opsPath(stateDir);
  try { if (existsSync(p)) rmSync(p); } catch { /* best effort */ }
}

// ── pure appliers (mutate state.queues in place; each returns true if it changed anything) ──
function findIn(list, id) { return list.findIndex((t) => String(t.id) === String(id)); }

function applyDelete(state, taskId) {
  let changed = false;
  for (const key of ['backlog', 'blocked', 'done']) {
    const list = state.queues?.[key]; if (!Array.isArray(list)) continue;
    const i = findIn(list, taskId);
    if (i >= 0) { list.splice(i, 1); changed = true; }
  }
  return changed;
}

function applyRetry(state, taskId) {
  const blocked = state.queues?.blocked; const backlog = state.queues?.backlog;
  if (!Array.isArray(blocked) || !Array.isArray(backlog)) return false;
  const i = findIn(blocked, taskId);
  if (i < 0) return false;
  const [task] = blocked.splice(i, 1);
  // Reset the failure bookkeeping so the selector treats it as a fresh candidate.
  delete task.blockReason; delete task.cooldownUntilCycle; delete task.baseSha;
  task.attempts = 0; task.status = 'backlog'; task.needsReReview = true;
  backlog.unshift(task);
  return true;
}

function applyBump(state, taskId) {
  const backlog = state.queues?.backlog;
  if (!Array.isArray(backlog)) return false;
  const i = findIn(backlog, taskId);
  if (i <= 0) return false; // absent (−1) or already at front (0) → no-op
  const [task] = backlog.splice(i, 1);
  backlog.unshift(task);
  return true;
}

const APPLIERS = { delete: applyDelete, retry: applyRetry, bump: applyBump };

/** Apply a single op to an in-memory state. Returns true if state changed. */
export function applyTaskOp(state, op) {
  const fn = APPLIERS[op?.op];
  if (!fn) return false;
  return fn(state, op.taskId);
}

/** Apply a list of ops; returns the number that changed state. */
export function applyTaskOps(state, ops) {
  let n = 0;
  for (const op of ops) { if (applyTaskOp(state, op)) n++; }
  return n;
}

/**
 * Supervisor entry-point: read the ops file, apply every pending op to `state` (idempotent), clear the
 * file, and return the list of applied op descriptors (for logging). No-op when the file is absent.
 */
export function drainTaskOps(stateDir, state) {
  const ops = readOps(stateDir);
  if (!ops.length) return [];
  applyTaskOps(state, ops);
  clearTaskOps(stateDir);
  return ops;
}
