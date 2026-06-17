// core/intent-writer.mjs — U-66: public, named entry point for the intent-anchor step.
//
// Exposes writeIntentLocked() as a standalone callable so the supervisor can confirm the
// intent anchor was written and update state.intent_locked cleanly — decoupled from the
// full runPlanner() pipeline. Also exposes markIntentLocked() to sync the live state flag
// from a planResult object returned by lib/planner.mjs.
//
// Wired: imported + called in supervisor.mjs after the Selector phase completes.
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

function deriveIntent(task) {
  if (task.intent && (Array.isArray(task.intent.must) || task.intent.successSignal)) {
    return {
      must: (Array.isArray(task.intent.must) ? task.intent.must : []).slice(0, 5),
      mustNot: (Array.isArray(task.intent.mustNot) ? task.intent.mustNot : []).slice(0, 3),
      successSignal: task.intent.successSignal || `The task "${task.id}" is complete and verifiable.`,
    };
  }
  const must = Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length
    ? task.acceptanceCriteria.slice(0, 5)
    : [task.title || '(no title)'];
  return {
    must,
    mustNot: [],
    successSignal: task.visibleValue || `The task "${task.id}" is complete and verifiable.`,
  };
}

function formatIntentMd(task, intent) {
  const must = intent.must.map((m) => `- ${m}`).join('\n');
  const mustNot = intent.mustNot.length
    ? intent.mustNot.map((m) => `- ${m}`).join('\n')
    : '- (none specified)';
  return `# Intent anchor — ${task.id}\n` +
    `> Locked at selection. Read-only: the Implementer, Reviewer, and Auditor must NOT modify this file.\n\n` +
    `## must\n${must}\n\n## mustNot\n${mustNot}\n\n## successSignal\n${intent.successSignal}\n`;
}

// Write (or overwrite) the locked intent anchor for `task` into `handoffDir`.
// Idempotent: safe to call even if lib/planner.mjs already wrote the file this cycle.
// Returns { intentPath, intentMd, locked: true }.
export async function writeIntentLocked(task, handoffDir) {
  const intent = deriveIntent(task);
  const intentMd = formatIntentMd(task, intent);
  const intentPath = path.join(handoffDir, `intent-${task.id}.md`);
  await writeFile(intentPath, intentMd, 'utf8');
  return { intentPath, intentMd, locked: true };
}

// Synchronously update state.intent_locked based on the planning-gate result returned by
// runPlanner(). Returns the new value of the flag. Called after runPlanner() completes.
export function markIntentLocked(state, planResult) {
  state.intent_locked = !!(planResult && !planResult.skipped && planResult.intentPath);
  return state.intent_locked;
}
