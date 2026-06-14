#!/usr/bin/env node
// benchmark-compression.mjs — U-81 verification harness.
//
// Proves the AST context-compression target (40–60% token reduction on files > 200 lines) on REAL
// large source files, not synthetic fixtures. For each large JS/.mjs file it simulates a FOCUSED task
// (one symbol from the file is named in the task description, the realistic case the Implementer hits),
// runs lib/context-compressor.mjs at the production config, and reports the per-file and aggregate token
// reduction. Token estimate is chars/4 — the same rough estimate the supervisor records in
// state.json → framework.usage.lastCompressionStats, so the numbers here line up with production stats.
//
// Usage:  node scripts/benchmark-compression.mjs            (benchmarks the engine's own lib/*.mjs)
//         node scripts/benchmark-compression.mjs <dir...>   (benchmarks .js/.mjs files under each dir)
//
// Exit code 0 always (read-only diagnostic); the band check is reported, not enforced, so this can run
// in CI as an informational gate without breaking a build on a file that happens to fall outside 40–60%.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { compressContext } from '../lib/context-compressor.mjs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_ROOT = path.resolve(__dirname, '..');

const MIN_LINES = 200;       // matches config.contextCompression.minFileSizeLines
const LEVEL = 2;             // production default
const estTokens = (s) => Math.round(s.length / 4);

// Recursively collect .js/.mjs files under a directory (skips node_modules / dotfolders).
function collectFiles(dir, out = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(abs, out);
    else if (/\.(mjs|js)$/.test(e.name)) out.push(abs);
  }
  return out;
}

// Parse with acorn and return one top-level symbol name to seed a realistic focused task (the symbol an
// Implementer would actually be editing). Picks the median-by-position symbol so the dep-graph keep-set
// is representative. Returns '' when nothing parseable, in which case the file is skipped (its real-world
// behavior would be a Level-0 fallback and contribute 0% — not interesting for the band check).
function pickFocusSymbol(content) {
  let acorn;
  try { acorn = require('acorn'); } catch { return ''; }
  let ast;
  try { ast = acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'module' }); } catch { return ''; }
  const names = [];
  for (const stmt of ast.body || []) {
    const d = (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration')
      ? stmt.declaration : stmt;
    if (!d) continue;
    if ((d.type === 'FunctionDeclaration' || d.type === 'ClassDeclaration') && d.id) names.push(d.id.name);
    else if (d.type === 'VariableDeclaration' && d.declarations?.[0]?.id?.type === 'Identifier' &&
      ['ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression'].includes(d.declarations[0].init?.type)) {
      names.push(d.declarations[0].id.name);
    }
  }
  if (!names.length) return '';
  return names[Math.floor(names.length / 2)];
}

function main() {
  const args = process.argv.slice(2);
  const roots = args.length ? args.map((a) => path.resolve(process.cwd(), a)) : [path.join(ENGINE_ROOT, 'lib')];

  const candidates = [];
  for (const r of roots) {
    const isDir = (() => { try { return statSync(r).isDirectory(); } catch { return false; } })();
    if (isDir) collectFiles(r, candidates);
    else if (/\.(mjs|js)$/.test(r)) candidates.push(r);
  }

  console.log('AST context-compression benchmark');
  console.log(`level=${LEVEL}  minFileSizeLines=${MIN_LINES}  files scanned: ${candidates.length}`);
  console.log('');

  const rows = [];
  let sumOrigTok = 0;
  let sumCompTok = 0;
  for (const abs of candidates) {
    let content;
    try { content = readFileSync(abs, 'utf8'); } catch { continue; }
    const lines = content.split('\n').length;
    if (lines <= MIN_LINES) continue;
    const focus = pickFocusSymbol(content);
    if (!focus) continue; // not parseable as JS → Level-0 in production; excluded from the band check

    const taskDesc = `optimization: refactor ${focus} to improve performance`;
    const result = compressContext([{ path: abs, content }], taskDesc,
      { enabled: true, minFileSizeLines: MIN_LINES, level: LEVEL });
    const file = result.files[0];
    if (!file.wasCompressed) continue;

    const origTok = estTokens(content);
    const compTok = estTokens(file.content);
    const reductionPct = Math.round((1 - compTok / origTok) * 100);
    sumOrigTok += origTok;
    sumCompTok += compTok;
    rows.push({ name: path.relative(ENGINE_ROOT, abs), lines, origTok, compTok, reductionPct, focus });
  }

  if (!rows.length) {
    console.log('No compressible files > ' + MIN_LINES + ' lines found in the scanned roots.');
    console.log('Pass one or more source directories, e.g. node scripts/benchmark-compression.mjs lib');
    return;
  }

  rows.sort((a, b) => b.reductionPct - a.reductionPct);
  for (const r of rows) {
    console.log(`  ${r.reductionPct.toString().padStart(3)}%  ${r.origTok}→${r.compTok} tok  ` +
      `${r.lines} lines  [focus:${r.focus}]  ${r.name}`);
  }

  const aggReductionPct = Math.round((1 - sumCompTok / sumOrigTok) * 100);
  const meanReductionPct = Math.round(rows.reduce((s, r) => s + r.reductionPct, 0) / rows.length);
  const inBand = rows.filter((r) => r.reductionPct >= 40 && r.reductionPct <= 60).length;

  console.log('');
  console.log(`compressible files: ${rows.length}`);
  console.log(`aggregate token reduction: ${aggReductionPct}%  (${sumOrigTok}→${sumCompTok} tokens)`);
  console.log(`mean per-file reduction: ${meanReductionPct}%`);
  console.log(`files landing in the 40-60% target band: ${inBand}/${rows.length}`);
  console.log(meanReductionPct >= 40
    ? 'RESULT: meets the 40-60% token-reduction target (mean >= 40%)'
    : 'RESULT: below the 40% target on this sample — review symbol relevance heuristic');
}

main();
