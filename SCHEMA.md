# Kinetic `state.json` schema (v2 — two-tier)

`autopilot/state/state.json` is the single source of truth for the autonomous loop. As of schema
**v2** it is split into two independent tiers so the **framework** (the reusable kinetic engine)
is decoupled from the **target app** it is currently improving (RushPoint). This separation is the
prerequisite for running the same engine against multiple projects.

> The split exists **on disk**. In memory the supervisor still works with a single *flat* object
> (behaviour-preserving): `loadState()` merges the tiers back to flat, and `saveState()` splits the
> flat object into the two tiers only at the disk boundary.

## The two tiers

| Tier | Owns | Top-level keys |
|---|---|---|
| **`framework`** | The engine: executor / loop coordination, locks-adjacent run state, rate-limit + weekly-budget config, the currently-executing task slot. *Project-agnostic.* | `version`, `startedAt`, `deadlineAt`, `lastUpdated`, `cycle`, `status`, `goalPhase`, `rateLimit`, `current`, `usage` |
| **`app`** | The target project's work product: its task backlog, run metrics, and per-cycle history. *Project-specific (today: RushPoint).* | `queues` (`backlog` / `done` / `blocked`), `stats`, `history` |

**Rule of thumb:** the `app` tier is exactly the keys in `APP_KEYS` (`queues`, `stats`, `history`)
in `lib/state.mjs`. **Every other** top-level key is framework state, so any new/unknown field
defaults to the `framework` tier and round-trips losslessly.

## On-disk shape (v2)

```jsonc
{
  "schemaVersion": 2,
  "framework": {
    "version": 1,
    "startedAt": "2026-06-02T20:57:10.951Z",
    "deadlineAt": "2036-05-30T21:08:26.453Z",
    "lastUpdated": "2026-06-06T05:24:24.963Z",
    "cycle": 131,
    "status": "running",
    "goalPhase": "structure",
    "rateLimit": { "pausedUntil": null, "consecutiveHits": 0 },
    "current": null,
    "usage": { "windowResetAt": null, "cycles": 0, "costUsd": 0 }
  },
  "app": {
    "queues": { "backlog": [ /* tasks */ ], "done": [], "blocked": [] },
    "stats":  { "cyclesRun": 131, "completed": 40, "blocked": 5, "revisions": 12 },
    "history": [ { "cycle": 1, "taskId": "U-1", "outcome": "merged", "ts": "…" } ]
  }
}
```

## In-memory shape (flat — what the supervisor mutates)

```jsonc
{
  "version": 1, "startedAt": "…", "deadlineAt": "…", "lastUpdated": "…",
  "cycle": 131, "status": "running", "goalPhase": "structure",
  "rateLimit": { … }, "current": null, "usage": { … },
  "queues": { "backlog": [], "done": [], "blocked": [] },
  "stats": { … }, "history": [ … ]
}
```

## API (`lib/state.mjs`)

| Export | Returns | Use |
|---|---|---|
| `loadState(path)` | flat object | Behaviour-preserving load (merges tiers; reads either v1 or v2). |
| `saveState(path, flat)` | — | Atomic save; persists the flat object as two-tier v2. |
| `loadFrameworkState(path)` | `frameworkState` | Independent loader — engine/loop state only. |
| `loadAppState(path)` | `appState` | Independent loader — target-project backlog/metrics only. |
| `splitState(flat)` | `{ frameworkState, appState }` | Split a flat object into the two tiers. |
| `mergeState(tiered)` | flat object | Merge tiers back to flat (accepts `{frameworkState,appState}` or on-disk `{framework,app}`; passes a flat object through unchanged). |
| `SCHEMA_VERSION` | `2` | Current persisted wrapper version. |

```js
// Read only the engine's loop state (no target-app data):
const fw = await loadFrameworkState(STATE_PATH);   // { cycle, status, rateLimit, current, usage, … }

// Read only the target project's backlog/metrics:
const app = await loadAppState(STATE_PATH);         // { queues, stats, history }
```

## Migration & backward compatibility

* **Old flat (v1) files load unchanged.** `loadState()` detects a v1 file (no `schemaVersion: 2`
  wrapper), returns the flat object as-is, logs a one-time migration notice, and the **next
  `saveState()` re-persists it in the v2 two-tier shape** — no manual migration step required.
* **Round-trip is lossless:** `mergeState(splitState(x))` deep-equals `x`, so the on-disk reshape
  never changes engine behaviour. The corrupt-file `.bak` recovery path is normalized the same way.

## Notes / follow-ups

The supervisor (`supervisor.mjs`) and `watchdog.mjs` are **frozen by the Strangler-Fig guard**
(`lib/protect.mjs`) until `autopilot/core/.ready` exists, so they continue to consume the flat
working view via `loadState()`/`saveState()`. The independent tier loaders above are provided so
that engine modules — and the future `core/` engine once the freeze lifts — can read
`frameworkState` / `appState` directly without the frozen entry-points needing to change today.
