// lessons-injector.mjs — loads lessons-rules.json and filters applicable rule lessons for prompt
// injection. This is separate from the failure-learning system (lessons.json flat array + Jaccard
// matching in learn.mjs) — it handles HAND-CRAFTED rule lessons: guidelines tagged by file-pattern
// and goal/category that get injected into the Implementer and Reviewer system prompts.
//
// Schema (autopilot/state/lessons-rules.json):
//   { "lessons": [ { id, category, ruleText, applicableFilePatterns, tags } ] }
//   - id: unique identifier (e.g. "R-0001")
//   - category: short label (e.g. "task-classification", "wiring", "verification")
//   - ruleText: the rule as a complete sentence, injected verbatim into the prompt
//   - applicableFilePatterns: glob patterns (** supported); rule appears for implementer when active
//     files match at least one pattern
//   - tags: string array; rule appears for reviewer when task.goal or task.class matches a tag
import { existsSync, readFileSync } from 'node:fs';

// Convert a glob pattern to a RegExp. Supports ** (any path depth) and * (within one segment).
function globToRegex(pattern) {
  const p = pattern.replace(/\\/g, '/');
  let re = p.replace(/[.+^${}()|[\]\\]/g, '\\$&'); // escape regex metacharacters except * and ?
  re = re.replace(/\*\*/g, '\x00'); // temporarily mark **
  re = re.replace(/\*/g, '[^/]*');  // * matches within a single path segment
  re = re.replace(/\x00/g, '.*');   // ** matches any number of segments (including /)
  return new RegExp('^' + re + '$');
}

function matchesGlob(filePath, pattern) {
  const fp = filePath.replace(/\\/g, '/');
  const pat = pattern.replace(/\\/g, '/');
  if (!pat.includes('*')) return fp === pat || fp.startsWith(pat + '/');
  try { return globToRegex(pat).test(fp); } catch { return false; }
}

/**
 * Load rule lessons from the lessons-rules.json file.
 * Returns [] on missing file, unreadable file, or wrong format (graceful degradation).
 * @param {string} rulesPath  absolute path to lessons-rules.json
 * @param {Function} [logger] optional logger for warnings
 * @returns {{ id, category, ruleText, applicableFilePatterns, tags }[]}
 */
export function loadRuleLessons(rulesPath, logger = () => {}) {
  if (!existsSync(rulesPath)) return [];
  try {
    const raw = JSON.parse(readFileSync(rulesPath, 'utf8'));
    // Accept either { lessons: [...] } wrapper or a flat array
    const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.lessons) ? raw.lessons : []);
    return arr.filter((l) => l && typeof l.ruleText === 'string');
  } catch (e) {
    logger(`⚠️ lessons-rules.json unreadable (${e.message}) — skipping rule injection.`);
    return [];
  }
}

/**
 * Filter lessons for the Implementer: keep lessons whose applicableFilePatterns overlap with
 * the set of active files the context compiler identified as relevant for this task.
 * @param {object[]} lessons  loaded rule lessons
 * @param {string[]} activeFiles  relative file paths from the context compiler
 * @returns {object[]} matching lessons
 */
export function filterForImplementer(lessons, activeFiles = []) {
  if (!activeFiles.length || !lessons.length) return [];
  return lessons.filter((l) => {
    const patterns = Array.isArray(l.applicableFilePatterns) ? l.applicableFilePatterns : [];
    if (!patterns.length) return false;
    return activeFiles.some((f) => patterns.some((p) => matchesGlob(f, p)));
  });
}

/**
 * Filter lessons for the Reviewer: keep lessons whose tags intersect with the task's goal or class.
 * When the task has no goal/class info, all lessons are returned (inject everything available).
 * @param {object[]} lessons  loaded rule lessons
 * @param {{ goal?: string, class?: string, category?: string, tags?: string[] }} task
 * @returns {object[]} matching lessons
 */
export function filterForReviewer(lessons, task = {}) {
  if (!lessons.length) return [];
  const targets = new Set(
    [task.goal, task.class, task.category, ...(Array.isArray(task.tags) ? task.tags : [])]
      .filter(Boolean)
      .map((s) => String(s).toLowerCase())
  );
  if (!targets.size) return lessons; // no targeting info — inject all available rules
  return lessons.filter((l) => {
    const tags = Array.isArray(l.tags) ? l.tags.map((t) => String(t).toLowerCase()) : [];
    return tags.some((t) => targets.has(t));
  });
}

/**
 * Format a filtered lesson set into a prompt block string.
 * Returns '' when lessons is empty so {{VAR}} substitution produces no visible section.
 * @param {object[]} lessons  filtered rule lessons to inject
 * @param {string}   header   section heading text
 * @returns {string}
 */
export function formatLessonsBlock(lessons, header = 'Applicable lessons from past cycles:') {
  if (!lessons.length) return '';
  const items = lessons.map((l) => `- [${l.id || '?'}] (${l.category || 'general'}) ${l.ruleText}`).join('\n');
  return `\n## ${header}\n${items}\n`;
}

/**
 * Filter failure lessons (from lessons.json) by file overlap between their `filesInvolved` field
 * and the set of active files identified by the context compiler. Complements the keyword-Jaccard
 * matching in learn.mjs — catches lessons not found by title similarity but involving the same files.
 * @param {object[]} failureLessons  raw lessons.json entries ({ id, filesInvolved, errorSummary, avoidHints, … })
 * @param {string[]} activeFiles     relative file paths from the context compiler
 * @returns {object[]} matching failure lessons
 */
export function filterFailureLessonsByFiles(failureLessons, activeFiles = []) {
  if (!activeFiles.length || !Array.isArray(failureLessons) || !failureLessons.length) return [];
  const activeSet = new Set(activeFiles.map((f) => f.replace(/\\/g, '/')));
  return failureLessons.filter((l) => {
    const involved = Array.isArray(l.filesInvolved) ? l.filesInvolved : [];
    return involved.some((f) => activeSet.has(f.replace(/\\/g, '/')));
  });
}

/**
 * Format file-matched failure lessons into a prompt block string.
 * Includes the failure type, a short problem description, and any avoid-hints.
 * Returns '' when lessons is empty — no visible section injected.
 * @param {object[]} failureLessons  filtered failure lessons
 * @param {string}   header
 * @returns {string}
 */
export function formatFailureLessonsBlock(failureLessons, header = 'File-matched past failure warnings:') {
  if (!failureLessons.length) return '';
  const items = failureLessons.map((l) => {
    const title = String(l.title || '').slice(0, 120);
    const summary = l.errorSummary ? `\n  Problem: ${String(l.errorSummary).slice(0, 240)}` : '';
    const avoid = Array.isArray(l.avoidHints) && l.avoidHints.length
      ? `\n  Avoid: ${l.avoidHints.join('; ')}` : '';
    const files = Array.isArray(l.filesInvolved) && l.filesInvolved.length
      ? `\n  Files: ${l.filesInvolved.join(', ')}` : '';
    return `- [${l.id || '?'}] (${l.failureType || 'failure'}) ${title}${summary}${avoid}${files}`;
  }).join('\n');
  return `\n## ${header}\n${items}\n`;
}
