/**
 * File conflict scanner for Selector phase
 * Detects file path references in task notes/titles to identify overlaps with current changes
 */

/**
 * Parse file path references from task title/notes using regex patterns
 * @param {Array} candidates - Task candidates with id, title, notes
 * @param {Set} currentFiles - Set of currently modified file paths
 * @returns {Array} Conflict matrix showing which candidates reference which files
 */
export function scanConflicts(candidates, currentFiles) {
  // Handle null/undefined currentFiles
  const filesSet = currentFiles instanceof Set ? currentFiles : new Set();

  // Pattern to match file path references: src/, lib/, apps/, functions/
  const filePathPattern = /(?:src|lib|apps|functions)\/[\w./\-]+(?:\.\w+)?/g;

  const conflicts = [];

  // Process each candidate
  if (Array.isArray(candidates)) {
    for (const candidate of candidates) {
      const candidateConflicts = [];

      // Extract text to search from title and notes
      const searchText = `${candidate.title || ''} ${candidate.notes || ''}`;

      // Find all file path matches
      const matches = searchText.match(filePathPattern) || [];
      const uniqueMatches = new Set(matches);

      // Check each match against current files
      for (const filePath of uniqueMatches) {
        if (filesSet.has(filePath)) {
          candidateConflicts.push({
            taskId: candidate.id,
            filePath: filePath,
            conflict: true
          });
        }
      }

      // Add candidate entry even if no conflicts
      if (candidateConflicts.length > 0) {
        conflicts.push(...candidateConflicts);
      }
    }
  }

  return conflicts;
}
