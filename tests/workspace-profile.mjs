// workspace-profile.mjs — assertions for the workspace PROFILE layer (lib/workspace-profile.mjs):
//   • loadProfile: rushpoint carries the extracted content; generic is neutral; unknown → generic
//   • compileFilters: rebuild / UI-freeze logic driven by the profile's regexes (permissive when empty)
//   • profileSeed: returns a defensive copy
// This proves RushPoint content lives in the PROFILE, not the engine, and that the generic default is
// project-neutral + safe (permissive filters, empty seed).
//   node autopilot/tests/workspace-profile.mjs
import assert from 'node:assert/strict';
import { loadProfile, compileFilters, profileSeed, PROFILE_DEFAULTS } from '../lib/workspace-profile.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// ── profile loading ──
check('rushpoint profile carries the extracted seed + filters + prompt rules', () => {
  const p = loadProfile('rushpoint');
  assert.equal(p.resolvedId, 'rushpoint');
  assert.equal(p.seed.length, 7, 'the 7 curated RushPoint seed tasks');
  assert.ok(p.seed.every((t) => t.id && t.title && t.dims), 'seed tasks are well-shaped');
  assert.ok(p.goalPhases.includes('social'), 'RushPoint goal phases');
  assert.equal(p.selectionFilters.applyHardeningFreeze, true);
  assert.ok(/FIRESTORE_PATHS/.test(p.promptProfile), 'RushPoint prompt conventions present');
});

check('generic profile is project-neutral (empty seed, no filters, no prompt rules)', () => {
  const g = loadProfile('generic');
  assert.equal(g.seed.length, 0);
  assert.equal(g.promptProfile, '');
  assert.equal(g.selectionFilters.applyHardeningFreeze, false);
  assert.equal(g.selectionFilters.shippedFeature, '');
});

check('unknown profile falls back to generic (never another project, never throws)', () => {
  const p = loadProfile('this-profile-does-not-exist');
  assert.equal(p.resolvedId, 'generic');
  assert.equal(p.seed.length, 0);
});

check('PROFILE_DEFAULTS is the neutral floor', () => {
  assert.equal(PROFILE_DEFAULTS.seed.length, 0);
  assert.equal(PROFILE_DEFAULTS.promptProfile, '');
  assert.equal(PROFILE_DEFAULTS.selectionFilters.applyHardeningFreeze, false);
});

// ── filter compilation (the logic that used to be hardcoded RushPoint regexes) ──
check('rushpoint filters: rebuild detection + hardening keep/drop', () => {
  const f = compileFilters(loadProfile('rushpoint'));
  assert.equal(f.applyHardeningFreeze, true);
  assert.equal(f.looksLikeRebuild('redesign the leaderboard'), true, 'shipped feature, no polish intent → rebuild');
  assert.equal(f.looksLikeRebuild('polish the leaderboard loading state'), false, 'polish intent → not a rebuild');
  assert.equal(f.looksLikeRebuild('build a totally new gizmo'), false, 'not a shipped feature → not a rebuild');
  assert.equal(f.looksLikeUiOrFeature({ title: 'add confetti animation' }), true, 'cosmetic → UI/feature');
  assert.equal(f.looksLikeUiOrFeature({ title: 'harden the retry/backoff logic' }), false, 'hardening keep → not dropped');
});

check('generic filters are permissive (nothing pre-dropped; quality gates still apply)', () => {
  const f = compileFilters(loadProfile('generic'));
  assert.equal(f.applyHardeningFreeze, false);
  assert.equal(f.looksLikeRebuild('redesign the leaderboard'), false, 'no shipped-feature pattern → never a rebuild');
  assert.equal(f.looksLikeUiOrFeature({ title: 'add confetti animation' }), false, 'no UI-polish pattern → not dropped');
});

// ── seed is a defensive copy ──
check('profileSeed returns a copy (mutating it does not corrupt the loaded profile)', () => {
  const p = loadProfile('rushpoint');
  const s = profileSeed(p);
  s[0].title = 'MUTATED';
  s[0].dims.userImpact = 99;
  assert.notEqual(p.seed[0].title, 'MUTATED', 'profile seed unchanged');
  assert.notEqual(p.seed[0].dims.userImpact, 99, 'nested dims unchanged');
});

console.log(`\nworkspace-profile: ${passed}/${passed} checks passed ✓`);
