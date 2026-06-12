#!/usr/bin/env node
// config-loader.mjs — single source of truth for project paths (U-25) and validation commands (U-26).
//
// Reads autopilot/config.json and resolves the project-agnostic root variables
// (appRoot / appsDir / functionsDir / packagesDir / scriptsDir) into absolute paths, so workflow
// modules never hardcode RushPoint-specific 'apps/'… strings. Onboarding a new project becomes a
// pure config edit (change config.json → paths) with zero engine-code changes.
//
// It also exposes the project's validation commands (typecheck / build-admin / lint / e2e) as a
// configurable array (U-26) so those project-specific commands live in config.json, never in engine
// code — onboarding a new project means editing config.json → validation, no module change.
//
// Why this lives OUTSIDE supervisor.mjs / watchdog.mjs: those two entry-points are FROZEN by the
// Strangler-Fig guard (lib/protect.mjs → verifyProtected) until autopilot/core/.ready exists — any
// edit to them is auto-reverted and fails the cycle. This loader is the non-protected seam the
// engine imports once that freeze lifts. Until then it is fully usable by any non-protected module
// and as a CLI:  node autopilot/config-loader.mjs  → prints the resolved paths.

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidConfig } from './lib/config-validator.mjs';
import { activeBundleVariant, bundleManifest, isFeatureAvailable, bundleVariantResolvedLine } from './lib/bundle-variants.mjs';
// Re-export bundle-variant API so all consumers get it through the canonical config-loader entry-point.
export { activeBundleVariant, bundleManifest, isFeatureAvailable, bundleVariantResolvedLine };

const KINETIC_DIR = path.dirname(fileURLToPath(import.meta.url));
// Pluggable config loader (U-44): prefer commercial/config.json (the project-specific bundle layer)
// when present; fall back to the legacy root config.json so existing setups keep working unchanged.
const COMMERCIAL_CONFIG = path.join(KINETIC_DIR, 'commercial', 'config.json');
const CONFIG_PATH = existsSync(COMMERCIAL_CONFIG)
  ? COMMERCIAL_CONFIG
  : path.join(KINETIC_DIR, 'config.json');

// Project-agnostic defaults (RushPoint layout). Used when config.json omits a `paths` block so the
// loader is safe even against an older config — the engine keeps its current behavior.
const DEFAULT_PATHS = {
  appRoot: '.',          // repo root, relative to the autopilot/ parent
  appsDir: 'apps',
  functionsDir: 'functions',
  packagesDir: 'packages',
  scriptsDir: 'scripts'
};

export const config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

// Fail fast on schema violations so misconfigured engines surface the root cause immediately.
// assertValidConfig is a no-op when ajv/schema is unavailable (graceful degradation).
const CONFIG_DISPLAY = CONFIG_PATH.includes('commercial') ? 'autopilot/commercial/config.json' : 'autopilot/config.json';
assertValidConfig(config, CONFIG_DISPLAY);

// U-56: riskToModel runtime validation — keys must be numeric strings '1'–'5'; values must be
// non-empty model ID strings; each value must be one of the model IDs declared in config.models
// (so a typo fails loudly at startup instead of silently using the wrong model).
{
  const rtm = (config.implementerRouting || {}).riskToModel;
  if (rtm && typeof rtm === 'object' && !Array.isArray(rtm)) {
    const VALID_RISK_KEYS = new Set(['1', '2', '3', '4', '5']);
    const knownModelIds = new Set(Object.values(config.models || {}).filter((v) => typeof v === 'string' && v));
    for (const [key, modelId] of Object.entries(rtm)) {
      if (key.startsWith('_')) continue; // allow _comment keys
      if (!VALID_RISK_KEYS.has(String(key))) {
        throw new Error(`${CONFIG_DISPLAY}: implementerRouting.riskToModel key "${key}" is invalid — must be a risk level 1–5`);
      }
      if (typeof modelId !== 'string' || !modelId.trim()) {
        throw new Error(`${CONFIG_DISPLAY}: implementerRouting.riskToModel[${key}] must be a non-empty model ID string`);
      }
      if (knownModelIds.size > 0 && !knownModelIds.has(modelId)) {
        throw new Error(`${CONFIG_DISPLAY}: implementerRouting.riskToModel[${key}] — unknown model ID "${modelId}" (not in config.models: ${[...knownModelIds].join(', ')})`);
      }
    }
  }
}

// `_comment` keys in config.json are documentation only — never treat them as a path. `queues` is a
// nested block resolved separately below (against the autopilot/ dir, not appRoot).
const rawPaths = { ...config.paths };
delete rawPaths._comment;
delete rawPaths.queues;
const rel = { ...DEFAULT_PATHS, ...rawPaths };

// appRoot resolves relative to the repo root (the autopilot/ parent); every other dir resolves
// relative to appRoot. Multi-project support is therefore a single appRoot edit.
const repoRoot = path.resolve(KINETIC_DIR, '..');
const appRoot = path.resolve(repoRoot, rel.appRoot);
const under = (p) => path.resolve(appRoot, p);

export const paths = {
  repoRoot,
  appRoot,
  appsDir: under(rel.appsDir),
  functionsDir: under(rel.functionsDir),
  packagesDir: under(rel.packagesDir),
  scriptsDir: under(rel.scriptsDir),
  rel: { ...rel }        // portable relative forms (for logging / cross-platform display)
};

// Engine queue/state directory targets (U-31). Defaults match the original hardcoded supervisor
// layout so an older/minimal config (no `paths.queues` block) keeps the exact current behavior.
// These resolve against the autopilot/ dir itself (NOT appRoot): they are engine runtime dirs, not
// target-project source dirs. The backlog/done/blocked markdown mirrors + state.json + locks all live
// under stateDir, so relocating the BACKLOG/DONE queues is a single stateDir edit.
const DEFAULT_QUEUE_PATHS = {
  inboxDir: 'inbox',
  stateDir: 'state',
  handoffDir: 'state/handoff'
};

const rawQueues = { ...(config.paths && config.paths.queues) };
delete rawQueues._comment; // documentation only — never treat as a path
const relQueues = { ...DEFAULT_QUEUE_PATHS, ...rawQueues };
const underAutopilot = (p) => path.resolve(KINETIC_DIR, p);

export const queuePaths = {
  autopilotDir: KINETIC_DIR,
  inboxDir: underAutopilot(relQueues.inboxDir),
  stateDir: underAutopilot(relQueues.stateDir),
  handoffDir: underAutopilot(relQueues.handoffDir),
  // Convenience absolute paths to the backlog/done queue mirrors that live under stateDir.
  backlogFile: path.resolve(underAutopilot(relQueues.stateDir), 'backlog.md'),
  doneFile: path.resolve(underAutopilot(relQueues.stateDir), 'done.md'),
  rel: { ...relQueues } // portable relative forms (for logging / cross-platform display)
};

/** One-line startup confirmation that the queue/state paths came from config.json (not hardcoded). */
export function queuePathsResolvedLine() {
  const q = queuePaths.rel;
  return `config-loaded queue paths from config.json → inbox=${q.inboxDir} state=${q.stateDir} ` +
    `handoff=${q.handoffDir}`;
}

/** One-line startup confirmation that the paths came from config.json (not hardcoded). */
export function pathsResolvedLine() {
  const r = paths.rel;
  return `config-loaded paths from config.json → appRoot=${r.appRoot} apps=${r.appsDir} ` +
    `functions=${r.functionsDir} packages=${r.packagesDir} scripts=${r.scriptsDir}`;
}

// Project-agnostic validation defaults (U-26). Used when config.json omits a `validation` block so
// the loader stays safe against an older/minimal config (the engine keeps a no-op validation rather
// than crashing). The real RushPoint commands live in config.json → validation.commands.
const DEFAULT_VALIDATION = {
  commands: [],
  lintRegressionGuard: false,
  e2e: { enabled: false, cmd: '', timeoutMs: 600000 }
};

const rawValidation = { ...config.validation };
delete rawValidation._comment; // `_comment` keys are documentation only — never treat them as config.
export const validation = {
  commands: Array.isArray(rawValidation.commands) ? rawValidation.commands : DEFAULT_VALIDATION.commands,
  lintRegressionGuard: rawValidation.lintRegressionGuard ?? DEFAULT_VALIDATION.lintRegressionGuard,
  e2e: { ...DEFAULT_VALIDATION.e2e, ...(rawValidation.e2e || {}) }
};

/** The configured lint command (or '' when none is configured). Centralizes the lookup so no engine
 *  module hardcodes 'npm run lint' — the project's lint command lives in config.json. */
export function lintCommand() {
  return (validation.commands.find((c) => c.name === 'lint') || {}).cmd || '';
}

// Auto-fix configuration (U-46). Pre-flight linting and import-sorting before AI invocation to
// eliminate trivial fixable issues. Omitting the `autoFix` block disables auto-fixing (fully backward
// compatible). Consumed via this loader → { autoFix } and autopilot/lib/auto-fix.mjs.
const DEFAULT_AUTOFIX = {
  enabled: false,
  lintFixCommand: '',
  importSortCommand: '',
  timeoutMs: 600000
};

const rawAutoFix = { ...(config.autoFix || {}) };
delete rawAutoFix._comment; // documentation only — never treat as a config value
export const autoFix = {
  enabled: rawAutoFix.enabled ?? DEFAULT_AUTOFIX.enabled,
  lintFixCommand: rawAutoFix.lintFixCommand || DEFAULT_AUTOFIX.lintFixCommand,
  importSortCommand: rawAutoFix.importSortCommand || DEFAULT_AUTOFIX.importSortCommand,
  timeoutMs: rawAutoFix.timeoutMs ?? DEFAULT_AUTOFIX.timeoutMs
};

/** Startup confirmation that autoFix config was loaded. */
export function autoFixResolvedLine() {
  return autoFix.enabled
    ? `config-loaded autoFix from config.json → enabled (lint: ${!!autoFix.lintFixCommand}, imports: ${!!autoFix.importSortCommand})`
    : 'config-loaded autoFix from config.json → disabled';
}

// Proactive Scanner configuration (U-57). Resolves the optional `scanner` block with safe defaults
// so the scanner stays disabled unless explicitly enabled — omitting the block (or `enabled:false`)
// keeps the scanner off (zero behavior change, fully backward compatible).
const DEFAULT_SCANNER = {
  enabled: false,
  runDuringIdleTime: false,
  ignorePaths: ['node_modules', 'dist', 'build', 'coverage', '.next', '.vite']
};

const rawScanner = { ...(config.scanner || {}) };
delete rawScanner._comment; // documentation only — never treat as a scanner setting
export const scanner = {
  enabled: rawScanner.enabled ?? DEFAULT_SCANNER.enabled,
  runDuringIdleTime: rawScanner.runDuringIdleTime ?? DEFAULT_SCANNER.runDuringIdleTime,
  ignorePaths: Array.isArray(rawScanner.ignorePaths) ? rawScanner.ignorePaths : DEFAULT_SCANNER.ignorePaths
};

/** Startup confirmation that scanner config was loaded. */
export function scannerResolvedLine() {
  if (!scanner.enabled) {
    return 'config-loaded scanner from config.json → disabled';
  }
  return `config-loaded scanner from config.json → enabled (idleTime=${scanner.runDuringIdleTime}, ignore=${scanner.ignorePaths.length} patterns)`;
}

// Per-project token budgets (U-33). Maps a projectId (repo+goal slug) to its independent limits so the
// kinetic can pace multiple projects/workspaces without their token counters cross-contaminating.
// Omitting the `budgets` block keeps the engine on cadence-only pacing (no per-project cap) — fully
// backward compatible. Consumed via this loader → { budgets } and autopilot/lib/token-pacer.mjs.
const rawBudgets = { ...(config.budgets || {}) };
delete rawBudgets._comment; // documentation only — never treat as a project budget
export const budgets = rawBudgets;

/** The resolved budget limits for one project, or null when none is configured. */
export function projectBudget(projectId) {
  return (projectId && budgets[projectId]) || null;
}

// Engine telemetry config (U-36). Resolves the optional `telemetry` block with safe defaults so the
// decoupled telemetry framework (autopilot/lib/telemetry.mjs) is disabled unless explicitly turned on —
// omitting the block keeps the engine silent (zero behavior change, fully backward compatible). The
// supervisor passes this straight to initTelemetry(); the watchdog reads `enabled` to gate its own events.
const DEFAULT_TELEMETRY = { enabled: false, endpoint: null, batchSize: 50, flushIntervalMs: 60000 };

const rawTelemetry = { ...(config.telemetry || {}) };
delete rawTelemetry._comment; // documentation only — never treat as a telemetry setting
export const telemetry = { ...DEFAULT_TELEMETRY, ...rawTelemetry };

/** One-line startup confirmation that the telemetry config came from config.json (not hardcoded). */
export function telemetryResolvedLine() {
  return `config-loaded telemetry from config.json → enabled=${telemetry.enabled}` +
    (telemetry.enabled ? ` · endpoint=${telemetry.endpoint || '(local buffer)'} · batchSize=${telemetry.batchSize}` : '');
}

/** One-line startup confirmation that the per-project budgets came from config.json (not hardcoded). */
export function budgetsResolvedLine() {
  const ids = Object.keys(budgets);
  return `config-loaded token budgets from config.json → ${ids.length ? ids.join(', ') : '(none — cadence-only pacing)'}`;
}

// External context-provider config (U-37). Resolves the optional `contextProvider` block with safe
// defaults so the selector stays on pure local analysis unless a host explicitly enables the seam —
// omitting the block (or `enabled:false`) keeps the engine standalone (zero behavior change, fully
// backward compatible). Consumed by autopilot/core/context-provider.mjs + core/selector.
const DEFAULT_CONTEXT_PROVIDER = {
  enabled: false,
  interface: 'core/context-provider.mjs#ContextProviderInterface',
  source: '',
  cacheStrategy: 'memory',
  validateFreshness: true,
  maxStaleMs: 300000,
  fallbackToLocal: true
};

const rawContextProvider = { ...(config.contextProvider || {}) };
delete rawContextProvider._comment; // documentation only — never treat as a setting
export const contextProvider = { ...DEFAULT_CONTEXT_PROVIDER, ...rawContextProvider };

/** One-line startup confirmation that the context-provider config came from config.json (not hardcoded). */
export function contextProviderResolvedLine() {
  if (!contextProvider.enabled) {
    return 'config-loaded context provider from config.json → enabled=false (local analysis / standalone mode)';
  }
  return `config-loaded context provider from config.json → enabled=true · source=${contextProvider.source || '(unset)'} ` +
    `· cache=${contextProvider.cacheStrategy} · validateFreshness=${contextProvider.validateFreshness} ` +
    `· maxStaleMs=${contextProvider.maxStaleMs} · fallbackToLocal=${contextProvider.fallbackToLocal}`;
}

// API key pooling / load balancing (Stage 1). Resolves the optional `api_pools` array + `keyRotation`
// tuning block. DEPRECATES the single global API key: instead of one token the engine load-balances a
// POOL of accounts (autopilot/lib/key-manager.mjs) and rotates off any that hit a 429 / daily budget.
// Secrets never live in config.json — each entry names an env var (`key_env`) read at runtime.
// Omitting `api_pools` (or leaving it empty) keeps the engine on its single pinned-account path — fully
// backward compatible (rotation is enabled only when a pool with a resolvable token exists).
const POOL_STATUSES = ['active', 'exhausted', 'rate-limited'];

function normalizePoolEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const provider = String(raw.provider || '').trim();
  const key_env = String(raw.key_env || '').trim();
  if (!id || !provider || !key_env) return null; // an entry missing identity/provider/env is unusable
  return {
    id,
    provider,
    key_env,
    status: POOL_STATUSES.includes(raw.status) ? raw.status : 'active',
    daily_budget: Number(raw.daily_budget) > 0 ? Number(raw.daily_budget) : 0, // 0 = uncapped
    current_usage: Number(raw.current_usage) || 0,
    retry_after: raw.retry_after || null,
  };
}

const rawApiPools = Array.isArray(config.api_pools) ? config.api_pools : [];
export const apiPools = rawApiPools.map(normalizePoolEntry).filter(Boolean);

const DEFAULT_KEY_ROTATION = {
  enabled: true,          // honored only when a usable pool exists (see keyRotationActive)
  maxRetries: 3,          // key rotations per call before surfacing AllKeysExhaustedError
  defaultCooldownMs: 60000, // fallback cooldown when a 429 carries no retry-after hint
  providerMap: { claude: 'anthropic' }, // adapter id → pool `provider` name
};
const rawKeyRotation = { ...(config.keyRotation || {}) };
delete rawKeyRotation._comment; // documentation only
export const keyRotation = {
  ...DEFAULT_KEY_ROTATION,
  ...rawKeyRotation,
  providerMap: { ...DEFAULT_KEY_ROTATION.providerMap, ...(rawKeyRotation.providerMap || {}) },
};

/** True when key rotation should actually engage: explicitly enabled AND at least one pool entry has
 *  its env token present. Lets the engine fall back to the pinned account when no real keys exist. */
export function keyRotationActive(env = process.env) {
  if (!keyRotation.enabled) return false;
  return apiPools.some((p) => env[p.key_env]);
}

/** One-line startup confirmation that the API pools came from config.json (not a hardcoded key). */
export function apiPoolsResolvedLine(env = process.env) {
  if (apiPools.length === 0) {
    return 'config-loaded API pools from config.json → (none — single pinned-account mode)';
  }
  const withToken = apiPools.filter((p) => env[p.key_env]).length;
  const byProvider = apiPools.reduce((acc, p) => { acc[p.provider] = (acc[p.provider] || 0) + 1; return acc; }, {});
  const summary = Object.entries(byProvider).map(([k, n]) => `${k}×${n}`).join(', ');
  return `config-loaded API pools from config.json → ${apiPools.length} key(s) [${summary}] · ` +
    `${withToken} with env token · rotation ${keyRotationActive(env) ? 'ACTIVE' : 'inactive (no token / disabled)'}`;
}

/** One-line startup confirmation that the validation commands came from config.json (not hardcoded). */
export function validationResolvedLine() {
  const names = validation.commands.map((c) => `${c.name}${c.required ? '' : '?'}`).join(', ') || '(none)';
  return `config-loaded validation from config.json → [${names}] · ` +
    `lintRegressionGuard=${validation.lintRegressionGuard} · e2e=${validation.e2e.enabled}`;
}

// Provider-mapping config (U-42). Resolves the optional `providers` block with safe defaults so the
// engine continues using the single global config.provider when no per-role routing is configured —
// omitting the block (or leaving definitions empty) keeps the engine on its current Claude-only path,
// fully backward compatible. Consumed by autopilot/core/providers.mjs → getProviderForRole().
const VALID_ADAPTER_TYPES = ['claude', 'openrouter', 'custom'];

function normalizeProviderDef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name || '').trim();
  if (!name) return null; // name is the only required field
  const type = raw.type && VALID_ADAPTER_TYPES.includes(raw.type) ? raw.type : name;
  return {
    name,
    type,
    baseURL:   raw.baseURL   != null ? String(raw.baseURL)   : null,
    apiKeyEnv: raw.apiKeyEnv != null ? String(raw.apiKeyEnv) : null,
    modelId:   raw.modelId   != null ? String(raw.modelId)   : null,
    default:   Boolean(raw.default),
  };
}

const rawProviders = config.providers || {};
const rawDefinitions = Array.isArray(rawProviders.definitions) ? rawProviders.definitions : [];
const rawRoleMap = rawProviders.roleMap && typeof rawProviders.roleMap === 'object' ? { ...rawProviders.roleMap } : {};
delete rawRoleMap._comment; // documentation only

export const providers = {
  definitions: rawDefinitions.map(normalizeProviderDef).filter(Boolean),
  roleMap: rawRoleMap,
};

/** Validate that every roleMap value references a defined provider name. Throws on invalid config. */
export function assertValidProviders() {
  const defined = new Set(providers.definitions.map((d) => d.name));
  const invalid = Object.entries(providers.roleMap)
    .filter(([, v]) => v && !defined.has(v))
    .map(([role, v]) => `  ${role}: "${v}" is not in providers.definitions`);
  if (invalid.length) {
    throw new Error(
      `Invalid providers.roleMap in autopilot/config.json — ${invalid.length} unknown provider(s):\n${invalid.join('\n')}\n` +
      `Defined providers: ${[...defined].join(', ') || '(none)'}`
    );
  }
}

// Fail fast on invalid provider references at startup (only when a providers block is present).
if (providers.definitions.length > 0) {
  assertValidProviders();
}

/** One-line startup confirmation that the providers config came from config.json. */
export function providersResolvedLine() {
  if (providers.definitions.length === 0) {
    return 'config-loaded providers from config.json → (none — global config.provider mode)';
  }
  const names = providers.definitions.map((d) => `${d.name}(${d.type})`).join(', ');
  const roles = Object.entries(providers.roleMap)
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => `${k}→${v}`)
    .join(', ') || '(all roles use global provider)';
  return `config-loaded providers from config.json → [${names}] · roleMap: {${roles}}`;
}

// CLI: print the confirmation + the absolute resolution so the wiring is verifiable today.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(bundleVariantResolvedLine());
  console.log(pathsResolvedLine());
  console.log(queuePathsResolvedLine());
  console.log(budgetsResolvedLine());
  console.log(telemetryResolvedLine());
  console.log(contextProviderResolvedLine());
  console.log(apiPoolsResolvedLine());
  console.log(providersResolvedLine());
  console.log(validationResolvedLine());
  console.log(autoFixResolvedLine());
  console.log(JSON.stringify({
    repoRoot: paths.repoRoot,
    appRoot: paths.appRoot,
    appsDir: paths.appsDir,
    functionsDir: paths.functionsDir,
    packagesDir: paths.packagesDir,
    scriptsDir: paths.scriptsDir,
    inboxDir: queuePaths.inboxDir,
    stateDir: queuePaths.stateDir,
    handoffDir: queuePaths.handoffDir,
    backlogFile: queuePaths.backlogFile,
    doneFile: queuePaths.doneFile
  }, null, 2));
  console.log(JSON.stringify({ validation }, null, 2));
}
