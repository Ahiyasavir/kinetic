// audit-formatter.mjs — turns the structured check results from lib/audit.mjs into operator-facing
// text (U-63). Two renderers share one line shape so non-verbose and verbose output stay consistent:
//   • formatLine()    — one diagnostic line, "[CATEGORY] message <glyph>"
//   • formatSummary() — the default (non-verbose) view: one roll-up line per category + a total
//   • formatVerbose() — the --verbose view: every individual check, in category order
// Lines are intentionally flat (one check per line, stable prefix) so they are easy to grep/parse.

import { CATEGORIES, STATUS_GLYPHS, isCategory } from './audit-categories.mjs';

/**
 * Format a single diagnostic line: `[CATEGORY] message ✓`.
 * @param {string} category one of CATEGORIES
 * @param {string} message  human-readable description of the check
 * @param {'pass'|'fail'|'warn'|'info'} [status='info']
 */
export function formatLine(category, message, status = 'info') {
  if (!isCategory(category)) throw new Error(`audit-formatter: unknown category "${category}"`);
  const glyph = STATUS_GLYPHS[status] || STATUS_GLYPHS.info;
  return `[${category}] ${message} ${glyph}`;
}

/** Group checks by their category, preserving the canonical category order. */
function byCategory(checks) {
  const groups = new Map(CATEGORIES.map((c) => [c, []]));
  for (const chk of checks) {
    if (!groups.has(chk.category)) groups.set(chk.category, []);
    groups.get(chk.category).push(chk);
  }
  return groups;
}

/**
 * Non-verbose (default) rendering: a single pass/fail roll-up per category plus an overall line.
 * This is the backward-compatible summary view shown when --verbose is NOT set.
 */
export function formatSummary(checks) {
  const groups = byCategory(checks);
  const lines = [];
  let totalPass = 0;
  let totalFail = 0;
  for (const [category, list] of groups) {
    if (list.length === 0) continue;
    const fails = list.filter((c) => c.status === 'fail').length;
    const pass = list.length - fails;
    totalPass += pass;
    totalFail += fails;
    const status = fails > 0 ? 'fail' : 'pass';
    lines.push(formatLine(category, `${pass}/${list.length} checks passed`, status));
  }
  const overall = totalFail > 0 ? 'fail' : 'pass';
  lines.push(formatLine('FILES', `audit ${overall === 'pass' ? 'PASS' : 'FAIL'} — ${totalPass} passed, ${totalFail} failed`, overall));
  return lines;
}

/**
 * Verbose rendering: one line per individual check, grouped in category order. Includes the
 * optional `detail` field appended in parentheses so the operator sees exactly what was inspected.
 */
export function formatVerbose(checks) {
  const groups = byCategory(checks);
  const lines = [];
  for (const [, list] of groups) {
    for (const chk of list) {
      const detail = chk.detail ? ` (${chk.detail})` : '';
      lines.push(formatLine(chk.category, `${chk.message}${detail}`, chk.status));
    }
  }
  return lines;
}
