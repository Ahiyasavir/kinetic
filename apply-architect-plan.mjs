// apply-architect-plan.mjs — one-shot: splice the Architect blueprint into state.json.
// Reads autopilot/state/architect-plan-review.json (produced by run-architect-once.mjs),
// loads the live state.json, calls applyArchitectPlanToState, and saves. No API calls, no
// model invocation — pure in-process state mutation. Safe to re-run: if the epic is already
// in the backlog it reports "already-decomposed" and writes nothing.
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { queuePaths } from './config-loader.mjs';
import { loadState, saveState, emptyState } from './lib/state.mjs';
import { applyArchitectPlanToState } from './lib/architect.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(queuePaths.stateDir, 'state.json');
const REVIEW_PATH = path.join(__dirname, 'state', 'architect-plan-review.json');

async function main() {
  if (!existsSync(REVIEW_PATH)) {
    throw new Error(`Review file not found: ${REVIEW_PATH}\nRun node autopilot/run-architect-once.mjs first.`);
  }

  const review = JSON.parse(await readFile(REVIEW_PATH, 'utf8'));
  const { epic, subtasks, warnings = [] } = review;

  if (!epic || !Array.isArray(subtasks) || !subtasks.length) {
    throw new Error('Review file has no subtasks. Re-run run-architect-once.mjs first.');
  }

  console.log(`Blueprint: "${epic.title}" — ${subtasks.length} sub-tasks (generated ${review.generatedAt})`);

  let state;
  if (existsSync(STATE_PATH)) {
    state = await loadState(STATE_PATH);
    const bl = (state.queues?.backlog || []).length;
    const dn = (state.queues?.done || []).length;
    console.log(`Loaded state.json  cycle=${state.cycle || 0}  backlog=${bl}  done=${dn}`);
  } else {
    state = emptyState();
    console.log('No state.json found — starting from empty state.');
  }

  const result = applyArchitectPlanToState(state, epic.id, { epic, subtasks });

  if (result.skipped) {
    console.log(`\n⚠️  Already applied — epic ${result.epicId} found in backlog (${result.skipped}).`);
    console.log('   Nothing written. If you want to re-apply, remove the epic\'s sub-tasks from state.json first.');
    return;
  }

  await saveState(STATE_PATH, state);

  const backlogNow = (state.queues?.backlog || []).length;
  console.log(`\n✅  Injected ${result.injected} sub-tasks under epic ${result.epicId}.`);
  console.log(`   Backlog is now ${backlogNow} tasks.`);
  console.log(`   State saved → ${path.relative(process.cwd(), STATE_PATH)}`);
  if (warnings.length) {
    for (const w of warnings) console.log(`   ⚠️  ${w}`);
  }

  // Print the dependency wave summary so it's visible in the terminal output.
  console.log('\nBacklog head (first 10 tasks in injection order):');
  const head = state.queues.backlog.slice(0, 10);
  for (const t of head) {
    const depStr = t.deps?.length ? ` ← [${t.deps.join(', ')}]` : '';
    console.log(`  ${t.id}  [${t.priority}/${t.goal}]  ${t.title}${depStr}`);
  }
}

main().catch((e) => { console.error(`\nError: ${e.message}`); process.exit(1); });
