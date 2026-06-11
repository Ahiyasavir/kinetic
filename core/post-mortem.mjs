// core/post-mortem.mjs — Post-mortem agent: runs AFTER a cycle is marked failed/blocked/high-revision.
// Analyzes failure context (review reasons, validation output, revision count, involved files) to
// extract explicit actionable rules, then persists them to lessons.json with structured fields and
// near-duplicate de-duplication (incrementing occurrenceCount instead of creating duplicate entries).
//
// New schema fields added to lessons.json entries:
//   rule            — human-readable actionable rule ("Never X" / "If X, then Y")
//   context         — compact failure context string (taskId, class, goal, top reason)
//   firstSeen       — ISO timestamp of first occurrence (preserved across de-dup merges)
//   occurrenceCount — how many times this rule pattern has fired (incremented on near-duplicate)
//
// All existing fields (id, taskId, keywords, failureType, revisionCount, etc.) are preserved for
// backward compatibility with bestLessonMatch() and other existing consumers.

import { loadLessons, saveLessons, extractKeywords } from '../lib/learn.mjs';

// Tokenize a rule string for near-duplicate detection (minimum 3 chars per token).
function ruleTokens(rule) {
  const out = new Set();
  for (const w of String(rule || '').toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length >= 3) out.add(w);
  }
  return out;
}

/**
 * True if two rules share ≥60% of their tokens (Jaccard on the smaller set).
 * Requires at least 4 tokens in each to avoid spurious matches on short strings.
 */
export function rulesNearDuplicate(ruleA, ruleB) {
  const A = ruleTokens(ruleA), B = ruleTokens(ruleB);
  if (A.size < 4 || B.size < 4) return String(ruleA).trim() === String(ruleB).trim();
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / Math.min(A.size, B.size) >= 0.6;
}

// Return a file-type / command pattern string describing what triggered the failure category.
// Used as the queryable `pattern` field in lessons.json entries.
function buildPattern(category, filesInvolved) {
  switch (category) {
    case 'product-gate':     return 'class=product; gitignored=true; allowGitignored=false';
    case 'marker-absent':    return 'console.log(`...${var}...`); template-literal in static verifyArtifacts check';
    case 'frozen-file':      return 'structural/frozen file referenced in acceptance criteria';
    case 'timeout':          return 'tsc compilation; large file I/O; execution >30s';
    case 'validation':       return '*.ts; npm run typecheck; npm run build';
    case 'rollback-typecheck': return '*.ts; npm run typecheck; TypeScript type-error';
    case 'rollback-lint':    return '*.ts; eslint; lint-regression guard';
    case 'rollback-evidence': return 'verifyArtifacts[].wired=false; dead-file (no import)';
    case 'rollback-review':  return 'review.approved=false; missing verifyArtifacts evidence';
    case 'high-revision': {
      const exts = [...new Set((filesInvolved || []).map(f => (f.split('.').pop() || '')).filter(Boolean))];
      return exts.length ? `high-revision; files: *.${exts.join(', *.')}` : 'high-revision; multiple files';
    }
    case 'blocked-generic':  return 'blocked-cycle; unknown failure pattern';
    default:                 return `${category}; generic failure pattern`;
  }
}

// Base confidence (0–1) for a rule derived from the given failure category.
// Higher for precise, actionable categories; lower for generic/ambiguous ones.
function baseConfidence(category) {
  const CONF = {
    'product-gate':       0.95,
    'marker-absent':      0.92,
    'rollback-evidence':  0.90,
    'rollback-typecheck': 0.85,
    'rollback-lint':      0.85,
    'validation':         0.80,
    'frozen-file':        0.75,
    'high-revision':      0.55,
    'timeout':            0.60,
    'rollback-review':    0.55,
    'blocked-generic':    0.45,
    'generic':            0.40,
  };
  return CONF[category] ?? 0.45;
}

// Classify into a specific sub-category for targeted rule generation.
// Returns one of: 'product-gate' | 'marker-absent' | 'frozen-file' | 'timeout' | 'validation' |
//                 'rollback-typecheck' | 'rollback-lint' | 'rollback-evidence' | 'rollback-review' |
//                 'high-revision' | 'blocked-generic' | 'generic'
function categorizeFailure(failureType, errorText) {
  const e = String(errorText || '').toLowerCase();
  if (failureType === 'blocked') {
    if (e.includes('product gate') || e.includes('gitdifrequired') || e.includes('no visible product') ||
        e.includes('gitignored') || e.includes('git diff') || e.includes('allowgitignored'))
      return 'product-gate';
    if (e.includes('marker absent') || e.includes('static string') || e.includes('template literal'))
      return 'marker-absent';
    if (e.includes('structural') || e.includes('frozen file') || e.includes('freeze'))
      return 'frozen-file';
    if (e.includes('timeout') || e.includes('timed out'))
      return 'timeout';
    if (e.includes('typecheck') || e.includes('typescript') || e.includes('build fail'))
      return 'validation';
    return 'blocked-generic';
  }
  if (failureType === 'rollback') {
    if (e.includes('typecheck') || e.includes('typescript') || e.includes('type error'))
      return 'rollback-typecheck';
    if (e.includes('lint') || e.includes('eslint') || e.includes('regression'))
      return 'rollback-lint';
    if (e.includes('evidence') || e.includes('verifyartifact') || e.includes('wired'))
      return 'rollback-evidence';
    return 'rollback-review';
  }
  if (failureType === 'high-revision') return 'high-revision';
  return 'generic';
}

/**
 * Extract an explicit, actionable rule from a failure context.
 * Returns a human-readable "Never X; instead Y" or "If X, then Y" string.
 *
 * @param {object} task  the task object (id, title, goal, class, acceptanceCriteria, etc.)
 * @param {object} ctx   { failureType, revisionCount, impl, validation, review }
 * @returns {string}
 */
export function extractRule(task, { failureType, revisionCount = 0, impl, validation, review } = {}) {
  const errorText = [
    ...(review?.reasons || []),
    validation?.summary || '',
    ...(review?.requiredFixes || []),
    ...(review?.riskNotes ? [review.riskNotes] : []),
  ].join(' ');
  const category = categorizeFailure(failureType, errorText);
  const goal = task.goal || 'unknown';
  const taskClass = task.class || 'unknown';
  const files = (impl?.filesChanged || []).slice(0, 3).join(', ') || 'multiple files';

  switch (category) {
    case 'product-gate':
      return `Never classify engine/maintenance tasks as "product" class — all deliverables in the gitignored autopilot/ tree must use class="engine" to bypass the product-delivery git-diff gate`;
    case 'marker-absent':
      return `verifyArtifacts marker strings must be static literals, not template literals (e.g. \`count: \${n}\`); the supervisor's grep-based artifact check only matches literal strings in the file`;
    case 'frozen-file':
      return `Before assigning a task, verify acceptance criteria do not require editing files frozen by the engine; structurally-blocked tasks waste a full cycle with no retry benefit`;
    case 'timeout':
      return `Tasks with heavy TypeScript compilation or large file processing can timeout; if timeout exceeds 30s consider splitting large files or reducing the scope of a single cycle`;
    case 'validation':
      return `${taskClass} tasks in goal="${goal}" that fail validation on the first attempt need an explicit "run npm run typecheck && npm run build" self-check step in implementationHints`;
    case 'rollback-typecheck':
      return `TypeScript changes must pass \`npm run typecheck\` before committing; always verify types and fix errors before the review step — especially for ${taskClass} tasks`;
    case 'rollback-lint':
      return `Never introduce new ESLint errors — verify the lint-error count does not increase versus baseline before finalizing; the lint-regression guard will block the cycle`;
    case 'rollback-evidence':
      return `Every deliverable module must be wired (imported/consumed) — a file nothing imports is a dead file; list each one in verifyArtifacts with wired:true and verify the import exists`;
    case 'rollback-review':
      return `${goal} tasks rejected after ${revisionCount} revision(s): ensure the handoff's verifyArtifacts includes every deliverable with wired:true to satisfy the on-disk evidence gate`;
    case 'high-revision':
      return `Tasks touching ${files} required ${revisionCount} revisions — vague acceptance criteria cause rework; specify exact file paths, expected exports, and verifiable test outputs in implementationHints`;
    default:
      return `${failureType} in goal="${goal}" after ${revisionCount} revision(s): add more specific acceptance criteria with verifiable file-level evidence to prevent repeat failures`;
  }
}

// Build a compact context string for human readers (stored in lessons.json alongside the rule).
function buildContext(task, { failureType, revisionCount, validation, review }) {
  const parts = [
    `taskId=${task.id}`,
    `class=${task.class || 'unknown'}`,
    `goal=${task.goal || 'unknown'}`,
    `revisions=${revisionCount}`,
    failureType,
  ];
  const topReason = (review?.reasons || [])[0] || (validation?.summary || '').slice(0, 80);
  if (topReason) parts.push(topReason.slice(0, 120));
  return parts.join('; ');
}

/**
 * Run the post-mortem agent for a failed/blocked/high-revision cycle.
 *
 * Extracts an explicit rule, de-duplicates against existing lessons (incrementing occurrenceCount
 * on near-duplicate rule matches instead of creating duplicate entries), and persists to lessons.json.
 * Never throws — all errors are caught and logged; the caller's loop continues unaffected.
 *
 * @param {string}   lessonsPath  absolute path to lessons.json
 * @param {object}   task         task object from state (id, title, goal, class, acceptanceCriteria…)
 * @param {object}   ctx          { failureType, revisionCount, impl, validation, review }
 * @param {Function} [logger]     optional log function (defaults to no-op)
 * @returns {object|null}         the persisted lesson entry, or null on skip/error
 */
export function runPostMortem(lessonsPath, task, ctx, logger = () => {}) {
  const { failureType, revisionCount = 0, impl, validation, review } = ctx;
  try {
    const lessons = loadLessons(lessonsPath, logger);
    const rule = extractRule(task, ctx);
    const context = buildContext(task, ctx);
    const keywords = extractKeywords(
      `${task.title || ''} ${(task.acceptanceCriteria || []).join(' ')} ${task.notes || ''}`
    );
    const errorSummary = ((review?.reasons || []).join('; ') || validation?.summary || '').slice(0, 500);
    const now = new Date().toISOString();
    const filesInvolved = (impl?.filesChanged || []).slice(0, 20);

    // Pre-compute structured fields shared by new-entry and de-dup update paths.
    const errorText = [
      ...(review?.reasons || []),
      validation?.summary || '',
      ...(review?.requiredFixes || []),
    ].join(' ');
    const category = categorizeFailure(failureType, errorText);
    const pattern = buildPattern(category, filesInvolved);

    // Primary de-dup: near-duplicate rule text for the same failureType → increment occurrenceCount.
    const existing = lessons.find(
      (l) => l.failureType === failureType && rulesNearDuplicate(l.rule || l.fix || '', rule)
    );
    if (existing) {
      existing.occurrenceCount = (existing.occurrenceCount || 1) + 1;
      existing.context = context; // update to latest occurrence
      // Boost confidence on repeated occurrence (capped at 0.98).
      existing.confidence = Math.min(0.98, (existing.confidence ?? baseConfidence(category)) + 0.05);
      saveLessons(lessonsPath, lessons);
      logger(`🧠 Post-mortem: updated lesson ${existing.id} (${failureType}, ×${existing.occurrenceCount}) — ${rule.slice(0, 60)}…`);
      return existing;
    }

    // Legacy de-dup: same exact task+failureType already recorded (no rule field on old entry).
    if (lessons.some((l) => l.taskId === task.id && l.failureType === failureType)) {
      logger(`🧠 Post-mortem: lesson already exists for ${task.id}+${failureType} — skipping.`);
      return null;
    }

    const entry = {
      id: `L-${String(lessons.length + 1).padStart(4, '0')}`,
      // Structured fields required by the U-47 spec schema
      // (queryable by U-48 Implementer/Reviewer injection and U-57 Proactive Scanner)
      category,       // sub-category: 'product-gate' | 'rollback-typecheck' | etc.
      pattern,        // file-type / command pattern that triggered the failure
      fix: rule,      // human-readable actionable rule ("Never X" / "If X, then Y")
      confidence: baseConfidence(category), // 0–1 certainty of the rule's applicability
      learnedAt: now, // ISO timestamp (canonical alias for firstSeen)
      // Extended fields for rich context and de-duplication
      failureType,
      rule,           // kept alongside `fix` for backward compat with bestLessonMatch() consumers
      context,
      firstSeen: now,
      occurrenceCount: 1,
      // Legacy fields preserved for backward compatibility
      timestamp: now,
      taskId: task.id,
      title: task.title || '',
      keywords,
      revisionCount,
      filesInvolved,
      errorSummary,
      avoidHints: [...(review?.requiredFixes || []), ...(task.lastFailure?.requiredFixes || [])]
        .filter(Boolean).slice(0, 8),
    };

    lessons.push(entry);
    saveLessons(lessonsPath, lessons);
    logger(`🧠 Post-mortem: recorded lesson ${entry.id} (${failureType}) — rule: ${rule.slice(0, 80)}…`);
    return entry;
  } catch (e) {
    logger(`⚠️  post-mortem failed (non-fatal, lessons not updated): ${e.message}`);
    return null;
  }
}
