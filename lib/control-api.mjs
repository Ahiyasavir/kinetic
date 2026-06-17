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
import { governCycle, detectQuotaMode, TIER_QUOTAS } from './budget-governor.mjs';
import { ensureBreaker, isTripped } from './circuit-breaker.mjs';
import { nowIso, saveState } from './state.mjs';
import { addInboxTask } from './inbox.mjs';
import { fiveHourView } from './usage-ledger.mjs';
import { measureUsage } from './usage-reader.mjs';
import { enqueueTaskOp, applyTaskOp } from './task-ops.mjs';
import { selectEntries } from './decision-log.mjs';
import { computeStats } from './cost-stats.mjs';
import { projectWeeklyCost } from './cost-projector.mjs';
import path from 'node:path';

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
// Augments the in-memory copy with TRUE account-wide weekly usage measured from Claude's transcripts
// (lib/usage-reader.mjs) so every read path (status/budget/usage) reflects real usage — including the
// user's interactive sessions on the shared account — without persisting or needing manual calibration.
async function loadWsState(ws) {
  if (!existsSync(ws.statePath)) return null;
  let state;
  try { state = await loadState(ws.statePath); } catch { return null; }
  injectMeasuredUsage(state);
  return state;
}

// In-memory only: measure true weekly + 5h account usage and stash it on state.usage so the governor's
// windowSpend() and the usage card consume it. Scoped to the engine's fixed weekly window when known.
// Best-effort — any failure (no transcripts, read error) leaves the legacy counters untouched.
function injectMeasuredUsage(state) {
  try {
    const u = state.usage || (state.usage = {});
    const weeklyStartMs = u.windowStartedAt ? new Date(u.windowStartedAt).getTime() : undefined;
    const m = measureUsage({ weeklyStartMs });
    if (m.available) {
      u.measuredWeeklyTokens = m.weekly.tokens;
      u.measuredFiveHour = m.fiveHour;        // { tokens, entries, resetAtMs, msLeft }
      u.measuredByModel = m.byModel;
      u.measuredAt = m.at;
    }
  } catch { /* transcripts unavailable — fall back to engine counters */ }
}

// The governor view to DISPLAY. Prefer the decision the last real cycle persisted (state.budget) —
// it carries the live statusline-inferred quota the running supervisor saw. A fresh governCycle() in
// this read-only context lacks that context and can mislabel the quota as 'unknown'/'downgrade', so it
// is only the fallback when nothing has been persisted yet (workspace never ran a cycle). This keeps
// the dashboard's budget numbers identical to `supervisor.mjs status`.
//
// Staleness patch: state.budget.spent is a snapshot from the last cycle's governCycle() call. The
// live usage counters in state.usage continue to accumulate between cycles (and between pauses).
// When both the known quota (from the persisted snapshot) and current counters are available, we
// re-derive spent/fractionUsed so the UI always shows the freshest numbers without losing the
// inferred quota.
function effectiveGov(state, config, budgetScope) {
  const p = state && state.budget;
  if (p && typeof p.spent === 'number' && typeof p.action === 'string') {
    // Re-derive spent from current usage so the display stays fresh between cycles. Prefer the TRUE
    // measured account-wide weekly total (injected by loadWsState); fall back to engine counters.
    if (Number.isFinite(p.quota) && p.quota > 0) {
      const u = (state && state.usage) || {};
      const measured = Number(u.measuredWeeklyTokens);
      const currentSpent = Number.isFinite(measured) && measured > 0
        ? measured
        : (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0) +
          (Number(u.cacheReadTokens) || 0) + (Number(u.cacheCreationTokens) || 0) +
          (Number(u.externalTokenOffset) || 0);
      if (currentSpent !== p.spent) {
        const fractionUsed = currentSpent / p.quota;
        return { ...p, spent: currentSpent, fractionUsed };
      }
    }
    return p;
  }
  return governCycle(state || { usage: {} }, config, budgetScope);
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
  const gov = effectiveGov(state, config, ws.budgetScope);
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
    forecast: state.forecast || null,
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
  const gov = effectiveGov(state, config, ws.budgetScope);
  const u = base.usage || {};
  return {
    workspace: ws.id, budgetScope: ws.budgetScope, quotaMode: gov.quotaMode, safeMode: gov.safeMode,
    action: gov.action, spent: gov.spent, quota: gov.quota, usable: gov.usable,
    projected: gov.projected, cyclesLeft: gov.cyclesLeft, fractionUsed: gov.fractionUsed,
    usage: { cycles: u.cycles||0, costUsd: u.costUsd||0, inputTokens: u.inputTokens||0, outputTokens: u.outputTokens||0, cacheReadTokens: u.cacheReadTokens||0, cacheCreationTokens: u.cacheCreationTokens||0 },
  };
}

// ── Cycle cost analytics (U-66) — per-[goal] and per-[risk] rolling cost averages recorded after every
// completed cycle into state.stats.costHistory[goal][risk]. Side-effect-free read; empty/zeroed when the
// workspace has never run (or cost tracking is disabled, so nothing was recorded). ──
export async function getCostAnalytics(ws) {
  const state = await loadWsState(ws);
  const history = state && state.stats ? state.stats.costHistory : null;
  const stats = computeStats(history);
  return {
    workspace: ws.id,
    byGoal: stats.byGoal,
    byRisk: stats.byRisk,
    totalCycles: stats.totalCycles,
    avgCostPerCycle: stats.avgCostPerCycle,
    projectedWeeklySpend: projectWeeklyCost(stats.avgCostPerCycle),
    variance: stats.variance,
  };
}

// ── Usage / rate-limit windows (the live 5h ledger window + the 7d quota window + any active
// rate-limit cooldown). This is what lets the UI surface the rate-limit state the engine tracks. ──
export async function getUsage(ws, config = engineConfig) {
  const state = await loadWsState(ws);
  const base = state || { usage: {} };
  const gov = effectiveGov(state, config, ws.budgetScope);
  // Prefer the TRUE 5h window measured from Claude's transcripts (account-wide, includes the user's
  // interactive sessions). Fall back to the engine-only ledger when transcripts are unavailable.
  const measured5h = base.usage?.measuredFiveHour;
  const fiveHour = (measured5h && Number.isFinite(measured5h.tokens))
    ? { spentTokens: measured5h.tokens, entries: measured5h.entries, resetAt: measured5h.resetAtMs }
    : fiveHourView(base);                               // self-tracked rolling 5h window (fallback)
  const rl = base.rateLimit || {};
  const pausedUntil = rl.pausedUntil || null;
  const pausedMsLeft = pausedUntil ? Math.max(0, new Date(pausedUntil).getTime() - Date.now()) : 0;
  return {
    workspace: ws.id,
    status: base.status || null,
    sevenDay: {
      spent: gov.spent, quota: gov.quota, usable: gov.usable,
      fractionUsed: gov.fractionUsed, cyclesLeft: gov.cyclesLeft,
      // calibratedResetAt is ground truth (from Claude.ai). After a weekly rollover it is cleared and
      // windowResetAt holds an estimate (prev + 7d). resetIsEstimated lets the UI flag this clearly.
      resetAt: base.usage?.calibratedResetAt || base.usage?.windowResetAt || null,
      resetIsEstimated: !base.usage?.calibratedResetAt || !!base.usage?.windowResetIsEstimated,
      action: gov.action, reason: gov.reason, safeMode: gov.safeMode, quotaMode: gov.quotaMode,
      quotaSource: gov.quotaSource,
    },
    fiveHour: {
      spent: fiveHour.spentTokens, entries: fiveHour.entries,
      resetAt: fiveHour.resetAt, msLeft: Math.max(0, fiveHour.resetAt - Date.now()),
    },
    rateLimit: {
      paused: pausedMsLeft > 0,
      pausedUntil,
      msLeft: pausedMsLeft,
      consecutiveHits: rl.consecutiveHits || 0,
    },
    calibration: base.usage?.calibratedAt ? {
      calibratedAt: base.usage.calibratedAt,
      calibratedPct: base.usage.calibratedPct || null,
      externalOffset: Number(base.usage.externalTokenOffset) || 0,
      calibratedQuota: base.usage.calibratedQuota || null,
      calibratedResetAt: base.usage.calibratedResetAt || null,
    } : null,
    at: nowIso(),
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

// ── Task management ops (delete / retry-blocked / bump-to-top) ────────────────
// Each op is (1) enqueued to the workspace's task-ops file — which the supervisor drains + re-applies
// idempotently at the next cycle start, defeating the mid-cycle save race — and (2) applied to
// state.json immediately for instant feedback when the engine is idle/paused. See lib/task-ops.mjs.
async function runTaskOp(ws, op, taskId) {
  const id = String(taskId || '').trim();
  if (!id) throw new Error('missing taskId');
  const descriptor = { op, taskId: id, at: nowIso() };
  enqueueTaskOp(ws.stateDir, descriptor);                 // durable, race-safe
  const state = await loadWsState(ws);
  let changed = false;
  if (state) {
    changed = applyTaskOp(state, descriptor);             // immediate effect when idle
    if (changed) await saveState(ws.statePath, state);
  }
  return { workspace: ws.id, op, taskId: id, applied: changed, queued: true };
}

export function deleteTask(ws, taskId) { return runTaskOp(ws, 'delete', taskId); }
export function retryTask(ws, taskId)  { return runTaskOp(ws, 'retry', taskId); }
export function bumpTask(ws, taskId)   { return runTaskOp(ws, 'bump', taskId); }

// ── One-time manual calibration (correct for shared-account drift) ────────────
// When the user reads their real usage % from Claude.ai/account and enters it here, we compute
// externalTokenOffset = (reportedSpent − engineTracked) and persist it so the governor's
// windowSpend() sees the true total on every subsequent cycle. Resets automatically on weekly rollover.
//
// Inputs (pass at least one of pctUsed+quota, or spentTokens):
//   pctUsed        — the % shown on Claude's usage page (e.g. 94)
//   quota          — override the quota value if Claude shows a different total (optional)
//   spentTokens    — exact tokens spent (alternative to pctUsed+quota)
//   actualQuota    — the real weekly token quota for this account (e.g. 56_000_000). Persisted to
//                    state.usage.calibratedQuota so resolveQuota() uses it on every subsequent cycle.
//   tier           — shorthand for actualQuota: 'free' (25M), 'pro' (56M), 'max' (200M).
//                    Resolved via TIER_QUOTAS. actualQuota takes precedence if both are provided.
//   resetInMinutes — minutes until the weekly quota window resets (read directly from Claude's usage
//                    page, e.g. "Resets in 15 hr 22 min" → 922). When provided, state.usage.windowResetAt
//                    is corrected to now + resetInMinutes, overriding the stale config-anchored estimate.
//                    This is the ONLY reliable source for the reset time — Anthropic's window is not a
//                    strict 7-day rolling interval from a fixed anchor.
export async function calibrateUsage(ws, { pctUsed, quota, spentTokens, actualQuota, tier, resetInMinutes } = {}) {
  const state = await loadWsState(ws);
  if (!state) throw Object.assign(new Error('engine has not run yet — no state to calibrate'), { http: 409 });

  const u = state.usage || {};
  const engineTracked = (Number(u.inputTokens) || 0) + (Number(u.outputTokens) || 0)
    + (Number(u.cacheReadTokens) || 0) + (Number(u.cacheCreationTokens) || 0);

  // Resolve the calibrated quota from actualQuota / tier (new), or fall through to legacy behavior.
  let calibratedQuota = null;
  if (Number(actualQuota) > 0) {
    calibratedQuota = Math.round(Number(actualQuota));
  } else if (tier && TIER_QUOTAS[String(tier).toLowerCase()]) {
    calibratedQuota = TIER_QUOTAS[String(tier).toLowerCase()];
  }

  // Resolve the quota used for offset math: user-supplied quota → calibratedQuota (just resolved)
  // → persisted from last governor run → hard fallback. CRITICAL: when the account tier changes,
  // the offset MUST be computed against the NEW quota, not the stale 200M config value — otherwise
  // actualSpent = 0.48 × 200M = 96M (wrong) instead of 0.48 × 56M = 27M (correct).
  const knownQuota = Number(quota) > 0 ? Math.round(Number(quota))
    : (calibratedQuota || state.budget?.quota || null);

  // Compute actual spent from user input
  let actualSpent = null;
  if (Number(spentTokens) > 0) {
    actualSpent = Math.round(Number(spentTokens));
  } else if (Number(pctUsed) > 0 && knownQuota) {
    actualSpent = Math.round((Number(pctUsed) / 100) * knownQuota);
  }
  if (!actualSpent || actualSpent <= 0) {
    throw Object.assign(
      new Error('Cannot compute actual spend — provide pctUsed (+ optional quota) or spentTokens'),
      { http: 400 }
    );
  }

  // The offset absorbs everything Claude attributes to this account that the engine didn't track.
  // Clamp to 0 — if the engine over-counted somehow, we don't go negative (that widens the budget).
  const newOffset = Math.max(0, actualSpent - engineTracked);

  if (!state.usage) state.usage = {};
  state.usage.externalTokenOffset = newOffset;
  state.usage.calibratedAt = nowIso();
  state.usage.calibratedPct = Number(pctUsed) || null;
  // Persist the calibrated quota so resolveQuota() picks it up on every subsequent cycle.
  // This survives weekly rollovers (it's the account tier ceiling, not a per-window metric).
  if (calibratedQuota) state.usage.calibratedQuota = calibratedQuota;
  if (quota) state.usage.calibratedQuota = knownQuota;

  // Correct the weekly window reset time when the user provides "resetInMinutes" from Claude's usage
  // page. Anthropic's actual reset window does NOT align to a strict 7-day interval from a fixed
  // config anchor — the only ground truth is what Claude.ai reports. Overwriting windowResetAt here
  // ensures the adaptive cadence and UI "resets in X" display are accurate.
  let correctedResetAt = null;
  if (Number(resetInMinutes) > 0) {
    correctedResetAt = new Date(Date.now() + Number(resetInMinutes) * 60 * 1000).toISOString();
    state.usage.windowResetAt = correctedResetAt;
    state.usage.calibratedResetAt = correctedResetAt; // survives future paceForWeeklyBudget rolls
  }

  // Re-run the governor immediately so state.budget reflects the calibration before the next cycle.
  // CRITICAL: force the known quota into the governor config. governCycle() here has no liveUsage
  // (the statusline is headless-blind) and config.budgetGovernor has no weeklyTokenQuota, so without
  // this override resolveQuota() falls through to Infinity → quotaMode 'unknown' → it would WIPE
  // state.budget.quota to null and fractionUsed to 0 — the exact reason calibration "did nothing".
  // Forcing weeklyTokenQuota = knownQuota makes the governor resolve a 'known' quota and compute
  // fractionUsed = calibratedSpend / knownQuota (e.g. 75%).
  const effectiveQuota = calibratedQuota || knownQuota;
  const calibConfig = effectiveQuota
    ? { ...engineConfig, budgetGovernor: { ...(engineConfig.budgetGovernor || {}), weeklyTokenQuota: effectiveQuota } }
    : engineConfig;
  const gov = governCycle(state, calibConfig, ws.budgetScope);
  state.budget = {
    action: gov.action, reason: gov.reason, spent: gov.spent, quota: gov.quota,
    quotaMode: gov.quotaMode, safeMode: gov.safeMode,
    // Mirror the calibrated quota into the budget block so it is auditable there and survives as a
    // budget-scoped persistence source (resolveQuota honors state.budget.calibratedQuota as a fallback).
    calibratedQuota: gov.calibratedQuota ?? (state.usage.calibratedQuota || null),
    usable: gov.usable, projected: gov.projected, estimate: gov.estimate,
    cyclesLeft: gov.cyclesLeft, fractionUsed: gov.fractionUsed, at: nowIso(),
  };

  await saveState(ws.statePath, state);

  return {
    workspace: ws.id,
    engineTracked,
    externalOffset: newOffset,
    actualSpent,
    quota: effectiveQuota || knownQuota,
    calibratedQuota: calibratedQuota || (state.usage.calibratedQuota || null),
    tier: tier ? String(tier).toLowerCase() : null,
    fractionUsed: gov.fractionUsed,
    action: gov.action,
    calibratedAt: state.usage.calibratedAt,
    windowResetAt: correctedResetAt || state.usage.windowResetAt || null,
  };
}

// ── Cycle state (U-66: intent/plan validation flags for the current cycle) ───────────────────
// Returns the three per-cycle flags set by the supervisor after the planning gate:
//   intent_locked    — true once intent-{taskId}.md was written this cycle
//   plan_validated   — true=Haiku approved, false=rejected, null=skipped/not-yet-run
//   validation_feedback — last validation feedback message
export async function getCycleState(ws) {
  const state = await loadWsState(ws);
  if (!state) {
    return { workspace: ws.id, exists: false, intent_locked: false, plan_validated: null, validation_feedback: '' };
  }
  return {
    workspace: ws.id,
    exists: true,
    cycle: state.cycle || 0,
    intent_locked: state.intent_locked ?? false,
    plan_validated: state.plan_validated ?? null,
    validation_feedback: state.validation_feedback || '',
  };
}

// ── Decision log (parsed per-cycle entries) ──────────────────────────────────
// Reads the workspace's decision_log.md and returns the last `n` entries as summaries (newest first);
// pass a `cycle` to also get that one cycle's FULL parsed entry (so the heavy raw block loads on demand).
export async function getDecisions(ws, { n = 40, cycle = null } = {}) {
  const file = path.join(ws.stateDir, 'decision_log.md');
  let text = '';
  try { text = _readDecisionFile(file); } catch { return { workspace: ws.id, exists: false, count: 0, summaries: [], full: null }; }
  const sel = selectEntries(text, { n, cycle });
  return { workspace: ws.id, exists: true, ...sel };
}

// Isolated for a single try/catch above; uses the already-imported fs reader.
function _readDecisionFile(file) { return readFileSync(file, 'utf8'); }
