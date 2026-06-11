# autopilot/config.json — Schema Reference

Full JSON Schema: [`autopilot/schema/config.schema.json`](../schema/config.schema.json)  
Schema draft: JSON Schema Draft-07

Run standalone validation (exit 0 = valid, 1 = invalid):

```bash
npm run validate-config
```

---

## Required fields

| Field | Type | Description |
|---|---|---|
| `model` | string | Default implementer model id (e.g. `claude-opus-4-8`). Overridden per-cycle by `implementerRouting`. |
| `models` | object | Named model ids for each engine role — see [models](#models). |
| `durationDays` | integer ≥ 1 | Total planned project duration in days. Controls scheduling horizons. |
| `phase` | string | Current project phase label (e.g. `hardening`, `building`, `shipping`). |
| `paths` | object | Project-agnostic root paths — see [paths](#paths). |
| `cli` | object | CLI wrapper configuration — see [cli](#cli). |
| `cycle` | object | Per-cycle pacing controls — see [cycle](#cycle). |
| `validation` | object | Project-specific validation commands — see [validation](#validation). |
| `git` | object | Git target configuration — see [git](#git). |

---

## Top-level fields (optional)

### `provider`
```json
"provider": "claude"
```
Active model provider id. Must match an adapter under `autopilot/lib/providers/`.  
Default: `"claude"`.

### `profile`
```json
"profile": "rushpoint"
```
Workspace profile name under `autopilot/profiles/`. Controls backlog seed, task filters, and goal phases.

### `architectModel`
```json
"architectModel": "claude-fable-5"
```
Model id used by the Architect stage when decomposing a macro-vision task.

---

## `models`

Required sub-fields: `selector`, `reviewer`, `auditor`, `implementerHigh`, `implementerLow`.

```json
"models": {
  "selector":          "claude-haiku-4-5",
  "reviewer":          "claude-sonnet-4-6",
  "auditor":           "claude-haiku-4-5",
  "architect":         "claude-fable-5",
  "implementerHigh":   "claude-opus-4-8",
  "implementerLow":    "claude-sonnet-4-6",
  "implementerLowest": "claude-haiku-4-5"
}
```

| Field | Required | Description |
|---|---|---|
| `selector` | yes | Model for the task-selection stage. |
| `reviewer` | yes | Model for the review stage. |
| `auditor` | yes | Model for the audit stage. |
| `implementerHigh` | yes | High-tier model for risky/complex tasks. |
| `implementerLow` | yes | Mid-tier model for standard tasks. |
| `architect` | no | Model for Architect decomposition (falls back to `architectModel`). |
| `implementerLowest` | no | Cheapest fallback model when the budget governor downgrades. |

---

## `architect`

Controls the Architect-mode decomposition stage.

```json
"architect": {
  "enabled": true,
  "autoTrigger": true,
  "minTasks": 20,
  "maxTasks": 40
}
```

| Field | Type | Description |
|---|---|---|
| `enabled` | boolean | Enable/disable Architect mode. |
| `autoTrigger` | boolean | Auto-decompose detected macro-vision inbox tasks. |
| `minTasks` | integer ≥ 1 | Minimum sub-tasks the Architect must produce. |
| `maxTasks` | integer ≥ 1 | Maximum sub-tasks the Architect may produce. |

---

## `api_pools`

Stage 1 key pool for load balancing across multiple API accounts. Secrets live in env vars, never here.

```json
"api_pools": [
  {
    "id": "primary",
    "provider": "anthropic",
    "key_env": "ANTHROPIC_API_KEY_1",
    "status": "active",
    "daily_budget": 10,
    "current_usage": 0,
    "retry_after": null
  }
]
```

| Field | Required | Type | Valid values | Description |
|---|---|---|---|---|
| `id` | yes | string | — | Unique entry identifier. |
| `provider` | yes | string | `anthropic`, `openrouter`, `openai` | Provider name. |
| `key_env` | yes | string | — | Name of the env var holding the API token. |
| `status` | no | string | `active`, `exhausted`, `rate-limited` | Current key status. Default: `active`. |
| `daily_budget` | no | number ≥ 0 | — | Per-day USD cap; `0` = uncapped. |
| `current_usage` | no | number ≥ 0 | — | Tracked usage (updated by the engine at runtime). |
| `retry_after` | no | string \| null | ISO 8601 | Date-time after which to retry; `null` = retry now. |

Empty array `[]` = single pinned-account mode (no rotation).

---

## `keyRotation`

Tuning for the key-rotation wrapper (`lib/key-manager.mjs`).

```json
"keyRotation": {
  "enabled": true,
  "maxRetries": 3,
  "defaultCooldownMs": 60000,
  "providerMap": { "claude": "anthropic" }
}
```

| Field | Type | Description |
|---|---|---|
| `enabled` | boolean | Enable key rotation. Active only when a pool entry with a resolvable env token exists. |
| `maxRetries` | integer ≥ 0 | Key rotations per call before surfacing `AllKeysExhaustedError`. |
| `defaultCooldownMs` | integer ≥ 0 | Fallback cooldown (ms) when a 429 carries no `retry-after` header. |
| `providerMap` | object | Maps adapter id to pool `provider` name (e.g. `{ "claude": "anthropic" }`). |

---

## `implementerRouting`

Risk-aware model routing for the implementer stage.

```json
"implementerRouting": {
  "opusMinRisk": 3,
  "opusKeywords": ["security", "schema", "migration", "scoring"]
}
```

| Field | Type | Description |
|---|---|---|
| `opusMinRisk` | integer ≥ 0 | Minimum risk score that routes to `models.implementerHigh`. |
| `opusKeywords` | string[] | Task-title keywords that force the high-tier model regardless of risk. |

---

## `scoring`

Scoring weights and bonuses for task prioritisation.

```json
"scoring": {
  "weights": { "userImpact": 5, "adminImpact": 3, "reliability": 3, "productRisk": 2, "cleanupValue": 1 },
  "categoryBonus": { "stations": 12, "gameplay": 6, "ui": 6, "reliability": 1 },
  "minProductShare": 0.7,
  "minProductTasks": 5,
  "maxAttemptsBeforeBlock": 3,
  "maxReviewFailAttempts": 2
}
```

| Field | Type | Constraints | Description |
|---|---|---|---|
| `weights` | object | values are numbers | Dimension weights (userImpact, adminImpact, reliability, …). |
| `categoryBonus` | object | values are numbers | Per-category score bonus map. |
| `minProductShare` | number | 0–1 | Minimum fraction of selected tasks that must be product-class. |
| `minProductTasks` | integer ≥ 0 | — | Minimum absolute count of product-class tasks in selection. |
| `maxAttemptsBeforeBlock` | integer ≥ 1 | — | Attempts before a task is blocked. |
| `maxReviewFailAttempts` | integer ≥ 1 | — | Allowed review failures before a task is escalated. |

---

## `paths`

Project-agnostic root paths. `appRoot` is required; all others default to RushPoint layout.

```json
"paths": {
  "appRoot": ".",
  "appsDir": "apps",
  "functionsDir": "functions",
  "packagesDir": "packages",
  "scriptsDir": "scripts",
  "queues": {
    "inboxDir": "inbox",
    "stateDir": "state",
    "handoffDir": "state/handoff"
  }
}
```

| Field | Required | Description |
|---|---|---|
| `appRoot` | yes | Repo root, relative to the `autopilot/` parent directory. Use `"."` for the monorepo root. |
| `appsDir` | no | Apps directory, relative to `appRoot`. Default: `"apps"`. |
| `functionsDir` | no | Cloud Functions directory. Default: `"functions"`. |
| `packagesDir` | no | Shared packages directory. Default: `"packages"`. |
| `scriptsDir` | no | Scripts directory. Default: `"scripts"`. |
| `queues.inboxDir` | no | Inbox queue directory, relative to `autopilot/`. Default: `"inbox"`. |
| `queues.stateDir` | no | State/backlog directory, relative to `autopilot/`. Default: `"state"`. |
| `queues.handoffDir` | no | Handoff JSON directory, relative to `autopilot/`. Default: `"state/handoff"`. |

---

## `cli`

CLI wrapper configuration for invoking the model provider.

```json
"cli": {
  "bin": "claude",
  "outputFormat": "json",
  "permission": "--dangerously-skip-permissions",
  "timeoutMs": 1800000,
  "maxTurnsPerCall": 60
}
```

| Field | Required | Type | Valid values | Description |
|---|---|---|---|---|
| `bin` | yes | string | — | CLI binary name (e.g. `claude`). |
| `outputFormat` | yes | string | `json`, `text` | Output format expected from the CLI. |
| `timeoutMs` | yes | integer ≥ 0 | — | Timeout per CLI call in milliseconds. |
| `maxTurnsPerCall` | yes | integer ≥ 1 | — | Max conversation turns per CLI invocation. |
| `permission` | no | string | — | Permission flag passed to the CLI. |

---

## `cycle`

Per-cycle pacing and backlog top-up controls.

```json
"cycle": {
  "maxReviseAttempts": 2,
  "cooldownBetweenCyclesMs": 120000,
  "backlogTopUpThreshold": 4
}
```

| Field | Required | Type | Description |
|---|---|---|---|
| `maxReviseAttempts` | yes | integer ≥ 0 | Maximum revision passes before a task is failed. |
| `cooldownBetweenCyclesMs` | yes | integer ≥ 0 | Minimum gap between cycle starts (milliseconds). |
| `backlogTopUpThreshold` | yes | integer ≥ 0 | Minimum backlog depth before top-up is triggered. |

---

## `rateLimit`

Exponential back-off bounds for rate-limit handling.

```json
"rateLimit": {
  "baseCooldownMs": 1200000,
  "maxCooldownMs": 2700000
}
```

| Field | Type | Description |
|---|---|---|
| `baseCooldownMs` | integer ≥ 0 | Initial cooldown on a 429 response (milliseconds). |
| `maxCooldownMs` | integer ≥ 0 | Cap for exponential back-off cooldown (milliseconds). |

---

## `taskClasses`

Task taxonomy that gates selection and review by class.

```json
"taskClasses": {
  "default": "product",
  "map": {},
  "policy": {}
}
```

| Field | Type | Valid values | Description |
|---|---|---|---|
| `default` | string | `product`, `engine`, `maintenance`, `migration` | Class for tasks that cannot be classified from title/goal. |
| `map` | object | string values | Goal/prefix → class overrides. |
| `policy` | object | — | Per-class gate policy overrides. |

---

## `budgetGovernor`

Deterministic pre-cycle budget gate (`lib/budget-governor.mjs`). Runs before each cycle — no LLM involved.

```json
"budgetGovernor": {
  "enabled": true,
  "weeklyTokenQuota": null,
  "reserveFraction": 0.10,
  "safetyMargin": 0.15,
  "retryBuffer": 1.50,
  "hardStopFraction": 0.95,
  "downgradeFraction": 0.80,
  "minCycleTokens": 50000,
  "safeMode": true,
  "safeReserveFraction": 0.25,
  "safeDowngradeFraction": 0.50,
  "safeHardStopFraction": 0.75
}
```

| Field | Type | Description |
|---|---|---|
| `enabled` | boolean | Enable/disable the governor. `false` skips all budget checks. |
| `weeklyTokenQuota` | integer \| null | Total weekly token quota Q; `null` = derive from per-project cap or unlimited. |
| `reserveFraction` | number 0–1 | Fraction of Q withheld as reserve. |
| `safetyMargin` | number ≥ 0 | Multiplier added to the average cycle cost estimate. |
| `retryBuffer` | number ≥ 1 | Extra multiplier accounting for retry overhead. |
| `hardStopFraction` | number 0–1 | Halt immediately when spent ≥ Q × this fraction. |
| `downgradeFraction` | number 0–1 | Switch to cheaper models when projected spend > usable × this. |
| `minCycleTokens` | integer ≥ 0 | Floor for the per-cycle token estimate. |
| `safeMode` | boolean | Engage tighter reserve/downgrade fractions when quota is unknown. |
| `safeReserveFraction` | number 0–1 | Reserve fraction used in safe mode. |
| `safeDowngradeFraction` | number 0–1 | Downgrade threshold used in safe mode. |
| `safeHardStopFraction` | number 0–1 | Hard-stop threshold used in safe mode. |

---

## `circuitBreaker`

Engine safety halt — trips the STOP flag when consecutive failure thresholds are exceeded.

```json
"circuitBreaker": {
  "enabled": true,
  "maxConsecutiveFailures": 5,
  "maxConsecutiveRateLimits": 8,
  "maxConsecutiveUnproductive": 12,
  "maxWindowCostUsd": null
}
```

| Field | Type | Description |
|---|---|---|
| `enabled` | boolean | Enable/disable the circuit breaker. |
| `maxConsecutiveFailures` | integer ≥ 0 | Back-to-back crash cycles before tripping. |
| `maxConsecutiveRateLimits` | integer ≥ 0 | Back-to-back rate-limit hits before tripping. |
| `maxConsecutiveUnproductive` | integer ≥ 0 | Back-to-back non-merge cycles before tripping. |
| `maxWindowCostUsd` | number \| null | Window spend ceiling in USD; `null` = disabled. |

Reset after fixing the cause: `node autopilot/supervisor.mjs reset-breaker`.

---

## `weeklyBudget`

Weekly pacing governor — spreads cycle starts evenly toward the reset date.

```json
"weeklyBudget": {
  "enabled": true,
  "resetAt": "2026-06-10T22:00:00.000Z",
  "resetIntervalDays": 7,
  "maxCyclesPerDay": 200,
  "velocitySensitivity": 1.0
}
```

| Field | Type | Description |
|---|---|---|
| `enabled` | boolean | Enable/disable the weekly pacing governor. |
| `resetAt` | string (ISO 8601) | Date-time of the next weekly window reset. |
| `resetIntervalDays` | integer ≥ 1 | Days between window resets. |
| `maxCyclesPerDay` | integer ≥ 0 | Maximum cycle starts allowed per calendar day. |
| `velocitySensitivity` | number ≥ 0 | Multiplier on velocity-based pacing (1.0 = default). |

---

## `budgets`

Per-project token budgets. Keys are projectId slugs (repo + branch suffix).

```json
"budgets": {
  "rushpoint-kinetic-topo": {
    "maxTokensPerCycle": 80000000,
    "maxSpendPerEvent": 500
  }
}
```

| Field | Type | Description |
|---|---|---|
| `maxTokensPerCycle` | number ≥ 0 | Cumulative token cap for the current pacing window. |
| `maxSpendPerEvent` | number ≥ 0 | Per-event USD ceiling (reserved for forward use). |

Keys prefixed with `_` are treated as documentation comments and ignored by the engine.

---

## `validation`

Project-specific validation commands. Lives in config, not engine code. Required: `commands`.

```json
"validation": {
  "commands": [
    { "name": "typecheck", "cmd": "npm run typecheck", "required": true,  "timeoutMs": 600000 },
    { "name": "build-admin","cmd": "npm run build --workspace=apps/admin", "required": true, "timeoutMs": 600000 },
    { "name": "lint",       "cmd": "npm run lint",      "required": false, "timeoutMs": 600000 }
  ],
  "lintRegressionGuard": true,
  "e2e": { "enabled": false, "cmd": "node scripts/e2e-verify.mjs", "timeoutMs": 600000 }
}
```

### `commands` items

| Field | Required | Type | Description |
|---|---|---|---|
| `name` | yes | string | Unique command identifier (e.g. `typecheck`). |
| `cmd` | yes | string | Shell command to execute. |
| `required` | no | boolean | `true` = failing this command fails the cycle. |
| `timeoutMs` | no | integer ≥ 0 | Per-command timeout in milliseconds. |

### Other `validation` fields

| Field | Type | Description |
|---|---|---|
| `lintRegressionGuard` | boolean | Fail the cycle when the lint error count increases vs the baseline. |
| `e2e.enabled` | boolean | Enable the e2e test command. |
| `e2e.cmd` | string | Shell command for e2e tests. |
| `e2e.timeoutMs` | integer ≥ 0 | Timeout for the e2e command. |

---

## `telemetry`

Engine health/metrics telemetry (`lib/telemetry.mjs`). `enabled: false` = no-op.

```json
"telemetry": {
  "enabled": true,
  "endpoint": null,
  "batchSize": 50,
  "flushIntervalMs": 60000
}
```

| Field | Type | Description |
|---|---|---|
| `enabled` | boolean | Enable telemetry. `false` makes every recorder a no-op. |
| `endpoint` | string \| null | HTTP endpoint to POST batched events; `null` = local buffer only. |
| `batchSize` | integer ≥ 1 | Number of events per HTTP POST batch. |
| `flushIntervalMs` | integer ≥ 0 | Interval between flush attempts (milliseconds). |

---

## `git`

Git target configuration (`lib/git-config-loader.mjs`). Required: `integrationBranch`, `baseBranch`, `commitPrefix`.

```json
"git": {
  "integrationBranch": "autopilot/topo",
  "baseBranch": "topographic-maps",
  "commitPrefix": "kinetic"
}
```

| Field | Required | Type | Description |
|---|---|---|---|
| `integrationBranch` | yes | string | Branch all reviewed work lands on. |
| `baseBranch` | yes | string | Branch the integration branch forks from. |
| `commitPrefix` | yes | string | Auto-commit message prefix (e.g. `kinetic`). |
| `repository` | no | string | Path to the target repo, relative to the autopilot/ parent, or absolute. Default: `.`. |
| `branch` | no | string | Active branch override. |
| `worktreeName` | no | string | Git worktree name for isolated target-repo management. |

See [git-config.md](git-config.md) for advanced multi-repo usage.

---

## `contextProvider`

External codebase-context seam (`core/context-provider.mjs`). `enabled: false` = local analysis only.

```json
"contextProvider": {
  "enabled": false,
  "interface": "core/context-provider.mjs#ContextProviderInterface",
  "source": "",
  "cacheStrategy": "memory",
  "validateFreshness": true,
  "maxStaleMs": 300000,
  "fallbackToLocal": true
}
```

| Field | Type | Valid values | Description |
|---|---|---|---|
| `enabled` | boolean | — | Enable/disable the external context seam. |
| `interface` | string | — | Contract module#export the host implements. |
| `source` | string | — | Provider/codebase id, used as the cache key. |
| `cacheStrategy` | string | `memory`, `none` | How to cache a loaded context bundle. |
| `validateFreshness` | boolean | — | Reject maps older than `maxStaleMs`. |
| `maxStaleMs` | integer ≥ 0 | — | Freshness window (milliseconds). Default: 300000 (5 min). |
| `fallbackToLocal` | boolean | — | Fall back to local file-system analysis when context is unavailable. |

See [context-provider.md](context-provider.md) for the full interface contract.

---

## `handoff`

Per-role handoff file context tag (`lib/handoff-paths.mjs`).

```json
"handoff": {
  "context": "rushpoint-kinetic-topo"
}
```

| Field | Type | Description |
|---|---|---|
| `context` | string | Tag inserted into handoff filenames to isolate concurrent project contexts (e.g. `selection-rushpoint-kinetic-topo.json`). |

---

## `locks`

Process-lock filenames (`lib/lock-manager.mjs`). `{repoGoal}` is expanded at runtime.

```json
"locks": {
  "watchdog":  "{repoGoal}.watchdog.lock",
  "supervisor":"{repoGoal}.supervisor.lock"
}
```

| Field | Type | Description |
|---|---|---|
| `watchdog` | string | Lock filename template for the watchdog process. |
| `supervisor` | string | Lock filename template for the supervisor process. |
| `repoGoal` | string | Optional override for the derived `repo+goal` segment. |

---

## Comment keys (`_*`)

Any key at any level that starts with `_` is a documentation comment. The schema allows these throughout via `patternProperties: { "^_": {} }`. They are stripped before processing and never treated as config values.

Example:
```json
{
  "_provider_comment": "Set to 'claude' for the Anthropic CLI adapter.",
  "provider": "claude"
}
```

---

## Annotated minimal example

```json
{
  "provider": "claude",
  "model": "claude-opus-4-8",
  "models": {
    "selector": "claude-haiku-4-5",
    "reviewer": "claude-sonnet-4-6",
    "auditor": "claude-haiku-4-5",
    "implementerHigh": "claude-opus-4-8",
    "implementerLow": "claude-sonnet-4-6"
  },
  "durationDays": 30,
  "phase": "building",
  "paths": {
    "appRoot": ".",
    "queues": {
      "inboxDir": "inbox",
      "stateDir": "state",
      "handoffDir": "state/handoff"
    }
  },
  "cli": {
    "bin": "claude",
    "outputFormat": "json",
    "timeoutMs": 1800000,
    "maxTurnsPerCall": 60
  },
  "cycle": {
    "maxReviseAttempts": 2,
    "cooldownBetweenCyclesMs": 120000,
    "backlogTopUpThreshold": 4
  },
  "validation": {
    "commands": [
      { "name": "typecheck", "cmd": "npm run typecheck", "required": true, "timeoutMs": 600000 }
    ]
  },
  "git": {
    "integrationBranch": "my-project/main",
    "baseBranch": "main",
    "commitPrefix": "kinetic"
  }
}
```

---

## Troubleshooting common validation errors

| Error | Cause | Fix |
|---|---|---|
| `(root): must have required property 'model'` | Missing required top-level field. | Add the `model` field with a valid model id string. |
| `.cli.outputFormat: must be equal to one of the allowed values` | Invalid `outputFormat`. | Set to `"json"` or `"text"`. |
| `.api_pools[0].provider: must be equal to one of the allowed values` | Unknown provider. | Use `"anthropic"`, `"openrouter"`, or `"openai"`. |
| `.taskClasses.default: must be equal to one of the allowed values` | Invalid class. | Use `"product"`, `"engine"`, `"maintenance"`, or `"migration"`. |
| `.paths: must NOT have additional properties` | Unknown key in `paths`. | Prefix documentation keys with `_` (e.g. `"_comment": "…"`). |
| `.validation.commands[0]: must have required property 'name'` | Command entry missing `name` or `cmd`. | Add both `"name"` and `"cmd"` to each command object. |
| `config-validator: ajv or schema unavailable — validation skipped.` | `ajv` is not installed. | Run `npm install` at the repo root. |

Run `npm run validate-config` at any time to get a full list of violations with field paths and constraint descriptions.
