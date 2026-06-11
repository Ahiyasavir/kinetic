// architect.mjs — Stage 2: Architect Mode (the Fable-5 "mastermind" decomposition pipeline).
//
// A MACRO-VISION prompt ("Build a real-time chat app from scratch") must NOT go to the per-cycle
// implementer — one cycle can't ship a whole product. Instead the supervisor routes it to the Architect
// (core/architect/), which invokes the PREMIUM tier (Fable 5 — long-context multi-step planning) to map
// the architecture and return a structured plan. THIS module is the pure, deterministic half: it detects
// a macro-vision prompt, validates + normalizes the model's plan into a dependency-ordered backlog of
// 20–40 granular sub-tasks (each with a `parent_task_id` epic pointer and forward-only `deps`), and
// splices them into state.json. Keeping the validation/normalization here (no LLM, no Date.*) makes the
// whole contract unit-testable; the LLM call lives in the core role + the thin supervisor wiring.

import { HANDOFF_SCHEMA_VERSION } from './handoff-schema.mjs';
import { normalizePriority, PRIORITIES } from './priority.mjs';

const DEFAULT_MIN = 20;
const DEFAULT_MAX = 40;

// Macro-vision detector. Two ways to trigger, conservative on purpose so ordinary polish/hardening
// tasks ("build a clearer loading state") never decompose:
//   1. explicit  → an `architect: true` front-matter hint on the inbox task (definitive override).
//   2. heuristic → "from scratch" / "from the ground up" / "greenfield" language, OR "build a <thing>"
//      where <thing> is a whole-product noun (app, platform, system, SaaS, game, …).
const MACRO_PATTERNS = [
  /\bfrom scratch\b/i,
  /\bfrom the ground up\b/i,
  /\bgreenfield\b/i,
  /\b(build|create|scaffold|bootstrap|architect|design)\b[\s\S]{0,60}\b(an?\s+)?(web\s+|mobile\s+|full[\s-]?stack\s+)?(app|application|platform|system|service|saas|website|web ?app|product|game|mvp|backend|codebase|monorepo)\b/i,
];

export function isMacroVision(text, hints = {}) {
  if (hints && hints.architect === true) return true;
  if (hints && hints.architect === false) return false; // explicit opt-out wins over the heuristic
  const t = String(text || '');
  if (t.trim().length < 12) return false;
  return MACRO_PATTERNS.some((re) => re.test(t));
}

function clamp15(n, dflt = 3) { const v = Number(n); return Number.isFinite(v) ? Math.max(1, Math.min(5, Math.round(v))) : dflt; }
function clamp05(n, dflt = 0) { const v = Number(n); return Number.isFinite(v) ? Math.max(0, Math.min(5, Math.round(v))) : dflt; }

function normDims(d = {}, fallback) {
  const f = fallback || { userImpact: 3, adminImpact: 2, reliability: 2, productRisk: 2, cleanupValue: 0 };
  return {
    userImpact: clamp05(d.userImpact, f.userImpact),
    adminImpact: clamp05(d.adminImpact, f.adminImpact),
    reliability: clamp05(d.reliability, f.reliability),
    productRisk: clamp05(d.productRisk, f.productRisk),
    cleanupValue: clamp05(d.cleanupValue, f.cleanupValue),
  };
}

const normTitle = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Validate + normalize a raw Architect plan into an epic + dependency-ordered sub-task backlog.
 *
 * @param {object} raw   the model's handoff: { summary?, architecture?, tasks:[{title, goal?, notes?,
 *                        risk?, effort?, priority?, deps?, dims?, acceptanceCriteria?, implementationHints?}] }
 *                        `deps` entries may reference a sibling by 1-based index, by its final id, or by
 *                        title — all are resolved to final ids and constrained to a forward-only DAG.
 * @param {object} opts  { epicId, cycle, min=20, max=40, vision? } — vision carries goal/userRequested.
 * @returns {{ epic:object, subtasks:object[], warnings:string[] }}
 */
export function normalizeArchitectPlan(raw, opts = {}) {
  const epicId = String(opts.epicId || 'A-1');
  const cycle = opts.cycle ?? 0;
  const min = Number.isInteger(opts.min) ? opts.min : DEFAULT_MIN;
  const max = Number.isInteger(opts.max) ? opts.max : DEFAULT_MAX;
  const vision = opts.vision || {};
  const warnings = [];

  let rawTasks = Array.isArray(raw && raw.tasks) ? raw.tasks.filter((t) => t && String(t.title || '').trim()) : [];
  if (!rawTasks.length) {
    warnings.push('architect plan contained no usable tasks');
    return { epic: buildEpic(epicId, vision, raw, [], cycle), subtasks: [], warnings };
  }

  // Dedup by normalized title (keep first occurrence) so a repeated step doesn't inflate the count.
  const seen = new Set();
  rawTasks = rawTasks.filter((t) => { const k = normTitle(t.title); if (seen.has(k)) return false; seen.add(k); return true; });

  if (rawTasks.length > max) {
    warnings.push(`architect returned ${rawTasks.length} tasks; truncated to max ${max}`);
    rawTasks = rawTasks.slice(0, max); // forward-only deps below means the kept prefix is self-contained
  }
  if (rawTasks.length < min) {
    warnings.push(`architect returned ${rawTasks.length} tasks; fewer than min ${min} (kept as-is)`);
  }

  // First pass — assign final ids + build resolution maps.
  const ids = rawTasks.map((_, i) => `${epicId}.${i + 1}`);
  const idSet = new Set(ids);
  const titleToId = new Map();
  rawTasks.forEach((t, i) => titleToId.set(normTitle(t.title), ids[i]));

  // Resolve one raw dep reference to a sibling's final id (or null if unresolvable).
  const resolveDep = (d) => {
    if (d == null) return null;
    const s = String(d).trim();
    if (idSet.has(s)) return s;                                  // already a final id
    if (/^\d+$/.test(s)) { const n = Number(s); return (n >= 1 && n <= ids.length) ? ids[n - 1] : null; } // 1-based index
    if (typeof d === 'number' && d >= 1 && d <= ids.length) return ids[d - 1];
    const byTitle = titleToId.get(normTitle(s));                  // by (sub)title
    return byTitle || null;
  };

  const subtasks = rawTasks.map((t, i) => {
    const id = ids[i];
    const rawDeps = Array.isArray(t.deps) ? t.deps : (t.deps != null ? [t.deps] : []);
    const deps = [];
    for (const d of rawDeps) {
      const rid = resolveDep(d);
      if (!rid) { warnings.push(`${id}: dropped unresolvable dependency "${d}"`); continue; }
      if (rid === id) { warnings.push(`${id}: dropped self-dependency`); continue; }
      const depIdx = ids.indexOf(rid);
      if (depIdx >= i) { warnings.push(`${id}: dropped forward/cyclic dependency on ${rid}`); continue; } // forward-only DAG
      if (!deps.includes(rid)) deps.push(rid);
    }
    return {
      version: HANDOFF_SCHEMA_VERSION,
      id,
      parent_task_id: epicId,                       // the epic this sub-task decomposes (grouping/traceability)
      goal: String(t.goal || vision.goal || 'gameplay'),
      title: String(t.title).trim().slice(0, 300),
      dims: normDims(t.dims),
      risk: clamp15(t.risk),
      effort: clamp15(t.effort),
      deps,
      priority: PRIORITIES.includes(normalizePriority(t.priority)) ? normalizePriority(t.priority) : 'medium',
      source: 'architect',
      status: 'backlog',
      createdCycle: cycle,
      notes: String(t.notes || '').slice(0, 4000),
      ...(Array.isArray(t.acceptanceCriteria) ? { acceptanceCriteria: t.acceptanceCriteria.map(String).slice(0, 20) } : {}),
      ...(Array.isArray(t.implementationHints) ? { implementationHints: t.implementationHints.map(String).slice(0, 20) } : {}),
    };
  });

  return { epic: buildEpic(epicId, vision, raw, subtasks.map((s) => s.id), cycle), subtasks, warnings };
}

function buildEpic(epicId, vision, raw, subtaskIds, cycle) {
  const arch = raw && (raw.architecture || raw.summary) ? String(raw.architecture || raw.summary).slice(0, 8000) : '';
  return {
    version: HANDOFF_SCHEMA_VERSION,
    id: epicId,
    kind: 'epic',
    goal: 'architecture',
    title: String(vision.title || (raw && raw.summary) || 'Architect plan').slice(0, 300),
    source: 'architect',
    status: 'decomposed',                 // epics are NEVER implemented directly — they are decomposed
    userRequested: !!vision.userRequested,
    subtaskIds,
    createdCycle: cycle,
    notes: arch || String(vision.notes || ''),
  };
}

/**
 * Splice a normalized plan into the live state: convert the original macro-vision task into the epic
 * (status 'decomposed', so it is never picked for implementation), and inject the sub-tasks into the
 * backlog. Idempotent-ish: if the epic was already decomposed, it is a no-op. Returns a small summary.
 */
export function applyArchitectPlanToState(state, visionTaskId, plan) {
  if (!state.queues) state.queues = { backlog: [], done: [], blocked: [] };
  const backlog = state.queues.backlog;
  const idx = backlog.findIndex((t) => t.id === visionTaskId);
  // Remove the original vision task from the backlog (it becomes the epic). Tolerate it already gone
  // (e.g. it was state.current) — the epic still gets recorded.
  if (idx >= 0) backlog.splice(idx, 1);

  // Don't double-inject if this epic already produced sub-tasks.
  const already = backlog.some((t) => t.parent_task_id === plan.epic.id);
  if (already) return { injected: 0, epicId: plan.epic.id, skipped: 'already-decomposed' };

  // Record the epic (for traceability) and inject the sub-tasks at the front so the new product work is
  // worked next, in dependency order (the selector/priority gate handles the actual ordering).
  if (!Array.isArray(state.epics)) state.epics = [];
  if (!state.epics.some((e) => e.id === plan.epic.id)) state.epics.push(plan.epic);
  backlog.unshift(...plan.subtasks);
  return { injected: plan.subtasks.length, epicId: plan.epic.id };
}

/** Build the prompt vars for the architect role from a macro-vision task. */
export function buildArchitectVars(visionTask, opts = {}) {
  const min = Number.isInteger(opts.min) ? opts.min : DEFAULT_MIN;
  const max = Number.isInteger(opts.max) ? opts.max : DEFAULT_MAX;
  return {
    VISION_TITLE: String(visionTask.title || '').slice(0, 300),
    VISION_DETAIL: String(visionTask.notes || '(no extra detail supplied)').slice(0, 8000),
    EPIC_ID: String(visionTask.id || 'A-1'),
    MIN_TASKS: String(min),
    MAX_TASKS: String(max),
    HANDOFF_PATH: opts.handoffPath || 'architect.json',
  };
}

export { DEFAULT_MIN as ARCHITECT_MIN_TASKS, DEFAULT_MAX as ARCHITECT_MAX_TASKS };
