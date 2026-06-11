// token-pacer.mjs — per-project budget pacing, decoupled from token counting (U-33).
//
// Reads the per-project budget limits from config + the running per-project spend from state (kept by
// lib/token-counter.mjs) and answers a single question: is this project still within its budget? Two
// concurrent projects each have their own entry in config.budgets and their own counter in
// state.tokenSpent, so one project exhausting its budget never affects another.
//
// Backward compatible: a project with no configured budget is treated as unconstrained (returns true),
// so the existing cadence-based weekly pacer keeps its exact current behavior until budgets are set.

import { tokensSpent } from './token-counter.mjs';

/**
 * The configured budget for a project, or null when none is set.
 * @param {string} projectId
 * @param {object} config   project config (expects config.budgets[projectId])
 * @returns {{maxTokensPerCycle?:number, maxSpendPerEvent?:number}|null}
 */
export function projectBudget(projectId, config = {}) {
  const budgets = (config && config.budgets) || {};
  return budgets[projectId] || null;
}

/** The effective cumulative token cap for a project (Infinity when no positive cap is configured). */
export function budgetTokenCap(budget) {
  if (!budget) return Infinity;
  const cap = Number(budget.maxTokensPerCycle);
  return Number.isFinite(cap) && cap > 0 ? cap : Infinity;
}

/**
 * True when the project's accumulated token spend is still within its configured budget. A project
 * without a configured (positive) budget is always within budget — pacing falls back to cadence only.
 * @param {string} projectId
 * @param {object} config   project config (config.budgets[projectId])
 * @param {object} state    current state (state.tokenSpent[projectId])
 * @returns {boolean}
 */
export function isWithinBudget(projectId, config = {}, state = {}) {
  const cap = budgetTokenCap(projectBudget(projectId, config));
  if (cap === Infinity) return true;
  return tokensSpent(projectId, state) < cap;
}
