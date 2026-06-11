#!/usr/bin/env node
// build.mjs — bundle variant assembler (U-44).
//
// Reads bundle-manifest.json and copies files matching the chosen variant's
// include/exclude patterns into a distributable output directory. The two variants
// declared in the manifest are:
//
//   core       — open-source layer (core/, lib/, shared/, plugins/, templates/)
//   commercial — full deployment (core + commercial/config.json + profiles/)
//
// Usage:
//   node autopilot/build.mjs [--variant core|commercial] [--out <dir>] [--dry-run]
//
// Defaults:
//   --variant   commercial   (mirrors the active deployment layout)
//   --out       autopilot/dist/<variant>
//   --dry-run   false        (set to preview the file list without writing)
//
// The output directory is created automatically. Re-running overwrites existing files.
// Mirrors only the content under autopilot/; the host repo root is never touched.

import { readFileSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AUTOPILOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_PATH = path.join(AUTOPILOT_DIR, 'bundle-manifest.json');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const get  = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const has  = (flag) => args.includes(flag);

const requestedVariant = get('--variant') || 'commercial';
const outArg           = get('--out');
const dryRun           = has('--dry-run') || has('--dryRun');

const outDir = outArg
  ? path.resolve(AUTOPILOT_DIR, outArg)
  : path.join(AUTOPILOT_DIR, 'dist', requestedVariant);

// ── Load manifest ─────────────────────────────────────────────────────────────
let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
} catch (e) {
  console.error(`[build] Cannot read bundle-manifest.json: ${e.message}`);
  process.exit(1);
}

const variantDef = manifest.variants && manifest.variants[requestedVariant];
if (!variantDef) {
  const available = Object.keys(manifest.variants || {}).join(', ') || '(none)';
  console.error(`[build] Unknown variant "${requestedVariant}". Available: ${available}`);
  process.exit(1);
}

console.log(`[build] variant=${requestedVariant}${dryRun ? '  (dry-run)' : ''}`);
console.log(`[build] ${variantDef.description}`);
if (!dryRun) console.log(`[build] output → ${outDir}`);

// ── Glob-pattern → RegExp ─────────────────────────────────────────────────────
// Supports: ** (any path), * (any single segment), exact paths, and trailing /** suffixes.
function globToRegex(pattern) {
  const p = pattern.replace(/\\/g, '/');
  let escaped = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*' && p[i + 1] === '*') {
      escaped += '.*'; i++;          // ** → match any depth
      if (p[i + 1] === '/') i++;     // consume trailing slash after **
    } else if (ch === '*') {
      escaped += '[^/]+';            // * → match one segment
    } else if ('.+^${}()|[]'.includes(ch)) {
      escaped += '\\' + ch;          // escape regex specials
    } else {
      escaped += ch;
    }
  }
  // A pattern that ends without ** still matches the subtree (e.g. "core/**" was already handled;
  // "commercial" alone should match commercial/config.json too).
  return new RegExp(`^${escaped}(/.*)?$`);
}

const includeRe = (variantDef.include || []).map(globToRegex);
const excludeRe = (variantDef.exclude || []).map(globToRegex);

function matchesAny(relPath, patterns) {
  const norm = relPath.replace(/\\/g, '/');
  return patterns.some((re) => re.test(norm));
}

function isIncluded(relPath) {
  return matchesAny(relPath, includeRe) && !matchesAny(relPath, excludeRe);
}

// ── Recursive directory walk ──────────────────────────────────────────────────
// Directories that are never part of any distribution variant.
const ALWAYS_SKIP = new Set(['dist', 'state', '.account', 'node_modules', '.git']);

function walk(dir) {
  const results = [];
  let entries;
  try { entries = readdirSync(dir); } catch { return results; }
  for (const entry of entries) {
    if (ALWAYS_SKIP.has(entry)) continue;
    const full = path.join(dir, entry);
    const rel  = path.relative(AUTOPILOT_DIR, full);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      results.push(...walk(full));
    } else if (isIncluded(rel)) {
      results.push({ full, rel });
    }
  }
  return results;
}

const files = walk(AUTOPILOT_DIR);

if (files.length === 0) {
  console.warn('[build] No files matched the variant patterns — check bundle-manifest.json');
  process.exit(0);
}

// ── Copy / report ─────────────────────────────────────────────────────────────
let copied = 0;
for (const { full, rel } of files) {
  if (dryRun) {
    console.log(`  [dry-run] ${rel}`);
  } else {
    const dest = path.join(outDir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(full, dest);
  }
  copied++;
}

if (dryRun) {
  console.log(`[build] ${copied} file(s) would be copied (dry-run — no files written).`);
} else {
  console.log(`[build] Copied ${copied} file(s) → ${outDir}`);
  console.log('[build] Done.');
}
