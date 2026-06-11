// route.mjs — decide which model the IMPLEMENTER uses. DETERMINISTIC: a fixed policy over (task class,
// risk, remaining budget) — the LLM never chooses its own budget path. Works in LOGICAL tiers
// ('strong' | 'mid' | 'cheap'); the active provider adapter resolves each tier to a concrete model id, so
// this policy is vendor-neutral.
//
// ───────── ROUTING RULES (first match wins) ─────────
//   Base tier by risk + class:
//     • risk ≥ opusMinRisk (default 3)                         → strong
//     • architecturally sensitive (opusKeywords) OR migration  → strong  (small diff, high stakes)
//     • maintenance/docs AND risk ≤ 1                          → cheap   (trivial, lowest cost)
//     • otherwise                                              → mid
//   Budget overlay (from the deterministic budget governor):
//     • budgetAction === 'downgrade' → drop ONE tier (strong→mid, mid→cheap, cheap→cheap)
//     • budgetAction === 'stop'      → caller must NOT run (no model returned by the loop)
//   The downgrade is applied AFTER the base tier, so a depleting quota always lowers cost, never raises it.

import { classifyTask } from './task-class.mjs';
import { getAdapter } from './providers/index.mjs';

const TIERS = ['cheap', 'mid', 'strong'];
function downOne(tier) { const i = TIERS.indexOf(tier); return i > 0 ? TIERS[i - 1] : 'cheap'; }

// Pick the base tier from task class + risk (no budget consideration).
export function baseTier(task, config) {
  const r = config.implementerRouting || {};
  const opusMinRisk = r.opusMinRisk ?? 3;
  const risk = task.risk ?? 5;
  const cls = classifyTask(task, config);
  const text = [task.title, task.notes, task.rationale, ...(task.implementationHints || [])]
    .filter(Boolean).join(' ').toLowerCase();

  if (risk >= opusMinRisk) return { tier: 'strong', reason: `risk ${risk}/5 ≥ ${opusMinRisk} — complex/risky work` };
  const hit = (r.opusKeywords || []).find((k) => text.includes(k));
  if (hit) return { tier: 'strong', reason: `architecture-sensitive ("${hit}") — strong despite low risk` };
  if (cls === 'migration') return { tier: 'strong', reason: 'migration — strong model (state/data correctness)' };
  if ((cls === 'maintenance') && risk <= 1) return { tier: 'cheap', reason: `trivial ${cls} (risk ${risk}/5) — cheapest model` };
  return { tier: 'mid', reason: `low-risk (${risk}/5), no architectural surface — mid model` };
}

// Backward compatible: pickImplementerModel(task, config) behaves as before (no budget overlay). The
// optional 3rd arg carries the governor's decision: { budgetAction: 'proceed'|'downgrade'|'stop' }.
export function pickImplementerModel(task, config, opts = {}) {
  const adapter = getAdapter(config);
  let { tier, reason } = baseTier(task, config);
  if (opts.budgetAction === 'downgrade') {
    const lowered = downOne(tier);
    if (lowered !== tier) { reason = `${reason}; budget DOWNGRADE ${tier}→${lowered}`; tier = lowered; }
    else reason = `${reason}; budget low but already cheapest`;
  }
  const model = adapter.resolveModel(tier, config);
  // tierLabel keeps the legacy opus/sonnet wording in logs/state where it's purely cosmetic.
  const tierLabel = tier === 'strong' ? 'opus' : tier === 'mid' ? 'sonnet' : 'haiku';
  return { model, tier, tierLabel, reason };
}
