# Autopilot Engine — Integration Guide

This guide covers everything a third-party project needs to adopt the autopilot engine:
bundle architecture, third-party project setup, plugin authoring, and the commercial feature-flag
reference.

---

## 1. Bundle architecture

The engine is split into four independently distributable layers:

```
autopilot/
│
├── core/               ← OPEN-SOURCE: project-agnostic agent-workflow engine
│   ├── index.mjs       ← createCore({...}) — the only required entry-point for hosts
│   ├── runtime.mjs     ← renderPrompt / extractJsonObject / createRoleRunner
│   ├── selector/       ← SELECT workflow
│   ├── implementer/    ← IMPLEMENT workflow
│   ├── reviewer/       ← REVIEW workflow
│   ├── auditor/        ← AUDIT workflow
│   └── architect/      ← Stage-2 Architect Mode (macro-vision decomposition)
│
├── lib/                ← OPEN-SOURCE: engine utilities
│   ├── state.mjs       ← state.json (atomic load/save, two-tier schema)
│   ├── claude.mjs      ← runs `claude -p`, parses JSON, detects rate limits
│   ├── git.mjs         ← branch / commit / merge helpers
│   ├── validate.mjs    ← runs typecheck / lint / e2e
│   ├── providers/      ← model-provider adapters (claude / openrouter / custom)
│   ├── bundle-variants.mjs ← active bundle-variant detection (U-44)
│   └── …               ← budget-governor, circuit-breaker, key-manager, telemetry …
│
├── shared/             ← OPEN-SOURCE: universal type contracts
│   └── types.mjs       ← ContextProviderInterface, TASK_CLASS, PROVIDER_TYPE
│
├── plugins/            ← OPEN-SOURCE: reusable, project-agnostic extension modules
│   └── (add adapters here — see Plugin Authoring below)
│
├── templates/          ← OPEN-SOURCE: example configurations for third-party projects
│   └── typescript-starter/  ← minimal working TypeScript project config (copy-paste start)
│
├── commercial/         ← PRIVATE: project-specific deployment bindings
│   └── config.json     ← your project config (model IDs, validation commands, git targets …)
│
└── profiles/           ← workspace profiles (one per project)
    ├── generic.json    ← blank profile (use for new projects)
    └── <your-project>.json
```

`bundle-manifest.json` at the root formally declares the two variants and the feature-flag
registry. `lib/bundle-variants.mjs` reads it at runtime to detect the active variant and is
re-exported from `config-loader.mjs` for any module that needs it.

---

## 2. Setting up for a third-party project

### Step 1 — Copy the starter template

```powershell
# From the repo root (the autopilot/ parent):
cp autopilot/templates/typescript-starter/config.json  autopilot/commercial/config.json
cp autopilot/templates/typescript-starter/profile.json autopilot/profiles/my-project.json
```

### Step 2 — Edit `commercial/config.json`

Required fields to change:

| Field | What to set |
|---|---|
| `profile` | Name of your profile file without the `.json` extension (e.g. `"my-project"`) |
| `paths.appRoot` | Your project root relative to the `autopilot/` parent (usually `"."`) |
| `validation.commands` | Your typecheck / build / lint commands |
| `git.integrationBranch` | The branch where reviewed work lands (e.g. `"main"`) |
| `git.baseBranch` | The branch the engine forks cycle-branches from (usually `integrationBranch`) |
| `git.commitPrefix` | Prefix for auto-generated commit messages (e.g. `"kinetic"`) |

Optional — leave as-is or tune later:

| Field | Default | Purpose |
|---|---|---|
| `models.*` | Sonnet/Haiku defaults | Model IDs per agent role |
| `budgetGovernor.enabled` | `false` | Token-spend gate before each cycle |
| `circuitBreaker.enabled` | `true` | Safety halt on consecutive failures |
| `cycle.cooldownBetweenCyclesMs` | `60000` | Pause between cycles (ms) |
| `durationDays` | `7` | How many days before the loop self-terminates |

### Step 3 — Edit `profiles/my-project.json`

| Field | What to set |
|---|---|
| `id` | Unique profile id (matches the filename) |
| `label` | Human-readable project name |
| `goalPhases` | Ordered list of goal phase names the selector cycles through |
| `promptProfile` | Project-specific conventions appended to every implementer prompt |
| `seed` | Initial backlog tasks (can be empty `[]`; add tasks via `inbox/` instead) |

### Step 4 — Initialise and run

```powershell
node autopilot/supervisor.mjs init   # seeds state/ from the profile's seed backlog
node autopilot/supervisor.mjs run    # starts the autonomous loop
```

Config resolution: `config-loader.mjs` prefers `commercial/config.json` when it exists; it falls
back to `config.json` at the root. Existing setups using the root file keep working unchanged.

---

## 3. Plugin authoring

Plugins live in `autopilot/plugins/` and are registered in `commercial/config.json`. Each plugin
is a self-contained directory with an `index.mjs` entry point.

### Plugin types

#### 3a. Model provider adapter

Adds support for a new LLM provider (anything beyond the built-in `claude`, `openrouter`, and
`custom` adapters).

```
autopilot/plugins/my-provider/
├── index.mjs       ← implements the ProviderAdapter interface
└── README.md
```

**`index.mjs` contract** (matches `lib/providers/` built-in adapters):

```js
// plugins/my-provider/index.mjs
export const type = 'my-provider';  // must match the `type` field in config providers.definitions

/**
 * @param {{ baseURL: string, apiKeyEnv: string, modelId: string }} def
 * @param {{ prompt: string, model: string, cwd: string, config: object, label: string }} callOpts
 * @returns {Promise<{ result: string, usage: { inputTokens, outputTokens, costUsd } }>}
 */
export async function invoke(def, callOpts) {
  // ... call your provider API and return result + usage
}
```

**Register in `commercial/config.json`:**

```json
{
  "providers": {
    "definitions": [
      {
        "name": "my-provider",
        "type": "my-provider",
        "baseURL": "https://api.my-provider.com/v1",
        "apiKeyEnv": "MY_PROVIDER_API_KEY",
        "modelId": "my-model-id"
      }
    ],
    "roleMap": {
      "reviewer": "my-provider"
    }
  }
}
```

Call `registerAdapter` (exported from `lib/providers/index.mjs`) to register your adapter at
startup, **before** the supervisor starts its first cycle. The registry is synchronous; an unknown
provider id throws immediately, so registration must happen at boot time.

**Boot wiring example:**

```js
import { registerAdapter } from './autopilot/lib/providers/index.mjs';
import myAdapter from './autopilot/plugins/my-provider/index.mjs';
registerAdapter(myAdapter); // register before starting the supervisor
```

#### 3b. Context-provider plugin

Pre-computes codebase indexes (file index, symbol index, dependency graph) so the selector skips
redundant local file scanning. Useful when the host already has a language server or index service.

**`index.mjs` contract** (implements `ContextProviderInterface` from `shared/types.mjs`):

```js
// plugins/my-context-provider/index.mjs
import { TASK_CLASS } from '../../shared/types.mjs';  // example import from shared/

/**
 * Must implement all four methods of ContextProviderInterface.
 */
export async function getFileIndex()       { /* → Array<FileIndexMap> */      }
export async function getSymbolIndex()     { /* → Array<SymbolIndexMap> */    }
export async function getDependencyGraph() { /* → DependencyGraph */          }
export async function isFresh()            { /* → boolean — staleness check */}
```

**Register in `commercial/config.json`:**

```json
{
  "contextProvider": {
    "enabled": true,
    "source": "my-context-provider",
    "cacheStrategy": "memory",
    "validateFreshness": true,
    "maxStaleMs": 300000,
    "fallbackToLocal": true
  }
}
```

Import the plugin and pass it as `contextProvider` (or `contextMaps`) when invoking the selector.
`source` is used as a **cache key** in `core/context-provider.mjs` — it is not a file path and
the module does not auto-discover plugins from disk. When `ok: false` is returned (provider error
or stale data), the caller should fall back to local file-system analysis (`fallbackToLocal: true`
is the advisory flag for the host to honour this convention).

**Boot wiring example:**

```js
import { loadContextMaps } from './autopilot/core/context-provider.mjs';
import myContextPlugin from './autopilot/plugins/my-context-provider/index.mjs';
// pass the provider object directly; core/context-provider.mjs validates + caches it
const ctx = await loadContextMaps({ provider: myContextPlugin, validateFreshness: true });
if (ctx.ok) { /* use ctx.maps */ }
```

#### 3c. Custom scoring / priority plugin

The selector's task ranking uses the formula in `lib/score.mjs`. To override the ranking without
touching engine code, export a `scoreTask` function from a plugin and register it:

```js
// plugins/my-scorer/index.mjs
/**
 * @param {object} task   — the raw task object from state.json
 * @param {object} state  — current engine state (flat view)
 * @param {object} config — resolved engine config
 * @returns {number}      — numeric score (higher = selected sooner)
 */
export function scoreTask(task, state, config) {
  // Custom scoring logic here
  return task.dims.userImpact * 10;
}
```

Register in `commercial/config.json` by adding a `scoring.plugin` key:

```json
{
  "scoring": {
    "plugin": "plugins/my-scorer/index.mjs"
  }
}
```

### Plugin conventions

- Plugins **must not** import from `../commercial/` — they must be free of project-specific secrets
  and deployable independently.
- Plugins **may** import from `../core/`, `../lib/`, and `../shared/`.
- Each plugin should include a `README.md` that describes its interface and config keys.

---

## 4. Feature flags for commercial components

All feature flags are declared in `autopilot/bundle-manifest.json` and queryable at runtime via
`lib/bundle-variants.mjs`:

```js
import { isFeatureAvailable, activeBundleVariant } from './config-loader.mjs';

if (isFeatureAvailable('budgetGovernor')) {
  // safe to use budget-governor features
}
console.log(activeBundleVariant); // 'core' | 'commercial'
```

### Flag reference

| Flag | Available in | Config key | Description |
|---|---|---|---|
| `multiWorkspace` | core + commercial | `workspaces` | Multiple workspace targets via `workspaces.json` |
| `budgetGovernor` | core + commercial | `budgetGovernor.enabled` | Pre-cycle token-spend gate |
| `keyPooling` | core + commercial | `api_pools` | API key pool rotation |
| `architectMode` | core + commercial | `architect.enabled` | Macro-vision decomposition via premium tier |
| `contextProvider` | core + commercial | `contextProvider.enabled` | External codebase-context seam |
| `providerRouting` | core + commercial | `providers` | Per-role LLM provider routing |
| `commercialProfile` | **commercial only** | `profile` | Project-specific workspace profile with curated seed + filters |

The `commercialProfile` flag is the only commercial-only flag. All other flags are available in
both bundle variants and are controlled purely by their config keys (set the key → feature is
active; omit or set `enabled: false` → feature is off, engine keeps current behavior).

### Enabling a feature

All flags follow the same pattern: add or update the flag's `configKey` in `commercial/config.json`
(or the root `config.json`). No code changes are needed.

Example — enable the budget governor:

```json
{
  "budgetGovernor": {
    "enabled": true,
    "weeklyTokenQuota": 500000,
    "reserveFraction": 0.10
  }
}
```

---

## 5. Verifying and assembling the bundle layout

```powershell
# Print active bundle variant + all resolved config paths
node autopilot/config-loader.mjs

# Expected output (commercial variant):
#   bundle-variant=commercial (commercial/config.json present)
#   config-loaded paths from config.json → appRoot=. apps=apps functions=functions …
#   config-loaded validation from config.json → [typecheck, build-admin?, lint?] …
#   …

# Dry-run: list which files would be included in the core-only bundle
node autopilot/build.mjs --variant core --dry-run

# Assemble the core-only distributable into autopilot/dist/core/
node autopilot/build.mjs --variant core

# Assemble the full commercial bundle
node autopilot/build.mjs --variant commercial

# Custom output directory
node autopilot/build.mjs --variant core --out /tmp/my-core-bundle
```

`build.mjs` reads `bundle-manifest.json` to determine which files belong to each variant
(`include`/`exclude` glob patterns) and copies them to the output directory. The `dist/` and
`state/` directories are always excluded regardless of patterns — they are runtime artefacts,
not distribution content.

---

## 6. Related docs

| Doc | Contents |
|---|---|
| `autopilot/docs/ARCHITECTURE.md` | Two-tier state schema (framework vs target tiers) |
| `autopilot/docs/PROVIDER_CONFIG.md` | Full provider-routing examples (OpenRouter, custom endpoint) |
| `autopilot/docs/context-provider.md` | Context-provider plugin protocol in depth |
| `autopilot/docs/budget-routing-providers.md` | Budget governor + key-pool rotation reference |
| `autopilot/docs/git-config.md` | Git target config (external repo, worktree mode) |
| `autopilot/core/README.md` | Core engine module map and host usage API |
| `autopilot/README.md` | Supervisor design, CLI, start/stop/resume |
