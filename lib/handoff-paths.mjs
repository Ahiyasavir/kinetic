// handoff-paths.mjs — context-aware resolution of the per-role HANDOFF file names (U-34).
//
// The four per-cycle handoff files the Claude agents write/read — selection.json, implementation.json,
// review.json, audit.json — used to have GENERIC basenames. When a single kinetic host monitors more
// than one project context that shares a handoff directory, those identical names collide (one context's
// implementer overwrites another's selection read → race conditions / lost data). This module tags every
// handoff basename with a deterministic project-context segment, e.g.
//   selection.json → selection-rushpoint-kinetic-topo.json
// so two contexts never write to the same file.
//
// Naming convention (see autopilot/HANDOFF_STRUCTURE.md):
//   <role>.json  →  <role>-<contextId>.json     (the contextId is inserted before the extension)
//
// The contextId is derived DETERMINISTICALLY from config.json so the same project always resolves to the
// same files: an explicit `config.handoff.context` wins, otherwise we reuse the repo+goal slug already
// used for the process locks (lib/lock-manager.mjs → resolveRepoGoal, e.g. "rushpoint-kinetic-topo").
//
// Mirrors the U-25/U-31/U-32/U-33 config-driven seam pattern. Backward compatible: when the resolved
// contextId is empty (no config + no derivable repo/goal) the basenames pass through UNCHANGED, so a
// minimal config keeps the EXACT legacy 'selection.json' layout (no breaking change). The mapping is also
// idempotent — re-resolving an already-tagged name does not double-append the context segment.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, queuePaths } from '../config-loader.mjs';
import { resolveRepoGoal } from './lock-manager.mjs';

// Slugify into a filesystem-safe, collision-resistant context segment (same rule as lock-manager).
function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * The deterministic project-context identifier (U-34). An explicit `config.handoff.context` (or the
 * legacy alias `config.projectIdentifier`) overrides; otherwise it falls back to the repo+goal slug that
 * already keys the process locks and token budgets — so handoff files, locks and budgets all share one
 * stable per-project identity. Returns '' only when nothing is derivable (→ legacy generic basenames).
 */
export function resolveContextId(cfg = config) {
  const explicit = (cfg.handoff && cfg.handoff.context) || cfg.projectIdentifier;
  if (explicit) return slug(explicit);
  return resolveRepoGoal(cfg);
}

// Pre-resolved against the live config — the form supervisor.mjs / core wiring consume directly.
export const contextId = resolveContextId();

/**
 * Map a GENERIC handoff basename to its context-aware form by inserting `-<context>` before the
 * extension: `selection.json` → `selection-<context>.json`. Idempotent (never double-tags) and a no-op
 * when `context` is empty (legacy fallback).
 */
export function contextualName(filename, context = contextId) {
  if (!context) return filename;
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  if (base.endsWith(`-${context}`)) return filename; // already tagged — don't double-append
  return `${base}-${context}${ext}`;
}

/**
 * Resolve a handoff file to its ABSOLUTE, context-aware path. Signature `(context, filename)` per the
 * U-34 contract; `dir` defaults to the configured handoff directory (config.json → paths.queues.handoffDir).
 */
export function resolveHandoffPath(context, filename, dir = queuePaths.handoffDir) {
  return path.join(dir, contextualName(filename, context));
}

/** One-line startup confirmation that the handoff names are context-tagged (not generic/colliding). */
export function handoffResolvedLine() {
  const src = (config.handoff && config.handoff.context) || config.projectIdentifier
    ? 'config.handoff.context'
    : 'derived repo+goal slug';
  return contextId
    ? `config-loaded handoff context from ${src} → contextId=${contextId} ` +
      `(e.g. ${contextualName('selection.json')})`
    : 'handoff context not derivable → legacy generic basenames (selection.json …)';
}

// CLI: print the confirmation + the resolved per-role basenames so the wiring is verifiable today.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(handoffResolvedLine());
  console.log(JSON.stringify({
    contextId,
    files: ['selection.json', 'implementation.json', 'review.json', 'audit.json']
      .map((f) => ({ generic: f, resolved: contextualName(f), path: resolveHandoffPath(contextId, f) }))
  }, null, 2));
}
