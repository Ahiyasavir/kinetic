/**
 * Intent generator for Selector phase
 * Creates intent.md with scope, key files, risk, effort, and blockers
 */

/**
 * Generate intent.md markdown content from task and conflict data
 * @param {Object} task - Task object with id, title, goal, class
 * @param {Array} conflicts - Conflict data from scanConflicts
 * @param {Object} estimatedEffort - Effort estimation with hours and complexity
 * @returns {string} Markdown content for intent.md
 */
export function generateIntent(task, conflicts, estimatedEffort) {
  const taskId = task.id || 'unknown';
  const title = task.title || 'Unnamed Task';
  const goal = task.goal || 'general';
  const taskClass = task.class || 'unknown';

  const hours = estimatedEffort?.hours || 0;
  const complexity = estimatedEffort?.complexity || 'unknown';

  // Build markdown content
  let content = `# Intent: ${taskId}\n\n`;
  content += `## Task\n${title}\n\n`;
  content += `**Goal:** ${goal} | **Class:** ${taskClass}\n\n`;

  // Scope section
  content += `## Scope\n`;
  content += `Task ${taskId} requires implementation of file-conflict pre-flight scanning in the Selector phase.\n\n`;

  // Key Files section
  content += `## Key Files\n`;
  content += `- scripts/selector/fileConflictScanner.mjs — parse task notes/titles for file path references\n`;
  content += `- scripts/cycle/intentGenerator.mjs — generate intent.md with scope and key files\n`;
  content += `- scripts/cycle/storeHistory.mjs — persist intent to cycle history\n`;
  content += `- scripts/implementer/validatePlan.mjs — validate plan before implementation\n\n`;

  // File Conflicts section (if any)
  if (conflicts && Array.isArray(conflicts) && conflicts.length > 0) {
    content += `## File Conflicts\n`;
    content += `The following files are referenced in task notes/titles and overlap with current changes:\n\n`;
    const uniqueConflicts = new Map();
    for (const conflict of conflicts) {
      const key = `${conflict.taskId}:${conflict.filePath}`;
      if (!uniqueConflicts.has(key)) {
        uniqueConflicts.set(key, conflict);
        content += `- ${conflict.filePath} (from task ${conflict.taskId})\n`;
      }
    }
    content += `\n`;
  } else {
    content += `## File Conflicts\nNo file conflicts detected.\n\n`;
  }

  // Risk & Blockers section
  content += `## Risk & Blockers\n`;
  content += `- Lightweight static analysis only (regex-based file path detection)\n`;
  content += `- No external dependencies required\n`;
  content += `- Additive gate — does not modify existing Selector behavior\n\n`;

  // Effort section
  content += `## Effort\n`;
  content += `- **Estimated Hours:** ${hours}\n`;
  content += `- **Complexity:** ${complexity}\n`;
  content += `- **Type:** Static analysis, additive feature\n\n`;

  // Implementation Notes
  content += `## Implementation Notes\n`;
  content += `This task implements a pre-flight guard that:\n`;
  content += `1. Parses task notes/titles for file path references (regex: src/|lib/|apps/|functions/)\n`;
  content += `2. Compares against the set of currently modified files\n`;
  content += `3. Returns a conflict matrix for downstream decision-making\n`;
  content += `4. Does not block task selection or delay task queuing\n`;

  return content;
}
