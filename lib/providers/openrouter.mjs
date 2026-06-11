// providers/openrouter.mjs — ProviderAdapter for OpenRouter (https://openrouter.ai).
// OpenRouter exposes an OpenAI-compatible /v1/chat/completions endpoint supporting hundreds of
// models (Claude, GPT-4o, Llama-3, Mistral…). Secrets are never hardcoded: the API key is read
// from the env var named in config.providers.definitions[openrouter].apiKeyEnv at runtime.
//
// Result shape is normalized to the same { ok, text, usage:{input_tokens,output_tokens}, costUsd }
// contract as claudeAdapter so the budget-governor / token-pacer work provider-neutrally.

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

function resolveModel(tierOrId, config) {
  const m = (config && config.models) || {};
  switch (tierOrId) {
    case 'premium': return m.architect || m.premium || 'openrouter/auto';
    case 'strong':  return m.implementerHigh || m.implementer || 'openrouter/auto';
    case 'mid':     return m.implementerLow  || 'openrouter/auto';
    case 'cheap':   return m.implementerLowest || m.selector || m.auditor || 'openrouter/auto';
    default:        return tierOrId;
  }
}

function resolveApiKey(config) {
  const defs = config?.providers?.definitions || [];
  const def = defs.find((d) => d.type === 'openrouter' || d.name === 'openrouter');
  const envVar = def?.apiKeyEnv;
  return (envVar && process.env[envVar]) || process.env.OPENROUTER_API_KEY || '';
}

function resolveBaseUrl(config) {
  const defs = config?.providers?.definitions || [];
  const def = defs.find((d) => d.type === 'openrouter' || d.name === 'openrouter');
  return (def?.baseURL) || DEFAULT_BASE_URL;
}

async function run({ prompt, config, label, model }) {
  const apiKey  = resolveApiKey(config);
  const baseUrl = resolveBaseUrl(config);
  const modelId = model || 'openrouter/auto';

  if (!apiKey) {
    return {
      ok: false,
      text: `[${label}] OpenRouter: no API key — set apiKeyEnv in config.providers.definitions or OPENROUTER_API_KEY env var`,
      usage: null,
      costUsd: null,
    };
  }

  let raw;
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/rushpoint/autopilot',
      },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 32000,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      const msg = (data?.error?.message || JSON.stringify(data)).slice(0, 400);
      if (response.status === 429) {
        const err = new Error(`[${label}] OpenRouter rate limit: ${msg}`);
        err._isRateLimit = true;
        throw err;
      }
      return { ok: false, text: `[${label}] OpenRouter error ${response.status}: ${msg}`, usage: null, costUsd: null };
    }
    raw = data;
  } catch (err) {
    if (err._isRateLimit) throw err;
    return { ok: false, text: `[${label}] OpenRouter fetch failed: ${err.message}`, usage: null, costUsd: null };
  }

  const text = raw?.choices?.[0]?.message?.content || '';
  const usage = raw?.usage ? {
    input_tokens:  raw.usage.prompt_tokens    || 0,
    output_tokens: raw.usage.completion_tokens || 0,
  } : null;
  const costUsd = typeof raw?.usage?.total_cost === 'number' ? raw.usage.total_cost : null;

  return { ok: true, text, raw, usage, costUsd };
}

export const openrouterAdapter = {
  id: 'openrouter',
  run,
  resolveModel,
  estimateTokens: (text) => Math.ceil(String(text || '').length / 4),
  tokensOf: (res) => {
    const u = (res && res.usage) || {};
    return (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0);
  },
  priceOf: (res) => (res && typeof res.costUsd === 'number') ? res.costUsd : 0,
  isRateLimit: (err) => err?._isRateLimit === true || /rate limit|too many requests|429/i.test(err?.message || ''),
  retryAfterMs: () => null,
};
