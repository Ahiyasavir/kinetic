# Engine Decoupling Audit — Hardcoded Host-Project References

> Generated/maintained with `node autopilot/scripts/audit-refs.mjs`. Re-run after any decoupling step
> to track progress toward the invariant **"`core/` knows nothing about any specific project."**

This audit inventories every hardcoded reference to the current host project (RushPoint) inside the
engine source tree (`core/`, `lib/`, `shared/`, `prompts/`). Each row gives a file location, a code
snippet, and a coarse effort estimate for removing the reference (moving the fact into the swappable
`project`/context layer described in `docs/INTEGRATION.md` and `core/config.schema.json`).

## How to reproduce

```powershell
node autopilot/scripts/audit-refs.mjs            # human-readable report (file:line + snippet)
node autopilot/scripts/audit-refs.mjs --json     # machine-readable JSON
node autopilot/scripts/audit-refs.mjs --core-only # gate: exits 1 if core/ has ANY hit
```

Markers scanned: `rushpoint`, `topographic`, `apps/`, `functions/`, `firestore`, `gameState`,
`taskScore`, `tene`, and Jerusalem geography terms. Directories `contexts/`, `commercial/`,
`profiles/`, `templates/`, and `tests/` are intentionally excluded — those layers are *meant* to hold
project facts.

## Summary (latest run)

| Marker | Hits |
|---|---|
| rushpoint | 36 |
| firestore | 8 |
| apps/ | 4 |
| gameState | 2 |
| functions/ | 2 |
| topographic | 1 |
| **Total** | **53 across 23 files** |

The 53 references split into two categories:

- **Cosmetic / documentation** — comments and READMEs that *name* RushPoint to describe the decoupling
  invariant (e.g. "this module knows nothing about RushPoint"). These do not functionally couple the
  engine; removing them is a doc edit, not a behavior change. Effort: **trivial**.
- **Functional** — code (defaults, fallback strings, prompt text) that bakes a RushPoint fact into the
  engine. These are the references that must move into the `project`/context layer. Effort: **low–medium**.

## Functional references (require a code change to remove)

| File:Line | Marker | Snippet | Removal | Effort |
|---|---|---|---|---|
| `lib/manifest-loader.mjs:47` | rushpoint | `const DEFAULT_APP_ID = 'rushpoint-pwa-7daaa';` | Read app id from `project`/profile, not a built-in default. | low |
| `lib/manifest-loader.mjs:49` | rushpoint | `projectName: 'RushPoint',` | Default to a neutral name; source the real name from the profile. | low |
| `lib/manifest-loader.mjs:14,25,58` | rushpoint | "falls back to the built-in RushPoint defaults" | Rename the fallback to a generic "default manifest". | low |
| `lib/state.mjs:39–42` | rushpoint | "default profile is config.profile ('rushpoint')" / seed default | Make the seed/profile default project-neutral (empty seed). | medium |
| `lib/files.mjs:62` | rushpoint | ``const header = `# Decision Log\n\n_RushPoint Kinetic — …` `` | Build the log header from the profile label. | low |
| `lib/providers/openrouter.mjs:56` | rushpoint | `'HTTP-Referer': 'https://github.com/rushpoint/autopilot'` | Make the referer/app-url configurable (provider def). | low |
| `prompts/selector.md` (5 hits) | rushpoint/firestore/apps/ | Project facts embedded in the generic selector prompt | Move project facts to `contexts/<id>/prompts/selector.md`; keep `prompts/selector.md` role-only. | medium |
| `prompts/auditor.md` (3 hits) | rushpoint/firestore | Project facts in the generic auditor prompt | Same: layer project facts via the context prompt overlay. | medium |
| `prompts/reviewer.md` (2 hits) | rushpoint/firestore | Project facts in the generic reviewer prompt | Same. | medium |

## Cosmetic / documentation references (trivial)

These are comments/READMEs that *describe* the decoupling and merely mention the project name. They are
flagged by the audit for completeness but do not functionally couple the engine:

| File:Line | Note |
|---|---|
| `core/index.mjs:5` | Docstring: "no RushPoint paths, Firestore, …" |
| `core/runtime.mjs:10,13` | Docstring describing what core hardcodes (nothing). |
| `core/reviewer/index.mjs:5` | Docstring: "no dependency on RushPoint's callables…" |
| `core/README.md:5,6` | Module map prose. |
| `lib/git-config-loader.mjs`, `lib/lock-manager.mjs`, `lib/handoff-paths.mjs`, `lib/telemetry.mjs`, `lib/workspace*.mjs`, `lib/git.mjs`, `lib/handoff-schema.mjs` | Comments using `rushpoint-kinetic-topo` as an *example* slug, or describing defaults. |

## False positives

- `lib/context-compiler.mjs:136` — the substring `functions/types` in the phrase "matching symbols
  (functions/types)" is prose, not a directory path. Safe to ignore.

## Recommended removal order

1. **Prompts** (`prompts/*.md`) — split each generic role prompt from its project facts; this is the
   single biggest source-of-truth leak and is referenced by every cycle.
2. **`lib/manifest-loader.mjs` + `lib/state.mjs` defaults** — make the built-in fallbacks neutral so a
   project with no profile boots as a true NullContext.
3. **Cosmetic log/header strings** (`lib/files.mjs`, `lib/providers/openrouter.mjs`) — source from the
   profile label.
4. **Doc comments** — reword last; they are harmless and currently document the intended invariant.

When step 1–3 are done, `node autopilot/scripts/audit-refs.mjs --core-only` should report **0 core
hits**, and the remaining `lib/` hits should be comments only.
