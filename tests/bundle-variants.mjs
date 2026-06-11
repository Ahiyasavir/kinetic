// tests/bundle-variants.mjs — assertions for the bundle-variant detection module (U-44).
//
// Verifies: (1) manifest loads with expected structure; (2) active variant is 'core' or
// 'commercial'; (3) known flags resolve correctly; (4) unknown flags return false;
// (5) bundleVariantResolvedLine returns the active variant name; (6) activeVariantDescriptor
// is an object or null; (7) the example-scorer plugin satisfies the scoreTask interface.
//
//   node autopilot/tests/bundle-variants.mjs
import assert from 'node:assert/strict';
import {
  bundleManifest,
  activeBundleVariant,
  activeVariantDescriptor,
  isFeatureAvailable,
  bundleVariantResolvedLine,
} from '../lib/bundle-variants.mjs';
import { scoreTask, pluginMeta } from '../plugins/example-scorer/index.mjs';

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

// 1) Manifest structure.
check('manifest has schemaVersion', () => {
  assert.ok(bundleManifest.schemaVersion, 'bundleManifest.schemaVersion must be set');
});
check('manifest declares core and commercial variants', () => {
  assert.ok(bundleManifest.variants?.core,       'core variant must be declared');
  assert.ok(bundleManifest.variants?.commercial, 'commercial variant must be declared');
});
check('manifest has featureFlags block', () => {
  assert.ok(bundleManifest.featureFlags,                        'featureFlags must be present');
  assert.ok('budgetGovernor' in bundleManifest.featureFlags,   'budgetGovernor flag must be declared');
  assert.ok('commercialProfile' in bundleManifest.featureFlags, 'commercialProfile flag must be declared');
});

// 2) Active variant value.
check('activeBundleVariant is core or commercial', () => {
  assert.ok(
    ['core', 'commercial'].includes(activeBundleVariant),
    `activeBundleVariant must be 'core' or 'commercial', got: ${activeBundleVariant}`,
  );
});

// 3) Flags available in both variants pass.
for (const flag of ['budgetGovernor', 'keyPooling', 'architectMode', 'contextProvider', 'multiWorkspace', 'providerRouting']) {
  check(`flag '${flag}' is available (availableIn: core+commercial)`, () => {
    assert.equal(isFeatureAvailable(flag), true,
      `${flag} is availableIn:["core","commercial"] so must always return true`);
  });
}

// 4) Unknown flag returns false.
check('unknown flag returns false', () => {
  assert.equal(isFeatureAvailable('nonExistentPluginFlag'), false);
});

// 5) bundleVariantResolvedLine content.
check('bundleVariantResolvedLine returns a non-empty string', () => {
  const line = bundleVariantResolvedLine();
  assert.ok(typeof line === 'string' && line.length > 0, 'must return a non-empty string');
  assert.ok(line.includes(activeBundleVariant), 'line must include the active variant name');
});

// 6) activeVariantDescriptor is object or null.
check('activeVariantDescriptor is an object or null', () => {
  assert.ok(activeVariantDescriptor === null || typeof activeVariantDescriptor === 'object');
});

// 7) Example-scorer plugin contract (wiring check for plugins/example-scorer/index.mjs).
check('example-scorer exports scoreTask function', () => {
  assert.equal(typeof scoreTask, 'function', 'scoreTask must be a function');
});
check('example-scorer exports pluginMeta with id and type', () => {
  assert.ok(pluginMeta?.id,   'pluginMeta.id must be set');
  assert.ok(pluginMeta?.type, 'pluginMeta.type must be set');
  assert.equal(pluginMeta.type, 'scorer');
});
check('example-scorer scoreTask returns a positive number for a task with dims', () => {
  const task = { dims: { userImpact: 3, adminImpact: 2, reliability: 2, productRisk: 1, cleanupValue: 0 } };
  const score = scoreTask(task, {}, {});
  assert.equal(typeof score, 'number', 'scoreTask must return a number');
  assert.ok(score > 0, 'score must be positive for a task with meaningful dims');
});
check('example-scorer scoreTask applies userRequested boost', () => {
  const base    = { dims: { userImpact: 3, adminImpact: 2, reliability: 2, productRisk: 1, cleanupValue: 0 } };
  const boosted = { ...base, userRequested: true };
  assert.ok(
    scoreTask(boosted, {}, {}) > scoreTask(base, {}, {}) + 90000,
    'userRequested task must score ≥100000 more than the same task without the flag',
  );
});
check('example-scorer scoreTask returns 0 for a task with all-zero dims', () => {
  const empty = { dims: {} };
  assert.equal(scoreTask(empty, {}, {}), 0);
});

console.log(`\nbundle-variants: ${passed} assertions passed`);
