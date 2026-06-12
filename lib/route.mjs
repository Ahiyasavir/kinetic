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
//   riskToModel overlay (U-56, applied ONLY when the safety floor did NOT fire):
//     • config.implementerRouting.riskToModel[risk] is a direct risk-level → model-id mapping
//     • Haiku for risk ≤ 1, Sonnet for risk ≥ 3 (default table in config.json)
//     • risk 2 uses configurable fallback (default Haiku)
//   Budget overlay (from the deterministic budget governor):
//     • budgetAction === 'downgrade' → drop ONE tier (strong→mid, mid→cheap, cheap→cheap)
//       (if riskToModel fired first, the mapped tier is still subject to this downgrade)
//     • budgetAction === 'stop'      → caller must NOT run (no model returned by the loop)
//   The downgrade is applied AFTER the base tier, so a depleting quota always lowers cost, never raises it.

import { classifyTask } from './task-class.mjs';
import { getAdapter } from './providers/index.mjs';

const TIERS = ['cheap', 'mid', 'strong'];
function downOne(tier) { const i = TIERS.indexOf(tier); return i > 0 ? TIERS[i - 1] : 'cheap'; }

// Reverse-map a concrete model id to a logical tier so the budget-downgrade overlay can still apply
// after a riskToModel direct assignment. Conservative fallback to 'strong' prevents under-pricing.
function tierFromModelId(modelId) {
  const m = (modelId || '').toLowerCase();
  if (m.includes('haiku') || m.includes('flash') || m.includes('-nano')) return 'cheap';
  if (m.includes('sonnet') || m.includes('turbo') || m.includes('-mini')) return 'mid';
  return 'strong';
}

// Pick the base tier from task class + risk (no budget consideration).
export function baseTier(task, config) {
  const r = config.implementerRouting || {};
  const opusMinRisk = r.opusMinRisk ?? 3;
  const risk = task.risk ?? 5;
  const cls = classifyTask(task, config);
  const text = [task.title, task.notes, task.rationale, ...(task.implementationHints || [])]
    .filter(Boolean).join(' ').toLowerCase();

  // Safety-critical escalations ALWAYS win and are evaluated FIRST, so the U-74 goal override below can
  // never lower the tier for risky/architectural/migration work — it only steers the non-critical default.
  // safetyFloor:true signals to riskToModel (U-56) that this escalation must not be overridden.
  if (risk >= opusMinRisk) return { tier: 'strong', reason: `risk ${risk}/5 ≥ ${opusMinRisk} — complex/risky work`, safetyFloor: true };
  const hit = (r.opusKeywords || []).find((k) => text.includes(k));
  if (hit) return { tier: 'strong', reason: `architecture-sensitive ("${hit}") — strong despite low risk`, safetyFloor: true };
  if (cls === 'migration') return { tier: 'strong', reason: 'migration — strong model (state/data correctness)', safetyFloor: true };
  // U-74: goal-aware default tier. When a goal has a configured tier in goalTierOverride and NO
  // safety trigger fired above, route by goal — lets cheap, mechanical goals (ui/maintenance/docs)
  // default to the cheapest model and subtler goals default up, without touching the risk/keyword
  // safety floor. No-op (falls through) when the goal isn't listed or the table is absent.
  const goal = String(task.goal || '').toLowerCase();
  const goalTier = (r.goalTierOverride || {})[goal];
  if (goalTier && TIERS.includes(goalTier)) {
    return { tier: goalTier, reason: `goal "${goal}" → ${goalTier} tier (goalTierOverride; risk ${risk}/5, no safety trigger)`, safetyFloor: false };
  }
  if ((cls === 'maintenance') && risk <= 1) return { tier: 'cheap', reason: `trivial ${cls} (risk ${risk}/5) — cheapest model`, safetyFloor: false };
  return { tier: 'mid', reason: `low-risk (${risk}/5), no architectural surface — mid model`, safetyFloor: false };
}

// Backward compatible: pickImplementerModel(task, config) behaves as before (no budget overlay). The
// optional 3rd arg carries the governor's decision: { budgetAction: 'proceed'|'downgrade'|'stop' }.
export function pickImplementerModel(task, config, opts = {}) {
  const adapter = getAdapter(config);
  let { tier, reason, safetyFloor } = baseTier(task, config);

  // U-56: riskToModel — direct risk-level → model-id mapping. Applied ONLY when the safety floor
  // (opusMinRisk / opusKeywords / migration) has NOT fired. When it fires, the mapped model id
  // determines the logical tier so the budget-downgrade overlay can still apply below.
  const r = config.implementerRouting || {};
  const risk = task.risk ?? 5;
  const rtm = r.riskToModel;
  let riskMappedModel = null;
  if (!safetyFloor && rtm && rtm[String(risk)]) {
    riskMappedModel = rtm[String(risk)];
    const mappedTier = tierFromModelId(riskMappedModel);
    reason = `${reason}; riskToModel[${risk}]→${riskMappedModel}`;
    tier = mappedTier;
  }

  if (opts.budgetAction === 'downgrade') {
    const lowered = downOne(tier);
    if (lowered !== tier) {
      reason = `${reason}; budget DOWNGRADE ${tier}→${lowered}`;
      tier = lowered;
      riskMappedModel = null; // budget override wins; fall through to tier-based resolution
    } else {
      reason = `${reason}; budget low but already cheapest`;
    }
  }
  const model = riskMappedModel ?? adapter.resolveModel(tier, config);
  // tierLabel keeps the legacy opus/sonnet wording in logs/state where it's purely cosmetic.
  const tierLabel = tier === 'strong' ? 'opus' : tier === 'mid' ? 'sonnet' : 'haiku';
  return { model, tier, tierLabel, reason };
}

// HAIKU-FIRST REVISION TRIAGE: when a revision is needed purely because of a MECHANICAL validation
// failure (typecheck / lint / build) — not a reviewer judgement about approach/scope — the fix is
// almost always a trivial type/import/syntax patch. Route the FIRST such revision to the CHEAP tier
// (Haiku): fast + ~20× cheaper, and it resolves the large majority of compile/lint breaks. If Haiku's
// attempt still fails, the caller escalates back to the task's real tier on the next attempt.
//
// Inputs: attempt (1-based revision number), mechanical (true when the trigger was failing validation,
// NOT a reviewer 'revise' on logic). Returns null when triage does NOT apply (caller uses the base route).
export function pickRevisionModel(task, config, { attempt, mechanical, budgetAction } = {}) {
  const r = config.implementerRouting || {};
  if (r.haikuFirstRevision === false) return null;          // opt-out
  if (!mechanical) return null;                              // logic/scope revise → keep the strong model
  if (attempt !== 1) return null;                            // only the FIRST mechanical retry gets Haiku
  // Don't UPGRADE cost: if the base route is already cheap, there's nothing to save — let it run normally.
  const base = baseTier(task, config).tier;
  if (base === 'cheap') return null;
  const adapter = getAdapter(config);
  const model = adapter.resolveModel('cheap', config);
  return { model, tier: 'cheap', tierLabel: 'haiku',
    reason: `Haiku-first triage: mechanical validation failure (revision ${attempt}) — cheap model attempts the trivial fix before escalating` };
}
