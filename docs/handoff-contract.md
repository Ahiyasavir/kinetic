# Kinetic handoff contract (U-34)

This is the **stable contract** for the kinetic's handoff files — the JSON each agent role writes/reads
between steps. It exists so external contributors can extend handoffs safely without causing silent
collisions or schema drift across concurrent instances. Two independent concerns are covered:

1. **Naming** — how a file is named so two project contexts never overwrite each other.
2. **Schema versioning** — an envelope on persisted structures so a reader can detect and migrate drift.

> The naming half is documented in depth in [`../HANDOFF_STRUCTURE.md`](../HANDOFF_STRUCTURE.md); this
> file is the canonical, contributor-facing contract and covers the **versioning/migration** half added
> on top of it.

## 1. Naming (collision-safe)

The four per-cycle role handoffs live in the handoff dir (`autopilot/state/handoff/`, configurable via
`config.json → paths.queues.handoffDir`):

| Role | Generic name | Writes | Read by |
|---|---|---|---|
| selector | `selection.json` | chosen task + proposed backlog | supervisor |
| implementer | `implementation.json` | what it changed + self-check | supervisor, reviewer, auditor |
| reviewer | `review.json` | approve/revise/reject verdict | supervisor |
| auditor | `audit.json` | independent regression/scope verdict | supervisor |

Every basename is tagged with a deterministic **project-context id** so concurrent instances that share a
handoff dir cannot collide:

```
selection.json → selection-<contextId>.json     (the contextId is inserted before the extension)
```

`<contextId>` comes from `config.json` (`handoff.context`, else the repo+goal slug — the same identity that
keys process locks and per-project token budgets). Resolution lives in
[`../lib/handoff-paths.mjs`](../lib/handoff-paths.mjs) (`resolveContextId`, `contextualName`,
`resolveHandoffPath`). When no context is derivable the basename passes through unchanged (legacy layout).

```bash
node autopilot/lib/handoff-paths.mjs   # prints contextId + generic→tagged→absolute paths
```

## 2. Versioned schema envelope

Persisted handoff structures carry a small **envelope** so a reader can detect a file written by another
engine version or another project context. Defined in [`../lib/handoff-schema.mjs`](../lib/handoff-schema.mjs):

| Field | Type | Meaning |
|---|---|---|
| `version` | integer | schema version (`HANDOFF_SCHEMA_VERSION`, currently **1**); bump on a breaking shape change |
| `timestamp` | ISO-8601 string | write time — provenance + ordering across concurrent contexts |
| `projectScope` | string | the `contextId` the structure belongs to — lets a reader reject/flag a foreign file |

- **Stamp on write:** `stampHandoff(payload, { context, timestamp })` — idempotent and non-destructive
  (an explicit envelope field already on the payload is preserved). Used for engine-persisted structures
  (e.g. inbox task items carry `version`).
- **Validate on load:** `validateHandoffSchema(data, { context, file })` returns
  `{ ok, status, version, migration, scopeMismatch }` and **never throws or mutates** the payload.

### `status` values

| status | condition | behavior |
|---|---|---|
| `ok` | `version === current` | trusted |
| `unstamped` | no integer `version` (legacy / ephemeral agent handoff) | accepted as **v0**, migration message |
| `outdated` | `0 < version < current` | accepted, migrated on load (re-stamped on next write) |
| `future` | `version > current` (written by a newer engine) | **not trusted** (`ok:false`), warning |

`scopeMismatch` is `true` when a payload's `projectScope` is present but differs from the active context —
the signal that a file from another concurrent instance drifted into a shared handoff dir.

## 3. Backward compatibility & migration

- **No silent corruption.** An old file missing the envelope is accepted (treated as v0); the supervisor
  logs a **clear migration message once per file per process** (deduped so ephemeral agent handoffs don't
  re-log every cycle). A `future` version is not trusted rather than mis-parsed.
- The per-cycle agent handoffs are **ephemeral** — `clearHandoff()` wipes the handoff dir at the start of
  every cycle, so they are regenerated, not migrated in place.
- `state.json` has its **own** independent two-tier schema versioning (see
  [`../SCHEMA.md`](../SCHEMA.md)); it is intentionally out of scope of this contract.

## 4. Where it is wired

- `lib/handoff-paths.mjs` — context-tagged basenames (naming).
- `lib/handoff-schema.mjs` — `HANDOFF_SCHEMA_VERSION`, `stampHandoff`, `validateHandoffSchema`.
- `core/runtime.mjs` — `createRoleRunner({ validateHandoff })`: every `readHandoff` calls the injected
  validator right after parsing (the core stays project-agnostic; validation is injected, not hardcoded).
- `supervisor.mjs` — injects `validateOnLoad` (logs migration / scope-mismatch) and prints
  `handoffSchemaResolvedLine()` at startup. Watchdog has no handoff I/O.
- `lib/inbox.mjs` — stamps each ingested user task with `version`.

## 5. Extending safely (for contributors)

1. **Adding a field to a handoff** that does not change existing fields → no version bump needed.
2. **Renaming/removing/repurposing a field** (a breaking shape change) → bump `HANDOFF_SCHEMA_VERSION`
   in `lib/handoff-schema.mjs` and add a migration branch where the structure is read.
3. **A new persisted handoff structure** → call `stampHandoff()` when writing it and
   `validateHandoffSchema()` when reading it; document it in the table above.
4. **A new project context** → give it its own `config.json → handoff.context` (or rely on a distinct
   repo+goal slug) so its files never overlap another instance's.
