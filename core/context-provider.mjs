// core/context-provider.mjs — the ContextProvider input seam (U-37).
//
// A host application can pre-compute its own codebase context maps (file index, symbol index,
// dependency graph) and feed them DIRECTLY to the kinetic selector, so the selector doesn't have to
// re-derive that context from a local file-system scan. This module defines the provider INTERFACE,
// a loader that resolves + validates + caches the maps, and a small freshness check. It is the
// counterpart of the U-25/U-31/U-35 config-driven seams: a new, optional INPUT — never a workflow
// change. When no provider is wired (the default), the loader returns null and callers fall back to
// their existing local analysis unchanged (fully backward compatible).
//
// Pure + dependency-free: this module reads no files and runs no git. A provider hands it data; it
// validates the shape, checks freshness, and caches in memory. Safe to import from anywhere.
//
// ── The interface a host implements ──────────────────────────────────────────────────────────────
//   A ContextProvider is any object exposing:
//     { source: string, getContextMaps(): ContextMaps | Promise<ContextMaps>, validateFreshness?: bool }
//   getContextMaps() returns a ContextMaps bundle:
//     {
//       fileIndex:       FileIndexMap,       // { [relPath]: { size?, lang?, hash? } }
//       symbolIndex:     SymbolIndexMap,      // { [symbol]: { file, line?, kind? } }
//       dependencyGraph: DependencyGraph,     // { [file]: string[]  (files it imports) }
//       generatedAt:     number | string,     // epoch-ms or ISO timestamp the maps were built
//       source?:         string               // optional override of the provider's source id
//     }
//
// @typedef {Record<string, {size?:number, lang?:string, hash?:string}>} FileIndexMap
// @typedef {Record<string, {file:string, line?:number, kind?:string}>}  SymbolIndexMap
// @typedef {Record<string, string[]>}                                    DependencyGraph
// @typedef {{fileIndex:FileIndexMap, symbolIndex:SymbolIndexMap, dependencyGraph:DependencyGraph, generatedAt:(number|string), source?:string}} ContextMaps
// @typedef {{source:string, getContextMaps:Function, validateFreshness?:boolean}} ContextProviderInterface

/** The three canonical map kinds a host must provide (documented contract — also used in validation). */
export const REQUIRED_MAP_KEYS = ['fileIndex', 'symbolIndex', 'dependencyGraph'];

/** Default freshness window (ms) when a host enables freshness validation but sets no maxStaleMs. */
export const DEFAULT_MAX_STALE_MS = 300000; // 5 minutes

// In-memory cache, keyed by source id → { maps, storedAt }. The 'memory' cache strategy reuses a
// previously-loaded bundle within its freshness window; 'none' disables caching (always re-resolve).
const _cache = new Map();

/** Clear the in-memory context-map cache (test/host hook). */
export function clearContextCache() { _cache.clear(); }

/** Coerce a generatedAt (epoch-ms number or ISO/string) to epoch-ms, or NaN when unparseable. */
function toEpochMs(generatedAt) {
  if (typeof generatedAt === 'number') return generatedAt;
  if (typeof generatedAt === 'string') {
    const n = Number(generatedAt);
    if (Number.isFinite(n)) return n;
    const t = Date.parse(generatedAt);
    return Number.isNaN(t) ? NaN : t;
  }
  return NaN;
}

/**
 * Validate a ContextMaps bundle's shape and (optionally) freshness.
 * @param {ContextMaps} maps
 * @param {{validateFreshness?:boolean, maxStaleMs?:number, now?:number}} [opts]
 * @returns {{ valid:boolean, fresh:boolean, ageMs:(number|null), reason:(string|null) }}
 */
export function validateContextMaps(maps, opts = {}) {
  const { validateFreshness = false, maxStaleMs = DEFAULT_MAX_STALE_MS, now = Date.now() } = opts;
  if (!maps || typeof maps !== 'object') {
    return { valid: false, fresh: false, ageMs: null, reason: 'no maps object' };
  }
  for (const k of REQUIRED_MAP_KEYS) {
    if (!maps[k] || typeof maps[k] !== 'object') {
      return { valid: false, fresh: false, ageMs: null, reason: `missing/invalid map: ${k}` };
    }
  }
  const epoch = toEpochMs(maps.generatedAt);
  if (Number.isNaN(epoch)) {
    // Shape is valid but we can't reason about freshness. Treat as fresh only when not enforcing it.
    return {
      valid: true,
      fresh: !validateFreshness,
      ageMs: null,
      reason: validateFreshness ? 'missing/unparseable generatedAt' : null
    };
  }
  const ageMs = now - epoch;
  if (validateFreshness && ageMs > maxStaleMs) {
    return { valid: true, fresh: false, ageMs, reason: `stale by ${ageMs - maxStaleMs}ms (age ${ageMs}ms > ${maxStaleMs}ms)` };
  }
  return { valid: true, fresh: true, ageMs, reason: null };
}

/**
 * Normalize the many ways a host can hand us a provider into a uniform { source, getContextMaps }.
 * Accepts: a full provider object, a bare ContextMaps bundle, or a function returning a bundle.
 * @returns {ContextProviderInterface|null}
 */
function normalizeProvider({ provider, contextMaps } = {}) {
  // 1) Explicit pre-computed maps win — wrap them in a trivial provider.
  if (contextMaps && typeof contextMaps === 'object') {
    return { source: contextMaps.source || 'inline', getContextMaps: () => contextMaps };
  }
  if (!provider) return null;
  // 2) A function that returns the maps.
  if (typeof provider === 'function') {
    return { source: 'fn', getContextMaps: provider };
  }
  // 3) A provider object exposing getContextMaps().
  if (typeof provider.getContextMaps === 'function') {
    return {
      source: provider.source || 'provider',
      getContextMaps: () => provider.getContextMaps(),
      validateFreshness: provider.validateFreshness
    };
  }
  // 4) A bare ContextMaps bundle passed as `provider`.
  if (REQUIRED_MAP_KEYS.every((k) => provider[k])) {
    return { source: provider.source || 'inline', getContextMaps: () => provider };
  }
  return null;
}

/**
 * Resolve codebase context maps from a host-supplied provider, validate + (optionally) freshness-check,
 * and cache them in memory. The single entry-point callers (the selector) use.
 *
 * @param {{
 *   provider?: ContextProviderInterface|Function|ContextMaps,
 *   contextMaps?: ContextMaps,
 *   validateFreshness?: boolean,
 *   maxStaleMs?: number,
 *   cacheStrategy?: ('memory'|'none'),
 *   now?: number
 * }} [opts]
 * @returns {Promise<{ ok:boolean, maps:(ContextMaps|null), source:(string|null), fromCache:boolean, fresh:boolean, reason:(string|null) }>}
 *   `ok:false` is the graceful-fallback signal — the caller should silently use local analysis.
 */
export async function loadContextMaps(opts = {}) {
  const {
    validateFreshness = false,
    maxStaleMs = DEFAULT_MAX_STALE_MS,
    cacheStrategy = 'memory',
    now = Date.now()
  } = opts;

  const norm = normalizeProvider(opts);
  if (!norm) {
    return { ok: false, maps: null, source: null, fromCache: false, fresh: false, reason: 'no context provider configured' };
  }

  // Per-provider freshness preference can override the caller's default.
  const enforceFreshness = norm.validateFreshness ?? validateFreshness;

  // Cache hit (memory strategy only): reuse a previously-loaded bundle while it's still fresh.
  if (cacheStrategy === 'memory') {
    const hit = _cache.get(norm.source);
    if (hit) {
      const v = validateContextMaps(hit.maps, { validateFreshness: enforceFreshness, maxStaleMs, now });
      if (v.valid && v.fresh) {
        return { ok: true, maps: hit.maps, source: norm.source, fromCache: true, fresh: true, reason: null };
      }
      _cache.delete(norm.source); // evict stale/invalid
    }
  }

  let maps;
  try {
    maps = await norm.getContextMaps();
  } catch (err) {
    return { ok: false, maps: null, source: norm.source, fromCache: false, fresh: false, reason: `provider error: ${err?.message || err}` };
  }

  const v = validateContextMaps(maps, { validateFreshness: enforceFreshness, maxStaleMs, now });
  if (!v.valid || !v.fresh) {
    return { ok: false, maps: null, source: norm.source, fromCache: false, fresh: v.fresh, reason: v.reason };
  }

  const source = maps.source || norm.source;
  if (cacheStrategy === 'memory') _cache.set(source, { maps, storedAt: now });
  return { ok: true, maps, source, fromCache: false, fresh: true, reason: null };
}

/**
 * Build a compact, prompt-friendly summary of context maps (counts + a short sample) so the selector
 * can hand the role agent provider-supplied context without dumping a huge object into the prompt.
 * @param {ContextMaps} maps
 */
export function summarizeContextMaps(maps) {
  if (!maps) return null;
  const fileCount = Object.keys(maps.fileIndex || {}).length;
  const symbolCount = Object.keys(maps.symbolIndex || {}).length;
  const depCount = Object.keys(maps.dependencyGraph || {}).length;
  return {
    source: maps.source || null,
    generatedAt: maps.generatedAt ?? null,
    fileCount,
    symbolCount,
    dependencyNodes: depCount,
    sampleFiles: Object.keys(maps.fileIndex || {}).slice(0, 25),
    sampleSymbols: Object.keys(maps.symbolIndex || {}).slice(0, 25)
  };
}
