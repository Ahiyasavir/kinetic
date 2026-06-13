// agents/scanner.mjs — Proactive Scanner agent for tech-debt detection.
//
// Runs during idle time between cycles to analyze the codebase for common tech-debt patterns:
// - Dead code (unused imports, unreachable statements)
// - Overly-nested logic (deeply nested conditions/loops)
// - Missing error handling (try/catch violations, unhandled promises)
// - Hardcoded paths and magic numbers
// - Unused imports and variables
//
// Generates Markdown tickets into autopilot/suggestions/ for user approval.
// Uses AST-based analysis (core/dependencies.mjs + acorn for .js/.mjs; regex for TypeScript).
//
// Exports:
//   runScanner(options)                  → Promise<ScannerResult>
//   deduplicateIssues(currentIssues, pastIssues) → Issue[]

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const _require = createRequire(import.meta.url);
let _acornParse = null;
try {
  const acorn = _require('acorn');
  _acornParse = acorn.parse;
} catch { /* acorn unavailable, fall back to regex */ }

// Tech-debt issue categories and patterns
const PATTERNS = {
  unused_import: {
    name: 'Unused Import',
    description: 'Import statement that is never used in the file',
    effort: 1,
    risk: 1
  },
  dead_code: {
    name: 'Dead Code',
    description: 'Unreachable code or unused variable declarations',
    effort: 2,
    risk: 1
  },
  nested_logic: {
    name: 'Deeply Nested Logic',
    description: 'Nesting level exceeds 3, reducing readability and maintainability',
    effort: 2,
    risk: 2
  },
  missing_error_handling: {
    name: 'Missing Error Handling',
    description: 'Promise or async operation without proper error handling',
    effort: 2,
    risk: 3
  },
  hardcoded_path: {
    name: 'Hardcoded Path',
    description: 'Absolute or hardcoded file path instead of using path resolution',
    effort: 1,
    risk: 2
  },
  magic_number: {
    name: 'Magic Number',
    description: 'Numeric constant without explanation (should be a named constant)',
    effort: 1,
    risk: 1
  }
};

// Regex patterns for static analysis
const PATTERNS_REGEX = {
  import_from: /import\s+(?:(?:\{[^}]*\})|(?:\w+)|(?:\w+,\s*\{[^}]*\}))\s+from\s+['"`]([^'"`]+)['"`]/gm,
  require_call: /(?:const|let|var)\s+(\w+)\s*=\s*require\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/gm,
  nested_logic: /(?:if|for|while|switch)\s*\([^)]*\)\s*\{/g,
  hardcoded_path: /['"`](\/[a-zA-Z]|[A-Z]:\\|\.\/\.\.\/\.\.\/)[^'"`]*['"`]/g,
  magic_number: /:\s*\d{2,}(?:\s*[,;}]|$)/gm,
  unhandled_promise: /\.(?:then|catch)\s*\(|await\s+|Promise\s*\(/g,
  missing_catch: /\.then\s*\([^)]*\)(?!\s*\.catch)/gm
};

/**
 * Extract imported/required names from an import/require statement using AST or regex.
 * Returns an array of { name: string, line: number }.
 *
 * @param {string} content - file content
 * @param {string} filePath - relative file path (for AST choice)
 * @returns {{ name: string, line: number }[]}
 */
function extractImportedNames(content, filePath) {
  const names = [];
  const ext = path.extname(filePath).toLowerCase();
  const useRegex = ['.ts', '.tsx', '.jsx'].includes(ext);

  if (!useRegex && _acornParse) {
    // AST-based extraction for JavaScript
    try {
      const ast = _acornParse(content, { ecmaVersion: 'latest', sourceType: 'module' });
      _walkAstForImports(ast, content, names);
      return names;
    } catch {
      // Fall through to regex
    }
  }

  // Regex fallback for TypeScript or failed AST
  const lines = content.split('\n');

  // Extract from ES6 imports: import x from '...' or import { x, y } from '...'
  PATTERNS_REGEX.import_from.lastIndex = 0;
  let match;
  while ((match = PATTERNS_REGEX.import_from.exec(content))) {
    const lineNum = content.substring(0, match.index).split('\n').length;
    const importClause = match[0];
    // Extract named imports: import { x, y } from ...
    const namedMatch = importClause.match(/\{([^}]+)\}/);
    if (namedMatch) {
      const named = namedMatch[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop());
      for (const name of named) {
        if (name && name.length > 0) names.push({ name, line: lineNum });
      }
    }
    // Extract default imports: import x from ...
    const defMatch = importClause.match(/import\s+(\w+)\s+/);
    if (defMatch) {
      names.push({ name: defMatch[1], line: lineNum });
    }
  }

  // Extract from require: const x = require(...)
  PATTERNS_REGEX.require_call.lastIndex = 0;
  while ((match = PATTERNS_REGEX.require_call.exec(content))) {
    const lineNum = content.substring(0, match.index).split('\n').length;
    names.push({ name: match[1], line: lineNum });
  }

  return names;
}

/**
 * Walk the AST to extract imported variable names.
 * @param {*} node - AST node
 * @param {string} content - original source
 * @param {*[]} names - output array of { name, line }
 */
function _walkAstForImports(node, content, names) {
  if (!node || typeof node !== 'object') return;

  if (node.type === 'ImportDeclaration' && node.specifiers) {
    const lineNum = content.substring(0, node.start || 0).split('\n').length;
    for (const spec of node.specifiers) {
      if (spec.local && spec.local.name) {
        names.push({ name: spec.local.name, line: lineNum });
      }
    }
  } else if (node.type === 'VariableDeclarator' && node.id && node.init &&
             node.init.type === 'CallExpression' && node.init.callee.name === 'require') {
    const lineNum = content.substring(0, node.start || 0).split('\n').length;
    if (node.id.name) {
      names.push({ name: node.id.name, line: lineNum });
    }
  }

  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) _walkAstForImports(c, content, names);
    } else if (child && typeof child === 'object' && child.type) {
      _walkAstForImports(child, content, names);
    }
  }
}

/**
 * Detect unused imports by checking if imported names are used in the file.
 * Uses extractImportedNames to extract imported variable names via AST (for .js/.mjs)
 * and regex fallback (for TypeScript), then validates actual usage in the file.
 *
 * @param {string} filePath - relative file path
 * @param {string} content - file content
 * @returns {Issue[]}
 */
function detectUnusedImports(filePath, content) {
  const issues = [];
  const importedNames = extractImportedNames(content, filePath);

  for (const { name, line } of importedNames) {
    // Count occurrences of the name, excluding the import line itself
    const lines = content.split('\n');
    let usageCount = 0;

    for (let i = 0; i < lines.length; i++) {
      if (i === line - 1) continue; // Skip the import line
      const lineContent = lines[i];
      const matches = lineContent.match(new RegExp(`\\b${name}\\b`, 'g')) || [];
      usageCount += matches.length;
    }

    // If used 0 times in the rest of the file, flag it as unused
    if (usageCount === 0) {
      issues.push({
        category: 'unused_import',
        filePath,
        line,
        description: `Import "${name}" is never used in the file`,
        severity: 'low',
        effort: PATTERNS.unused_import.effort,
        risk: PATTERNS.unused_import.risk
      });
    }
  }

  return issues;
}

/**
 * Detect magic numbers (unexplained numeric literals).
 *
 * @param {string} filePath - relative file path
 * @param {string} content - file content
 * @returns {Issue[]}
 */
function detectMagicNumbers(filePath, content) {
  const issues = [];
  const lines = content.split('\n');
  const commonConstants = new Set(['0', '1', '2', '-1', '10', '100', '1000', '60', '60000']);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments and constants declarations
    if (line.trim().startsWith('//') || line.includes('const ') || line.includes('= ')) {
      continue;
    }

    // Look for numeric literals in control flow or calculations
    const matches = line.match(/[^a-zA-Z_](\d{3,})\b/g);
    if (matches) {
      for (const match of matches) {
        const num = match.trim();
        if (!commonConstants.has(num) && !line.includes(`${num}ms`) && !line.includes(`${num}px`)) {
          issues.push({
            category: 'magic_number',
            filePath,
            line: i + 1,
            description: `Magic number ${num} (consider extracting to named constant)`,
            severity: 'low',
            effort: PATTERNS.magic_number.effort,
            risk: PATTERNS.magic_number.risk
          });
          break; // One issue per line
        }
      }
    }
  }

  return issues;
}

/**
 * Detect missing error handling on promises and async operations.
 *
 * @param {string} filePath - relative file path
 * @param {string} content - file content
 * @returns {Issue[]}
 */
function detectMissingErrorHandling(filePath, content) {
  const issues = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for .then() without .catch() - simplified (checks if line has .then but no catch)
    if (line.includes('.then(') && !line.includes('.catch(')) {
      // Look ahead to see if there's a catch on the next line or same statement
      let foundCatch = false;
      for (let j = i; j < Math.min(i + 3, lines.length); j++) {
        if (lines[j].includes('.catch(')) {
          foundCatch = true;
          break;
        }
      }

      if (!foundCatch && !line.trim().startsWith('//')) {
        issues.push({
          category: 'missing_error_handling',
          filePath,
          line: i + 1,
          description: 'Promise .then() without .catch() error handler',
          severity: 'high',
          effort: PATTERNS.missing_error_handling.effort,
          risk: PATTERNS.missing_error_handling.risk
        });
      }
    }

    // Check for await without try-catch (only if not already in a try block)
    if (line.includes('await ') && !line.includes('try {') && !line.includes('try {')) {
      let inTryBlock = false;
      for (let j = Math.max(0, i - 5); j < i; j++) {
        if (lines[j].includes('try {') || lines[j].includes('try{')) {
          inTryBlock = true;
          break;
        }
      }

      if (!inTryBlock && !line.trim().startsWith('//')) {
        // Heuristic: look for catch within reasonable distance
        let foundCatch = false;
        for (let j = i; j < Math.min(i + 10, lines.length); j++) {
          if (lines[j].includes('} catch')) {
            foundCatch = true;
            break;
          }
        }

        if (!foundCatch && !line.includes('// @ts-ignore')) {
          issues.push({
            category: 'missing_error_handling',
            filePath,
            line: i + 1,
            description: 'Await statement without try-catch error handling',
            severity: 'high',
            effort: PATTERNS.missing_error_handling.effort,
            risk: PATTERNS.missing_error_handling.risk
          });
        }
      }
    }
  }

  return issues;
}

/**
 * Detect hardcoded file system paths instead of using path.join/resolve.
 *
 * @param {string} filePath - relative file path
 * @param {string} content - file content
 * @returns {Issue[]}
 */
function detectHardcodedPaths(filePath, content) {
  const issues = [];
  const lines = content.split('\n');

  // Patterns for absolute paths and likely hardcoded paths
  const hardcodedPathPatterns = [
    /['"`](\/[a-zA-Z]|[A-Z]:\\)/,  // Unix absolute or Windows drive
    /path\s*:\s*['"`]\/\w+\/\w+/,  // path: "/something/else"
    /pathname\s*:\s*['"`]\/\w+/,   // pathname: "/something"
  ];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pattern of hardcodedPathPatterns) {
      if (pattern.test(line)) {
        // Skip comments and common false positives
        if (line.trim().startsWith('//') || line.includes('example') || line.includes('REPO_ROOT')) {
          continue;
        }
        issues.push({
          category: 'hardcoded_path',
          filePath,
          line: i + 1,
          description: `Hardcoded file path detected (consider using path.join/resolve)`,
          severity: 'medium',
          effort: PATTERNS.hardcoded_path.effort,
          risk: PATTERNS.hardcoded_path.risk
        });
        break; // One issue per line
      }
    }
  }

  return issues;
}

/**
 * Detect dead code: unreachable statements after return/throw and unused variable declarations.
 *
 * @param {string} filePath - relative file path
 * @param {string} content - file content
 * @returns {Issue[]}
 */
function detectDeadCode(filePath, content) {
  const issues = [];
  const lines = content.split('\n');

  // Track variable declarations and usage for dead variable detection
  const varDeclarations = new Map(); // varName -> { line, context }
  const varUsage = new Set(); // varNames that are used

  // 1. Detect unreachable code after return/throw
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip comments and empty lines
    if (!line || line.startsWith('//') || line.startsWith('*')) continue;

    // Check if this line contains a return or throw statement
    if (/^return\b/.test(line) || /^throw\b/.test(line)) {
      // Look for code after return/throw on same line or following lines
      const afterReturn = line.substring(line.indexOf(line.match(/return|throw/)[0]) + 6).trim();

      // Check next few lines for code (not just closing braces/comments)
      for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
        const nextLine = lines[j].trim();
        // Skip empty lines, closing braces, and comments
        if (!nextLine || nextLine === '}' || nextLine.startsWith('//') || nextLine.startsWith('*')) {
          continue;
        }
        // Found unreachable code
        if (/^(case|default|else|catch|finally|}\s*else)/.test(nextLine) === false) {
          issues.push({
            category: 'dead_code',
            filePath,
            line: j + 1,
            description: `Unreachable code after return/throw statement on line ${i + 1}`,
            severity: 'medium',
            effort: PATTERNS.dead_code.effort,
            risk: PATTERNS.dead_code.risk
          });
          break; // Report once per return/throw block
        }
      }
    }
  }

  // 2. Detect unused variable declarations (const/let/var that are never referenced)
  // Use the same walk as detectUnusedImports to find variable references
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match variable declarations: const x = ..., let y = ..., var z = ...
    const varMatch = line.match(/^(?:const|let|var)\s+(\w+)\s*=/);
    if (varMatch) {
      const varName = varMatch[1];
      // Skip common patterns that shouldn't trigger this (underscore, etc.)
      if (varName.startsWith('_')) continue;
      varDeclarations.set(varName, { line: i + 1, context: line });
    }

    // Collect all identifier usage (simple heuristic)
    const identifiers = line.match(/\b[a-zA-Z_]\w*\b/g) || [];
    for (const id of identifiers) {
      varUsage.add(id);
    }
  }

  // Check which declared variables are never used
  for (const [varName, { line: declLine }] of varDeclarations) {
    // If variable is not in usage set, mark as unused
    // Note: this is a simple heuristic and may have false positives (e.g., if used in comments)
    if (!varUsage.has(varName)) {
      issues.push({
        category: 'dead_code',
        filePath,
        line: declLine,
        description: `Unused variable declaration "${varName}" (never referenced)`,
        severity: 'low',
        effort: PATTERNS.dead_code.effort,
        risk: PATTERNS.dead_code.risk
      });
    }
  }

  return issues;
}

/**
 * Detect deeply nested logic blocks (if/for/while/switch with depth > 4).
 *
 * @param {string} filePath - relative file path
 * @param {string} content - file content
 * @returns {Issue[]}
 */
function detectDeeplyNestedLogic(filePath, content) {
  const issues = [];
  const lines = content.split('\n');
  const depthByLine = [];
  let currentDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let lineDepth = currentDepth;

    // Count { and } on this line
    for (const char of line) {
      if (char === '{') {
        currentDepth++;
        lineDepth = Math.max(lineDepth, currentDepth);
      } else if (char === '}') {
        currentDepth--;
      }
    }

    depthByLine[i] = lineDepth;
  }

  // Find lines with excessive nesting (depth > 4) that contain control flow keywords
  for (let i = 0; i < lines.length; i++) {
    if (depthByLine[i] > 4) {
      const line = lines[i].trim();
      if (/^(if|for|while|switch|else)\b/.test(line)) {
        issues.push({
          category: 'nested_logic',
          filePath,
          line: i + 1,
          description: `Nested control flow at depth ${depthByLine[i]} (> 4 recommended)`,
          severity: 'medium',
          effort: PATTERNS.nested_logic.effort,
          risk: PATTERNS.nested_logic.risk
        });
        break; // Report once per file
      }
    }
  }

  return issues;
}

/**
 * Analyze a single file for tech-debt patterns.
 * Returns an array of detected issues.
 *
 * @param {string} filePath - relative file path
 * @param {string} content - file content
 * @returns {Issue[]} detected issues
 */
function analyzeFile(filePath, content) {
  if (!content) return [];
  const issues = [];
  const lines = content.split('\n');

  // Skip certain file types
  const ext = path.extname(filePath).toLowerCase();
  if (['.json', '.md', '.lock'].includes(ext)) return [];

  // 1. Detect unused imports using AST-based analysis
  const unusedImports = detectUnusedImports(filePath, content);
  issues.push(...unusedImports);

  // 2. Detect dead code (unreachable statements and unused variable declarations)
  const deadCodeIssues = detectDeadCode(filePath, content);
  issues.push(...deadCodeIssues);

  // 3. Detect deeply nested logic
  const nestedLogicIssues = detectDeeplyNestedLogic(filePath, content);
  issues.push(...nestedLogicIssues);

  // 4. Detect hardcoded paths
  const hardcodedPaths = detectHardcodedPaths(filePath, content);
  issues.push(...hardcodedPaths);

  // 5. Detect missing error handling on promises
  const errorHandlingIssues = detectMissingErrorHandling(filePath, content);
  issues.push(...errorHandlingIssues);

  // 6. Detect magic numbers in numeric literals (limit to avoid noise)
  const magicNumberIssues = detectMagicNumbers(filePath, content);
  issues.push(...magicNumberIssues.slice(0, 2)); // Limit to 2 issues per file

  return issues;
}

/**
 * Deduplicate issues by content hash and file path.
 * Keeps only unique problems to avoid reporting the same issue multiple times.
 *
 * @param {Issue[]} currentIssues - issues detected in this scan
 * @param {Map<string, Issue>} pastIssues - issues from previous scans (keyed by contentHash)
 * @returns {Issue[]} deduplicated issues
 */
function deduplicateIssues(currentIssues, pastIssues = new Map()) {
  const seen = new Map(); // contentHash → Issue
  for (const issue of currentIssues) {
    const hash = crypto.createHash('sha256')
      .update(`${issue.filePath}:${issue.category}:${issue.line}`)
      .digest('hex')
      .slice(0, 8);
    if (!seen.has(hash) && !pastIssues.has(hash)) {
      issue.contentHash = hash;
      seen.set(hash, issue);
    }
  }
  return Array.from(seen.values());
}

/**
 * Format an issue as Markdown ticket content.
 *
 * @param {Issue} issue - the issue to format
 * @returns {string} markdown content
 */
function formatIssueAsMarkdown(issue) {
  const goal = 'intelligence'; // All scanner tasks are intelligence goals
  const title = `tech-debt: ${issue.description.slice(0, 60)}`;
  const content = `# ${title}

**Goal:** ${goal}
**Class:** maintenance
**Risk:** ${issue.risk}
**Effort:** ${issue.effort}

## Description

${PATTERNS[issue.category]?.description || 'Tech-debt issue detected'}

**Category:** ${issue.category}
**File:** \`${issue.filePath}\`
**Line:** ${issue.line}

## Details

${issue.description}

## Fix

Review the file and apply the appropriate fix for the detected pattern.

`;
  return content;
}

/**
 * Generate a ticket filename with category, timestamp, and content hash.
 *
 * @param {Issue} issue - the issue
 * @returns {string} filename (without directory)
 */
function generateTicketFilename(issue) {
  const timestamp = Date.now();
  const hash = issue.contentHash || crypto.createHash('sha256')
    .update(`${issue.filePath}:${issue.category}:${issue.line}`)
    .digest('hex')
    .slice(0, 8);
  return `tech-debt-${issue.category}-${timestamp}-${hash}.md`;
}

/**
 * Load all existing tickets from the suggestions directory.
 * Also loads dismissed content hashes from .dismissed file to exclude them from re-generation.
 * Returns a Map of contentHash → Issue for deduplication.
 *
 * @param {string} suggestionsDir - path to autopilot/suggestions/
 * @returns {Map<string, Issue>} existing issues by hash (includes dismissed)
 */
function loadExistingTickets(suggestionsDir) {
  const existing = new Map();
  if (!existsSync(suggestionsDir)) return existing;

  try {
    const files = readdirSync(suggestionsDir);
    for (const file of files) {
      if (!file.endsWith('.md')) continue;
      const match = file.match(/tech-debt-[^-]+-\d+-([a-f0-9]+)\.md/);
      if (match) {
        existing.set(match[1], { filename: file });
      }
    }

    // Also load dismissed hashes to avoid re-generating dismissed issues
    const dismissedPath = path.join(suggestionsDir, '.dismissed');
    if (existsSync(dismissedPath)) {
      try {
        const dismissedContent = readFileSync(dismissedPath, 'utf8');
        const hashes = dismissedContent.split('\n').filter(h => h.trim().length > 0);
        for (const hash of hashes) {
          existing.set(hash, { filename: null, dismissed: true });
        }
      } catch (err) {
        // Ignore dismissed file read errors
      }
    }
  } catch (err) {
    // Ignore read errors
  }

  return existing;
}

/**
 * Internal helper: persist a content hash into the .dismissed log for a suggestions directory.
 * Deduplicates before writing; tolerates a missing .dismissed file.
 *
 * @param {string} suggestionsDir - path to autopilot/suggestions/
 * @param {string} contentHash - the hash to persist
 */
function _persistDismissedHash(suggestionsDir, contentHash) {
  const dismissedPath = path.join(suggestionsDir, '.dismissed');
  let dismissed = [];
  if (existsSync(dismissedPath)) {
    const content = readFileSync(dismissedPath, 'utf8');
    dismissed = content.split('\n').filter(h => h.trim().length > 0);
  }
  if (!dismissed.includes(contentHash)) {
    dismissed.push(contentHash);
    writeFileSync(dismissedPath, dismissed.join('\n') + '\n', 'utf8');
  }
}

/**
 * Unified dismissal pipeline: unlink the suggestion file and atomically persist its content
 * hash to the .dismissed log so it is never re-generated. This is the single canonical mutation
 * point for dismissal — no other code should call unlinkSync or appendFileSync on these paths.
 *
 * Exported so supervisor.mjs can delegate all dismiss I/O here (Cycle-207 fix).
 *
 * @param {string} suggestionPath - absolute path to the suggestion .md file
 * @param {string} contentHash    - the hash extracted from the filename (8-char hex)
 */
export function dismissSuggestion(suggestionPath, contentHash) {
  const suggestionsDir = path.dirname(suggestionPath);
  if (existsSync(suggestionPath)) {
    unlinkSync(suggestionPath);
  }
  _persistDismissedHash(suggestionsDir, contentHash);
}

/**
 * Approve a suggestion by removing its hash from the dismissed list (if present).
 *
 * @param {string} suggestionsDir - path to autopilot/suggestions/
 * @param {string} contentHash - the hash to approve
 */
function approveSuggestion(suggestionsDir, contentHash) {
  try {
    const dismissedPath = path.join(suggestionsDir, '.dismissed');
    if (existsSync(dismissedPath)) {
      const content = readFileSync(dismissedPath, 'utf8');
      const dismissed = content.split('\n').filter(h => h.trim().length > 0 && h !== contentHash);
      writeFileSync(dismissedPath, dismissed.join('\n') + (dismissed.length > 0 ? '\n' : ''), 'utf8');
    }
  } catch (err) {
    // Ignore write errors for dismissed file
  }
}

/**
 * Main scanner entry point.
 * Analyzes the codebase, deduplicates issues, and writes tickets.
 *
 * @param {Object} options
 * @param {string} options.repoRoot - repository root path
 * @param {string} options.suggestionsDir - output directory for tickets
 * @param {string[]} options.ignorePaths - glob patterns to exclude
 * @param {boolean} options.dryRun - if true, don't write files
 * @param {Object} options.telemetry - telemetry recorder
 * @returns {Promise<ScannerResult>}
 */
export async function runScanner(options = {}) {
  const {
    repoRoot = process.cwd(),
    suggestionsDir = path.join(repoRoot, 'autopilot', 'suggestions'),
    ignorePaths = [],
    dryRun = false,
    telemetry = null
  } = options;

  const result = {
    ticketsGenerated: 0,
    ticketsDeduped: 0,
    totalIssuesFound: 0,
    filesScanned: 0,
    durationMs: 0,
    errors: [],
    timestamp: new Date().toISOString()
  };

  const startTime = Date.now();
  const allIssues = [];
  const ignorePatternsSet = new Set(ignorePaths);

  try {
    // 1. Walk the repository and collect files to scan
    const filesToScan = [];
    function walkDir(dir, prefix = '') {
      try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const name = entry.name;
          // Skip hidden/node_modules/build artifacts
          if (name.startsWith('.') || name === 'node_modules' || name === 'dist' || name === 'build' || name === 'coverage') {
            continue;
          }

          const fullPath = path.join(dir, name);
          const relPath = path.join(prefix, name).replaceAll('\\', '/');

          // Check ignore patterns
          let shouldIgnore = false;
          for (const pattern of ignorePatternsSet) {
            if (relPath.includes(pattern) || pattern.includes(relPath)) {
              shouldIgnore = true;
              break;
            }
          }
          if (shouldIgnore) continue;

          if (entry.isDirectory()) {
            walkDir(fullPath, relPath);
          } else {
            const ext = path.extname(name).toLowerCase();
            if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
              filesToScan.push({ fullPath, relPath });
            }
          }
        }
      } catch (err) {
        result.errors.push(`Error walking ${dir}: ${err.message}`);
      }
    }

    walkDir(repoRoot);

    // 2. Analyze each file for tech-debt
    for (const { fullPath, relPath } of filesToScan) {
      try {
        const content = readFileSync(fullPath, 'utf8');
        const issues = analyzeFile(relPath, content);
        allIssues.push(...issues);
        result.filesScanned++;
      } catch (err) {
        result.errors.push(`Error analyzing ${relPath}: ${err.message}`);
      }
    }

    result.totalIssuesFound = allIssues.length;

    // 3. Deduplicate against existing tickets
    const existingTickets = loadExistingTickets(suggestionsDir);
    const deduped = deduplicateIssues(allIssues, existingTickets);
    result.ticketsDeduped = allIssues.length - deduped.length;

    // 4. Write tickets to suggestions directory
    if (deduped.length > 0 && !dryRun) {
      if (!existsSync(suggestionsDir)) {
        mkdirSync(suggestionsDir, { recursive: true });
      }

      for (const issue of deduped) {
        const filename = generateTicketFilename(issue);
        const filePath = path.join(suggestionsDir, filename);
        const markdown = formatIssueAsMarkdown(issue);
        writeFileSync(filePath, markdown, 'utf8');
        result.ticketsGenerated++;
      }
    }

    result.durationMs = Date.now() - startTime;

    // 5. Emit telemetry
    if (telemetry && typeof telemetry.recordEvent === 'function') {
      telemetry.recordEvent('scanner-run', {
        ticketsGenerated: result.ticketsGenerated,
        ticketsDeduped: result.ticketsDeduped,
        totalIssuesFound: result.totalIssuesFound,
        filesScanned: result.filesScanned,
        durationMs: result.durationMs,
        errorCount: result.errors.length
      });
    }
  } catch (err) {
    result.errors.push(`Scanner fatal error: ${err.message}`);
  }

  return result;
}

/**
 * Approve a suggestion ticket, removing it from the dismissed list and moving it to the inbox.
 * Emits telemetry event for approval tracking.
 *
 * @param {string} suggestionsDir - path to autopilot/suggestions/
 * @param {string} filename - ticket filename (e.g., tech-debt-unused_import-1234567890-abcd1234.md)
 * @param {Object} telemetry - telemetry recorder
 */
export function cmdApproveSuggestion(suggestionsDir, filename, telemetry = null) {
  const match = filename.match(/([a-f0-9]+)\.md$/);
  const contentHash = match ? match[1] : null;

  if (!contentHash) {
    throw new Error(`Invalid suggestion filename: ${filename}`);
  }

  // Remove from dismissed list
  approveSuggestion(suggestionsDir, contentHash);

  // Read the suggestion .md from suggestionsDir and move it to inbox
  const suggestionPath = path.join(suggestionsDir, filename);
  if (existsSync(suggestionPath)) {
    try {
      const content = readFileSync(suggestionPath, 'utf8');
      const inboxDir = path.join(path.dirname(suggestionsDir), 'inbox');
      if (!existsSync(inboxDir)) {
        mkdirSync(inboxDir, { recursive: true });
      }
      const timestamp = Date.now();
      const inboxFilename = `${timestamp}-tech-debt-${contentHash}.md`;
      const inboxPath = path.join(inboxDir, inboxFilename);
      writeFileSync(inboxPath, content, 'utf8');
      unlinkSync(suggestionPath);
    } catch (err) {
      // Log error but don't fail the approval
      console.error(`Failed to move suggestion to inbox: ${err.message}`);
    }
  }

  // Emit telemetry
  if (telemetry && typeof telemetry.recordEvent === 'function') {
    telemetry.recordEvent('scanner-approve', { filename });
  }
}

/**
 * Dismiss a suggestion ticket via the centralized dismissSuggestion pipeline.
 * Emits telemetry event for dismissal tracking.
 *
 * @param {string} suggestionsDir - path to autopilot/suggestions/
 * @param {string} filename - ticket filename (e.g., tech-debt-unused_import-1234567890-abcd1234.md)
 * @param {Object} telemetry - telemetry recorder
 */
export function cmdDismissSuggestion(suggestionsDir, filename, telemetry = null) {
  const match = filename.match(/([a-f0-9]+)\.md$/);
  const contentHash = match ? match[1] : null;

  if (!contentHash) {
    throw new Error(`Invalid suggestion filename: ${filename}`);
  }

  dismissSuggestion(path.join(suggestionsDir, filename), contentHash);

  // Emit telemetry
  if (telemetry && typeof telemetry.recordEvent === 'function') {
    telemetry.recordEvent('scanner-dismiss', { filename });
  }
}

export default { runScanner, deduplicateIssues, dismissSuggestion, cmdApproveSuggestion, cmdDismissSuggestion };
