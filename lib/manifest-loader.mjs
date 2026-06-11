#!/usr/bin/env node
// manifest-loader.mjs — project-manifest seam (U-28): make the project's strategic GOALS and lifecycle
// PHASES configuration-driven instead of hardcoded in the engine. Reads autopilot/config/project-manifest.json,
// validates its schema, and exports { projectName, description, goals, phases, appId } plus small helpers
// the candidate-ranking layer uses to prioritize tasks by manifest-defined goal priority.
//
// Why this lives OUTSIDE supervisor.mjs (same reasoning as config-loader.mjs, U-25/U-26): supervisor.mjs
// and watchdog.mjs are FROZEN by the Strangler-Fig guard (lib/protect.mjs → verifyProtected) until
// autopilot/core/.ready exists — any edit to them is auto-reverted and fails the cycle. So the manifest
// seam is a NON-protected module the engine imports: today via lib/score.mjs candidate ranking, and
// (once the freeze lifts) directly from the supervisor to initialize the selector/implementer roles.
//
// Loading is IDEMPOTENT (module-singleton — parsed once on first import) and FAILS GRACEFULLY: a missing
// or malformed manifest logs a single warning and falls back to the built-in RushPoint defaults, so the
// loop never crashes on a bad file. The defaults mirror config.json → scoring.categoryBonus + the engine's
// GOAL_PHASES, so the engine keeps its exact current behavior with zero regression when the file is absent.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KINETIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(KINETIC_DIR, 'config', 'project-manifest.json');

// Built-in RushPoint defaults — goal priorities mirror config.json → scoring.categoryBonus and the phase
// names mirror the engine's GOAL_PHASES lifecycle. Used when the manifest is absent or malformed.
const DEFAULT_GOALS = [
  { id: 'goal-stations', title: 'Smart station operator tooling', category: 'stations', priority: 12 },
  { id: 'goal-builder', title: 'Event builder / config tooling', category: 'builder', priority: 9 },
  { id: 'goal-admin', title: 'Admin / control-room tooling', category: 'admin', priority: 9 },
  { id: 'goal-access', title: 'Access-code management', category: 'access', priority: 9 },
  { id: 'goal-review', title: 'Judge / station review flows', category: 'review', priority: 9 },
  { id: 'goal-gameplay', title: 'Player gameplay flow', category: 'gameplay', priority: 6 },
  { id: 'goal-ui', title: 'Polished, fast, attractive UI', category: 'ui', priority: 6 },
  { id: 'goal-social', title: 'Healthy, fair social sharing', category: 'social', priority: 3 },
  { id: 'goal-reliability', title: 'Event-day reliability / hardening', category: 'reliability', priority: 1 },
  { id: 'goal-structure', title: 'Project structure / organization', category: 'structure', priority: 0 }
];
const DEFAULT_PHASES = [
  { name: 'structure', status: 'done' },
  { name: 'features', status: 'done' },
  { name: 'ui', status: 'done' },
  { name: 'social', status: 'done' },
  { name: 'admin', status: 'active' },
  { name: 'continuous', status: 'pending' }
];
const DEFAULT_APP_ID = 'rushpoint-pwa-7daaa';
const DEFAULT_MANIFEST = {
  projectName: 'RushPoint',
  description: '(built-in defaults — project-manifest.json missing or invalid)',
  goals: DEFAULT_GOALS, phases: DEFAULT_PHASES, appId: DEFAULT_APP_ID
};

let _warned = false;
function warnOnce(msg) {
  if (_warned) return; // idempotent: warn at most once even if re-imported in the same process
  _warned = true;
  console.warn(`[manifest-loader] ${msg} — falling back to built-in RushPoint defaults.`);
}

const validGoal = (g) =>
  g && typeof g === 'object' && typeof g.category === 'string' && g.category.trim() && Number.isFinite(Number(g.priority));
const validPhase = (p) => p && typeof p === 'object' && typeof p.name === 'string' && p.name.trim();

// Parse + validate the manifest. Any failure (missing file, bad JSON, no valid goals) → safe defaults.
function loadManifest() {
  let raw;
  try {
    raw = readFileSync(MANIFEST_PATH, 'utf8');
  } catch {
    warnOnce(`manifest not found at ${path.relative(KINETIC_DIR, MANIFEST_PATH).replaceAll('\\', '/')}`);
    return { ...DEFAULT_MANIFEST };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    warnOnce(`manifest is not valid JSON (${e.message})`);
    return { ...DEFAULT_MANIFEST };
  }
  const goalsIn = Array.isArray(parsed.goals) ? parsed.goals.filter(validGoal) : [];
  if (!goalsIn.length) {
    warnOnce('manifest defines no valid goals (need {category, priority})');
    return { ...DEFAULT_MANIFEST };
  }
  const phasesIn = Array.isArray(parsed.phases) ? parsed.phases.filter(validPhase) : [];
  return {
    projectName: typeof parsed.projectName === 'string' && parsed.projectName.trim() ? parsed.projectName : DEFAULT_MANIFEST.projectName,
    description: typeof parsed.description === 'string' ? parsed.description : '',
    goals: goalsIn.map((g) => ({
      id: String(g.id || `goal-${g.category}`), title: String(g.title || g.category),
      category: String(g.category), priority: Number(g.priority)
    })),
    phases: phasesIn.length ? phasesIn.map((p) => ({ name: String(p.name), status: String(p.status || 'pending') })) : DEFAULT_PHASES,
    appId: typeof parsed.appId === 'string' && parsed.appId.trim() ? parsed.appId : DEFAULT_APP_ID
  };
}

const manifest = loadManifest(); // parsed exactly once → idempotent module singleton

export const projectName = manifest.projectName;
export const description = manifest.description;
export const goals = manifest.goals;
export const phases = manifest.phases;
export const appId = manifest.appId;

const _priorityByCategory = new Map(goals.map((g) => [g.category, g.priority]));

/** The ordered list of goal category names the manifest defines. */
export function goalCategories() { return goals.map((g) => g.category); }

/** True if `category` is a goal the manifest knows about (for optional candidate filtering). */
export function isKnownGoal(category) { return _priorityByCategory.has(category); }

/** Manifest-defined ranking priority for a goal category, or undefined if the manifest doesn't define it
 *  (callers then fall back to their existing config-driven bonus). 0 is a valid priority (e.g. structure). */
export function goalPriority(category) {
  return _priorityByCategory.has(category) ? _priorityByCategory.get(category) : undefined;
}

/** One-line startup confirmation that goals/phases came from the manifest (not hardcoded in the engine). */
export function manifestResolvedLine() {
  return `manifest-loaded "${projectName}" from project-manifest.json → ${goals.length} goal(s) ` +
    `[${goalCategories().join(', ')}], ${phases.length} phase(s), appId=${appId}`;
}

// CLI: print the confirmation + the resolved manifest so the wiring is verifiable today.
//   node autopilot/lib/manifest-loader.mjs
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(manifestResolvedLine());
  console.log(JSON.stringify({ projectName, description, appId, goals, phases }, null, 2));
}
