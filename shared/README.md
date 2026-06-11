# shared/

This directory contains **universal type contracts and constants** used across the engine, plugins,
and any third-party integrations — the stable interface layer that all layers can depend on safely.

**Contents:**
- `types.mjs` — JSDoc-typed interfaces (`ContextProviderInterface`, `FileIndexMap`,
  `DependencyGraph`, …) and enums (`TASK_CLASS`, `PROVIDER_TYPE`). Import these instead of
  inline-duplicating the contracts in plugins or commercial code.

**Rules:**
- No project-specific logic (no RushPoint, no Firebase, no commercial config references).
- No runtime dependencies on `../core/`, `../lib/`, `../commercial/`, or `../plugins/`.
- Changes here are breaking changes for any consumer — treat them as a public API.
