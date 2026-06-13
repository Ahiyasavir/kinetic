// control-api.mjs — a THIN, side-effect-free command/query layer for a future desktop control center.
//
// It exposes the engine's state as PLAIN DATA (JSON-serializable) and a few safe control actions,
// always SCOPED TO ONE EXPLICIT WORKSPACE. It does not spawn the loop, print to the console, or hold
// any state of its own — a UI process (or a test) calls these functions and renders/acts on the result.
// Starting/resuming the loop stays with the existing CLI (`supervisor start|run`); this layer covers the
// read-side (picker, queues, budget, logs, verification) + the safe stop/resume flag toggles a UI needs.
//
// Every query takes a Workspace (from workspace-registry) so a UI must pick a workspace FIRST, then act
// — there is no "act on everything" entry point, by design (Goal B/D: explicit workspace per task).
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { loadRegistry, listWorkspaces, selectWorkspace } from './workspace-registry.mjs';
import { summarizeWorkspace } from './workspace.mjs';
import { config as engineConfig } from '../config-loader.mjs';
import { loadState } from './state.mjs';
import { governCycle, detectQuotaMode } from './budget-governor.mjs';
import { ensureBreaker, isTripped } from './circuit-breaker.mjs';
import { nowIso } from './state.mjs';
import { addInboxTask } from './inbox.mjs';

// ── Workspace discovery (the picker) ────────────────────────────────────────
export function getWorkspaces(opts = {}) {
  const registry = loadRegistry(opts);
  return { defaultId: registry.defaultId, warnings: registry.warnings, workspaces: listWorkspaces(registry) };
}

export function getWorkspace(id, opts = {}) {
  const registry = loadRegistry(opts);
  return selectWorkspace(registry, id); // throws on unknown id (no silent fallback)
}

function countQueue(q) { return Array.isArray(q) ? q.length : 0; }
function taskSummary(t) {
  return { id: t.id, title: t.title, goal: t.goal, risk: t.risk ?? null, status: t.status || null,
    blockReason: t.blockReason || null, userRequested: !!t.userRequested };
}

// Load a workspace's state, or null when it has never run (no state.json yet).
async function loadWsState(ws) {
  if (!existsSync(ws.statePath)) return null;
  try { return await loadState(ws.statePath); } catch { return null; }
}

// ── Status snapshot (header card: cycle, status, queues, budget, breaker, stop flag) ──
export async function getStatus(ws, config = engineConfig) {
  const stopRequested = existsSync(ws.queuePaths.stopFlag);
  const state = await loadWsState(ws);
  if (!state) {
    return { workspace: summarizeWorkspace(ws), exists: false, stopRequested,
      quotaMode: detectQuotaMode(config, ws.budgetScope), at: nowIso() };
  }
  ensureBreaker(state);
  const gov = governCycle(state, config, ws.budgetScope);
  return {
    workspace: summarizeWorkspace(ws),
    exists: true,
    stopRequested,
    quotaMode: gov.quotaMode,
    status: state.status || null,
    cycle: state.cycle || 0,
    goalPhase: state.goalPhase || null,
    queues: {
      backlog: countQueue(state.queues?.backlog),
      done: countQueue(state.queues?.done),
      blocked: countQueue(state.queues?.blocked),
    },
    budget: {
      action: gov.action, reason: gov.reason, quotaMode: gov.quotaMode, safeMode: gov.safeMode,
      spent: gov.spent, quota: gov.quota, usable: gov.usable, projected: gov.projected,
      cyclesLeft: gov.cyclesLeft, fractionUsed: gov.fractionUsed,
    },
    breaker: { tripped: isTripped(state), reason: state.circuitBreaker?.reason || null },
    at: nowIso(),
  };
}

// ── Queue view ──────────────────────────────────────────────────────────────
export async function getQueues(ws) {
  const state = await loadWsState(ws);
  if (!state) return { workspace: ws.id, exists: false, backlog: [], done: [], blocked: [] };
  const q = state.queues || {};
  return {
    workspace: ws.id, exists: true,
    backlog: (q.backlog || []).map(taskSummary),
    done: (q.done || []).map(taskSummary),
    blocked: (q.blocked || []).map(taskSummary),
  };
}

// ── Budget / usage display ───────────────────────────────────────────────────
export async function getBudget(ws, config = engineConfig) {
  const state = await loadWsState(ws);
  const base = state || { usage: {} };
  const gov = governCycle(base, config, ws.budgetScope);
  const u = base.usage || {};
  return {
    workspace: ws.id, budgetScope: ws.budgetScope, quotaMode: gov.quotaMode, safeMode: gov.safeMode,
    action: gov.action, spent: gov.spent, quota: gov.quota, usable: gov.usable,
    projected: gov.projected, cyclesLeft: gov.cyclesLeft, fractionUsed: gov.fractionUsed,
    usage: { cycles: u.cycles||0, costUsd: u.costUsd||0, inputTokens: u.inputTokens||0, outputTokens: u.outputTokens||0, cacheReadTokens: u.cacheReadTokens||0, cacheCreationTokens: u.cacheCreationTokens||0 },
  };
}

// ── Recent activity (logs/verification results) — tail of the decision log if present ──
export async function getActivity(ws, n = 20) {
  const state = await loadWsState(ws);
  if (!state || !Array.isArray(state.history)) return { workspace: ws.id, history: [] };
  return { workspace: ws.id, history: state.history.slice(-n) };
}

// ── Safe control actions (pause / resume). Start/run remain with the CLI. ──
// requestStop writes the workspace's STOP flag; the supervisor honors it at the next cycle boundary —
// a graceful, restart-surviving pause that never kills in-flight work mid-step.
export function requestStop(ws, reason = 'stop requested via control API') {
  writeFileSync(ws.queuePaths.stopFlag, `${reason} @ ${nowIso()}`, 'utf8');
  return { workspace: ws.id, stopRequested: true };
}

export function clearStop(ws) {
  try { if (existsSync(ws.queuePaths.stopFlag)) rmSync(ws.queuePaths.stopFlag); } catch { /* best effort */ }
  return { workspace: ws.id, stopRequested: existsSync(ws.queuePaths.stopFlag) };
}

export function isStopRequested(ws) {
  return existsSync(ws.queuePaths.stopFlag);
}

// ── Task input (UI → the workspace's inbox) ──────────────────────────────────
// Drops a user task into the SELECTED workspace's own inbox dir (per-workspace isolation: a task can
// never land in another workspace's queue). The supervisor ingests it at the next cycle as a
// high-priority user task. Returns the created file path.
export async function addTask(ws, text, stampMs) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('empty task text');
  const file = await addInboxTask(ws.queuePaths.inboxDir, clean, stampMs);
  return { workspace: ws.id, file };
}
