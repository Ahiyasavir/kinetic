# Handoff file structure & naming (U-34)

The kinetic's four agent roles communicate through **per-cycle handoff JSON files** written into the
handoff directory (`autopilot/state/handoff/`, configurable via `config.json → paths.queues.handoffDir`):

| Role | Generic name | Writes | Read by |
|---|---|---|---|
| selector | `selection.json` | the chosen task + proposed backlog | supervisor |
| implementer | `implementation.json` | what it changed + self-check | supervisor, reviewer, auditor |
| reviewer | `review.json` | approve/revise/reject verdict | supervisor |
| auditor | `audit.json` | independent regression/scope verdict | supervisor |

These files are **ephemeral** — `clearHandoff()` wipes and recreates the handoff directory at the start
of every cycle, then the agents rewrite them. They are not persisted state.

## Why names are context-tagged

When a single host monitors **more than one project context that shares a handoff directory**, identical
basenames (`selection.json`, `implementation.json`, …) collide: one context's implementer overwrites
another's selection read → race conditions and lost data. To prevent this, every handoff basename is
tagged with a deterministic **project-context identifier**:

```
selection.json       → selection-<contextId>.json
implementation.json  → implementation-<contextId>.json
review.json          → review-<contextId>.json
audit.json           → audit-<contextId>.json
```

e.g. for this project: `selection-rushpoint-kinetic-topo.json`.

The `<contextId>` is inserted **before the extension** so the file type is still obvious.

## How `contextId` is derived (deterministic, from `config.json`)

Resolved by [`lib/handoff-paths.mjs`](lib/handoff-paths.mjs) → `resolveContextId()`:

1. **Explicit** — `config.json → handoff.context` (or the legacy alias `projectIdentifier`), slugified.
2. **Derived** — otherwise the repo+goal slug (`lib/lock-manager.mjs → resolveRepoGoal`): the repo
   directory name + the `git.integrationBranch` suffix, e.g. `rushpoint-kinetic-topo`. This is the
   **same identity** that already keys the process locks (U-32) and per-project token budgets (U-33), so
   a project's handoff files, locks and budgets all share one stable name.

Because it comes entirely from `config.json`, the **same project always resolves to the same files**.

## Modules that resolve handoff paths

- **`lib/handoff-paths.mjs`** — `resolveHandoffPath(context, filename)`, `contextualName(filename)`,
  `resolveContextId()`, `contextId`. The single source of truth for the mapping.
- **`supervisor.mjs`** — `handoffRel(file)` tags the basename it tells each agent to write (the prompt's
  `{{HANDOFF_PATH}}`), and injects `resolveName: contextualName` into `createCore(...)` so the core's
  `readHandoff` reads back the **same** tagged file. (Process locks are already context-aware via U-32;
  `state.json` and the inbox are per-checkout, see below.)
- **`core/runtime.mjs`** — `createRoleRunner({ resolveName })` applies the host-injected mapping inside
  `readHandoff(file)`. The core stays project-agnostic (the tagging is injected, not hardcoded).
- **`core/{selector,implementer,reviewer,auditor}/index.mjs`** — unchanged; they pass the **generic**
  basename (`HANDOFF_FILE`) and the runner tags it. No per-role edits needed.

## Multi-project layout

Run two contexts against a shared handoff dir and the files never overlap:

```
autopilot/state/handoff/
├── selection-rushpoint-kinetic-topo.json
├── implementation-rushpoint-kinetic-topo.json
├── review-rushpoint-kinetic-topo.json
├── audit-rushpoint-kinetic-topo.json
├── selection-otherproject-main.json
├── implementation-otherproject-main.json
└── …
```

Give each context its own `config.json → handoff.context` (or rely on distinct repo+goal slugs).

## Migration / backward compatibility

- **No backfill needed for handoff files.** They are regenerated every cycle (`clearHandoff()` →
  agents rewrite), so the first cycle after this change simply writes the new context-tagged names. Any
  stale generic `selection.json` etc. is harmless leftover and can be deleted manually.
- **Backward compatible.** If `contextId` resolves to empty (no `handoff` block and no derivable
  repo/goal), the basenames pass through unchanged (`selection.json`), preserving the legacy layout.
- **`state.json`, the inbox, and process locks are out of scope here.** Process locks are already
  context-tagged (U-32). `state.json` and the inbox queue are per-checkout engine state (each project is
  its own clone with its own `autopilot/state/`); if you ever point two contexts at one `state/`
  directory, relocate them via `config.json → paths.queues.stateDir`/`inboxDir` (U-31) — that is a
  **manual** relocation, not auto-migrated.

## Verify

```bash
node autopilot/lib/handoff-paths.mjs
```

prints the resolved `contextId` and the generic → tagged → absolute path for all four roles. The
supervisor also logs a one-line confirmation at startup (`config-loaded handoff context …`).
