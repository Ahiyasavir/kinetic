// architect.mjs — assertions for Stage 2 Architect Mode (the Fable-5 decomposition pipeline).
//   • isMacroVision detection (heuristic + explicit hint override)
//   • normalizeArchitectPlan: id/parent wiring, dep resolution + forward-only DAG, count bounds, dedup
//   • applyArchitectPlanToState: epic swap + sub-task injection + idempotence
//   • provider: 'premium' tier resolves to Fable 5
//   node autopilot/tests/architect.mjs
import assert from 'node:assert/strict';
import {
  isMacroVision, normalizeArchitectPlan, applyArchitectPlanToState, buildArchitectVars,
  ARCHITECT_MIN_TASKS, ARCHITECT_MAX_TASKS,
} from '../lib/architect.mjs';
import { getAdapter } from '../lib/providers/index.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// ── isMacroVision ──────────────────────────────────────────────────────────────
check('isMacroVision detects whole-product prompts', () => {
  assert.equal(isMacroVision('Build a real-time chat app from scratch'), true);
  assert.equal(isMacroVision('Create a SaaS billing platform'), true);
  assert.equal(isMacroVision('Bootstrap a greenfield mobile app'), true);
  assert.equal(isMacroVision('Build an end-to-end inventory system from the ground up'), true);
});
check('isMacroVision ignores ordinary polish/hardening tasks', () => {
  assert.equal(isMacroVision('Build a clearer loading state for the dashboard'), false);
  assert.equal(isMacroVision('Fix the leaderboard tie-breaker'), false);
  assert.equal(isMacroVision('tiny'), false);          // too short
});
check('explicit architect hint overrides the heuristic both ways', () => {
  assert.equal(isMacroVision('Fix a typo', { architect: true }), true);
  assert.equal(isMacroVision('Build a chat app from scratch', { architect: false }), false);
});

// ── normalizeArchitectPlan ───────────────────────────────────────────────────────
const plan = (n, extra = {}) => ({
  summary: 'build it', architecture: 'layers',
  tasks: Array.from({ length: n }, (_, i) => ({ title: `Step ${i + 1}`, goal: 'gameplay', risk: 3, effort: 2 })),
  ...extra,
});

check('assigns epic-scoped ids, parent_task_id, and architect source', () => {
  const { epic, subtasks } = normalizeArchitectPlan(plan(22), { epicId: 'U-3', cycle: 7, vision: { id: 'U-3', title: 'V', userRequested: true } });
  assert.equal(subtasks.length, 22);
  assert.equal(subtasks[0].id, 'U-3.1');
  assert.equal(subtasks[21].id, 'U-3.22');
  assert.ok(subtasks.every((t) => t.parent_task_id === 'U-3' && t.source === 'architect' && t.status === 'backlog' && t.createdCycle === 7));
  assert.equal(epic.id, 'U-3');
  assert.equal(epic.status, 'decomposed');
  assert.equal(epic.userRequested, true);
  assert.equal(epic.subtaskIds.length, 22);
});

check('truncates above max and warns; default count target is 20–40', () => {
  assert.equal(ARCHITECT_MIN_TASKS, 20);
  assert.equal(ARCHITECT_MAX_TASKS, 40);
  const { subtasks, warnings } = normalizeArchitectPlan(plan(50), { epicId: 'A-1', max: 40 });
  assert.equal(subtasks.length, 40);
  assert.ok(warnings.some((w) => /truncated to max 40/.test(w)));
});

check('warns when fewer than min but keeps the tasks', () => {
  const { subtasks, warnings } = normalizeArchitectPlan(plan(5), { epicId: 'A-1', min: 20 });
  assert.equal(subtasks.length, 5);
  assert.ok(warnings.some((w) => /fewer than min 20/.test(w)));
});

check('dedups sub-tasks by normalized title', () => {
  const raw = { tasks: [{ title: 'Setup repo' }, { title: 'setup   REPO' }, { title: 'Add auth' }] };
  const { subtasks } = normalizeArchitectPlan(raw, { epicId: 'A-1' });
  assert.equal(subtasks.length, 2);
});

check('resolves deps by 1-based index, final id, and title — constrained to a forward-only DAG', () => {
  const raw = { tasks: [
    { title: 'Scaffold' },                                   // 1 → A-1.1
    { title: 'Schema', deps: [1] },                          // index ref → A-1.1
    { title: 'API', deps: ['A-1.2', 'Scaffold'] },           // id + title refs
    { title: 'UI', deps: [4, 99, 3] },                       // self (drop) + out-of-range (drop) + valid
  ] };
  const { subtasks, warnings } = normalizeArchitectPlan(raw, { epicId: 'A-1' });
  assert.deepEqual(subtasks[0].deps, []);
  assert.deepEqual(subtasks[1].deps, ['A-1.1']);
  assert.deepEqual(subtasks[2].deps, ['A-1.2', 'A-1.1']);
  assert.deepEqual(subtasks[3].deps, ['A-1.3']);             // self + out-of-range dropped
  assert.ok(warnings.some((w) => /self-dependency/.test(w)));
});

check('drops a forward dependency (keeps the graph acyclic)', () => {
  const raw = { tasks: [{ title: 'A', deps: [2] }, { title: 'B' }] }; // A depends on later B → drop
  const { subtasks, warnings } = normalizeArchitectPlan(raw, { epicId: 'A-1' });
  assert.deepEqual(subtasks[0].deps, []);
  assert.ok(warnings.some((w) => /forward\/cyclic/.test(w)));
});

check('clamps risk/effort/dims and defaults priority to medium', () => {
  const raw = { tasks: [{ title: 'X', risk: 99, effort: 0, priority: 'nonsense', dims: { userImpact: 9 } }] };
  const { subtasks } = normalizeArchitectPlan(raw, { epicId: 'A-1' });
  assert.equal(subtasks[0].risk, 5);
  assert.equal(subtasks[0].effort, 1);
  assert.equal(subtasks[0].dims.userImpact, 5);
  assert.equal(subtasks[0].priority, 'medium');
});

check('honors an explicit background priority on a sub-task', () => {
  const raw = { tasks: [{ title: 'Write tests', priority: 'background' }] };
  const { subtasks } = normalizeArchitectPlan(raw, { epicId: 'A-1' });
  assert.equal(subtasks[0].priority, 'background');
});

// ── applyArchitectPlanToState ────────────────────────────────────────────────────
check('splices the epic in place of the vision task and injects sub-tasks at the front', () => {
  const state = { queues: { backlog: [{ id: 'U-3', title: 'Build app', architect: true }, { id: 'X-1', title: 'other' }], done: [], blocked: [] } };
  const norm = normalizeArchitectPlan(plan(3), { epicId: 'U-3', vision: { id: 'U-3', title: 'Build app', userRequested: true } });
  const res = applyArchitectPlanToState(state, 'U-3', norm);
  assert.equal(res.injected, 3);
  assert.equal(state.queues.backlog.find((t) => t.id === 'U-3'), undefined);  // vision task removed
  assert.deepEqual(state.queues.backlog.slice(0, 3).map((t) => t.id), ['U-3.1', 'U-3.2', 'U-3.3']);
  assert.equal(state.queues.backlog.at(-1).id, 'X-1');                        // existing task preserved
  assert.equal(state.epics[0].id, 'U-3');
});

check('applyArchitectPlanToState is idempotent (no double injection)', () => {
  const state = { queues: { backlog: [{ id: 'U-3', title: 'Build app' }], done: [], blocked: [] }, epics: [] };
  const norm = normalizeArchitectPlan(plan(3), { epicId: 'U-3', vision: { id: 'U-3' } });
  applyArchitectPlanToState(state, 'U-3', norm);
  const second = applyArchitectPlanToState(state, 'U-3', norm);
  assert.equal(second.injected, 0);
  assert.equal(second.skipped, 'already-decomposed');
  assert.equal(state.queues.backlog.filter((t) => t.parent_task_id === 'U-3').length, 3);
});

check('buildArchitectVars maps the vision into prompt vars', () => {
  const vars = buildArchitectVars({ id: 'U-3', title: 'Build chat', notes: 'realtime' }, { min: 20, max: 40 });
  assert.equal(vars.VISION_TITLE, 'Build chat');
  assert.equal(vars.EPIC_ID, 'U-3');
  assert.equal(vars.MIN_TASKS, '20');
  assert.equal(vars.MAX_TASKS, '40');
});

// ── provider: premium tier → Fable 5 ──────────────────────────────────────────────
check("provider 'premium' tier resolves to Fable 5 (config.models.architect)", () => {
  const adapter = getAdapter({ provider: 'claude' });
  assert.equal(adapter.resolveModel('premium', { models: { architect: 'claude-fable-5' } }), 'claude-fable-5');
  assert.equal(adapter.resolveModel('premium', {}), 'claude-fable-5');           // default
  assert.equal(adapter.priceOf({ usage: { input_tokens: 1_000_000, output_tokens: 0 }, model: 'claude-fable-5' }, {}), 55);
});

console.log(`\narchitect: ${passed} checks passed.`);
