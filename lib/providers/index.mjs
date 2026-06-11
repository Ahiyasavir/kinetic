// providers/index.mjs — provider-agnostic adapter seam. Core agent policy (routing, budgeting,
// verification) is written against LOGICAL model tiers ('strong' | 'mid' | 'cheap') and a normalized
// result shape — never against a specific vendor. A ProviderAdapter maps those neutral concepts onto a
// concrete provider (Claude CLI today; Cursor / Windsurf / Antigravity / OpenAI-compatible endpoints by
// adding a sibling module). Swapping providers = set config.provider + provide config.models; no change
// to route.mjs / budget-governor.mjs / verify.mjs.
//
// ───────── ProviderAdapter interface ─────────
//   id: string
//   run({prompt, cwd, config, label, model}) → Promise<result>
//       result = { ok, text, usage:{input_tokens,output_tokens,cache_*}, costUsd:number|null }
//       (adapters MUST normalize their provider's usage into these canonical keys so metering is neutral)
//   resolveModel(tierOrId, config) → concrete model id        ('strong'|'mid'|'cheap' → config.models.*)
//   estimateTokens(text) → number                              (provider-neutral heuristic for pre-call est.)
//   tokensOf(result) → number                                  (input+output tokens from a result)
//   priceOf(result, config) → number                           (USD; provider-reported if available)
//   isRateLimit(err) → boolean
//   retryAfterMs(err) → number|null
//
// The registry is intentionally tiny + synchronous; adapters are plain objects with bound functions.

import { claudeAdapter } from './claude.mjs';
import { openrouterAdapter } from './openrouter.mjs';
import { customAdapter } from './custom.mjs';

const REGISTRY = { claude: claudeAdapter, openrouter: openrouterAdapter, custom: customAdapter };

// Register a new provider adapter at runtime (e.g. a host plugging in Cursor/Windsurf). Validates the
// minimal contract so a broken adapter fails loudly here, not deep in the loop.
export function registerAdapter(adapter) {
  for (const m of ['id', 'run', 'resolveModel', 'estimateTokens', 'tokensOf', 'priceOf', 'isRateLimit', 'retryAfterMs']) {
    if (!(m in adapter)) throw new Error(`provider adapter missing required member: ${m}`);
  }
  REGISTRY[adapter.id] = adapter;
  return adapter;
}

// Resolve the active adapter from config.provider (default 'claude'). Throws on an unknown provider so a
// typo can't silently fall back to the wrong vendor.
export function getAdapter(config = {}) {
  const id = (config && config.provider) || 'claude';
  const a = REGISTRY[id];
  if (!a) throw new Error(`unknown provider "${id}" — registered: ${Object.keys(REGISTRY).join(', ')}`);
  return a;
}

export function listProviders() { return Object.keys(REGISTRY); }

// Canonical token count from a normalized result (provider-neutral).
export function tokensOfResult(res) {
  const u = (res && res.usage) || {};
  return (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0);
}
