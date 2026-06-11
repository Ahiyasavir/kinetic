// core/providers.mjs — provider factory and role-to-model resolver (U-42).
// This is the single seam the engine uses to map an agent role to a provider and concrete model ID.
// It reads config.providers.roleMap + config.providers.definitions to decide which adapter and model
// to use per role, then delegates to lib/providers/index.mjs (the adapter registry). No hardcoded
// model strings here: all IDs flow from config.json.
//
// Three built-in provider types (registered in lib/providers/index.mjs):
//   claude      — Anthropic CLI (lib/providers/claude.mjs) — the default
//   openrouter  — OpenRouter HTTP API (OpenAI-compat; lib/providers/openrouter.mjs)
//   custom      — Any OpenAI-compatible HTTP endpoint (lib/providers/custom.mjs)
//
// Backward compatible: if config.providers is absent, all resolution falls back to the existing
// config.provider + config.models behavior (zero behavior change for unmodified config.json files).
//
// Usage:
//   import { getProviderForRole, resolveModelForRole } from './core/providers.mjs';
//   const adapter = getProviderForRole('reviewer', config);         // → ProviderAdapter
//   const modelId = resolveModelForRole('reviewer', 'mid', config); // → 'claude-sonnet-4-6'

import { getAdapter } from '../lib/providers/index.mjs';

/**
 * Look up the provider definition for a role from config.providers.
 * Returns the matching definition object, or null when the providers section is absent.
 */
function resolveProviderDef(role, config) {
  const defs = config?.providers?.definitions;
  if (!Array.isArray(defs) || defs.length === 0) return null;
  const roleMap = config?.providers?.roleMap || {};
  const provName = roleMap[role] ?? (defs.find((d) => d.default) ?? defs[0])?.name;
  return defs.find((d) => d.name === provName) ?? null;
}

/**
 * Get the ProviderAdapter for a given agent role.
 * Routes through config.providers.roleMap → definitions when present; falls back to the global
 * config.provider ('claude' by default) for full backward compatibility.
 *
 * @param {string} role   'implementer' | 'reviewer' | 'selector' | 'auditor' | 'architect'
 * @param {object} config loaded config.json object
 * @returns {ProviderAdapter}
 */
export function getProviderForRole(role, config) {
  const def = resolveProviderDef(role, config);
  if (def) {
    const adapterId = def.type || def.name || 'claude';
    return getAdapter({ ...config, provider: adapterId });
  }
  return getAdapter(config); // backward compat: use global config.provider (default 'claude')
}

/**
 * Resolve the concrete model ID for a role + logical tier.
 * Resolution order (first match wins):
 *   1. config.providers.definitions[roleMap[role]].modelId  (explicit per-provider override)
 *   2. config.models[role]  (existing per-role model map — backward compatible)
 *   3. adapter.resolveModel(tier, config)  (tier-based fallback in the adapter)
 *
 * @param {string} role   agent role name
 * @param {string} tier   logical tier: 'strong' | 'mid' | 'cheap' | 'premium' — or the role name
 *                        itself (when the caller doesn't know the tier, e.g. invokeRole)
 * @param {object} config loaded config.json
 * @returns {string} concrete model ID
 */
export function resolveModelForRole(role, tier, config) {
  const def = resolveProviderDef(role, config);
  if (def?.modelId) return def.modelId;
  const roleModel = config?.models?.[role];
  if (roleModel) return roleModel;
  return getProviderForRole(role, config).resolveModel(tier, config);
}

/**
 * Return the run-function bound to the configured provider for a given role.
 * The returned function has the same signature as runClaude / adapter.run.
 *
 * @param {string} role
 * @param {object} config
 * @returns {Function} async ({prompt, cwd, config, label, model}) => result
 */
export function getRunnerForRole(role, config) {
  return getProviderForRole(role, config).run;
}
