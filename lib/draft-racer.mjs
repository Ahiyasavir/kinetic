// draft-racer.mjs — parallel Haiku draft racing with Sonnet selector.
//
// Instead of one expensive Opus/Sonnet implementer call, runs TWO fast Haiku drafts in parallel with
// different strategy prefixes, then a Sonnet selector picks the better one (or requests refinement).
// Break-even: 2×Haiku + 1×Sonnet < 1×Opus for most tasks — with better quality from diverse approaches.
//
// Decision tree:
//   BOTH succeed → Sonnet selector picks winner → strategy: 'direct' or 'refine'
//   ONE  succeeds → use the surviving draft      → strategy: 'survivor'
//   BOTH fail    → return null (fall through to standard implementer, no regression)
//
// The winner's implementation text is injected as DRAFT_SEED into the Implementer prompt, giving it
// a strong starting point to refine rather than generate from scratch.
//
// Skip gate (all must pass to race):
//   config.draftRacing.enabled === true   (opt-in; false by default)
//   task.risk <= config.draftRacing.maxRisk   (skip high-risk security/migration tasks)
//   task.goal not in skipGoals            (skip goals that require deep reasoning)

export const DRAFT_RACING_DEFAULTS = Object.freeze({
  enabled: false,
  haikuModel: 'claude-haiku-4-5',
  selectorModel: 'claude-sonnet-4-6',
  maxRisk: 3,
  skipGoals: ['security', 'migration', 'data model', 'schema', 'scoring'],
  maxContextChars: 8000,   // truncate context to keep Haiku prompts cheap
  maxDraftChars: 6000,     // truncate each draft for the Sonnet selector prompt
  timeoutMs: 120000,       // per-draft timeout (2 min); if exceeded, treat as failure
});

function draftRacingConfig(config) {
  return { ...DRAFT_RACING_DEFAULTS, ...(config && config.draftRacing ? config.draftRacing : {}) };
}

// The two prompt strategy prefixes injected before the shared task context.
// Diversity drives quality: one leans simple/pragmatic, one leans thorough/defensive.
const STRATEGY_PREFIXES = [
  'You are a pragmatic implementer. Prefer the simplest correct solution. Avoid over-engineering. Write minimum code to satisfy the task.',
  'You are a thorough implementer. Consider edge cases, defensive patterns, and test-ability. Code should be robust against unexpected inputs.',
];

/**
 * Run the draft-racing phase.
 *
 * @param {object} task        - selected task (id, title, goal, risk, acceptanceCriteria, notes)
 * @param {string} contextHint - compiled context hint (active files, deps) from the supervisor
 * @param {object} config      - engine config (reads config.draftRacing)
 * @param {Function} invoker   - async (prompt, model, label) => { text, inputTokens, outputTokens, ... }
 * @param {Function} log       - supervisor logger
 * @returns {Promise<{winner:string, strategy:string, selectorReason:string, tokensA, tokensB, selectorTokens}|null>}
 *          null = fall through to standard implementer (both drafts failed, or skip gate triggered)
 */
export async function runDraftRacing(task, contextHint, config, invoker, log) {
  const dr = draftRacingConfig(config);

  // ── Skip gate ──────────────────────────────────────────────────────────────
  if (!dr.enabled) return null;
  const taskRisk = Number(task.risk) || 0;
  if (taskRisk > dr.maxRisk) return null;
  const taskGoal = (task.goal || '').toLowerCase();
  if (dr.skipGoals.some((g) => taskGoal.includes(g.toLowerCase()))) return null;

  // ── Build shared context block ──────────────────────────────────────────────
  const criteria = (task.acceptanceCriteria || []).map((c) => `  - ${c}`).join('\n') || '  (none specified)';
  const notes    = task.notes ? `\n\n## Notes\n${task.notes}` : '';
  const ctx      = contextHint ? `\n\n## Active files context\n${contextHint.slice(0, dr.maxContextChars)}` : '';
  const taskBlock = `## Task: ${task.id}
${task.title}

## Acceptance criteria
${criteria}${notes}${ctx}`;

  log(`[DRAFT-RACE] Starting parallel Haiku drafts for ${task.id} (risk ${taskRisk})…`);
  const draftStart = Date.now();

  // ── Two Haiku drafts in parallel with distinct strategy prefixes ────────────
  const makeDraftPrompt = (prefix) => `${prefix}\n\n${taskBlock}\n\nImplement this task now. Write all necessary code changes.`;

  const withTimeout = (promise, ms) => Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('draft-race timeout')), ms)),
  ]);

  const [draftA, draftB] = await Promise.allSettled([
    withTimeout(invoker(makeDraftPrompt(STRATEGY_PREFIXES[0]), dr.haikuModel, 'draft-A'), dr.timeoutMs),
    withTimeout(invoker(makeDraftPrompt(STRATEGY_PREFIXES[1]), dr.haikuModel, 'draft-B'), dr.timeoutMs),
  ]);

  const draftMs = Date.now() - draftStart;
  const goodA = draftA.status === 'fulfilled' && draftA.value && draftA.value.text;
  const goodB = draftB.status === 'fulfilled' && draftB.value && draftB.value.text;
  const tokA = goodA ? { in: draftA.value.inputTokens, out: draftA.value.outputTokens } : null;
  const tokB = goodB ? { in: draftB.value.inputTokens, out: draftB.value.outputTokens } : null;

  if (!goodA && !goodB) {
    log(`[DRAFT-RACE] Both drafts failed (${(draftMs / 1000).toFixed(1)}s) — falling through to standard implementer`);
    if (draftA.reason) log(`  Draft-A: ${draftA.reason.message}`);
    if (draftB.reason) log(`  Draft-B: ${draftB.reason.message}`);
    return null;
  }

  // ── Single survivor ──────────────────────────────────────────────────────────
  if (!goodA || !goodB) {
    const survivor = goodA ? draftA.value : draftB.value;
    const which = goodA ? 'A' : 'B';
    log(`[DRAFT-RACE] Draft ${goodA ? 'B' : 'A'} failed — using survivor Draft ${which} (${(draftMs / 1000).toFixed(1)}s)`);
    return { winner: survivor.text, strategy: 'survivor', selectorReason: `Draft ${which} was the only successful draft`, tokensA: tokA, tokensB: tokB, selectorTokens: null };
  }

  // ── Sonnet selects between A and B ──────────────────────────────────────────
  const selectStart = Date.now();
  const selectorPrompt = `You are a senior code reviewer comparing two implementation drafts for the same task.
Select the better implementation and decide whether it needs refinement or can be used directly.

## Task
${task.title}

## Acceptance criteria
${criteria}

## Draft A (pragmatic/minimal)
\`\`\`
${draftA.value.text.slice(0, dr.maxDraftChars)}
\`\`\`

## Draft B (thorough/defensive)
\`\`\`
${draftB.value.text.slice(0, dr.maxDraftChars)}
\`\`\`

Respond with ONLY a single JSON object on one line, nothing else:
{"winner":"A","needsRefinement":false,"reason":"Draft A is simpler and fully satisfies the criteria"}

Rules:
- winner: "A" or "B" — the draft that better satisfies the acceptance criteria
- needsRefinement: true if the winner needs significant changes before it can pass review; false if it can be used as-is with minor touch-ups
- reason: one sentence explaining the choice`;

  let selectorResult = null;
  let selectorTokens = null;
  try {
    const selRes = await withTimeout(
      invoker(selectorPrompt, dr.selectorModel, 'draft-selector'),
      60000
    );
    selectorTokens = selRes ? { in: selRes.inputTokens, out: selRes.outputTokens } : null;
    if (selRes && selRes.text) {
      // Extract JSON — handle markdown fences and surrounding prose
      const match = selRes.text.match(/\{[^{}]+\}/s);
      if (match) {
        selectorResult = JSON.parse(match[0]);
        // Validate shape
        if (!['A', 'B'].includes(selectorResult.winner)) selectorResult = null;
      }
    }
  } catch (e) {
    log(`[DRAFT-RACE] Selector call failed (${e.message}) — defaulting to Draft A`);
  }

  const selectMs = Date.now() - selectStart;
  const pickedA = !selectorResult || selectorResult.winner === 'A';
  const winnerText = pickedA ? draftA.value.text : draftB.value.text;
  const strategy = selectorResult && selectorResult.needsRefinement ? 'refine' : 'direct';
  const reason = selectorResult ? selectorResult.reason : 'selector unavailable — defaulting to Draft A';

  log(`[DRAFT-RACE] Winner: Draft ${pickedA ? 'A' : 'B'} · strategy: ${strategy} · ${(draftMs / 1000).toFixed(1)}s drafts + ${(selectMs / 1000).toFixed(1)}s selection`);
  if (reason) log(`  Reason: ${reason}`);

  return {
    winner: winnerText,
    strategy,
    selectorReason: reason,
    tokensA: tokA,
    tokensB: tokB,
    selectorTokens,
  };
}
