// lib/bundle-variants.mjs — bundle variant detection (U-44).
//
// Reads bundle-manifest.json and determines which distribution variant is active based on whether
// commercial/config.json exists. Used by config-loader.mjs to report the active variant at
// startup and by any module that needs to gate behaviour on bundle composition.
//
// Variant detection rule (mirrors the config-loader.mjs resolution order):
//   commercial/config.json present  → 'commercial' variant
//   root config.json only           → 'core' variant

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB_DIR      = path.dirname(fileURLToPath(import.meta.url));
const AUTOPILOT_DIR = path.resolve(LIB_DIR, '..');

const MANIFEST_PATH    = path.join(AUTOPILOT_DIR, 'bundle-manifest.json');
const COMMERCIAL_CONFIG = path.join(AUTOPILOT_DIR, 'commercial', 'config.json');

let _manifest = null;
function loadManifest() {
  if (_manifest) return _manifest;
  try {
    _manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  } catch {
    // Manifest absent (e.g. stripped distribution) — return a safe minimal fallback so the engine
    // keeps running; all isFeatureAvailable() calls return false for commercial-only flags.
    _manifest = { schemaVersion: '1', variants: {}, featureFlags: {} };
  }
  return _manifest;
}

/** The bundle manifest parsed from bundle-manifest.json (or a safe empty fallback). */
export const bundleManifest = loadManifest();

/** 'commercial' when commercial/config.json is present; 'core' otherwise. */
export const activeBundleVariant = existsSync(COMMERCIAL_CONFIG) ? 'commercial' : 'core';

/** The active variant's descriptor object from bundle-manifest.json, or null if absent. */
export const activeVariantDescriptor =
  (bundleManifest.variants && bundleManifest.variants[activeBundleVariant]) || null;

/**
 * Returns true when a named feature flag is listed as available in the active bundle variant.
 * All flags with availableIn: ["core", "commercial"] pass in both variants; flags with
 * availableIn: ["commercial"] only pass when commercial/config.json is present.
 *
 * @param {string} flagName — key from bundle-manifest.json → featureFlags
 * @returns {boolean}
 */
export function isFeatureAvailable(flagName) {
  const flags = bundleManifest.featureFlags;
  if (!flags) return false;
  const flag = flags[flagName];
  if (!flag) return false;
  const available = Array.isArray(flag.availableIn) ? flag.availableIn : [];
  return available.includes(activeBundleVariant);
}

/**
 * One-line startup confirmation for the log.
 * Example: "bundle-variant=commercial (commercial/config.json present)"
 */
export function bundleVariantResolvedLine() {
  const reason = activeBundleVariant === 'commercial'
    ? '(commercial/config.json present)'
    : '(core-only: commercial/config.json absent)';
  return `bundle-variant=${activeBundleVariant} ${reason}`;
}
