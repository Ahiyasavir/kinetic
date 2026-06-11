// files.mjs — regenerate the human-readable markdown mirrors from state.json after every cycle.
// state.json is authoritative; these .md files are never parsed back, only written.
import { writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';

function taskLine(t) {
  const d = t.dims || {};
  const dims = `U${d.userImpact ?? '?'} A${d.adminImpact ?? '?'} R${d.reliability ?? '?'} P${d.productRisk ?? '?'} C${d.cleanupValue ?? '?'}`;
  const tag = `${dims} · risk ${t.risk}/effort ${t.effort}`;
  return `- **${t.id}** [${t.goal}] ${t.title}  _(${tag})_${t.notes ? `\n    - ${t.notes}` : ''}`;
}

export async function writeMirrors(stateDir, state) {
  const backlog = `# Backlog (task queue)\n\n_Generated from state.json · ${state.lastUpdated || ''}_\n\n` +
    `Goal phase: **${state.goalPhase}**. ${state.queues.backlog.length} task(s) queued.\n\n` +
    (state.queues.backlog.length ? state.queues.backlog.map(taskLine).join('\n') : '_(empty — selector will top up next cycle)_') +
    '\n';

  const done = `# Done (completed queue)\n\n_Generated from state.json_\n\n` +
    `${state.queues.done.length} completed · ${state.stats.cyclesRun} cycles run.\n\n` +
    (state.queues.done.length
      ? state.queues.done.map((t) => `- **${t.id}** [${t.goal}] ${t.title}  _(cycle ${t.doneCycle ?? '?'})_`).join('\n')
      : '_(none yet)_') + '\n';

  const blocked = `# Blocked queue\n\n_Generated from state.json_\n\n` +
    (state.queues.blocked.length
      ? state.queues.blocked.map((t) => `- **${t.id}** [${t.goal}] ${t.title}\n    - reason: ${t.blockReason || 'unspecified'}`).join('\n')
      : '_(none)_') + '\n';

  await writeFile(path.join(stateDir, 'backlog.md'), backlog, 'utf8');
  await writeFile(path.join(stateDir, 'done.md'), done, 'utf8');
  await writeFile(path.join(stateDir, 'blocked.md'), blocked, 'utf8');
}

// Append one decision-log entry per cycle (the running narrative — never overwritten).
export async function appendDecision(stateDir, entry) {
  const block =
    `\n## Cycle ${entry.cycle} — ${entry.ts}\n` +
    `- **Task:** ${entry.taskId} — ${entry.title}\n` +
    `- **Goal phase:** ${entry.goalPhase}\n` +
    `- **Why chosen:** ${entry.rationale}\n` +
    (entry.whyBeatAlternatives ? `- **Why it beat the alternatives:** ${entry.whyBeatAlternatives}\n` : '') +
    (entry.visibleValue ? `- **Visible value added:** ${entry.visibleValue}\n` : '') +
    (entry.safeToContinue !== undefined ? `- **Safe to continue:** ${entry.safeToContinue ? 'yes' : 'NO — needs attention'}\n` : '') +
    (entry.downgradedFrom ? `- **Downgraded from:** ${entry.downgradedFrom} (risk reduction)\n` : '') +
    (entry.score ? `- **Product score:** ${entry.score}\n` : '') +
    (entry.implementerModel ? `- **Implementer model:** ${entry.implementerModel}\n` : '') +
    `- **Validation:** ${entry.validation}\n` +
    `- **Review verdict:** ${entry.verdict}${entry.reviseAttempts ? ` (after ${entry.reviseAttempts} revision pass(es))` : ''}\n` +
    `- **Outcome:** ${entry.outcome}\n` +
    (entry.proof
      ? `- **USER IMPACT SUMMARY:** ${entry.proof.userImpact}\n` +
        `- **WHAT IS NOW LIVE:** ${entry.proof.nowLive}\n` +
        `- **WHAT A PLAYER SEES DIFFERENTLY:** ${entry.proof.playerSees}\n`
      : '') +
    (entry.evidence ? `- **File-level diff:**\n\n    ${entry.evidence}\n\n` : '') +
    (entry.notes ? `- **Notes:** ${entry.notes}\n` : '');
  await appendFile(path.join(stateDir, 'decision_log.md'), block, 'utf8');
}

export async function ensureDecisionLogHeader(stateDir, state) {
  const header = `# Decision Log\n\n_RushPoint Kinetic — autonomous improvement run started ${state.startedAt}, ` +
    `deadline ${state.deadlineAt}._\n\nOne entry per cycle: what was chosen and why, plus the outcome.\n`;
  await writeFile(path.join(stateDir, 'decision_log.md'), header, 'utf8');
}
