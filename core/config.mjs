// core/config.mjs — project-agnostic config loader for the engine.
//
// Resolves a raw config object into the canonical two-section shape:
//   { engine: { models, cli, cycle, rateLimit, implementerRouting, weeklyBudget, learning },
//     project: { id, workspaceRoot, git, validation, goals, phase, scoring, context } }
//
// Three guarantees the rest of the engine relies on:
//   1. BACKWARD COMPATIBLE — a legacy flat config (top-level `models`, `cli`, `validation`, `git`, ...)
//      is remapped into engine/project with a one-line deprecation warning. A half-migrated config that
//      already has `engine`/`project` blocks is preserved; flat keys only fill what the blocks omit.
//   2. FAULT TOLERANT — missing/invalid sections fall back to documented defaults instead of throwing.
//      loadConfig() never throws inside the loop.
//   3. SCHEMA-AWARE — validateEngineConfig() checks the resolved object against core/config.schema.json
//      when ajv is available, and degrades to a no-op (valid:true, skipped:true) when it is not.
//
// This module is intentionally standalone: it is exported from core/index.mjs so hosts can adopt the
// new shape incrementally without touching supervisor.mjs. No host-project facts live here.

import { createRequire } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const _dir = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(_dir, 'config.schema.json');
const _require = createRequire(import.meta.url);

// Documented defaults applied when a section is absent. Conservative + project-neutral.
export const DEFAULT_ENGINE_CONFIG = {
  models: {
    selector: 'claude-haiku-4-5',
    reviewer: 'claude-sonnet-4-6',
    auditor: 'claude-haiku-4-5',
    implementerHigh: 'claude-opus-4-8',
    implementerLow: 'claude-sonnet-4-6',
  },
  implementerRouting: { opusMinRisk: 4, opusKeywords: [] },
  cli: {
    bin: 'claude',
    outputFormat: 'json',
    permission: '--dangerously-skip-permissions',
    timeoutMs: 1800000,
    maxTurnsPerCall: 60,
  },
  cycle: { maxReviseAttempts: 2, cooldownBetweenCyclesMs: 120000, backlogTopUpThreshold: 4 },
  rateLimit: { baseCooldownMs: 1200000, maxCooldownMs: 2700000 },
};

export const DEFAULT_PROJECT_CONFIG = {
  id: '',
  workspaceRoot: '.',
  git: { integrationBranch: 'main', baseBranch: 'main', commitPrefix: 'autopilot' },
  validation: { commands: [], lintRegressionGuard: true },
  goals: [],
  phase: '',
  scoring: {},
  context: { provider: 'fs', domainKnowledgeDir: '' },
};

// Legacy flat keys → where they belong in the new shape. Used to remap + warn.
const LEGACY_ENGINE_KEYS = ['models', 'implementerRouting', 'cli', 'cycle', 'rateLimit', 'weeklyBudget', 'learning'];
const LEGACY_PROJECT_KEYS = ['git', 'validation', 'goals', 'phase', 'scoring'];

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Normalize a raw config into { engine, project }, remapping legacy flat keys.
 * Pure: does not read disk, never throws. Emits deprecation lines via `log` (default console.warn).
 */
export function normalizeConfig(raw, { log = console.warn } = {}) {
  const src = isObject(raw) ? raw : {};
  const engine = isObject(src.engine) ? { ...src.engine } : {};
  const project = isObject(src.project) ? { ...src.project } : {};
  const deprecations = [];

  for (const key of LEGACY_ENGINE_KEYS) {
    if (src[key] !== undefined && engine[key] === undefined) {
      engine[key] = src[key];
      deprecations.push(key);
    }
  }
  for (const key of LEGACY_PROJECT_KEYS) {
    if (src[key] !== undefined && project[key] === undefined) {
      project[key] = src[key];
      deprecations.push(key);
    }
  }
  // A flat `paths.appRoot` historically named the workspace root.
  if (project.workspaceRoot === undefined && isObject(src.paths) && src.paths.appRoot !== undefined) {
    project.workspaceRoot = src.paths.appRoot;
    deprecations.push('paths.appRoot');
  }
  // A flat `profile` string historically named the project id.
  if (project.id === undefined && typeof src.profile === 'string') {
    project.id = src.profile;
    deprecations.push('profile');
  }

  if (deprecations.length && typeof log === 'function') {
    log(`[config] DEPRECATED top-level keys remapped to engine.*/project.*: ${deprecations.join(', ')} — see core/config.schema.json`);
  }
  return { engine, project };
}

function withDefaults(section, defaults) {
  const out = { ...defaults, ...(isObject(section) ? section : {}) };
  for (const [k, v] of Object.entries(defaults)) {
    if (isObject(v) && isObject(out[k])) out[k] = { ...v, ...out[k] };
  }
  return out;
}

// Compile the schema once; null when ajv or the schema file is unavailable.
let _validator;
let _validatorInit = false;
function getValidator() {
  if (_validatorInit) return _validator;
  _validatorInit = true;
  _validator = null;
  if (!existsSync(SCHEMA_PATH)) return _validator;
  try {
    const AjvMod = _require('ajv');
    const Ajv = AjvMod.default || AjvMod;
    const ajv = new Ajv({ allErrors: true, strict: false });
    _validator = ajv.compile(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
  } catch {
    _validator = null;
  }
  return _validator;
}

/**
 * Validate a resolved { engine, project } config against core/config.schema.json.
 * Returns { valid, errors, skipped }. Never throws; skipped=true ⇒ treat as valid.
 */
export function validateEngineConfig(config) {
  const validate = getValidator();
  if (!validate) return { valid: true, errors: [], skipped: true };
  const valid = validate(config);
  const errors = valid
    ? []
    : (validate.errors || []).map((e) => `${e.instancePath || '(root)'}: ${e.message}`);
  return { valid, errors, skipped: false };
}

/**
 * loadConfig — the engine entry-point. Accepts either a parsed object or a file path string.
 * Normalizes legacy keys, fills documented defaults, and validates (best-effort). Never throws:
 * a malformed file or invalid field logs a clear warning and yields a usable defaulted config.
 *
 * @returns {{ engine: object, project: object, valid: boolean, errors: string[] }}
 */
export function loadConfig(input, { log = console.warn } = {}) {
  let raw = input;
  if (typeof input === 'string') {
    try {
      raw = JSON.parse(readFileSync(input, 'utf8'));
    } catch (err) {
      log(`[config] could not read/parse "${input}" (${err && err.message}); using defaults`);
      raw = {};
    }
  }
  const normalized = normalizeConfig(raw, { log });
  const engine = withDefaults(normalized.engine, DEFAULT_ENGINE_CONFIG);
  const project = withDefaults(normalized.project, DEFAULT_PROJECT_CONFIG);
  const resolved = { engine, project };

  const { valid, errors, skipped } = validateEngineConfig(resolved);
  if (!valid && !skipped && typeof log === 'function') {
    log(`[config] schema validation reported ${errors.length} issue(s); proceeding with defaults where missing:\n  ${errors.join('\n  ')}`);
  }
  return { engine, project, valid: valid || skipped, errors };
}

export default loadConfig;
