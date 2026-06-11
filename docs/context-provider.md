# Context Provider — feeding external codebase maps to the selector (U-37)

The kinetic selector normally derives its understanding of a codebase from a **local file-system
scan**. The **Context Provider** is an optional **input seam** that lets any host application
pre-compute its own codebase maps (file index, symbol index, dependency graph) and hand them to the
selector directly — eliminating redundant local scanning and letting the engine reason about a
codebase it didn't index itself.

This mirrors the U-25/U-31/U-35 config-driven seams: a new, **optional** input, never a workflow
change. With no provider wired (the default), the selector falls back to local analysis exactly as
before — **fully backward compatible / standalone**.

## The interface contract

A `ContextProvider` is any object implementing:

```ts
interface ContextProviderInterface {
  source: string;                                   // id for this provider/codebase (also the cache key)
  getContextMaps(): ContextMaps | Promise<ContextMaps>;
  validateFreshness?: boolean;                      // optional per-provider freshness preference
}
```

`getContextMaps()` returns a **ContextMaps** bundle built from these three required map types:

```ts
type FileIndexMap     = Record<string, { size?: number; lang?: string; hash?: string }>;
type SymbolIndexMap   = Record<string, { file: string; line?: number; kind?: string }>;
type DependencyGraph  = Record<string, string[]>;   // file → files it imports

interface ContextMaps {
  fileIndex:       FileIndexMap;
  symbolIndex:     SymbolIndexMap;
  dependencyGraph: DependencyGraph;
  generatedAt:     number | string;                 // epoch-ms or ISO timestamp the maps were built
  source?:         string;                          // optional override of the provider's source id
}
```

The loader accepts three equivalent shapes for convenience: a full provider object (above), a bare
`ContextMaps` bundle, or a function returning a bundle.

## The `contextProvider` config block

```jsonc
"contextProvider": {
  "enabled": false,                                        // master switch (default: local analysis only)
  "interface": "core/context-provider.mjs#ContextProviderInterface", // REQUIRED — the contract a host targets
  "source": "",                                            // REQUIRED — provider/codebase id + cache key
  "cacheStrategy": "memory",                               // REQUIRED — 'memory' (reuse while fresh) | 'none'

  // ── OPTIONAL fallback fields ──
  "validateFreshness": true,                               // reject maps older than maxStaleMs
  "maxStaleMs": 300000,                                    // freshness window (default 5 min)
  "fallbackToLocal": true                                  // silently use local analysis when no/stale maps
}
```

| Field | Required | Default | Meaning |
|---|---|---|---|
| `enabled` | — | `false` | Master switch. `false` keeps the engine on pure local analysis (standalone). |
| `interface` | ✅ | `core/context-provider.mjs#ContextProviderInterface` | The contract a host implements. |
| `source` | ✅ | `""` | Stable id for the provider/codebase; also the in-memory cache key. |
| `cacheStrategy` | ✅ | `memory` | `memory` reuses a loaded bundle while fresh; `none` always re-resolves. |
| `validateFreshness` | — | `true` | Reject maps whose `generatedAt` is older than `maxStaleMs`. |
| `maxStaleMs` | — | `300000` | Freshness window in ms. |
| `fallbackToLocal` | — | `true` | When no/stale/invalid maps, silently use local file-system analysis. |

Resolved (with safe defaults) by `autopilot/config-loader.mjs → { contextProvider }`. Verify the live
resolution any time:

```bash
node autopilot/config-loader.mjs   # prints contextProviderResolvedLine() among the other seams
```

## How the selector prioritizes external maps

`core/selector/index.mjs → runSelector(runner, vars, model, opts)` accepts an optional `opts`:

```js
await core.runSelector(selectorVars, model, {
  contextMaps,           // a pre-computed ContextMaps bundle …
  // — or —
  contextProvider,       // … a provider object/function that returns one
  validateFreshness: true,
  maxStaleMs: 300000,
  cacheStrategy: 'memory'
});
```

The selector:

1. **Prioritizes** provider-supplied maps: it calls `loadContextMaps()`, which **validates the shape**
   (the three required maps) and **checks freshness** (`generatedAt` within `maxStaleMs`).
2. On success, injects a compact summary into the prompt vars (`CONTEXT_MAPS`, `CONTEXT_SOURCE`) so the
   role agent reasons from the host-supplied context instead of re-scanning.
3. On **absent / stale / invalid / erroring** maps, returns `ok:false` and the selector **silently
   falls back** to its existing local analysis — no error, no behavior change.

Caching: the `memory` strategy stores the loaded bundle keyed by `source` and reuses it while it stays
within the freshness window; stale/invalid entries are evicted on next load. `clearContextCache()` is
exposed for hosts/tests.

## Sample integration — an Express host feeding its own AST

```js
// host-app/feed-kinetic.mjs
import { createCore } from '../autopilot/core/index.mjs';
import { buildAst } from './my-indexer.mjs'; // your app's existing indexer

// 1) Build the three required maps from your app's AST / module graph.
function buildContextMaps() {
  const ast = buildAst('./src');
  const fileIndex = {};       // { 'src/routes/users.js': { lang: 'js', size: 1820 }, … }
  const symbolIndex = {};     // { 'getUser': { file: 'src/routes/users.js', line: 42, kind: 'function' }, … }
  const dependencyGraph = {}; // { 'src/routes/users.js': ['src/db/pool.js'], … }
  for (const node of ast.files) {
    fileIndex[node.path] = { lang: node.lang, size: node.size };
    for (const sym of node.symbols) symbolIndex[sym.name] = { file: node.path, line: sym.line, kind: sym.kind };
    dependencyGraph[node.path] = node.imports;
  }
  return { fileIndex, symbolIndex, dependencyGraph, generatedAt: Date.now(), source: 'express-app' };
}

// 2) Hand it to the selector as a provider — it's prioritized over local scanning.
const provider = { source: 'express-app', getContextMaps: buildContextMaps, validateFreshness: true };

const core = createCore({ /* promptDir, handoffDir, cwd, config, runClaude, … */ });
const selection = await core.runSelector(selectorVars, model, { contextProvider: provider, maxStaleMs: 600000 });
```

If `buildContextMaps()` throws, returns an incomplete bundle, or the maps are older than `maxStaleMs`,
the selector logs nothing special and proceeds with local analysis — the host integration is purely
additive.
