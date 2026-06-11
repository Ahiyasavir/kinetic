// protect.mjs — Strangler-Fig guardrails that stop the kinetic from breaking ITSELF while it
// refactors its own engine. Two enforcement layers, both wired into the deterministic validation
// phase (so a violation fails the cycle and triggers the normal rollback):
//
//   1. checkKineticSyntax() — hard `node --check` on every autopilot/**/*.mjs. A basic compile
//      error in the engine (or in a freshly-written core/ module) fails the cycle immediately.
//   2. verifyProtected()      — supervisor.mjs and watchdog.mjs are FROZEN. If a cycle changed or
//      deleted one, it is restored from the immutable startup snapshot and the cycle fails. The
//      freeze auto-lifts once autopilot/core/.ready exists (the Strangler-Fig migration is done).
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync
} from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KINETIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SNAP_DIR = path.join(KINETIC_DIR, '.protected');
const CORE_READY = path.join(KINETIC_DIR, 'core', '.ready');

// The live entry-points the kinetic may NOT touch until the new engine is ready.
const PROTECTED = ['supervisor.mjs', 'watchdog.mjs'];

// Dirs that never contain engine source to syntax-check (runtime/state/vendored/secrets).
const SKIP_DIRS = new Set(['node_modules', '.protected', '.account', 'state', 'inbox', 'backups', '.git']);

function sha(p) { return createHash('sha256').update(readFileSync(p)).digest('hex'); }

/** True once the Strangler-Fig migration is complete (core/ is live) — the freeze then lifts. */
export function coreReady() { return existsSync(CORE_READY); }

/**
 * The protected entry-points that are CURRENTLY frozen (empty once core/.ready lifts the freeze). Used
 * by the selection-time structural-impossibility guard: a task whose acceptance criteria require editing
 * one of these while the freeze is active is impossible THIS run and should be blocked, not retried.
 */
export function frozenProtectedFiles() { return coreReady() ? [] : [...PROTECTED]; }

/**
 * Capture the known-good protected files ONCE, the first time the supervisor starts after the guard
 * is installed. We keep the FIRST-seen-good copy as an immutable baseline (we never overwrite an
 * existing snapshot) so a later corrupted-then-restarted process can't re-baseline a bad file.
 * To intentionally update a protected file, delete autopilot/.protected/ and restart.
 */
export function snapshotProtected() {
  if (!existsSync(SNAP_DIR)) mkdirSync(SNAP_DIR, { recursive: true });
  for (const f of PROTECTED) {
    const src = path.join(KINETIC_DIR, f);
    const snap = path.join(SNAP_DIR, f);
    if (existsSync(src) && !existsSync(snap)) copyFileSync(src, snap);
  }
}

/**
 * If a protected entry-point was modified or deleted while the freeze is active, restore it from the
 * snapshot. Returns { violated, files } so validation can fail the cycle with a clear reason.
 */
export function verifyProtected() {
  if (coreReady()) return { violated: false, files: [] };
  const restored = [];
  for (const f of PROTECTED) {
    const src = path.join(KINETIC_DIR, f);
    const snap = path.join(SNAP_DIR, f);
    if (!existsSync(snap)) continue;                  // no baseline yet → nothing to enforce
    if (!existsSync(src) || sha(src) !== sha(snap)) {
      copyFileSync(snap, src);                         // RESTORE the frozen good version
      restored.push(f);
    }
  }
  return { violated: restored.length > 0, files: restored };
}

/** Recursively `node --check` every .mjs under autopilot/ (skipping runtime/vendored dirs). */
export function checkKineticSyntax() {
  const failures = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
      } else if (e.name.endsWith('.mjs')) {
        const p = path.join(dir, e.name);
        try {
          execSync(`node --check "${p}"`, { stdio: 'pipe' });
        } catch (err) {
          const msg = (err.stderr?.toString() || err.message || 'syntax error').trim().slice(0, 300);
          failures.push({ file: path.relative(KINETIC_DIR, p).replaceAll('\\', '/'), err: msg });
        }
      }
    }
  };
  walk(KINETIC_DIR);
  return { ok: failures.length === 0, failures };
}
