// arch-classifier.mjs — classify changed files as architecture-relevant or not.
// Used by the doc-sync audit to determine which changed files need doc coverage.

// Patterns that qualify a file as architecture-relevant (matched against normalized forward-slash paths).
// Covers the acceptance set: src/, lib/, core/, functions/, apps/ (anywhere in the path).
const ARCH_INCLUDE_PATTERNS = [
  /^functions\//,
  /^apps\//,
  /^packages\/shared\/src\//,
  /(^|\/)src\//,
  /(^|\/)lib\//,
  /(^|\/)core\//,
];

// Patterns that disqualify a file even if it matches an include pattern.
const ARCH_EXCLUDE_PATTERNS = [
  /node_modules\//,
  /\/dist\//,
  /^dist\//,
  /^functions\/lib\//, // compiled Cloud Functions output (TS build artifact), not source
  /\.d\.ts$/,
  /\.(next)\//,
  /^\.(next)\//,
  /__tests__\//,
  /\.test\.[^/]+$/,
  /\.spec\.[^/]+$/,
];

function normalizePath(p) {
  return (p || '').replace(/\\/g, '/');
}

function isArchitectureRelevant(filePath) {
  const p = normalizePath(filePath);
  if (ARCH_EXCLUDE_PATTERNS.some(re => re.test(p))) return false;
  return ARCH_INCLUDE_PATTERNS.some(re => re.test(p));
}

/**
 * Classify a list of file paths as architecture-relevant or excluded.
 * @param {string[]} files - file paths (may use backslashes on Windows)
 * @returns {{ architectureRelevant: string[], excluded: string[] }}
 */
export function classifyArchitectureFiles(files) {
  if (!Array.isArray(files)) return { architectureRelevant: [], excluded: [] };

  const architectureRelevant = [];
  const excluded = [];

  for (const file of files) {
    if (isArchitectureRelevant(file)) {
      architectureRelevant.push(file);
    } else {
      excluded.push(file);
    }
  }

  return { architectureRelevant, excluded };
}
