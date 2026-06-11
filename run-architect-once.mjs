// run-architect-once.mjs — one-off Architect Mode invocation for backlog-seeding REVIEW.
//
// Runs the REAL Stage-2 Architect pipeline (same prompt template, core role runner, and provider
// adapter the supervisor uses) against a hand-built macro-vision task, then validates/normalizes the
// returned plan — but does NOT splice it into state.json. The normalized blueprint is written to
// state/architect-plan-review.json for human review; a separate ignition step applies it.
//
// Usage:  node autopilot/run-architect-once.mjs
import { writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, queuePaths } from './config-loader.mjs';
import { createCore } from './core/index.mjs';
import { getAdapter } from './lib/providers/index.mjs';
import { resolveModelForRole } from './core/providers.mjs';
import { contextualName } from './lib/handoff-paths.mjs';
import { buildArchitectVars, normalizeArchitectPlan } from './lib/architect.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const PROMPT_DIR = path.join(__dirname, 'prompts');
const HANDOFF_DIR = queuePaths.handoffDir;
const REVIEW_PATH = path.join(__dirname, 'state', 'architect-plan-review.json');

const log = (m) => console.log(m);

// The macro-vision task: Stage 3 Part B (React UI for the Kinetic Tauri Control Center).
const vision = {
  id: 'A-S3B',
  title: 'Stage 3 Part B — React UI for the Kinetic Tauri Control Center',
  userRequested: true,
  goal: 'ui',
  notes: `
Build the complete React/TypeScript frontend for the Kinetic desktop control center inside the
EXISTING Tauri scaffold at autopilot/ui/tauri/ (Part A is DONE: the Rust shell compiles, with 5
commands — start_engine, stop_engine, engine_running, read_config, write_config — plus
tauri-plugin-dialog for the native folder picker; the Node control server ui/server.mjs exposes
GET /api/health,/api/workspaces,/api/status,/api/queues,/api/budget,/api/activity,/api/keys and
POST /api/task,/api/stop,/api/resume,/api/start on 127.0.0.1:4317).

HARD CONSTRAINTS (non-negotiable):
- ADDITIVE ONLY: never modify autopilot/lib/, autopilot/core/, autopilot/tests/, or the engine loop.
  ui/server.mjs is frozen except for genuinely missing read-only endpoints. The standalone browser
  UI at ui/public/index.html must keep working untouched.
- All engine data flows over plain fetch() to http://127.0.0.1:4317 (typed wrappers in src/api/control.ts).
  Tauri invoke() is ONLY for the 5 Rust commands + the plugin-dialog folder picker (src/tauri/commands.ts).
- Secrets never enter the UI: api_pools entries carry key_env (an env-var NAME), never a token value.
- Vanilla React + TypeScript + Vite; no heavy state library (hooks/context only); no graph library
  (the DAG is hand-rolled SVG); keep dependencies minimal.

SCOPE TO DECOMPOSE:
1. Foundation: typed API layer (src/api/control.ts mirroring control-api.mjs result shapes;
   src/tauri/commands.ts wrapping the 5 Rust commands + pick_directory via @tauri-apps/plugin-dialog),
   a usePoll-style refresh hook, app shell with router (Dashboard | Backlog DAG | Settings), dark
   theme matching ui/public/index.html (CSS variables: --bg #0f1115, --panel, --accent #5b8cff, etc.),
   workspace picker in the header, engine start/stop controls backed by the Rust commands with
   /api/health as the liveness probe.
2. Dashboard page: status card (cycle, phase, breaker, stop flag), budget gauge (spent/quota bar,
   action pill, headroom cycles), queue counts, backlog list, recent-activity feed, task-submit box
   (POST /api/task) — a React port of the working vanilla index.html, polling every ~4s.
3. Settings page: read config.json via the read_config Rust command; render api_pools as an editable
   table (id, provider dropdown anthropic|openai|openrouter, key_env text, daily_budget number) with
   add/edit/delete rows; merge live status+spend per key from GET /api/keys (KeyManager snapshot);
   atomic save via write_config (validated JSON, preserve unknown config fields verbatim — parse,
   patch api_pools only, re-serialize); plus read-only display of a few core config fields.
4. Backlog DAG page: fetch /api/queues; group tasks by parent_task_id under epic headers; topological
   lane layout (lane = max(dep lanes)+1) computed in a pure, unit-testable function; render lanes as
   columns of TaskCard nodes (id chip, title, priority color, status pill, risk badge) with SVG lines
   connecting deps; empty/loading states.
5. First-launch wizard: when engine_running=false and /api/health unreachable → 3-step flow
   (pick workspace folder via dialog → run init → add first api_pools entry, reusing the Settings row
   form) then land on Dashboard.
6. Polish/hardening (background priority): error boundaries, toasts, loading skeletons, a pure-function
   unit test for the topological layout (node --test, no UI framework needed), README for ui/tauri/,
   and verifying ui:tauri dev + ui:tauri:build still pass.

Existing files to build on (READ them first): autopilot/ui/tauri/src/ (Vite React-TS scaffold),
autopilot/ui/tauri/src-tauri/src/commands.rs (the IPC contract), autopilot/ui/server.mjs (the HTTP
contract), autopilot/ui/public/index.html (the reference implementation + visual language),
autopilot/lib/control-api.mjs (response shapes), autopilot/lib/key-manager.mjs (snapshot shape).
`.trim(),
};

async function main() {
  const min = config.architect?.minTasks ?? 20;
  const max = config.architect?.maxTasks ?? 40;
  const model = resolveModelForRole('architect', 'premium', config);
  const adapter = getAdapter(config);

  await mkdir(HANDOFF_DIR, { recursive: true });
  // Clear any stale architect handoff so we can't accidentally read an old plan.
  const handoffName = contextualName('architect.json');
  const handoffAbs = path.join(HANDOFF_DIR, handoffName);
  if (existsSync(handoffAbs)) await rm(handoffAbs, { force: true });

  const handoffRel = path.join(path.relative(REPO_ROOT, HANDOFF_DIR), handoffName).replaceAll('\\', '/');

  const core = createCore({
    promptDir: PROMPT_DIR,
    handoffDir: HANDOFF_DIR,
    cwd: REPO_ROOT,
    config,
    runClaude: adapter.run,
    onUsage: (res) => {
      const u = (res && res.usage) || {};
      log(`   usage: in=${u.input_tokens ?? '?'} out=${u.output_tokens ?? '?'} cost=$${res?.costUsd ?? '?'}`);
    },
    log,
    resolveName: contextualName,
  });

  log(`🏛️  ARCHITECT (one-off review run) — model ${model}, target ${min}–${max} sub-tasks`);
  log(`   handoff → ${handoffRel}`);

  const vars = buildArchitectVars(vision, { min, max, handoffPath: handoffRel });
  const plan = await core.runArchitect(vars, model);

  if (!plan || !Array.isArray(plan.tasks) || !plan.tasks.length) {
    console.error('Architect produced no usable plan (handoff missing/empty). Nothing saved.');
    process.exit(1);
  }

  const { epic, subtasks, warnings } = normalizeArchitectPlan(plan, { epicId: vision.id, cycle: 0, min, max, vision });
  for (const w of warnings) log(`   ⚠️ ${w}`);

  await writeFile(REVIEW_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    model,
    vision: { id: vision.id, title: vision.title },
    summary: plan.summary || '',
    architecture: plan.architecture || '',
    epic, subtasks, warnings,
  }, null, 2), 'utf8');

  log('');
  log(`✅ ${subtasks.length} sub-tasks normalized (epic ${epic.id}). NOT applied to state.`);
  log(`   Review file → ${path.relative(REPO_ROOT, REVIEW_PATH)}`);
}

main().catch((e) => { console.error(`Error: ${e.message}`); process.exit(1); });
