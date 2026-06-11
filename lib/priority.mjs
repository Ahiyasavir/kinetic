// priority.mjs — Stage 2: smart prioritization + background execution + dependency eligibility.
//
// Adds a strict 3-band task priority — "high" | "medium" | "background" — on top of the existing
// product-first score. The rule (Task 2.3): the engine STRICTLY exhausts all high + medium work before
// it ever touches background work (refactors, test-writing, docs); background tasks are only fetched
// when no high/medium task is eligible (the foreground backlog is empty or every remaining foreground
// task is waiting on an unmet dependency).
//
// It also owns DEPENDENCY ELIGIBILITY: a task whose `deps` (prerequisite task ids) are not all complete
// is not selectable yet. This is what makes the Architect's decomposed sub-task chains (parent_task_id +
// deps) sequence correctly — a sub-task can't be picked before the slices it builds on.
//
// DESIGN: this module is pure and standalone (no import of score.mjs) to avoid a cycle — score.mjs
// imports the rank constants from here, not the other way round. The "cleanup → background" inference
// (which needs isCleanup) lives in score.mjs (effectiveTaskPriority), which composes normalizePriority
// from here. So the precedence is: explicit task.priority  →  cleanup heuristic (score.mjs)  →  medium.

export const PRIORITIES = Object.freeze(['high', 'medium', 'background']);

// Lower rank = picked first. Used as a strict gate that sits ABOVE the numeric score in the comparator.
export const PRIORITY_RANK = Object.freeze({ high: 0, medium: 1, background: 2 });

// Coerce any value to a valid priority band; unknown/empty → 'medium' (the neutral default, so a task
// with no explicit priority behaves exactly as before relative to its peers — only an explicit
// 'background' is demoted, keeping this change backward compatible for the existing backlog).
export function normalizePriority(p) {
  const v = String(p || '').trim().toLowerCase();
  return PRIORITIES.includes(v) ? v : 'medium';
}

// The prerequisite task ids that must be complete before this task is eligible. We gate on `deps`
// (the ordering edges between sibling sub-tasks). `parent_task_id` is the epic/grouping pointer (the
// macro-vision task is decomposed, never implemented), so it is NOT a gating prerequisite.
export function taskPrereqs(task) {
  const deps = Array.isArray(task && task.deps) ? task.deps : [];
  return [...new Set(deps.map((d) => String(d)).filter(Boolean))];
}

// True when every prerequisite of `task` is in `doneIds` (a Set or array of completed task ids). A task
// with no deps is always eligible — so the existing backlog (deps: []) is unaffected.
export function arePrereqsMet(task, doneIds) {
  const done = doneIds instanceof Set ? doneIds : new Set((doneIds || []).map((d) => String(d)));
  return taskPrereqs(task).every((d) => done.has(d));
}

// Strict comparator over priority band only (no score). Returns <0 if a should come before b.
export function comparePriorityRank(a, b) {
  return (PRIORITY_RANK[normalizePriority(a && a.priority)] ?? 1) -
         (PRIORITY_RANK[normalizePriority(b && b.priority)] ?? 1);
}

/**
 * Partition a candidate pool into the band the SELECTOR is allowed to draw from this cycle, enforcing
 * the strict-exhaustion rule with dependency eligibility.
 *
 *   1. Drop tasks whose deps aren't complete (not eligible yet).
 *   2. From the eligible set, take the FOREGROUND tasks (high + medium). User-requested tasks are always
 *      foreground regardless of band.
 *   3. Only if NO foreground task is eligible do we fall through to the eligible BACKGROUND tasks.
 *
 * @param {Array<object>} tasks      candidate tasks
 * @param {Set<string>|Array} doneIds completed task ids
 * @param {(t:object)=>string} [priorityOf] band resolver (default: explicit priority → 'medium');
 *        callers pass score.mjs#effectiveTaskPriority so cleanup tasks fold into 'background'.
 * @returns {{ pool: object[], band: 'foreground'|'background'|'none', eligible: object[], waiting: object[] }}
 */
export function selectablePool(tasks, doneIds, priorityOf = (t) => normalizePriority(t && t.priority)) {
  const list = Array.isArray(tasks) ? tasks : [];
  const done = doneIds instanceof Set ? doneIds : new Set((doneIds || []).map((d) => String(d)));
  const eligible = list.filter((t) => arePrereqsMet(t, done));
  const waiting = list.filter((t) => !arePrereqsMet(t, done));
  const isForeground = (t) => (t && t.userRequested) || priorityOf(t) !== 'background';
  const foreground = eligible.filter(isForeground);
  if (foreground.length) return { pool: foreground, band: 'foreground', eligible, waiting };
  const background = eligible.filter((t) => !isForeground(t));
  if (background.length) return { pool: background, band: 'background', eligible, waiting };
  return { pool: [], band: 'none', eligible, waiting };
}
