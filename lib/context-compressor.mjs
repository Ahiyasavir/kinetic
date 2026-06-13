// context compression: symbol-level extraction
//
// lib/context-compressor.mjs — AST-based context compression (U-81). Builds on U-45's deterministic
// file-relevance scan: once the relevant FILES are known, this shrinks each large file's CONTENT to
// only the symbols that matter for the current task before it is injected into the Implementer prompt.
// 80–90% of a 600-line file is noise for a task that touches one function; this strips that noise.
//
// SAFE PRINCIPLE (load-bearing): every code path is wrapped so that ANY failure — missing acorn, a
// parse error (TypeScript / dynamic syntax), an unexpected AST shape — silently returns the ORIGINAL,
// full file content (Level 0). A cycle must NEVER fail because of compression infrastructure. The
// original file on disk is never touched; we only transform an in-memory copy of the string.
//
// Compression levels:
//   Level 0  full content (fallback / under-threshold / parse failure / no symbols).
//   Level 1  every function/class → signature only (no bodies).
//   Level 2  (default for files > minFileSizeLines): task-relevant symbols + their 1-hop dep-graph
//            neighbours (callers/callees within the same file) at FULL body; all others at L1.
//   Level 3  reserved (2-hop) — NOT implemented; treated as Level 2.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Lazy, fault-tolerant acorn loader. Cached. Returns null when acorn is unavailable so callers fall
// back to Level 0 rather than throwing at module-import time (which would break the supervisor).
let _acorn; // undefined = not tried yet, null = unavailable, object = loaded
function getAcorn() {
  if (_acorn !== undefined) return _acorn;
  try { _acorn = require('acorn'); } catch { _acorn = null; }
  return _acorn;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Pull candidate identifier names out of the free-text task description (title + notes + criteria).
// Word-boundary tokens that look like code identifiers (>=3 chars, contain a letter). Used only to
// SEED relevance — over-matching is harmless (it just keeps more bodies), under-matching falls back
// toward Level 1 for that symbol.
function extractRelevantNames(taskDescription) {
  const out = new Set();
  if (!taskDescription || typeof taskDescription !== 'string') return out;
  const re = /\b([A-Za-z_$][A-Za-z0-9_$]{2,})\b/g;
  let m;
  while ((m = re.exec(taskDescription))) out.add(m[1].toLowerCase());
  return out;
}

// Unwrap an `export` / `export default` statement to the underlying declaration node, or return the
// node itself. Used so we can name exported functions/classes/consts.
function declOf(node) {
  if (!node) return null;
  if (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') {
    return node.declaration || null;
  }
  return node;
}

// Collect TOP-LEVEL named symbols (functions, classes, and const/let/var bound to a function/arrow/
// class expression), each with its name, character range and 1-based line range. Top-level only, so
// ranges never overlap — the renderer can replace them line-by-line safely.
function extractSymbols(ast, content) {
  const symbols = [];
  if (!ast || !Array.isArray(ast.body)) return symbols;
  for (const stmt of ast.body) {
    const outer = stmt; // keep the export wrapper's range so `export` stays in the signature
    const d = declOf(stmt);
    if (!d) continue;
    const push = (name) => {
      if (!name) return;
      if (!outer.loc || !outer.loc.start || !outer.loc.end) return;
      symbols.push({
        name,
        start: outer.start,
        end: outer.end,
        startLine: outer.loc.start.line,
        endLine: outer.loc.end.line,
      });
    };
    if (d.type === 'FunctionDeclaration' && d.id) push(d.id.name);
    else if (d.type === 'ClassDeclaration' && d.id) push(d.id.name);
    else if (d.type === 'VariableDeclaration' && Array.isArray(d.declarations)) {
      const first = d.declarations[0];
      if (first && first.id && first.id.type === 'Identifier' && first.init &&
        (first.init.type === 'ArrowFunctionExpression' ||
          first.init.type === 'FunctionExpression' ||
          first.init.type === 'ClassExpression')) {
        push(first.id.name);
      }
    }
  }
  return symbols;
}

// Bidirectional reference graph BFS: a symbol is kept if it is task-relevant (seed) or within maxHops
// of a seed through same-file references (covers BOTH callers and callees). A `visited` set guarantees
// termination even with circular references between symbols.
function computeRelevantSymbols(symbols, relevantNames, content, maxHops) {
  const adj = new Map(symbols.map((s) => [s.name, new Set()]));
  for (const a of symbols) {
    const bodyA = content.slice(a.start, a.end);
    for (const b of symbols) {
      if (a.name === b.name) continue;
      const re = new RegExp(`\\b${escapeRegExp(b.name)}\\b`);
      if (re.test(bodyA)) {
        adj.get(a.name).add(b.name);
        adj.get(b.name).add(a.name);
      }
    }
  }
  const keep = new Set();
  const visited = new Set();
  let frontier = symbols.filter((s) => relevantNames.has(s.name.toLowerCase())).map((s) => s.name);
  for (const n of frontier) { keep.add(n); visited.add(n); }
  let hop = 0;
  while (frontier.length && hop < maxHops) {
    const next = [];
    for (const name of frontier) {
      for (const neighbour of adj.get(name) || []) {
        if (visited.has(neighbour)) continue;
        visited.add(neighbour);
        keep.add(neighbour);
        next.push(neighbour);
      }
    }
    frontier = next;
    hop++;
  }
  return keep;
}

// Leading whitespace of a line, so an emitted signature keeps the original indentation.
function indentOf(line) {
  const m = /^(\s*)/.exec(line || '');
  return m ? m[1] : '';
}

// Collapse a symbol's source to a one-line signature: everything up to the first `{`, plus an elided
// body marker. Expression-bodied arrows (no brace) keep their first line.
function signatureOf(src) {
  const braceIdx = src.indexOf('{');
  if (braceIdx === -1) {
    const firstLine = (src.split('\n')[0] || '').trim();
    return `${firstLine} // …`;
  }
  const head = src.slice(0, braceIdx).replace(/\s+/g, ' ').trim();
  return `${head} { /* … */ }`;
}

// Rebuild file content: non-symbol lines (imports, top-level comments) are kept verbatim; kept symbols
// keep their full body; everything else collapses to a signature line.
function renderCompressed(content, symbols, keep) {
  const lines = content.split('\n');
  const sorted = [...symbols].sort((a, b) => a.startLine - b.startLine);
  const out = [];
  let cursor = 1; // 1-based line about to be emitted
  for (const sym of sorted) {
    if (sym.startLine < cursor) continue; // defensive: skip any overlap
    while (cursor < sym.startLine && cursor <= lines.length) { out.push(lines[cursor - 1]); cursor++; }
    if (keep.has(sym.name)) {
      while (cursor <= sym.endLine && cursor <= lines.length) { out.push(lines[cursor - 1]); cursor++; }
    } else {
      const src = content.slice(sym.start, sym.end);
      out.push(indentOf(lines[sym.startLine - 1]) + signatureOf(src));
      cursor = sym.endLine + 1;
    }
  }
  while (cursor <= lines.length) { out.push(lines[cursor - 1]); cursor++; }
  return out.join('\n');
}

// Compress a single file. Returns { content, wasCompressed, compressedLines }. Throws on internal
// failure so the public wrapper can catch and fall back to Level 0.
function compressFile(content, originalLines, minLines, level, relevantNames) {
  if (content.trim() === '') return { content, wasCompressed: false, compressedLines: originalLines };
  if (originalLines <= minLines) return { content, wasCompressed: false, compressedLines: originalLines };

  const acorn = getAcorn();
  if (!acorn) return { content, wasCompressed: false, compressedLines: originalLines };

  // A parse error here (TypeScript, dynamic syntax) propagates to the caller → Level 0 fallback.
  const ast = acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const symbols = extractSymbols(ast, content);
  if (!symbols.length) return { content, wasCompressed: false, compressedLines: originalLines };

  // Level 1 keeps NO bodies; Level 2 keeps task-relevant + 1-hop neighbours.
  const keep = level >= 2
    ? computeRelevantSymbols(symbols, relevantNames, content, 1)
    : new Set();

  const compressed = renderCompressed(content, symbols, keep);
  const compressedLines = compressed.split('\n').length;
  // No net shrink → not worth a behavior change; return the original.
  if (compressedLines >= originalLines) return { content, wasCompressed: false, compressedLines: originalLines };
  return { content: compressed, wasCompressed: true, compressedLines };
}

/**
 * Compress a set of files down to task-relevant symbols.
 * @param {Array<{path:string, content:string}>} files
 * @param {string} taskDescription  task title + notes concatenated (drives symbol relevance)
 * @param {object} config           the config.contextCompression block { enabled, minFileSizeLines, level }
 * @returns {{ files: Array<{path, content, wasCompressed, originalLines, compressedLines}>, totalRatio:number }}
 *          totalRatio = Σ compressedLines / Σ originalLines (1 when nothing compressed).
 */
export function compressContext(files, taskDescription, config = {}) {
  const cfg = config || {};
  const minLines = Number.isFinite(Number(cfg.minFileSizeLines)) ? Number(cfg.minFileSizeLines) : 200;
  let level = Number(cfg.level);
  if (!Number.isFinite(level)) level = 2;
  if (level >= 3) level = 2; // Level 3 (2-hop) is stubbed → fall back to Level 2.
  if (level < 1) level = 1;

  const relevantNames = extractRelevantNames(taskDescription);
  const list = Array.isArray(files) ? files : [];

  const outFiles = [];
  let sumOriginal = 0;
  let sumCompressed = 0;
  for (const f of list) {
    const content = (f && typeof f.content === 'string') ? f.content : '';
    const originalLines = content === '' ? 0 : content.split('\n').length;
    let result;
    try {
      result = compressFile(content, originalLines, minLines, level, relevantNames);
    } catch {
      // SAFE PRINCIPLE: any failure → Level 0 (full content), never throw.
      result = { content, wasCompressed: false, compressedLines: originalLines };
    }
    sumOriginal += originalLines;
    sumCompressed += result.compressedLines;
    outFiles.push({
      path: f ? f.path : undefined,
      content: result.content,
      wasCompressed: result.wasCompressed,
      originalLines,
      compressedLines: result.compressedLines,
    });
  }

  const totalRatio = sumOriginal > 0 ? sumCompressed / sumOriginal : 1;
  return { files: outFiles, totalRatio };
}

// Render the compressed files as a prompt block for the Implementer (empty string when nothing was
// compressed, so the prompt is unchanged — backward compatible).
export function compressedContextBlock(result) {
  if (!result || !Array.isArray(result.files)) return '';
  const compressed = result.files.filter((f) => f.wasCompressed);
  if (!compressed.length) return '';
  const blocks = compressed.map((f) =>
    `### ${f.path} (compressed ${f.originalLines}→${f.compressedLines} lines)\n` +
    '```\n' + f.content + '\n```');
  return [
    '## Task-focused file context (AST-compressed — signatures + relevant bodies only)',
    'Large files below were compressed to the symbols relevant to this task. Unrelated function bodies',
    'are elided as `{ /* … */ }`. Open the full file with your tools if you need an elided body.',
    ...blocks,
    ''
  ].join('\n');
}
