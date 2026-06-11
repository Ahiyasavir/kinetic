// providers/custom.mjs — ProviderAdapter for any OpenAI-compatible HTTP endpoint.
// Point baseURL at Ollama, LM Studio, vLLM, Mistral API, or any server speaking /chat/completions.
// config.providers.definitions[custom].baseURL sets the endpoint; apiKeyEnv names the env var
// holding the key (optional for endpoints that don't require auth, e.g. local Ollama).
// modelId in the definition overrides the per-tier model map for this provider.

function resolveModel(tierOrId, config) {
  const defs = config?.providers?.definitions || [];
  const def = defs.find((d) => d.type === 'custom' || d.name === 'custom');
  if (def?.modelId) return def.modelId;
  const m = (config && config.models) || {};
  switch (tierOrId) {
    case 'premium': return m.architect || m.premium || 'default';
    case 'strong':  return m.implementerHigh || m.implementer || 'default';
    case 'mid':     return m.implementerLow  || 'default';
    case 'cheap':   return m.implementerLowest || m.selector || m.auditor || 'default';
    default:        return tierOrId;
  }
}

function resolveApiKey(config) {
  const defs = config?.providers?.definitions || [];
  const def = defs.find((d) => d.type === 'custom' || d.name === 'custom');
  const envVar = def?.apiKeyEnv;
  return (envVar && process.env[envVar]) || '';
}

function resolveBaseUrl(config) {
  const defs = config?.providers?.definitions || [];
  const def = defs.find((d) => d.type === 'custom' || d.name === 'custom');
  return def?.baseURL || '';
}

async function run({ prompt, config, label, model }) {
  const baseUrl = resolveBaseUrl(config);
  const apiKey  = resolveApiKey(config);
  const modelId = model || 'default';

  if (!baseUrl) {
    return {
      ok: false,
      text: `[${label}] custom provider: baseURL not set — add it to config.providers.definitions[custom].baseURL`,
      usage: null,
      costUsd: null,
    };
  }

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let raw;
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
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
        const err = new Error(`[${label}] custom provider rate limit: ${msg}`);
        err._isRateLimit = true;
        throw err;
      }
      return { ok: false, text: `[${label}] custom provider error ${response.status}: ${msg}`, usage: null, costUsd: null };
    }
    raw = data;
  } catch (err) {
    if (err._isRateLimit) throw err;
    return { ok: false, text: `[${label}] custom provider fetch failed: ${err.message}`, usage: null, costUsd: null };
  }

  const text = raw?.choices?.[0]?.message?.content || '';
  const usage = raw?.usage ? {
    input_tokens:  raw.usage.prompt_tokens    || 0,
    output_tokens: raw.usage.completion_tokens || 0,
  } : null;

  return { ok: true, text, raw, usage, costUsd: null };
}

export const customAdapter = {
  id: 'custom',
  run,
  resolveModel,
  estimateTokens: (text) => Math.ceil(String(text || '').length / 4),
  tokensOf: (res) => {
    const u = (res && res.usage) || {};
    return (Number(u.input_tokens) || 0) + (Number(u.output_tokens) || 0);
  },
  priceOf: () => 0,
  isRateLimit: (err) => err?._isRateLimit === true || /rate limit|too many requests|429/i.test(err?.message || ''),
  retryAfterMs: () => null,
};
