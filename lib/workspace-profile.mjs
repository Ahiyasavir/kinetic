// workspace-profile.mjs — workspace PROFILES: the project-specific content layer that keeps the
// generic engine project-neutral. A profile is declarative JSON under autopilot/profiles/<id>.json and
// supplies everything that used to be hardcoded in the engine for one specific product:
//   • seed            — the starter backlog (init / reprioritize)
//   • selectionFilters— rebuild / UI-freeze / hardening regexes (string sources, compiled here)
//   • promptProfile   — product-specific implementer rules injected into the prompt ({{PROFILE_RULES}})
//   • goalPhases      — the workspace's phase taxonomy
//   • metadata        — descriptive info (domain, repo, …) for logs + the UI
//
// Selection is by id. An unknown/missing/corrupt profile falls back to the GENERIC profile (neutral:
// empty seed, no project filters, no prompt rules) — so the engine is safe and project-agnostic by
// default, and RushPoint is just `profiles/rushpoint.json` (one profile among many).
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { queuePaths } from '../config-loader.mjs';

const PROFILES_DIR = path.join(queuePaths.autopilotDir, 'profiles');

// Neutral, project-agnostic shape. Used as the merge floor so any profile file (even a partial one) is
// safe to load — missing keys fall back to these neutral values, never to another project's content.
export const PROFILE_DEFAULTS = Object.freeze({
  id: 'generic',
  label: 'Generic workspace',
  goalPhases: ['structure', 'features', 'quality', 'continuous'],
  metadata: {},
  selectionFilters: { shippedFeature: '', polishIntent: '', uiPolish: '', hardeningKeep: '', applyHardeningFreeze: false },
  promptProfile: '',
  seed: [],
});

function readProfileFile(id, dir) {
  const file = path.join(dir, `${id}.json`);
  if (!existsSync(file)) return null;
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'));
    return (d && typeof d === 'object') ? d : null;
  } catch {
    return null; // corrupt → treat as absent (caller falls back to generic)
  }
}

/**
 * Load a profile by id, merged over the neutral defaults. Unknown/missing/corrupt → the generic
 * profile (or the in-code neutral defaults if even generic.json is absent). Never throws.
 * @param {string} id
 * @param {{profilesDir?:string}} [opts]
 */
export function loadProfile(id, opts = {}) {
  const dir = opts.profilesDir || PROFILES_DIR;
  const wanted = readProfileFile(id, dir);
  const generic = readProfileFile('generic', dir);
  const raw = wanted || generic || {};
  const merged = {
    ...PROFILE_DEFAULTS,
    ...raw,
    // Deep-merge the nested filter block so a partial profile keeps neutral defaults for the rest.
    selectionFilters: { ...PROFILE_DEFAULTS.selectionFilters, ...(raw.selectionFilters || {}) },
    metadata: { ...PROFILE_DEFAULTS.metadata, ...(raw.metadata || {}) },
  };
  merged.resolvedId = wanted ? id : (generic ? 'generic' : 'generic-defaults');
  return merged;
}

// Compile a profile's string regex sources into a deterministic filter helper bundle. Empty sources →
// null regex → PERMISSIVE (no drop), so the generic profile never pre-drops a task; the engine's real
// quality gates still apply. This is the engine-neutral home of the logic that used to live as
// hardcoded RushPoint regexes in supervisor.mjs.
export function compileFilters(profile) {
  const sf = (profile && profile.selectionFilters) || PROFILE_DEFAULTS.selectionFilters;
  const re = (src) => (src ? new RegExp(src, 'i') : null);
  const shipped = re(sf.shippedFeature);
  const polish = re(sf.polishIntent);
  const uiPolish = re(sf.uiPolish);
  const hardeningKeep = re(sf.hardeningKeep);

  // A title is a "rebuild" if it names an already-shipped feature WITHOUT a polish/improve intent.
  // No shipped-feature pattern configured → never a rebuild (permissive).
  function looksLikeRebuild(title) {
    const t = String(title || '');
    if (!shipped) return false;
    const polishMatch = polish ? polish.test(t) : false;
    return shipped.test(t) && !polishMatch;
  }

  // In a hardening phase, drop cosmetic/new-feature work (kept ONLY if it's explicitly hardening).
  function looksLikeUiOrFeature(task) {
    const t = `${task.title || ''} ${task.notes || ''}`;
    if (hardeningKeep && hardeningKeep.test(t)) return false; // explicitly hardening → keep
    if (task.goal === 'ui') return true;                      // UI category → drop in hardening
    return uiPolish ? uiPolish.test(t) : false;               // cosmetic keywords → drop
  }

  return { looksLikeRebuild, looksLikeUiOrFeature, applyHardeningFreeze: !!sf.applyHardeningFreeze };
}

/** The profile's seed backlog (a defensive copy so callers can't mutate the loaded profile). */
export function profileSeed(profile) {
  return Array.isArray(profile && profile.seed) ? profile.seed.map((t) => ({ ...t, dims: { ...t.dims }, deps: [...(t.deps || [])] })) : [];
}
