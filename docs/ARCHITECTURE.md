# Kinetic Autopilot — State Schema Architecture

`autopilot/state/state.json` is the single source of truth for the autonomous loop. From schema
**v3** it is split into two independent tiers: **framework** (the reusable kinetic engine) and
**target** (the project currently being improved). This separation is what makes the engine
portable across multiple projects.

> The split exists **on disk only**. In memory the supervisor works with a single *flat* object
> (behavior-preserving): `loadState()` merges the tiers back to flat at read time, and
> `saveState()` splits the flat object at the disk boundary. No existing behavioral code needed
> to change; the architecture is transparent to callers.

---

## Two-tier overview

| Tier | Key | Owns | Conceptual groups |
|---|---|---|---|
| **framework** | `framework` | Engine-owned, project-agnostic loop state. | `tokenCounters`, `processLocks`, `budgetingState`, `telemetryLogs`, `engineMetrics` |
| **target** | `target` | Project-specific work data. | `goals`, `phases`, `taskCategories`, `customizations` |

The rule of thumb: `APP_KEYS` in `lib/state.mjs` lists every key that belongs to the target tier
(`queues`, `stats`, `history`, `goalPhase`). Every other top-level key defaults to the framework
tier and round-trips losslessly.

---

## Framework tier — conceptual groups

| Group | Fields | Purpose |
|---|---|---|
| `tokenCounters` | `usage.calls`, `usage.inputTokens`, `usage.outputTokens`, `usage.cacheReadTokens`, `usage.cacheCreationTokens`, `usage.costUsd`, `tokenSpent` | Per-window and per-project token spend tracking. |
| `processLocks` | `status`, `rateLimit`, `current` | Execution state of the supervisor loop (running/paused/idle) and the currently-active task slot. |
| `budgetingState` | `usage.windowResetAt`, `usage.windowStartedAt`, `usage.lastCycleAt`, `usage.velocityFactor` | Weekly budget window and adaptive cadence throttle. |
| `telemetryLogs` | `telemetry.events`, `telemetry.metrics`, `telemetry.errorCount`, `telemetry.lastFlush` | Decoupled engine telemetry (populated by `lib/telemetry.mjs`). |
| `engineMetrics` | `version`, `startedAt`, `deadlineAt`, `lastUpdated`, `cycle`, `usage.cycles` | Engine lifecycle and operational metrics. |

---

## Target tier — conceptual groups

| Group | Fields | Purpose |
|---|---|---|
| `phases` | `goalPhase` | Current goal phase driving the selector's ranking strategy. |
| `taskCategories` | `queues` (backlog / done / blocked) | All task queues for this project. |
| `goals` | `goals` *(optional)* | Explicit goal-type definitions beyond the default `GOAL_PHASES`. |
| `customizations` | `customizations` *(optional)*, `taskCategories` *(optional)*, `phases` *(optional)* | Project-level overrides for selector hints, routing preferences, and scoring. |
| *(project metrics)* | `stats`, `history` | Per-project run counters and compact cycle history. |

---

## On-disk shape (v3)

```jsonc
{
  "schemaVersion": 3,
  "framework": {
    "version": 1,
    "startedAt": "2026-06-02T20:57:10.951Z",
    "deadlineAt": "2036-05-30T21:08:26.453Z",
    "lastUpdated": "2026-06-11T12:00:00.000Z",
    "cycle": 164,
    "status": "running",
    "rateLimit": { "pausedUntil": null, "consecutiveHits": 0 },
    "current": null,
    "usage": {
      "windowResetAt": "2026-06-15T00:00:00.000Z",
      "windowStartedAt": "2026-06-08T00:00:00.000Z",
      "lastCycleAt": "2026-06-11T11:55:00.000Z",
      "velocityFactor": 1.0,
      "cycles": 12, "calls": 48,
      "inputTokens": 1200000, "outputTokens": 180000,
      "cacheReadTokens": 900000, "cacheCreationTokens": 60000,
      "costUsd": 4.32
    },
    "tokenSpent": {
      "rushpoint-architecture": { "inputTokens": 250000, "outputTokens": 40000, "costUsd": 0.92 }
    },
    "telemetry": { "events": [], "metrics": {}, "errorCount": 0, "lastFlush": null }
  },
  "target": {
    "goalPhase": "structure",
    "queues": {
      "backlog": [ /* Task objects */ ],
      "done":    [ /* Task objects */ ],
      "blocked": []
    },
    "stats": { "cyclesRun": 164, "completed": 52, "blocked": 8, "revisions": 24, "rateLimitPauses": 3 },
    "history": [
      { "cycle": 163, "taskId": "U-28", "title": "…", "outcome": "merged", "ts": "2026-06-11T11:00:00.000Z" }
    ]
  }
}
```

## In-memory shape (flat — what the supervisor mutates)

```jsonc
{
  "version": 1, "startedAt": "…", "deadlineAt": "…", "lastUpdated": "…",
  "cycle": 164, "status": "running",
  "rateLimit": { "pausedUntil": null, "consecutiveHits": 0 },
  "current": null,
  "usage": { "windowResetAt": "…", "cycles": 12, "costUsd": 4.32, /* … */ },
  "tokenSpent": { /* … */ },
  "telemetry": { "events": [], "metrics": {}, "errorCount": 0, "lastFlush": null },
  "goalPhase": "structure",
  "queues": { "backlog": [], "done": [], "blocked": [] },
  "stats": { "cyclesRun": 164, "completed": 52, "blocked": 8, "revisions": 24 },
  "history": [ /* … */ ]
}
```

---

## API (`lib/state.mjs`)

| Export | Returns | Use |
|---|---|---|
| `loadState(path)` | flat object | Behavior-preserving load (merges tiers; reads v1, v2, or v3). |
| `saveState(path, flat)` | — | Atomic save; persists the flat object as two-tier v3. |
| `loadFrameworkState(path)` | `frameworkState` | Independent loader — engine/loop state only (no target data). |
| `loadTargetState(path)` | `appState` (target fields) | Independent loader — target-project backlog/metrics/goalPhase only. |
| `loadAppState(path)` | same as `loadTargetState` | Legacy alias — prefer `loadTargetState` in new code. |
| `splitState(flat)` | `{ frameworkState, appState }` | Split a flat object into the two tiers. |
| `mergeState(tiered)` | flat object | Merge tiers back to flat (accepts `{framework,target}`, `{framework,app}` (v2), or `{frameworkState,appState}`; passes a flat object through). |
| `SCHEMA_VERSION` | `3` | Current persisted wrapper version. |

```js
// Read only the engine's loop state (no target-project data):
const fw = await loadFrameworkState(STATE_PATH);
// → { cycle, status, rateLimit, current, usage, tokenSpent, telemetry, … }

// Read only the target project's backlog/metrics:
const target = await loadTargetState(STATE_PATH);
// → { goalPhase, queues, stats, history }
```

---

## Migration guide

### v1 (flat) → v3 (two-tier)

**Automatic.** `loadState()` detects a v1 file (no `schemaVersion` wrapper), returns the flat
object as-is, logs a one-time migration notice, and the **next `saveState()` re-persists it in
the v3 two-tier shape** — no manual step required.

**Before (v1 flat):**
```json
{
  "version": 1, "cycle": 10, "status": "running", "goalPhase": "structure",
  "rateLimit": { "pausedUntil": null, "consecutiveHits": 0 },
  "queues": { "backlog": [], "done": [], "blocked": [] },
  "stats": { "cyclesRun": 10, "completed": 3 },
  "history": []
}
```

**After (v3 two-tier — written on next save):**
```json
{
  "schemaVersion": 3,
  "framework": {
    "version": 1, "cycle": 10, "status": "running",
    "rateLimit": { "pausedUntil": null, "consecutiveHits": 0 }
  },
  "target": {
    "goalPhase": "structure",
    "queues": { "backlog": [], "done": [], "blocked": [] },
    "stats": { "cyclesRun": 10, "completed": 3 },
    "history": []
  }
}
```

### v2 (framework/app) → v3 (framework/target)

**Automatic.** `loadState()` reads both `app` and `target` keys interchangeably via `mergeState()`.
The first `saveState()` after upgrading writes `target` and omits `app`. The `goalPhase` field
(previously in `framework` tier) is now placed in the `target` tier.

**Before (v2 on-disk):**
```json
{
  "schemaVersion": 2,
  "framework": { "cycle": 100, "status": "running", "goalPhase": "structure", "…": "…" },
  "app": { "queues": { "…": [] }, "stats": { "…": 0 }, "history": [] }
}
```

**After (v3 on-disk — written on next save):**
```json
{
  "schemaVersion": 3,
  "framework": { "cycle": 100, "status": "running", "…": "…" },
  "target": { "goalPhase": "structure", "queues": { "…": [] }, "stats": { "…": 0 }, "history": [] }
}
```

---

## Formal schema

The full JSON Schema (draft-07) is at `autopilot/state/state.json.schema.json`. It documents every
field with type, constraints, and its conceptual group (`tokenCounters`, `processLocks`, etc.).

---

## Notes

- The supervisor (`supervisor.mjs`) and `watchdog.mjs` always consume the **flat** working view via
  `loadState()`/`saveState()` and are unaffected by the on-disk tier structure.
- The `additionalProperties: true` guard on both tiers ensures any new fields introduced by future
  engine modules round-trip losslessly.
- `splitState(mergeState(splitState(x)))` is idempotent — the tier split never loses data.
