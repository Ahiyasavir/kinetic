// score.mjs — product-first weighted task ranking.
// Priority order (by weight): User value > Admin value > Event-day reliability > Product risk > Cleanup.
// Cleanup work scores low by construction and is only chosen when it unblocks product work or fixes
// failing validation (the selector enforces that exception).
//
// Goal/category PRIORITY is now manifest-driven (U-28): the per-goal ranking bonus is sourced from
// autopilot/config/project-manifest.json via lib/manifest-loader.mjs (goalPriority), falling back to
// config.json → scoring.categoryBonus when the manifest doesn't define that goal. The default manifest
// mirrors config.json exactly, so this is behavior-preserving; editing the manifest now re-prioritizes
// candidate tasks without an engine-code change.

import { goalPriority } from './manifest-loader.mjs';
import { PRIORITY_RANK, normalizePriority } from './priority.mjs';

const DIM_LABELS = {
  userImpact: 'improves the player experience',
  adminImpact: 'improves organizer / control-room tooling',
  reliability: 'increases event-day reliability',
  productRisk: 'de-risks the product / event',
  cleanupValue: 'code / docs cleanup'
};

function clamp(n) { return Math.max(0, Math.min(5, Number(n) || 0)); }

export function scoreTask(task, config) {
  const w = config.scoring.weights;
  const d = task.dims || {};
  const contrib = {
    userImpact: w.userImpact * clamp(d.userImpact),
    adminImpact: w.adminImpact * clamp(d.adminImpact),
    reliability: w.reliability * clamp(d.reliability),
    productRisk: w.productRisk * clamp(d.productRisk),
    cleanupValue: w.cleanupValue * clamp(d.cleanupValue)
  };
  // Category-priority bonus: smart stations > builder/admin tools > player flow > social > reliability.
  // Sourced from the project manifest (U-28); falls back to config.json → scoring.categoryBonus for any
  // goal the manifest doesn't define. (`?? ` preserves an explicit 0 priority, e.g. the `structure` goal.)
  const catBonus = goalPriority(task.goal) ?? (config.scoring.categoryBonus || {})[task.goal] ?? 0;
  // USER-REQUESTED override: anything the user dropped in the inbox outranks every auto-generated
  // task by a flat, wide margin. (Ordering AMONG user tasks is by insertion seq and is enforced in
  // rankBacklog, not here, so a high category bonus can't reshuffle the user's intended order.)
  const userBoost = task.userRequested ? 100000 : 0;
  const total = Object.values(contrib).reduce((a, b) => a + b, 0) + catBonus + userBoost;
  // One-line reason = the dimension contributing the most weighted points.
  const top = Object.entries(contrib).sort((a, b) => b[1] - a[1])[0][0];
  const dims = `U${clamp(d.userImpact)} A${clamp(d.adminImpact)} R${clamp(d.reliability)} P${clamp(d.productRisk)} C${clamp(d.cleanupValue)}`;
  return { total, contrib, reason: `${DIM_LABELS[top]} (${dims})` };
}

// A task is "cleanup" when its only real value is tidiness (cleanup dominates and there is no
// meaningful user/admin/reliability value).
export function isCleanup(task) {
  const d = task.dims || {};
  const product = Math.max(clamp(d.userImpact), clamp(d.adminImpact), clamp(d.reliability), clamp(d.productRisk));
  return clamp(d.cleanupValue) >= product && product <= 1;
}

export function isProduct(task) {
  return !isCleanup(task);
}

// The task's effective priority band (Stage 2). Precedence: an explicit task.priority wins; otherwise a
// pure-cleanup task (refactor/test/docs-style tidiness, which already scores low) folds into
// 'background'; everything else is the neutral 'medium'. This is the single source of truth the
// supervisor's selectablePool() and rankBacklog() both use, so foreground/background gating and the
// ranked display never disagree.
export function effectiveTaskPriority(task) {
  if (task && task.priority) return normalizePriority(task.priority);
  return isCleanup(task) ? 'background' : 'medium';
}

// Rank backlog. USER-requested tasks ALWAYS come first, ordered by insertion sequence (the order the
// user added them), independent of score — so category bonuses can never reshuffle the user's intent.
// Everything else ranks by total score; tie-break toward the better experience, then lower effort.
export function rankBacklog(tasks, config) {
  return tasks
    .map((t) => ({ task: t, ...scoreTask(t, config), cleanup: isCleanup(t) }))
    .sort((a, b) => {
      const au = a.task.userRequested ? 1 : 0;
      const bu = b.task.userRequested ? 1 : 0;
      if (au !== bu) return bu - au;                                   // user tasks first
      if (au && bu) {                                                  // among user tasks: earliest first
        return (a.task.userTaskSeq ?? Infinity) - (b.task.userTaskSeq ?? Infinity) ||
               String(a.task.id).localeCompare(String(b.task.id));
      }
      // PRIORITY BAND gate (Stage 2): high before medium before background, ABOVE the numeric score, so
      // a high-scoring background task can never outrank an eligible foreground one. (User tasks already
      // sorted ahead above and never reach here.)
      const ap = PRIORITY_RANK[effectiveTaskPriority(a.task)] ?? 1;
      const bp = PRIORITY_RANK[effectiveTaskPriority(b.task)] ?? 1;
      if (ap !== bp) return ap - bp;
      return b.total - a.total ||
        clamp(b.task.dims?.userImpact) - clamp(a.task.dims?.userImpact) ||
        clamp(b.task.dims?.adminImpact) - clamp(a.task.dims?.adminImpact) ||
        (a.task.effort ?? 3) - (b.task.effort ?? 3);
    });
}

export function productShare(tasks) {
  if (!tasks.length) return 0;
  return tasks.filter(isProduct).length / tasks.length;
}
