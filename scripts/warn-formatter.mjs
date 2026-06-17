// warn-formatter.mjs — format doc-drift warnings for console output and user review.

/**
 * Format a single doc-drift warning into a human-readable string.
 * @param {{
 *   filePath: string,
 *   matchedDocs?: string[],
 *   suggestedDocs?: string[],
 *   allDocs?: string[]
 * }} warning
 * @returns {string}
 */
export function formatWarning({ filePath, matchedDocs = [], suggestedDocs = [], allDocs = [] }) {
  const lines = [`[DOC-DRIFT] ${filePath} — architecture file not fully documented`];

  if (matchedDocs && matchedDocs.length > 0) {
    lines.push(`  Already referenced in: ${matchedDocs.join(', ')}`);
  }

  const toUpdate = suggestedDocs && suggestedDocs.length > 0
    ? suggestedDocs
    : allDocs.filter(d => !matchedDocs.includes(d));

  if (toUpdate.length > 0) {
    lines.push(`  Please update: ${toUpdate.join(', ')}`);
  }

  return lines.join('\n');
}
