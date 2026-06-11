// evidence.mjs — on-disk completion evidence. The deterministic answer to "is this task ACTUALLY done?"
// that a green typecheck/build can't give. A task may declare:
//
//   task.verifyArtifacts = [
//     { path: 'autopilot/lib/foo.mjs', wired: true },           // file must exist AND be imported somewhere
//     { path: 'autopilot/config.json', contains: '"foo"' },     // file must exist AND contain a marker
//     { path: 'autopilot/core/foo/index.mjs' },                 // file must merely exist
//   ]
//
// checkEvidence() verifies each: existence, optional `wired` (some OTHER module imports it — catches the
// "dead file nobody consumes" failure mode), and optional `contains` (a config/marker string). Tasks
// with no declared artifacts return ok:true but evidence:'none' so the caller can decide how much weight
// to give a green build alone. Tolerant of the legacy string field `task.verifiedArtifact` (best-effort:
// scans it for file-looking tokens) so already-reconciled tasks are still checkable.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KINETIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(KINETIC_DIR, '..');
const SCAN_SKIP = new Set(['node_modules', '.git', '.protected', 'state', 'inbox', 'backups', '.account']);

function resolveArtifact(p, repoRoot) {
  // Accept paths relative to repo root OR to autopilot/.
  const candidates = [path.resolve(repoRoot, p), path.resolve(KINETIC_DIR, p)];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0]; // report the repo-root form as the missing path
}

// True if some .mjs/.js file OTHER than `targetAbs` imports the module (by basename, extension-agnostic).
function isImportedSomewhere(targetAbs, scanRoot) {
  const base = path.basename(targetAbs).replace(/\.(mjs|js|cjs)$/i, '');
  const needle = new RegExp(`(import|require)[^\\n]*['"\`][^'"\`]*\\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.(mjs|js|cjs))?['"\`]`);
  let found = false;
  const walk = (dir) => {
    if (found) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (found) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SCAN_SKIP.has(e.name)) walk(full); }
      else if (/\.(mjs|js|cjs)$/i.test(e.name) && full !== targetAbs) {
        let txt; try { txt = readFileSync(full, 'utf8'); } catch { continue; }
        if (needle.test(txt)) { found = true; return; }
      }
    }
  };
  walk(scanRoot);
  return found;
}

function tokensFromLegacy(str) {
  // Pull file-looking tokens out of a free-text verifiedArtifact string.
  const out = [];
  const re = /([\w./-]+\.(?:mjs|js|cjs|json|ts|tsx|md))/g;
  let m;
  while ((m = re.exec(String(str || '')))) {
    const p = m[1].replace(/^\/+/, ''); // strip a leading slash left by brace-expansion residue ("/index.mjs")
    if (p.includes('/') || p.length > 4) out.push({ path: p });
  }
  return out;
}

export function deriveArtifacts(task) {
  if (Array.isArray(task && task.verifyArtifacts) && task.verifyArtifacts.length) return task.verifyArtifacts;
  if (typeof (task && task.verifiedArtifact) === 'string') return tokensFromLegacy(task.verifiedArtifact);
  return [];
}

// True only when a task carries EXPLICIT structured artifacts. Free-text `verifiedArtifact` strings are
// best-effort (brace-expansion, prose) and must NOT drive destructive reconcile decisions (demote/unblock).
export function hasStructuredArtifacts(task) {
  return Array.isArray(task && task.verifyArtifacts) && task.verifyArtifacts.length > 0;
}

// Returns { ok, evidence, checked[], missing[], unwired[], summary }.
//   evidence: 'none' (nothing declared) | 'present' (all checks passed) | 'incomplete' (something failed)
export function checkEvidence(task, repoRoot = REPO_ROOT, scanRoot = KINETIC_DIR) {
  const arts = deriveArtifacts(task);
  if (!arts.length) {
    return { ok: true, evidence: 'none', checked: [], missing: [], unwired: [], summary: 'no on-disk artifacts declared' };
  }
  const checked = [], missing = [], unwired = [], badContains = [];
  for (const a of arts) {
    const rel = typeof a === 'string' ? a : a.path;
    if (!rel) continue;
    const abs = resolveArtifact(rel, repoRoot);
    const exists = existsSync(abs) && statSync(abs).isFile();
    const rec = { path: rel, exists, wired: null, contains: null };
    if (!exists) { missing.push(rel); checked.push(rec); continue; }
    if (a && a.wired) {
      const wired = isImportedSomewhere(abs, scanRoot);
      rec.wired = wired;
      if (!wired) unwired.push(rel);
    }
    if (a && a.contains) {
      let txt = ''; try { txt = readFileSync(abs, 'utf8'); } catch { /* */ }
      const has = txt.includes(a.contains);
      rec.contains = has;
      if (!has) badContains.push(`${rel} ∌ ${a.contains}`);
    }
    checked.push(rec);
  }
  const ok = missing.length === 0 && unwired.length === 0 && badContains.length === 0;
  const parts = [`${checked.length} artifact(s)`];
  if (missing.length) parts.push(`MISSING: ${missing.join(', ')}`);
  if (unwired.length) parts.push(`UNWIRED (dead file, imported by nothing): ${unwired.join(', ')}`);
  if (badContains.length) parts.push(`MARKER ABSENT: ${badContains.join(', ')}`);
  if (ok) parts.push('all present + wired ✓');
  return { ok, evidence: ok ? 'present' : 'incomplete', checked, missing, unwired, badContains, summary: parts.join(' · ') };
}
