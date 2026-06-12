// state.mjs — single source of truth (state.json): load, atomic save, init, recovery.
//
// TWO-TIER SCHEMA (v2) — see autopilot/SCHEMA.md for the full reference.
// On disk, state.json is split into two independent tiers so the kinetic framework can be
// decoupled from any one target project (a prerequisite for running multiple projects):
//   { schemaVersion: 2,
//     framework: { ...executor/loop state: version, cycle, status, goalPhase, rateLimit, current,
//                  usage, deadlineAt, startedAt, lastUpdated... },   // engine-owned
//     app:       { queues, stats, history } }                        // target-project (RushPoint) data
// In memory the supervisor keeps using a single FLAT object (behavior-preserving): loadState()
// merges the two tiers back to flat, saveState() splits flat → two tiers when persisting. Old flat
// v1 files are auto-migrated on first save (loadState reads either shape). splitState()/mergeState()
// and the loadFrameworkState()/loadAppState() loaders expose the tiers to engine modules directly.
import { readFile, writeFile, rename, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { profileSeed } from './workspace-profile.mjs';

// Persisted schema version of the two-tier wrapper. Bump only on a breaking on-disk change.
export const SCHEMA_VERSION = 2;

// Keys that belong to the TARGET-APP tier (RushPoint backlog + metrics + project records). Every
// other top-level key is engine/FRAMEWORK state, so unknown/new fields default to the framework tier
// and round-trip losslessly through splitState()/mergeState().
const APP_KEYS = ['queues', 'stats', 'history'];

let _migrationLogged = false;

export const GOAL_PHASES = [
  'structure', // 1. clean up project structure / organization
  'features',  // 2. improve existing features (smarter + more reliable)
  'ui',        // 3. polished, fast, attractive UI
  'social',    // 4. healthy, fair social sharing
  'admin',     // 5. better admin / control-room tooling
  'continuous' // 6. keep proposing the next most valuable improvement
];

// Starter backlog for a workspace. PROJECT-NEUTRAL: the engine no longer owns any product's tasks —
// the seed comes from the active workspace PROFILE (autopilot/profiles/<id>.json → seed). The RushPoint
// curated seed now lives in profiles/rushpoint.json. With no profile (or a profile with no seed) this
// returns [] and the user supplies tasks via the inbox. Backward compatible: the default workspace's
// profile is config.profile ('rushpoint'), so `init` seeds exactly the same backlog as before.
export function seedBacklog(profile) {
  return profileSeed(profile);
}

export function emptyState() {
  return {
    version: 1,
    startedAt: null,
    deadlineAt: null,
    lastUpdated: null,
    cycle: 0,
    status: 'idle', // idle | running | paused-ratelimit | done
    goalPhase: 'structure',
    rateLimit: { pausedUntil: null, consecutiveHits: 0 },
    current: null, // active task during a cycle (re-queued on recovery)
    queues: { backlog: [], done: [], blocked: [] },
    stats: { cyclesRun: 0, completed: 0, blocked: 0, revisions: 0, rateLimitPauses: 0,
      // U-56: per-model usage breakdown (keyed by tierLabel: 'haiku'|'sonnet'|'opus')
      modelUsage: {} },
    // Weekly usage self-metering (drives the weeklyBudget cadence governor). Counters cover the
    // current window only and auto-reset when now ≥ windowResetAt.
    usage: {
      windowResetAt: null, windowStartedAt: null, lastCycleAt: null, velocityFactor: 1.0,
      cycles: 0, calls: 0,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0
    },
    // Per-project token spend (U-33), keyed by projectId (repo+goal slug). Decoupled from the global
    // `usage` window so multiple projects keep independent, isolated budgets. Maintained exclusively
    // through lib/token-counter.mjs; the budget pacer (lib/token-pacer.mjs) reads it.
    tokenSpent: {},
    // Decoupled engine telemetry (U-36). A FRAMEWORK-tier field (not in APP_KEYS) so it persists under
    // state.json → '.framework.telemetry', separate from the target-app tier. Maintained at runtime by
    // the supervisor via lib/telemetry.mjs (getTelemetryState); empty when telemetry is disabled.
    telemetry: { events: [], metrics: {}, errorCount: 0, lastFlush: null },
    history: [] // compact: { cycle, taskId, title, outcome, ts }
  };
}

export function nowIso() {
  return new Date().toISOString();
}

// ---------- two-tier schema: split / merge / migrate ----------
// Split a flat in-memory state into the two persisted tiers. App-tier keys go to `appState`; every
// other key (engine/loop/config/usage) goes to `frameworkState`. Returns { frameworkState, appState }.
export function splitState(flat) {
  const frameworkState = {};
  const appState = {};
  for (const [k, v] of Object.entries(flat || {})) {
    if (APP_KEYS.includes(k)) appState[k] = v;
    else frameworkState[k] = v;
  }
  return { frameworkState, appState };
}

// Merge the two tiers back into the single flat object the supervisor works with. Accepts either the
// { frameworkState, appState } shape (from splitState) or the on-disk { framework, app } shape; an
// already-flat object is passed through unchanged.
export function mergeState(tiered) {
  if (!tiered || typeof tiered !== 'object') return tiered;
  const hasTiers = 'frameworkState' in tiered || 'appState' in tiered || 'framework' in tiered || 'app' in tiered;
  if (!hasTiers) return tiered; // already flat
  const fw = tiered.frameworkState || tiered.framework || {};
  const app = tiered.appState || tiered.app || {};
  return { ...fw, ...app };
}

// True if a parsed object is already in the persisted two-tier (v2) shape.
function isTwoTier(o) {
  return !!o && typeof o === 'object' && Number(o.schemaVersion) >= 2 &&
    (Object.prototype.hasOwnProperty.call(o, 'framework') || Object.prototype.hasOwnProperty.call(o, 'app'));
}

// Wrap a flat working state into the two-tier persisted shape written to disk.
function toPersisted(flat) {
  const { frameworkState, appState } = splitState(flat);
  return { schemaVersion: SCHEMA_VERSION, framework: frameworkState, app: appState };
}

// Normalize whatever we parsed from disk into the flat working shape. Two-tier (v2) files are merged
// back to flat; old flat (v1) files are returned as-is and re-persisted as two-tier on the next save
// (backward-compatibility shim — logged once so the migration is visible in the run output).
function normalizeLoaded(parsed, statePath) {
  if (isTwoTier(parsed)) return mergeState(parsed);
  if (parsed && typeof parsed === 'object' && !_migrationLogged) {
    _migrationLogged = true;
    try {
      console.log(`[kinetic] state schema: migrating flat ${path.basename(statePath)} → two-tier v${SCHEMA_VERSION} (framework/app) on next save.`);
    } catch { /* logging is best-effort */ }
  }
  return parsed;
}

// Independent loader for the FRAMEWORK tier only (engine/loop/config/usage state). Reads the file and
// returns just `frameworkState`. Engine modules can consume this without seeing target-app data.
export async function loadFrameworkState(statePath) {
  return splitState(await loadState(statePath)).frameworkState;
}

// Independent loader for the APP tier only (target-project backlog + metrics + history).
export async function loadAppState(statePath) {
  return splitState(await loadState(statePath)).appState;
}

export async function ensureDirs(dirs) {
  for (const d of dirs) if (!existsSync(d)) await mkdir(d, { recursive: true });
}

// Load state, tolerating a corrupt/truncated file: fall back to the last-good .bak so a single bad
// write (or a kill mid-rename on some FS) can never brick the loop into a crash-restart spiral.
export async function loadState(statePath) {
  const tryParse = async (p) => {
    const raw = await readFile(p, 'utf8');
    if (!raw || !raw.trim()) throw new Error('empty');
    return JSON.parse(raw);
  };
  try {
    return normalizeLoaded(await tryParse(statePath), statePath);
  } catch (e) {
    const bak = statePath + '.bak';
    if (existsSync(bak)) {
      try {
        const recovered = await tryParse(bak);
        // promote the backup back to the primary so the next save chain is sane
        await writeFile(statePath, JSON.stringify(recovered, null, 2), 'utf8').catch(() => {});
        return normalizeLoaded(recovered, statePath);
      } catch { /* fall through */ }
    }
    throw new Error(`state.json is unreadable and no usable backup exists (${e.message})`);
  }
}

// Atomic write: tmp file + rename, so a crash mid-write can't corrupt state.json. Also keep the
// previous good copy as state.json.bak (rolled forward only on a successful parse-able save) so
// loadState can always recover.
export async function saveState(statePath, state) {
  state.lastUpdated = nowIso();
  const tmp = statePath + '.tmp';
  // Persist in the two-tier (v2) schema. `state` stays a flat in-memory object for the supervisor;
  // toPersisted() splits it into { framework, app } only at the disk boundary.
  const data = JSON.stringify(toPersisted(state), null, 2);
  // snapshot the current good file to .bak BEFORE we overwrite it
  if (existsSync(statePath)) {
    try { await copyFile(statePath, statePath + '.bak'); } catch { /* best effort */ }
  }
  await writeFile(tmp, data, 'utf8');
  await rename(tmp, statePath);
}

export async function initState(statePath, config, seed = []) {
  const state = emptyState();
  state.startedAt = nowIso();
  state.deadlineAt = new Date(Date.now() + config.durationDays * 86400000).toISOString();
  state.status = 'running';
  // The seed is supplied by the caller from the active workspace profile (engine stays project-neutral).
  state.queues.backlog = Array.isArray(seed) ? seed : [];
  await saveState(statePath, state);
  return state;
}

export function nextTaskId(state) {
  const all = [...state.queues.backlog, ...state.queues.done, ...state.queues.blocked];
  if (state.current) all.push(state.current);
  let max = 0;
  for (const t of all) {
    const n = parseInt(String(t.id || '').replace(/\D/g, ''), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return 'T-' + String(max + 1).padStart(4, '0');
}

export function isPastDeadline(state) {
  return state.deadlineAt && Date.now() >= new Date(state.deadlineAt).getTime();
}
