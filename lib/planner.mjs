// planner.mjs — U-83: Pre-implementation planning gate.
//
// Two lightweight guards that fire BEFORE the Implementer touches a single file, to stop the
// engine's #1 failure mode: scope drift across revision attempts (the model stops solving the
// original task and starts patching its own broken implementation).
//
//   Deliverable 1 — INTENT ANCHOR (intent-{taskId}.md)
//     Written here from the Selector's output. Read-only afterwards. Holds 3 locked fields:
//     `must` (≤5), `mustNot` (≤3), `successSignal` (1 sentence). The Reviewer reads it FIRST and
//     blocks if any `must` is unmet or any `mustNot` is violated.
//
//   Deliverable 2 — MICRO-PLAN (plan-{taskId}.md)
//     For tasks with risk >= config.planningGate.minRisk only. A cheap model drafts a 5–7 bullet
//     file+action plan from the task + intent, then a Haiku validation call checks the plan against
//     the intent. APPROVE → proceed; REJECT → one revision, then proceed anyway (never blocks).
//
// Wired into supervisor.mjs AFTER the Selector completes and BEFORE the Implementer starts. A full
// no-op (returns early) when config.planningGate.enabled is false, so existing cycles are unchanged.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

// ---------- intent derivation ----------

// Build a structured intent from the Selector's output, falling back to the task's own fields so an
// intent.md is ALWAYS written (acceptance criterion #2) even if the Selector didn't emit one yet.
function deriveIntent(task) {
  if (task.intent && (task.intent.must?.length || task.intent.successSignal)) {
    return {
      must: (task.intent.must || []).slice(0, 5),
      mustNot: (task.intent.mustNot || []).slice(0, 3),
      successSignal: task.intent.successSignal || successFallback(task),
    };
  }
  // Fallback: synthesize from acceptanceCriteria + title.
  const must = (task.acceptanceCriteria && task.acceptanceCriteria.length)
    ? task.acceptanceCriteria.slice(0, 5)
    : [task.title];
  return { must, mustNot: [], successSignal: successFallback(task) };
}

function successFallback(task) {
  return task.visibleValue || `The task "${task.title}" is complete and verifiable.`;
}

// Render the locked intent.md content.
function formatIntentMd(task, intent) {
  const must = intent.must.length ? intent.must.map((m) => `- ${m}`).join('\n') : '- (none specified)';
  const mustNot = intent.mustNot.length ? intent.mustNot.map((m) => `- ${m}`).join('\n') : '- (none specified)';
  return `# Intent anchor — ${task.id}\n` +
    `> Locked at selection. Read-only: the Implementer, Reviewer, and Auditor must NOT modify this file.\n\n` +
    `## must\n${must}\n\n` +
    `## mustNot\n${mustNot}\n\n` +
    `## successSignal\n${intent.successSignal}\n`;
}

// ---------- micro-plan ----------

function buildPlanPrompt(task, intentMd) {
  return `You are drafting a SHORT implementation plan for ONE engineering task. Do NOT write any code.

TASK: ${task.title}
${task.notes ? `NOTES: ${task.notes}\n` : ''}
INTENT ANCHOR (the locked goal — your plan must satisfy every "must" and violate no "mustNot"):
${intentMd}

Write a 5-7 bullet plan. Each bullet = ONE file + ONE action, e.g.:
- lib/planner.mjs — create and export runPlanner()
- supervisor.mjs — call runPlanner after the Selector phase

Reply with ONLY the bullet list (no prose, no headings).`;
}

function buildValidatePrompt(intentMd, planText) {
  return `Check whether this implementation PLAN satisfies the INTENT.

INTENT:
${intentMd}

PLAN:
${planText}

Does the plan cover every "must" item and avoid every "mustNot" item?
Reply with EXACTLY one JSON object, nothing else:
{ "verdict": "APPROVE", "reason": "<one sentence>" }
or
{ "verdict": "REJECT", "reason": "<one sentence naming the missing/violated item>" }`;
}

function parseVerdict(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/\{[^{}]*"verdict"\s*:\s*"(APPROVE|REJECT)"[^{}]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ---------- public API ----------

/**
 * Run the planning gate for a selected task.
 * @param {object}   task       the enriched task (reads task.intent / acceptanceCriteria / risk)
 * @param {string}   handoffDir absolute path to the per-cycle handoff directory
 * @param {object}   config     engine config (reads config.planningGate)
 * @param {Function} invoker    async (prompt, model) => string — host-injected LLM call (metered)
 * @param {Function} [log]      logger
 * @returns {Promise<{intentPath, planPath, planApproved, intentMd, skipped}>}
 */
export async function runPlanner(task, handoffDir, config, invoker, log = () => {}) {
  const cfg = (config && config.planningGate) || {};
  if (cfg.enabled === false) {
    return { intentPath: null, planPath: null, planApproved: null, intentMd: '', skipped: true };
  }

  // 1) INTENT ANCHOR — always written. // planning gate: intent anchor written
  const intent = deriveIntent(task);
  const intentMd = formatIntentMd(task, intent);
  const intentPath = path.join(handoffDir, `intent-${task.id}.md`);
  await writeFile(intentPath, intentMd, 'utf8');
  log(`Planning gate: intent anchor written → intent-${task.id}.md (${intent.must.length} must, ${intent.mustNot.length} mustNot).`);

  // 2) MICRO-PLAN — only for risk >= minRisk.
  const minRisk = cfg.minRisk ?? 3;
  const risk = Number(task.risk) || 0;
  if (risk < minRisk) {
    log(`Planning gate: micro-plan skipped (risk ${risk} < minRisk ${minRisk}).`);
    return { intentPath, planPath: null, planApproved: null, intentMd, skipped: false };
  }

  const model = cfg.model || (config.models && config.models.auditor) || 'claude-haiku-4-5';
  let planText = '';
  let planApproved = null;
  try {
    // Draft the plan.
    planText = (await invoker(buildPlanPrompt(task, intentMd), model) || '').trim();
    if (!planText) {
      log('Planning gate: planner produced no plan — proceeding without micro-plan.');
      return { intentPath, planPath: null, planApproved: null, intentMd, skipped: false };
    }

    // Validate the plan against the intent (the cheap Haiku gate).
    let verdict = parseVerdict(await invoker(buildValidatePrompt(intentMd, planText), model));
    log(`Planning gate: Haiku validation → ${verdict ? verdict.verdict : 'UNPARSEABLE'}${verdict?.reason ? ` (${verdict.reason})` : ''}.`);

    // One revision on REJECT, then proceed anyway (never block).
    if (verdict && verdict.verdict === 'REJECT') {
      const revisePrompt = buildPlanPrompt(task, intentMd) +
        `\n\nYour previous plan was REJECTED: ${verdict.reason}. Fix that specific gap and rewrite the full bullet list.`;
      planText = (await invoker(revisePrompt, model) || planText).trim();
      verdict = parseVerdict(await invoker(buildValidatePrompt(intentMd, planText), model));
      log(`Planning gate: Haiku re-validation → ${verdict ? verdict.verdict : 'UNPARSEABLE'}${verdict?.reason ? ` (${verdict.reason})` : ''}.`);
    }
    planApproved = verdict ? verdict.verdict === 'APPROVE' : null;
  } catch (e) {
    log(`Planning gate: micro-plan step failed (non-fatal): ${e.message}`);
  }

  const planPath = path.join(handoffDir, `plan-${task.id}.md`);
  const planMd = `# Micro-plan — ${task.id}\n` +
    `> Drafted + Haiku-validated against intent-${task.id}.md before implementation. ` +
    `Validation: ${planApproved === true ? 'APPROVED' : planApproved === false ? 'REJECTED (proceeding anyway)' : 'unparseable'}.\n\n` +
    `${planText}\n`;
  await writeFile(planPath, planMd, 'utf8').catch((e) => log(`Planning gate: plan write failed: ${e.message}`));

  return { intentPath, planPath, planApproved, intentMd, planMd, skipped: false };
}

export default { runPlanner };
