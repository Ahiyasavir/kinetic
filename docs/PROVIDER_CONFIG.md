# Provider Configuration (U-42)

The autopilot engine supports a modular provider-mapping system that lets you route any agent role
to a different LLM provider — without changing engine code. Three provider types ship out of the box:

| Type | Adapter | Notes |
|------|---------|-------|
| `claude` | `lib/providers/claude.mjs` | Anthropic CLI (`claude -p`). Default provider. |
| `openrouter` | `lib/providers/openrouter.mjs` | OpenRouter HTTP API (OpenAI-compat, 200+ models). |
| `custom` | `lib/providers/custom.mjs` | Any OpenAI-compatible HTTP endpoint. |

All model resolution goes through `core/providers.mjs` → `getProviderForRole` / `resolveModelForRole`.

---

## Quick-start: keep current behavior (no change needed)

Omit `config.providers` entirely (or leave it as shipped) and the engine stays on its single
global `config.provider = "claude"` path — zero behavior change.

---

## config.json schema

```json
{
  "providers": {
    "definitions": [
      {
        "name": "anthropic",
        "type": "claude"
      },
      {
        "name": "openrouter",
        "type": "openrouter",
        "baseURL": "https://openrouter.ai/api/v1",
        "apiKeyEnv": "OPENROUTER_API_KEY",
        "modelId": "openrouter/auto"
      },
      {
        "name": "custom",
        "type": "custom",
        "baseURL": "http://localhost:11434",
        "apiKeyEnv": "CUSTOM_LLM_API_KEY",
        "modelId": "llama3"
      }
    ],
    "roleMap": {
      "implementer": "anthropic",
      "reviewer":    "openrouter",
      "selector":    "anthropic",
      "auditor":     "openrouter",
      "architect":   "anthropic"
    }
  }
}
```

### `definitions[]` fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | ✅ | Unique identifier referenced by `roleMap`. |
| `type` | | Adapter type: `claude` / `openrouter` / `custom`. Defaults to `name` if omitted. |
| `baseURL` | | HTTP endpoint base URL. Required for `openrouter`/`custom`; ignored by `claude`. |
| `apiKeyEnv` | | Name of the env var holding the API key. **Secrets never live in config.json.** |
| `modelId` | | Explicit model ID that overrides the tier-based model resolution for this provider. |
| `default` | | `true` to use this provider when a role has no `roleMap` entry. |

### `roleMap` fields

Keys are agent role names (`implementer`, `reviewer`, `selector`, `auditor`, `architect`).
Values are `name` strings from `definitions[]`. Roles absent from `roleMap` fall back to the
global `config.provider`.

---

## Example: cheap review + audit via OpenRouter

```json
{
  "provider": "claude",
  "providers": {
    "definitions": [
      { "name": "anthropic", "type": "claude" },
      {
        "name": "openrouter",
        "type": "openrouter",
        "baseURL": "https://openrouter.ai/api/v1",
        "apiKeyEnv": "OPENROUTER_API_KEY",
        "modelId": "mistralai/mistral-nemo"
      }
    ],
    "roleMap": {
      "implementer": "anthropic",
      "reviewer":    "openrouter",
      "selector":    "anthropic",
      "auditor":     "openrouter",
      "architect":   "anthropic"
    }
  }
}
```

Set `OPENROUTER_API_KEY` in your environment. Reviewer and auditor calls go to Mistral Nemo
(cheap); implementer and selector keep using Anthropic.

---

## Example: fully local with Ollama

```json
{
  "provider": "custom",
  "providers": {
    "definitions": [
      {
        "name": "local",
        "type": "custom",
        "baseURL": "http://localhost:11434",
        "modelId": "qwen2.5-coder:32b"
      }
    ],
    "roleMap": {
      "implementer": "local",
      "reviewer":    "local",
      "selector":    "local",
      "auditor":     "local",
      "architect":   "local"
    }
  }
}
```

No `apiKeyEnv` needed — Ollama doesn't require auth. All roles use the local model.

---

## Model resolution order

For each agent role, `resolveModelForRole(role, tier, config)` resolves the model ID as follows:

1. `config.providers.definitions[roleMap[role]].modelId` — explicit per-provider override
2. `config.models[role]` — existing per-role model map (backward compat)
3. `adapter.resolveModel(tier, config)` — tier-based fallback (`strong`/`mid`/`cheap`/`premium`)

---

## Validation

`config-loader.mjs` validates at startup that every `roleMap` value references a defined
provider `name`. An invalid reference throws an error with the field path:

```
Invalid providers.roleMap in autopilot/config.json — 1 unknown provider(s):
  reviewer: "typo-name" is not in providers.definitions
Defined providers: anthropic, openrouter, custom
```
