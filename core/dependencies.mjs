// core/dependencies.mjs — lightweight AST-based dependency parser + relevance filter (U-45).
//
// Exports:
//   parseDependencies(filePath, fileContent)             → {imports:string[], requires:string[]}
//   buildDependencyGraph(fileMap)                        → DependencyGraph ({[file]:string[]})
//   getRelevantFiles(targetFile, taskDescription, allFiles) → string[]
//
// Used by core/selector/index.mjs to filter context maps to only the files relevant to
// candidate tasks, cutting token waste in the Selector LLM call by ≥30% when a
// context provider is wired.
//
// Algorithm (getRelevantFiles):
//   1. Score every file in allFiles by keyword match against taskDescription.
//   2. Seed BFS from targetFile (when given) and the top keyword-scored files.
//   3. Expand transitively up to maxDepth hops through the dependency graph.
//   4. Return up to maxFiles results sorted by (depth ASC, score DESC).
//
// Known limitations:
//   - TypeScript type-only imports are treated like regular imports (no distinction).
//   - Side-effect imports (`import 'polyfill'`) are captured but never traversed as roots.
//   - Circular dependencies are handled (visited set); graph is treated as directed.
//   - Dynamic require() with non-literal arguments (variables) are skipped intentionally.

import { createRequire } from 'node:module';
import path from 'node:path';

const _require = createRequire(import.meta.url);

// Attempt to load acorn for full AST parsing; fall back to regex when unavailable.
let _acornParse = null;
try {
  const acorn = _require('acorn');
  _acornParse = acorn.parse;
} catch { /* regex-only mode */ }

// Regex fallbacks — cover TypeScript, JSX, and acorn-parse failures.
const IMPORT_FROM_RE = /(?:^|;|\})\s*import\s+(?:[\s\S]*?\s+from\s+)?['"`]([^'"`\n]+)['"`]/gm;
const DYN_IMPORT_RE  = /\bimport\s*\(\s*['"`]([^'"`\n]+)['"`]\s*\)/gm;
const REQUIRE_RE     = /(?:^|[^.\w])require\s*\(\s*['"`]([^'"`\n]+)['"`]\s*\)/gm;

// Extensions for which regex is always preferred over acorn (TypeScript syntax).
const REGEX_ALWAYS = new Set(['.ts', '.tsx', '.jsx']);

// ── AST walking ────────────────────────────────────────────────────────────────────────────────

function _walkAst(node, imports, requires) {
  if (!node || typeof node !== 'object') return;
  switch (node.type) {
    case 'ImportDeclaration':
      if (node.source?.value) imports.push(node.source.value);
      break;
    case 'ImportExpression':
      // dynamic import('...')
      if (node.source?.type === 'Literal' && typeof node.source.value === 'string')
        imports.push(node.source.value);
      break;
    case 'CallExpression':
      if (node.callee?.name === 'require' &&
          node.arguments?.[0]?.type === 'Literal' &&
          typeof node.arguments[0].value === 'string')
        requires.push(node.arguments[0].value);
      break;
  }
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) { for (const c of child) _walkAst(c, imports, requires); }
    else if (child && typeof child === 'object' && child.type) _walkAst(child, imports, requires);
  }
}

function _parseWithAcorn(src) {
  let ast;
  try {
    ast = _acornParse(src, { ecmaVersion: 'latest', sourceType: 'module' });
  } catch {
    try { ast = _acornParse(src, { ecmaVersion: 'latest', sourceType: 'script' }); }
    catch { return null; } // signal caller to fall back to regex
  }
  const imports = [], requires = [];
  _walkAst(ast, imports, requires);
  return { imports: [...new Set(imports)], requires: [...new Set(requires)] };
}

function _parseWithRegex(src) {
  const imports = [], requires = [];
  let m;
  IMPORT_FROM_RE.lastIndex = 0;
  while ((m = IMPORT_FROM_RE.exec(src))) if (m[1]) imports.push(m[1]);
  DYN_IMPORT_RE.lastIndex = 0;
  while ((m = DYN_IMPORT_RE.exec(src))) if (m[1]) imports.push(m[1]);
  REQUIRE_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(src))) if (m[1]) requires.push(m[1]);
  return { imports: [...new Set(imports)], requires: [...new Set(requires)] };
}

// ── Public API ─────────────────────────────────────────────────────────────────────────────────

/**
 * Extract all import/require specifiers from a source file.
 * Uses acorn AST for .js/.mjs/.cjs files; regex for .ts/.tsx/.jsx and when acorn fails.
 * Only static string literals are captured — dynamic variable imports are intentionally skipped.
 *
 * @param {string} filePath     relative file path (extension drives parser choice)
 * @param {string} fileContent  raw source text
 * @returns {{ imports: string[], requires: string[] }}
 */
export function parseDependencies(filePath, fileContent) {
  if (!fileContent) return { imports: [], requires: [] };
  const ext = path.extname(filePath || '').toLowerCase();
  if (!REGEX_ALWAYS.has(ext) && _acornParse) {
    const result = _parseWithAcorn(fileContent);
    if (result) return result;
  }
  return _parseWithRegex(fileContent);
}

/**
 * Resolve an import specifier from fromFile to a relative path that exists in knownFiles.
 * Returns null for npm packages (no ./ or ../ prefix) and unresolvable paths.
 *
 * @param {string}      specifier
 * @param {string}      fromFile   the file containing the import
 * @param {Set<string>} knownFiles all file paths in the project
 * @returns {string|null}
 */
function _resolveSpecifier(specifier, fromFile, knownFiles) {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null; // npm package
  const fromDir = path.dirname(fromFile).replaceAll('\\', '/');
  const raw = path.posix.normalize(fromDir + '/' + specifier.replaceAll('\\', '/'));
  if (knownFiles.has(raw)) return raw;
  for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']) {
    if (knownFiles.has(raw + ext)) return raw + ext;
    const idx = raw + '/index' + ext;
    if (knownFiles.has(idx)) return idx;
  }
  return null;
}

/**
 * Build a dependency graph from a content map.
 * Only local imports (starting with . or /) are included; npm packages are skipped.
 *
 * @param {Record<string, string|null>} fileMap  {[relPath]: content|null}
 * @returns {Record<string, string[]>}           DependencyGraph — {[file]: [files it imports]}
 */
export function buildDependencyGraph(fileMap) {
  const knownFiles = new Set(Object.keys(fileMap));
  const graph = {};
  for (const [filePath, content] of Object.entries(fileMap)) {
    if (!content) { graph[filePath] = []; continue; }
    const { imports, requires } = parseDependencies(filePath, content);
    const deps = [];
    for (const spec of [...imports, ...requires]) {
      const resolved = _resolveSpecifier(spec, filePath, knownFiles);
      if (resolved && resolved !== filePath) deps.push(resolved);
    }
    graph[filePath] = [...new Set(deps)];
  }
  return graph;
}

/**
 * Return the minimal set of files needed by the Selector based on task context
 * and the dependency graph.
 *
 * @param {string|null}                      targetFile       root file for BFS traversal (optional)
 * @param {string}                           taskDescription  task text used for keyword scoring
 * @param {Record<string, string|null>|null} allFiles         {[relPath]: content|null} OR a
 *   pre-built DependencyGraph {[relPath]: string[]}; if null, uses built-in depGraph param.
 * @param {{
 *   depGraph?: Record<string, string[]>,  // pre-built graph (skips content parsing)
 *   maxDepth?: number,                    // BFS depth limit (default 3)
 *   maxFiles?: number,                    // max files to return (default 30)
 * }} [opts]
 * @returns {string[]}
 */
export function getRelevantFiles(targetFile, taskDescription = '', allFiles = null, opts = {}) {
  const { maxDepth = 3, maxFiles = 30 } = opts;

  // Resolve the dependency graph.
  let graph;
  if (opts.depGraph) {
    graph = opts.depGraph;
  } else if (allFiles && typeof allFiles === 'object') {
    // Distinguish between a content map {path: string|null} and a pre-built graph {path: string[]}.
    const firstVal = Object.values(allFiles)[0];
    if (Array.isArray(firstVal) || firstVal === undefined) {
      // Looks like a pre-built DependencyGraph.
      graph = allFiles;
    } else {
      graph = buildDependencyGraph(allFiles);
    }
  } else {
    return [];
  }

  const allFileList = Object.keys(graph);
  if (!allFileList.length) return [];

  // Extract keywords from taskDescription (3+ char tokens, lowercase).
  const keywords = [...new Set(
    (taskDescription || '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3)
  )];

  // Score every file by keyword match against its path.
  const fileScores = new Map();
  for (const f of allFileList) {
    const lf = f.toLowerCase().replaceAll('\\', '/');
    const base = lf.split('/').pop() || '';
    let score = 0;
    for (const kw of keywords) {
      if (base.includes(kw)) score += 3;
      else if (lf.includes(kw)) score += 1;
    }
    fileScores.set(f, score);
  }

  // Seed BFS from targetFile + top keyword-scoring files.
  const seeds = new Set();
  if (targetFile && graph[targetFile] !== undefined) seeds.add(targetFile);
  const topScored = [...fileScores.entries()]
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8);
  for (const [f] of topScored) seeds.add(f);

  if (!seeds.size) {
    // No keyword matches — return the first maxFiles by natural order (no graph traversal).
    return allFileList.slice(0, maxFiles);
  }

  // BFS traversal over the dependency graph.
  const visited = new Map(); // file → depth reached
  const queue = [];
  for (const s of seeds) { visited.set(s, 0); queue.push({ file: s, depth: 0 }); }

  let qi = 0;
  while (qi < queue.length) {
    const { file, depth } = queue[qi++];
    if (depth >= maxDepth) continue;
    for (const dep of graph[file] || []) {
      if (!visited.has(dep)) {
        visited.set(dep, depth + 1);
        queue.push({ file: dep, depth: depth + 1 });
      }
    }
  }

  // Sort: shallower first; within same depth, higher keyword score first.
  return [...visited.entries()]
    .sort((a, b) =>
      a[1] !== b[1]
        ? a[1] - b[1]
        : (fileScores.get(b[0]) || 0) - (fileScores.get(a[0]) || 0)
    )
    .slice(0, maxFiles)
    .map(([f]) => f);
}
