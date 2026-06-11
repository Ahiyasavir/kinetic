// providers/claude.mjs — the Claude (Anthropic CLI) ProviderAdapter. Thin wrapper over lib/claude.mjs so
// the existing run path is unchanged (behavior-preserving) while exposing the provider-neutral seam the
// core policy layers consume. This is the ONLY file that knows Claude model ids / pricing.

import { runClaude, RateLimitError } from '../claude.mjs';

// Fallback per-model pricing (USD per 1M tokens, blended input+output) used ONLY when the provider does
// not report a real cost. The Claude CLI reports `total_cost_usd` directly, so this is a backstop for
// estimation/headless modes — keep it conservative (round up) so cost is never under-counted.
const PRICE_PER_MTOK = {
  // Fable 5 (Mythos-class, tier ABOVE Opus) — real pricing $10/M input, $50/M output. The CLI reports
  // the true total_cost_usd; this padded blended backstop (≈ output rate) only fires when it doesn't,
  // and keeps the ordering fable > opus > sonnet > haiku so a missing real cost never under-prices Fable.
  'claude-fable-5': 55,
  'claude-opus-4-8': 30,
  'claude-sonnet-4-6': 6,
  'claude-haiku-4-5': 1.5,
  _default: 10,
};

// Logical tier → concrete model id, sourced from config.models so a host re-points tiers without code.
// 'premium' is the Stage-2 ARCHITECT/mastermind tier (Fable 5 by default) — above 'strong'; used for
// long-context multi-step planning, not the per-cycle implementer.
function resolveModel(tierOrId, config = {}) {
  const m = (config && config.models) || {};
  switch (tierOrId) {
    case 'premium': return m.architect || m.premium || config.architectModel || 'claude-fable-5';
    case 'strong': return m.implementerHigh || m.implementer || config.model || 'claude-opus-4-8';
    case 'mid':    return m.implementerLow || config.model || 'claude-sonnet-4-6';
    case 'cheap':  return m.implementerLowest || m.selector || m.auditor || 'claude-haiku-4-5';
    default:       return tierOrId; // already a concrete id (e.g. config.models[roleName])
  }
}

function priceOf(res, config) {
  if (res && typeof res.costUsd === 'number') return res.costUsd; // provider-reported truth
  const u = (res && res.usage) || {};
  const toks = (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0);
  const model = (res && res.model) || (config && config.model) || '_default';
  const rate = PRICE_PER_MTOK[model] ?? PRICE_PER_MTOK._default;
  return (toks / 1_000_000) * rate;
}

export const claudeAdapter = {
  id: 'claude',
  // Same signature + result shape as runClaude → drop-in for the createCore({ runClaude }) seam.
  run: (opts) => runClaude(opts),
  resolveModel,
  // Provider-neutral pre-call estimate: ~4 chars/token is the standard rough heuristic.
  estimateTokens: (text) => Math.ceil(String(text || '').length / 4),
  tokensOf: (res) => {
    const u = (res && res.usage) || {};
    return (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0);
  },
  priceOf,
  isRateLimit: (err) => err instanceof RateLimitError || /rate limit|usage limit|quota/i.test(err?.message || ''),
  retryAfterMs: (err) => (err && typeof err.retryAfterMs === 'number') ? err.retryAfterMs : null,
};
