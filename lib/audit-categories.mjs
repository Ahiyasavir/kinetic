// audit-categories.mjs — the canonical diagnostic categories for `autopilot audit` (U-63) and the
// order they are emitted in. Keeping the names + order in one place means the verbose formatter, the
// summary formatter, and the tests all agree on the contract (the [CATEGORY] prefixes operators grep).

/** Ordered list of diagnostic categories. The audit walks them in this exact order. */
export const CATEGORIES = Object.freeze(['FILES', 'CONFIG', 'STATE', 'GIT', 'LOCKS']);

/** Status glyphs appended to a formatted line so output is human-readable AND grep-able by status. */
export const STATUS_GLYPHS = Object.freeze({
  pass: '✓',
  fail: '✗',
  warn: '!',
  info: '·'
});

/** True iff `name` is one of the canonical categories (used to validate hand-written checks). */
export function isCategory(name) {
  return CATEGORIES.includes(name);
}
