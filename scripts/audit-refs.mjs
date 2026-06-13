#!/usr/bin/env node
// scripts/audit-refs.mjs — audit the engine for hardcoded host-project (RushPoint) references.
//
// The decoupling goal is that core/ knows nothing about any specific project. This script greps the
// engine source tree for project-specific markers and reports each hit with file:line, the code
// snippet, and a coarse effort estimate for removing it. Run it before/after a decoupling step to see
// what still leaks the host project into engine code.
//
//   node autopilot/scripts/audit-refs.mjs            # human-readable report
//   node autopilot/scripts/audit-refs.mjs --json     # machine-readable JSON
//   node autopilot/scripts/audit-refs.mjs --core-only # restrict to core/ (must be ZERO)
//
// Exit code: 0 always for the full scan (advisory); with --core-only it exits 1 if core/ has any hit,
// so it can gate CI on the "core is clean" invariant.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AUTOPILOT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Project-specific markers. label = what it indicates; weight feeds the effort estimate.
const MARKERS = [
  { name: 'rushpoint', re: /rushpoint/i, weight: 3 },
  { name: 'topographic', re: /topographic/i, weight: 2 },
  { name: 'apps-dir', re: /(?<![\w./-])apps\//, weight: 2 },
  { name: 'functions-dir', re: /(?<![\w./-])functions\//, weight: 2 },
  { name: 'firestore', re: /firestore/i, weight: 2 },
  { name: 'gameState', re: /gameState/, weight: 3 },
  { name: 'taskScore', re: /taskScore/, weight: 2 },
  { name: 'tene-basket', re: /\btene\b/i, weight: 1 },
  { name: 'jerusalem', re: /jerusalem|tzion|motza/i, weight: 1 },
];

// Directories to scan (engine source). contexts/ and commercial/ legitimately hold project facts.
const SCAN_DIRS = ['core', 'lib', 'shared', 'prompts'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'state', '.git', 'tests', 'templates']);
const SCAN_EXT = new Set(['.mjs', '.js', '.json', '.md']);

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (SCAN_EXT.has(path.extname(entry))) out.push(full);
  }
  return out;
}

function effortFor(weightSum, hitCount) {
  const score = weightSum + hitCount;
  if (score <= 2) return 'low';
  if (score <= 6) return 'medium';
  return 'high';
}

function audit() {
  const files = [];
  for (const d of SCAN_DIRS) walk(path.join(AUTOPILOT_ROOT, d), files);

  const findings = [];
  for (const file of files) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const rel = path.relative(AUTOPILOT_ROOT, file).replace(/\\/g, '/');
    const lines = content.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const marker of MARKERS) {
        if (marker.re.test(line)) {
          findings.push({
            file: rel,
            line: i + 1,
            marker: marker.name,
            weight: marker.weight,
            snippet: line.trim().slice(0, 160),
            inCore: rel.startsWith('core/'),
          });
        }
      }
    });
  }
  return findings;
}

function summarize(findings) {
  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, { weight: 0, hits: 0 });
    const agg = byFile.get(f.file);
    agg.weight += f.weight;
    agg.hits += 1;
  }
  const perFile = [];
  for (const [file, agg] of byFile) {
    perFile.push({ file, hits: agg.hits, effort: effortFor(agg.weight, agg.hits) });
  }
  perFile.sort((a, b) => b.hits - a.hits);
  return perFile;
}

const args = new Set(process.argv.slice(2));
let findings = audit();
if (args.has('--core-only')) findings = findings.filter((f) => f.inCore);

if (args.has('--json')) {
  process.stdout.write(JSON.stringify({ scannedDirs: SCAN_DIRS, total: findings.length, findings }, null, 2) + '\n');
} else {
  const perFile = summarize(findings);
  console.log(`Engine reference audit — scanned ${SCAN_DIRS.join(', ')} under autopilot/`);
  console.log(`Total project-specific references: ${findings.length} across ${perFile.length} file(s)\n`);
  for (const row of perFile) {
    console.log(`  ${row.file}  —  ${row.hits} hit(s), effort: ${row.effort}`);
  }
  console.log('');
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  [${f.marker}]  ${f.snippet}`);
  }
  const coreHits = findings.filter((f) => f.inCore).length;
  console.log(`\ncore/ hits: ${coreHits} (target: 0)`);
}

if (args.has('--core-only') && findings.length > 0) process.exit(1);
