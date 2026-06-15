// planValidator.mjs — U-65: plan-validation gate.
//
// Two callers, two shapes, ONE entry point (validatePlan) that dispatches on its arguments:
//
//   1. LLM gate (planner.mjs) — validatePlan(intentMd, planText, invoker, model)
//      Builds the validation prompt, calls the caller-supplied invoker (cheap model), and parses the
//      verdict JSON. Returns { verdict:'APPROVE'|'REJECT', reason } | null. No LLM is hard-coded — the
//      invoker (async (prompt, model) => string) is injected so this stays provider-neutral + testable.
//
//   2. Deterministic gate (supervisor pipeline + tests) — validatePlan(plan, intent)
//      Statically checks a micro-plan against the locked intent markdown WITHOUT an LLM:
//        • every step must name a concrete deliverable (a file / module), not a vague verb, and
//        • no step may pair a modification verb with a subject the intent's "## mustNot" section forbids.
//      Returns { status:'pass'|'fail', reason, violations }. On a fail the supervisor routes control
//      back to the Selector; on a pass it proceeds to the backlog cost forecast.
//
// Dispatch rule: when the 3rd argument is a function it is the LLM-gate form; otherwise it is the
// deterministic (plan, intent) form.

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

export function parseVerdict(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/\{[^{}]*"verdict"\s*:\s*"(APPROVE|REJECT)"[^{}]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ── deterministic (plan, intent) validation ─────────────────────────────────────────────────────

// Verbs that signal a step intends to MUTATE existing code. Paired with a forbidden subject they form a
// mustNot violation. Creating new modules ("add", "create", "implement", "write") is NOT a mutation.
const MODIFY_VERBS = [
  'modify', 'change', 'edit', 'alter', 'rewrite', 'replace', 'refactor',
  'overwrite', 'mutate', 'delete', 'drop', 'remove', 'rip',
];

// Words that carry no constraint signal — dropped when extracting forbidden subjects from mustNot bullets.
const STOPWORDS = new Set([
  'do', 'not', 'dont', 'the', 'a', 'an', 'to', 'of', 'and', 'but', 'or', 'for', 'with', 'that', 'this',
  'into', 'from', 'on', 'off', 'only', 'any', 'its', 'are', 'their', 'both', 'when', 'will', 'should',
  'new', 'add', 'core', 'logic', 'code', 'cycle', 'task', 'tasks', 'must', 'mustnot', 'no', 'never',
  'cause', 'causes', 'unavailable', 'failure', 'failures', 'block', 'blocks', 'abort', 'aborts',
  'plan', 'plans', 'step', 'steps', 'file', 'files', 'name', 'named', 'write', 'after', 'before',
  // verbs are matched separately — never treat them as forbidden subjects
  ...['modify', 'change', 'edit', 'alter', 'rewrite', 'replace', 'refactor', 'overwrite', 'mutate', 'delete', 'rip', 'treat'],
]);

// A step references a concrete deliverable when it names a source file or a known module directory.
const FILE_REF = /(\b[\w./-]+\.(?:mjs|js|ts|tsx|jsx|json|md|css|html|py))\b|\b(?:lib|core|scripts|supervisor|functions|src|apps|state|agents|tests)[\w./-]*/i;

function extractSteps(plan) {
  if (!plan) return [];
  if (Array.isArray(plan.steps)) return plan.steps.map((s) => String(s)).filter(Boolean);
  if (Array.isArray(plan)) return plan.map((s) => String(s)).filter(Boolean);
  if (typeof plan === 'string') {
    return plan.split('\n').map((l) => l.replace(/^[-*\d.\s]+/, '').trim()).filter(Boolean);
  }
  return [];
}

// Pull the "## mustNot" bullets out of the intent markdown and reduce each to its forbidden subjects
// (significant nouns the plan may not mutate, e.g. "selector", "ranking", "scoring", "schema").
function parseForbiddenSubjects(intent) {
  const subjects = new Set();
  const m = intent.match(/##\s+mustNot\b([\s\S]*?)(?:\n##\s|$)/i);
  if (!m) return subjects;
  for (const line of m[1].split('\n')) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (!bullet) continue;
    for (const raw of bullet[1].toLowerCase().split(/[^a-z0-9.]+/)) {
      const word = raw.replace(/^\.+|\.+$/g, '');
      if (word.length >= 4 && !STOPWORDS.has(word)) {
        subjects.add(word);
        // index the bare tokens of a dotted identifier too (e.g. "state.json" → "state", "json")
        for (const part of word.split('.')) if (part.length >= 4 && !STOPWORDS.has(part)) subjects.add(part);
      }
    }
  }
  return subjects;
}

function hasModifyVerb(stepLower) {
  return MODIFY_VERBS.some((v) => new RegExp(`\\b${v}\\b`).test(stepLower));
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validatePlanStatic(plan, intent) {
  // Guard: an empty / missing intent cannot anchor a plan — reject so the supervisor re-locks intent first.
  if (!intent || !String(intent).trim()) {
    return { status: 'fail', reason: 'Cannot validate plan: the intent anchor is missing or empty.', violations: [] };
  }

  const steps = extractSteps(plan);
  if (!steps.length) {
    return { status: 'fail', reason: 'Plan has no steps; each step must name a concrete file or module deliverable.', violations: [] };
  }

  const forbidden = parseForbiddenSubjects(String(intent));

  // 1) mustNot violations — a modification verb aimed at a forbidden subject.
  const violations = [];
  for (const step of steps) {
    const lower = step.toLowerCase();
    if (!hasModifyVerb(lower)) continue;
    for (const subj of forbidden) {
      if (new RegExp(`\\b${escapeRe(subj)}\\b`).test(lower)) {
        violations.push({ step, subject: subj });
        break;
      }
    }
  }
  if (violations.length) {
    const v = violations[0];
    return {
      status: 'fail',
      reason: `Plan violates a mustNot constraint: step "${v.step}" modifies "${v.subject}", which the locked intent forbids.`,
      violations,
    };
  }

  // 2) concreteness — every step must name a concrete deliverable (a file / module).
  const vague = steps.filter((s) => !FILE_REF.test(s));
  if (vague.length) {
    return {
      status: 'fail',
      reason: `Plan step lacks a concrete deliverable (no file or module named): "${vague[0]}". Every step must reference a concrete file or module.`,
      violations: [],
    };
  }

  return { status: 'pass', reason: 'Plan is concrete and respects every locked intent constraint.', violations: [] };
}

/**
 * Validate a micro-plan. Dispatches on arguments (see file header):
 *   • validatePlan(intentMd, planText, invoker, model) → LLM verdict (planner gate)
 *   • validatePlan(plan, intent)                       → { status, reason } (deterministic gate)
 */
export async function validatePlan(a, b, invoker, model = 'claude-haiku-4-5') {
  // LLM-gate form: 3rd argument is the injected model invoker.
  if (typeof invoker === 'function') {
    const prompt = buildValidatePrompt(a, b);
    const text = await invoker(prompt, model);
    return parseVerdict(text);
  }
  // Deterministic form: a = plan, b = intent markdown. Returns the canonical { status, reason,
  // violations } plus { valid, errors, feedback } aliases so both the supervisor pipeline and the
  // U-65 plan-validation contract (revisionHandler / processCycle) can read one result shape.
  const r = validatePlanStatic(a, b);
  const passed = r.status === 'pass';
  const errors = passed
    ? []
    : (r.violations && r.violations.length
        ? r.violations.map((v) => v.step || v.subject || String(v))
        : [r.reason]);
  return { ...r, valid: passed, errors, feedback: r.reason };
}

export default { validatePlan, parseVerdict };
