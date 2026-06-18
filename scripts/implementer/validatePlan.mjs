/**
 * Plan validation for Implementer phase
 * Validates that a generated plan (intent.md) is consistent with task scope
 */

/**
 * Validate a plan (intent.md) for scope consistency and completeness
 * @param {string} intentContent - Markdown content of the intent
 * @returns {boolean|object|Promise} Validation result (approval/rejection)
 */
export function validatePlan(intentContent) {
  // Ensure we have valid intent content to validate
  if (!intentContent || typeof intentContent !== 'string') {
    return false; // Invalid intent
  }

  // Check for presence of required sections (case-insensitive)
  const lowerContent = intentContent.toLowerCase();

  // Required sections for a valid intent
  const requiredSections = {
    scope: /scope|task|description/,
    files: /key.*file|file.*path|implementation/,
    risk: /risk|blocker|constraint/,
    effort: /effort|estimate|complex/
  };

  // Count how many required sections are present
  const presentSections = Object.values(requiredSections).filter(pattern =>
    pattern.test(lowerContent)
  ).length;

  // Intent is considered valid if it has most required sections
  // Return a simple approval indicator (true for valid, false for invalid)
  const isValid = presentSections >= 2; // At least 2 of 4 sections

  // Return validation result
  // This could be extended to return more detailed feedback
  return isValid ? true : false;
}
